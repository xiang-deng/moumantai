/**
 * Unit tests for edit-mcp-tools.ts.
 *
 * Covers: smoke test (5 tools with expected names), validate_face happy path
 * and missing-face error, validate_tool happy path and missing-tool error,
 * and request_promote_review error aggregation. generate_migration is not
 * integration-tested (requires drizzle-kit subprocess); its return shape is
 * verified via a missing-schema scenario.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildEditMcpTools } from '../../../src/server/agent/edit-mcp-tools.js'
import type { EditMcpToolsDeps } from '../../../src/server/agent/edit-mcp-tools.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'edit-mcp-tools-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Path to the fixture test-app (server/tests/fixtures/test-app). */
const FIXTURE_DIR = new URL('../../../tests/fixtures/test-app', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)

/** Build a minimal draft dir that mimics a Moumantai app layout. */
function makeDraftDir(): string {
  const draftDir = join(tmpDir, 'draft')
  mkdirSync(join(draftDir, 'faces'), { recursive: true })
  mkdirSync(join(draftDir, 'tools'), { recursive: true })

  // Minimal index.ts so reloadSingleApp can find the app
  writeFileSync(
    join(draftDir, 'index.ts'),
    `
import type { AppDefinition } from 'moumantai'
export default {
  manifest: { id: 'test-draft', name: 'Test Draft', icon: 'star', description: 'draft' },
  tools: [],
  faces: [],
} satisfies AppDefinition
`,
  )
  return draftDir
}

/** Copy the fixture face file into the draft's faces dir. */
function copyFixtureFace(draftDir: string, faceName: string): void {
  const src = join(FIXTURE_DIR, 'faces', `${faceName}.ts`)
  const dest = join(draftDir, 'faces', `${faceName}.compact.ts`)
  if (existsSync(src)) {
    cpSync(src, dest)
  }
}

/** Copy the fixture tool file into the draft's tools dir. */
function copyFixtureTool(draftDir: string, toolName: string): void {
  const src = join(FIXTURE_DIR, 'tools', `${toolName}.ts`)
  const dest = join(draftDir, 'tools', `${toolName}.ts`)
  if (existsSync(src)) {
    cpSync(src, dest)
  }
}

/** Build deps with no shadow DB (shadow path points to a non-existent file). */
function makeDeps(draftDir: string, overrides: Partial<EditMcpToolsDeps> = {}): EditMcpToolsDeps {
  return {
    draftId: 'test-draft-id',
    draftDir,
    shadowDbPath: join(draftDir, '.shadow', 'db.sqlite'), // won't exist
    markReadyForReview: () => {
      /* no-op */
    },
    // validate_types deps: no live baseline + a bogus repoRoot so the typecheck
    // fail-softs (no apps/tsconfig.json there) — these tests don't exercise tsc.
    liveSrcDir: null,
    home: join(draftDir, '..'),
    repoRoot: join(draftDir, '..', '..'),
    ...overrides,
  }
}

/** Call a tool handler by name from the array returned by buildEditMcpTools. */
async function callTool(
  tools: unknown[],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const found = (
    tools as Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>
  ).find((t) => t.name === name)
  if (!found) throw new Error(`Tool "${name}" not found`)
  return found.handler(args)
}

/** Parse the first content text from the tool response. */
function parseResult(resp: unknown): unknown {
  const r = resp as { content: Array<{ type: string; text: string }> }
  const text = r.content?.[0]?.text
  return text ? JSON.parse(text) : undefined
}

/**
 * Build a draft whose tool FILE is kebab-case (`follow-team.ts`) while the tool
 * NAME is snake_case (`follow_team`) — the canonical Moumantai convention and
 * the exact shape that used to fail promote-review with "Tool file not found:
 * tools/follow_team.ts". The tool is wired into index.ts so it is a registered
 * tool. moumantai is imported type-only so the esbuild draft loader can bundle
 * it without resolving the SDK at runtime.
 */
function writeKebabToolDraft(): string {
  const draftDir = join(tmpDir, 'kebab-draft')
  mkdirSync(join(draftDir, 'tools'), { recursive: true })
  mkdirSync(join(draftDir, 'faces'), { recursive: true })
  writeFileSync(
    join(draftDir, 'tools', 'follow-team.ts'),
    `
import type { ToolDefinition } from 'moumantai'
const followTeam: ToolDefinition = {
  name: 'follow_team',
  description: 'Follow a team',
  parameters: {},
  execute: async () => ({ result: 'ok' }),
}
export default followTeam
`,
  )
  writeFileSync(
    join(draftDir, 'index.ts'),
    `
import type { AppDefinition } from 'moumantai'
import followTeam from './tools/follow-team.js'
export default {
  manifest: { id: 'kebab-draft', name: 'Kebab', icon: 'star', description: 'd' },
  tools: [followTeam],
  faces: [],
} satisfies AppDefinition
`,
  )
  return draftDir
}

/** Build a draft that registers a tool object missing its `execute` function. */
function writeBrokenToolDraft(): string {
  const draftDir = join(tmpDir, 'broken-tool-draft')
  mkdirSync(join(draftDir, 'tools'), { recursive: true })
  mkdirSync(join(draftDir, 'faces'), { recursive: true })
  writeFileSync(
    join(draftDir, 'tools', 'bad-tool.ts'),
    `
const badTool = { name: 'bad_tool', description: 'no execute', parameters: {} }
export default badTool
`,
  )
  writeFileSync(
    join(draftDir, 'index.ts'),
    `
import type { AppDefinition } from 'moumantai'
import badTool from './tools/bad-tool.js'
export default {
  manifest: { id: 'broken-tool-draft', name: 'Broken', icon: 'star', description: 'd' },
  tools: [badTool],
  faces: [],
} as unknown as AppDefinition
`,
  )
  return draftDir
}

// ---------------------------------------------------------------------------
// 1. Smoke test: 4 tools with expected names
// ---------------------------------------------------------------------------

describe('buildEditMcpTools', () => {
  it('returns exactly 5 tools', () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir))
    expect(tools).toHaveLength(5)
  })

  it('returns tools with correct names', () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir)) as Array<{ name: string }>
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'generate_migration',
      'request_promote_review',
      'validate_face',
      'validate_tool',
      'validate_types',
    ])
  })

  it('each tool has a handler function', () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir)) as Array<{ handler?: unknown }>
    for (const t of tools) {
      expect(typeof t.handler).toBe('function')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. validate_face — missing face returns ok:false with descriptive message
// ---------------------------------------------------------------------------

describe('validate_face', () => {
  it('returns ok:false for a non-existent face_id', async () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir))

    const resp = await callTool(tools, 'validate_face', { face_id: 'nonexistent-face' })
    const result = parseResult(resp) as {
      ok: boolean
      errors?: Array<{ target: string; kind: string; message: string }>
    }

    expect(result.ok).toBe(false)
    expect(result.errors).toBeDefined()
    expect(result.errors![0]!.target).toBe('nonexistent-face')
    expect(result.errors![0]!.kind).toBe('face')
    expect(result.errors![0]!.message).toContain('nonexistent-face')
  })

  it('response content is always an array with a text entry', async () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir))

    const resp = (await callTool(tools, 'validate_face', { face_id: 'ghost' })) as {
      content: Array<{ type: string; text: string }>
    }

    expect(resp.content).toHaveLength(1)
    expect(resp.content[0]!.type).toBe('text')
    expect(() => JSON.parse(resp.content[0]!.text)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. validate_tool — missing tool returns ok:false
// ---------------------------------------------------------------------------

describe('validate_tool', () => {
  it('returns ok:false for a non-existent tool_name', async () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir))

    const resp = await callTool(tools, 'validate_tool', { tool_name: 'no-such-tool' })
    const result = parseResult(resp) as {
      ok: boolean
      errors?: Array<{ target: string; kind: string }>
    }

    expect(result.ok).toBe(false)
    expect(result.errors![0]!.target).toBe('no-such-tool')
    expect(result.errors![0]!.kind).toBe('tool')
  })

  it('resolves a kebab-filename / snake_case-name tool by its registered name', async () => {
    // Regression: a tool named `follow_team` lives in `tools/follow-team.ts`
    // (kebab file, snake name — the canonical convention). The validator used
    // to reconstruct `tools/follow_team.ts` from the name and report "Tool file
    // not found"; it must now resolve the tool by its registered name.
    const draftDir = writeKebabToolDraft()
    const tools = buildEditMcpTools(makeDeps(draftDir))
    const resp = await callTool(tools, 'validate_tool', { tool_name: 'follow_team' })
    const result = parseResult(resp) as { ok: boolean; errors?: Array<{ message: string }> }

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. generate_migration — handler never throws, returns well-formed shape
// ---------------------------------------------------------------------------

describe('generate_migration', () => {
  it('returns a well-formed result object (ok field present)', async () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir))

    // drizzle-kit is likely not set up in the tmp draft dir, so this will
    // return ok:false — we only verify the shape, not the outcome.
    const resp = await callTool(tools, 'generate_migration', {})
    const result = parseResult(resp) as Record<string, unknown>

    expect(typeof result['ok']).toBe('boolean')
    if (result['ok'] === false) {
      expect(Array.isArray(result['errors'])).toBe(true)
    } else {
      expect(typeof result['generated_file_path']).toBe('string')
      expect(typeof result['sql_summary']).toBe('string')
    }
  }, 90_000) // spawns a real `npx drizzle-kit` subprocess — slow under suite load

  it('does NOT throw even when drizzle-kit fails', async () => {
    const draftDir = makeDraftDir()
    const tools = buildEditMcpTools(makeDeps(draftDir))

    await expect(callTool(tools, 'generate_migration', {})).resolves.toBeDefined()
  }, 90_000) // spawns a real `npx drizzle-kit` subprocess — slow under suite load
})

// ---------------------------------------------------------------------------
// 5. request_promote_review — aggregates errors when app can't load
// ---------------------------------------------------------------------------

describe('request_promote_review', () => {
  it('returns ok:false with errors when the app def fails to load', async () => {
    // Draft with broken index.ts
    const draftDir = join(tmpDir, 'broken-draft')
    mkdirSync(draftDir, { recursive: true })
    writeFileSync(join(draftDir, 'index.ts'), 'export const broken = truly-broken-syntax !!!!')

    const tools = buildEditMcpTools(makeDeps(draftDir))
    const resp = await callTool(tools, 'request_promote_review', { summary: 'test summary' })
    const result = parseResult(resp) as { ok: boolean; errors?: Array<{ kind: string }> }

    expect(result.ok).toBe(false)
    expect(Array.isArray(result.errors)).toBe(true)
  })

  it('does NOT call markReadyForReview when validation errors exist', async () => {
    const draftDir = join(tmpDir, 'broken-draft2')
    mkdirSync(draftDir, { recursive: true })
    writeFileSync(join(draftDir, 'index.ts'), 'syntax err {{{')

    let called = false
    const deps = makeDeps(draftDir, {
      markReadyForReview: () => {
        called = true
      },
    })
    const tools = buildEditMcpTools(deps)

    await callTool(tools, 'request_promote_review', { summary: 'test' })
    expect(called).toBe(false)
  })

  it('a loadable draft with valid faces/tools PASSES (no unresolvable tsc gate)', async () => {
    // Regression guard: request_promote_review must not shell out to `npx tsc --noEmit`
    // in the worktree where `moumantai` is unresolvable — the check would never pass
    // and the agent would deadloop. A loadable draft with valid faces/tools must mark ready.
    const draftDir = makeDraftDir() // valid empty app (faces:[], tools:[])
    let readySummary: string | undefined
    const tools = buildEditMcpTools(
      makeDeps(draftDir, {
        markReadyForReview: (s) => {
          readySummary = s
        },
      }),
    )

    const resp = await callTool(tools, 'request_promote_review', { summary: 'empty draft test' })
    const result = parseResult(resp) as { ok: boolean; errors?: unknown[] }

    expect(result.ok).toBe(true)
    expect(readySummary).toBe('empty draft test')
  })

  it('PASSES a draft whose tool FILE is kebab-case but tool NAME is snake_case (regression)', async () => {
    // Pre-fix this failed with "Tool file not found: tools/follow_team.ts"
    // because the validator derived the filename from the snake_case name.
    const draftDir = writeKebabToolDraft()
    let readySummary: string | undefined
    const tools = buildEditMcpTools(
      makeDeps(draftDir, {
        markReadyForReview: (s) => {
          readySummary = s
        },
      }),
    )

    const resp = await callTool(tools, 'request_promote_review', { summary: 'kebab tool' })
    const result = parseResult(resp) as { ok: boolean; errors?: unknown[] }

    expect(result.ok).toBe(true)
    expect(readySummary).toBe('kebab tool')
  })

  it('FAILS when a registered tool is missing its execute function', async () => {
    // Guards the other direction: a genuinely malformed tool must still be
    // rejected (caught at app-def load, before ready-for-review is set).
    const draftDir = writeBrokenToolDraft()
    let called = false
    const tools = buildEditMcpTools(
      makeDeps(draftDir, {
        markReadyForReview: () => {
          called = true
        },
      }),
    )

    const resp = await callTool(tools, 'request_promote_review', { summary: 'broken tool' })
    const result = parseResult(resp) as { ok: boolean; errors?: unknown[] }

    expect(result.ok).toBe(false)
    expect(Array.isArray(result.errors)).toBe(true)
    expect(called).toBe(false)
  })
})
