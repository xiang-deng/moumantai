import { SizeClass } from '@moumantai/protocol/generated/moumantai/v1'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  discoverApps,
  validateAppDef,
  loadApps,
  scanSupplementalTools,
  scanSupplementalFaces,
  parseFaceFile,
  reloadAppBundled,
} from '../../../src/server/agent/app-loader.js'

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'app-loader-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeAppDir(name: string, content: string): void {
  const dir = join(tmpDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.ts'), content)
}

// ---------------------------------------------------------------------------
// Minimal valid AppDefinition for validation tests
// ---------------------------------------------------------------------------

function minimalDef(overrides: Record<string, unknown> = {}) {
  return {
    manifest: { id: 'test-app', name: 'Test', icon: 'star', description: 'A test app' },
    tools: [],
    faces: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// discoverApps
// ---------------------------------------------------------------------------

describe('discoverApps', () => {
  it('finds apps with index.ts in subdirectories', () => {
    makeAppDir('alpha', 'export default {}')
    makeAppDir('beta', 'export default {}')

    const entries = discoverApps([tmpDir], '/')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toContain('alpha')
    expect(entries[1]).toContain('beta')
  })

  it('returns sorted paths', () => {
    makeAppDir('zulu', 'export default {}')
    makeAppDir('alpha', 'export default {}')

    const entries = discoverApps([tmpDir], '/')
    expect(entries[0]).toContain('alpha')
    expect(entries[1]).toContain('zulu')
  })

  it('warns and skips missing directories', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = discoverApps(['/nonexistent/path'], '/')
    expect(entries).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not found'))
    warnSpy.mockRestore()
  })

  it('returns empty for directory with no subdirectories', () => {
    // tmpDir exists but has no subdirectories
    const entries = discoverApps([tmpDir], '/')
    expect(entries).toHaveLength(0)
  })

  it('skips subdirectories without index.ts or index.js', () => {
    const dir = join(tmpDir, 'no-entry')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'something.ts'), 'export default {}')

    const entries = discoverApps([tmpDir], '/')
    expect(entries).toHaveLength(0)
  })

  it('resolves relative paths against serverDir', () => {
    makeAppDir('myapp', 'export default {}')
    const entries = discoverApps(['.'], tmpDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain('myapp')
  })
})

// ---------------------------------------------------------------------------
// validateAppDef
// ---------------------------------------------------------------------------

describe('validateAppDef', () => {
  it('accepts a valid minimal definition', () => {
    const def = minimalDef()
    const result = validateAppDef(def, 'test.ts')
    expect(result.manifest.id).toBe('test-app')
    expect(result.tools).toEqual([])
    expect(result.faces).toEqual([])
  })

  it('rejects non-object export', () => {
    expect(() => validateAppDef(null, 'x.ts')).toThrow('not an object')
    expect(() => validateAppDef('string', 'x.ts')).toThrow('not an object')
  })

  it('rejects missing manifest', () => {
    expect(() => validateAppDef({ tools: [], faces: [] }, 'x.ts')).toThrow('manifest')
  })

  it('rejects manifest with missing fields', () => {
    expect(() =>
      validateAppDef(
        {
          manifest: { id: 'a' },
          tools: [],
          faces: [],
        },
        'x.ts',
      ),
    ).toThrow('manifest.name')
  })

  it('rejects reserved "home" id', () => {
    expect(() =>
      validateAppDef(
        minimalDef({
          manifest: { id: 'home', name: 'Home', icon: 'h', description: 'd' },
        }),
        'x.ts',
      ),
    ).toThrow('reserved')
  })

  it('rejects invalid id format', () => {
    expect(() =>
      validateAppDef(
        minimalDef({
          manifest: { id: 'Bad_Id', name: 'X', icon: 'x', description: 'd' },
        }),
        'x.ts',
      ),
    ).toThrow('must match')
  })

  it('rejects missing tools array', () => {
    expect(() =>
      validateAppDef(
        {
          manifest: { id: 'a', name: 'A', icon: 'a', description: 'd' },
          faces: [],
        },
        'x.ts',
      ),
    ).toThrow('tools')
  })

  it('rejects tools without execute function', () => {
    expect(() =>
      validateAppDef(
        minimalDef({
          tools: [{ name: 'foo' }],
        }),
        'x.ts',
      ),
    ).toThrow('tools[0].execute')
  })

  it('rejects missing faces array', () => {
    expect(() =>
      validateAppDef(
        {
          manifest: { id: 'a', name: 'A', icon: 'a', description: 'd' },
          tools: [],
        },
        'x.ts',
      ),
    ).toThrow('faces')
  })

  it('accepts optional schema and skill', () => {
    const def = minimalDef({
      schema: { expenses: {} },
      skill: 'You track expenses',
    })
    const result = validateAppDef(def, 'x.ts')
    expect(result.skill).toBe('You track expenses')
  })
})

// ---------------------------------------------------------------------------
// loadApps (end-to-end with temp fixture)
// ---------------------------------------------------------------------------

describe('loadApps', () => {
  it('loads a valid app from a fixture directory', async () => {
    makeAppDir(
      'good-app',
      `
      export function createAppDef() {
        return {
          manifest: { id: 'good-app', name: 'Good', icon: 'check', description: 'A good app' },
          tools: [{ name: 'do_thing', description: 'does', parameters: {}, execute: async () => ({ result: 'ok' }) }],
          faces: [{ id: 'main', label: 'Main', position: 0, components: [], resolve: () => ({}) }],
        }
      }
    `,
    )

    const { loaded, errors } = await loadApps([tmpDir], '/')
    expect(errors).toHaveLength(0)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].manifest.id).toBe('good-app')
    expect(loaded[0].tools).toHaveLength(1)
  })

  it('collects errors for invalid apps without crashing', async () => {
    makeAppDir('bad-app', 'export default { notAnApp: true }')

    const { loaded, errors } = await loadApps([tmpDir], '/')
    expect(loaded).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toContain('bad-app')
  })

  it('detects duplicate manifest IDs', async () => {
    makeAppDir(
      'app-a',
      `
      export function createAppDef() {
        return {
          manifest: { id: 'dupe', name: 'A', icon: 'a', description: 'First' },
          tools: [], faces: [],
        }
      }
    `,
    )
    makeAppDir(
      'app-b',
      `
      export function createAppDef() {
        return {
          manifest: { id: 'dupe', name: 'B', icon: 'b', description: 'Second' },
          tools: [], faces: [],
        }
      }
    `,
    )

    const { loaded, errors } = await loadApps([tmpDir], '/')
    expect(loaded).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0].error.message).toContain('Duplicate')
  })

  it('returns empty for missing directory', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loaded, errors } = await loadApps(['/nonexistent'], '/')
    expect(loaded).toHaveLength(0)
    expect(errors).toHaveLength(0)
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// scanSupplementalTools
// ---------------------------------------------------------------------------

describe('scanSupplementalTools', () => {
  it('discovers .ts files and imports them', async () => {
    const dir = join(tmpDir, 'tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'hello.ts'),
      `
      export default {
        name: 'hello',
        description: 'Say hi',
        parameters: {},
        execute: async () => ({ result: 'hi' }),
      }
    `,
    )

    const tools = await scanSupplementalTools(dir, new Set())
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('hello')
  })

  it('skips tools already in exclude set', async () => {
    const dir = join(tmpDir, 'tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'existing.ts'),
      `
      export default {
        name: 'existing',
        description: 'Already registered',
        parameters: {},
        execute: async () => ({ result: 'ok' }),
      }
    `,
    )

    const tools = await scanSupplementalTools(dir, new Set(['existing']))
    expect(tools).toHaveLength(0)
  })

  it('returns empty for missing directory', async () => {
    const tools = await scanSupplementalTools(join(tmpDir, 'nope'), new Set())
    expect(tools).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// scanSupplementalFaces
// ---------------------------------------------------------------------------

describe('scanSupplementalFaces', () => {
  it('discovers face files and imports them', async () => {
    const dir = join(tmpDir, 'faces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'stats.compact.ts'),
      `
      export default {
        id: 'stats',
        label: 'Stats',
        position: 0,
        components: [],
        resolve: () => ({ count: 42 }),
      }
    `,
    )

    const faces = await scanSupplementalFaces(dir, new Set())
    expect(faces).toHaveLength(1)
    expect(faces[0].face.id).toBe('stats')
    expect(faces[0].sizeClass).toBe(SizeClass.COMPACT)
  })

  it('preserves variant-suffixed faces even when the face id is already registered', async () => {
    // Regression: variant files (.compact.ts/.expanded.ts → sizeClass set) must always be
    // scanned; only unsuffixed files respect the exclude set. Without this, the expanded
    // variant would be silently dropped when the compact one is already registered.
    const dir = join(tmpDir, 'faces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'existing.compact.ts'),
      `
      export default { id: 'existing', label: 'X', position: 0, components: [], resolve: () => ({}) }
    `,
    )
    writeFileSync(
      join(dir, 'existing.expanded.ts'),
      `
      export default { id: 'existing', label: 'X', position: 0, components: [], resolve: () => ({}) }
    `,
    )

    const faces = await scanSupplementalFaces(dir, new Set(['existing']))
    expect(faces).toHaveLength(2)
    const kinds = faces.map((f) => f.sizeClass).sort()
    expect(kinds).toEqual([SizeClass.COMPACT, SizeClass.EXPANDED])
  })

  it('recurses one level into per-face subdirectories', async () => {
    const facesDir = join(tmpDir, 'faces')
    const todayDir = join(facesDir, 'today')
    mkdirSync(todayDir, { recursive: true })
    // compact variant in subdir
    writeFileSync(
      join(todayDir, 'today.compact.ts'),
      `
      export default { id: 'today', label: 'Today', position: 0, components: [], resolve: () => ({ ok: true }) }
    `,
    )
    // expanded variant in same subdir
    writeFileSync(
      join(todayDir, 'today.expanded.ts'),
      `
      export default { id: 'today', label: 'Today', position: 0, components: [], resolve: () => ({ ok: true }) }
    `,
    )
    // helper file — must be skipped
    writeFileSync(join(todayDir, 'today.resolve.ts'), `export const resolve = () => ({})`)

    const faces = await scanSupplementalFaces(facesDir, new Set())
    expect(faces).toHaveLength(2)
    const kinds = faces
      .map((f) => ({ id: f.face.id, sc: f.sizeClass }))
      .sort((a, b) => String(a.sc).localeCompare(String(b.sc)))
    expect(kinds).toEqual([
      { id: 'today', sc: SizeClass.COMPACT },
      { id: 'today', sc: SizeClass.EXPANDED },
    ])
  })

  it('loads flat and subdir faces in the same directory', async () => {
    const facesDir = join(tmpDir, 'faces')
    mkdirSync(facesDir, { recursive: true })
    // flat face (compact variant)
    writeFileSync(
      join(facesDir, 'flat.compact.ts'),
      `
      export default { id: 'flat', label: 'Flat', position: 0, components: [], resolve: () => ({}) }
    `,
    )
    // subdir face (expanded variant)
    const subDir = join(facesDir, 'sub')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'sub.expanded.ts'),
      `
      export default { id: 'sub', label: 'Sub', position: 1, components: [], resolve: () => ({}) }
    `,
    )

    const faces = await scanSupplementalFaces(facesDir, new Set())
    const ids = faces.map((f) => f.face.id).sort()
    expect(ids).toEqual(['flat', 'sub'])
  })
})

describe('parseFaceFile', () => {
  it('returns null for plain .ts files without explicit suffix', () => {
    expect(parseFaceFile('summary.ts')).toBeNull()
  })

  it('parses variant face file', () => {
    expect(parseFaceFile('summary.expanded.ts')).toEqual({
      faceId: 'summary',
      sizeClass: SizeClass.EXPANDED,
    })
    expect(parseFaceFile('summary.compact.ts')).toEqual({
      faceId: 'summary',
      sizeClass: SizeClass.COMPACT,
    })
  })

  it('returns null for unrecognized suffixes like .medium.ts', () => {
    expect(parseFaceFile('summary.medium.ts')).toBeNull()
  })

  it('skips resolve and parts helper files', () => {
    expect(parseFaceFile('summary.resolve.ts')).toBeNull()
    expect(parseFaceFile('summary.parts.ts')).toBeNull()
  })

  it('skips non-ts files', () => {
    expect(parseFaceFile('summary.js')).toBeNull()
    expect(parseFaceFile('readme.md')).toBeNull()
  })

  it('returns null for .ts files without a recognized size-class suffix', () => {
    expect(parseFaceFile('summary.ts')).toBeNull()
    expect(parseFaceFile('.dotfile-summary.ts')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// reloadAppBundled — full-graph reload for preview/promote
//
// The contract reloadAppModule cannot meet: an edit to a NON-entry module is
// reflected after reload (it bundles the whole graph, so children aren't served
// from the stale ESM cache). Also: import.meta.url stays pinned to the real
// entry, so the app's __dirname/migrationsFolder logic survives bundling.
// ---------------------------------------------------------------------------

describe('reloadAppBundled', () => {
  // Dependency-free app: face id is sourced from a CHILD module so a child edit
  // is observable. Uses import.meta.url for migrationsFolder, like real apps.
  function writeApp(dir: string, faceId: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'child.ts'), `export const FACE_ID = ${JSON.stringify(faceId)}\n`)
    writeFileSync(
      join(dir, 'index.ts'),
      `
      import { FACE_ID } from './child.js'
      import { fileURLToPath } from 'url'
      import { resolve } from 'path'
      const dir = fileURLToPath(new URL('.', import.meta.url))
      export function createTestDef() {
        return {
          manifest: { id: 'bundle-test', name: 'B', icon: 'star', description: 'd' },
          migrationsFolder: resolve(dir, 'drizzle'),
          tools: [],
          faces: [{ id: FACE_ID, resolve: () => ({}) }],
        }
      }
    `,
    )
  }

  it('reflects an edit to a non-entry module on reload, and pins import.meta.url to the entry', async () => {
    const appDir = join(tmpDir, 'app')
    const scratch = join(appDir, '.shadow')
    writeApp(appDir, 'face-v1')

    const first = await reloadAppBundled(join(appDir, 'index.ts'), scratch)
    expect(first.faces[0].id).toBe('face-v1')
    // import.meta.url pinned to the entry dir → migrationsFolder is <appDir>/drizzle,
    // NOT under the scratch dir the bundle was actually imported from.
    expect(first.migrationsFolder).toBe(join(appDir, 'drizzle'))

    // Edit ONLY the child module — the exact case reloadAppModule misses.
    writeFileSync(join(appDir, 'child.ts'), `export const FACE_ID = "face-v2"\n`)
    const second = await reloadAppBundled(join(appDir, 'index.ts'), scratch)
    expect(second.faces[0].id).toBe('face-v2')
  })
})
