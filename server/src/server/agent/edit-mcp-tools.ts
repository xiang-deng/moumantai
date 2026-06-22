/**
 * Edit-agent custom MCP tools.
 *
 * Exports 5 tools used exclusively by the edit-agent session:
 *   validate_face          — fresh-load + component validation + column check
 *   validate_tool          — fresh-load + shape validation
 *   validate_types         — diff-scoped, fail-soft `tsc` over the draft
 *   generate_migration     — drizzle-kit generate + apply to shadow DB
 *   request_promote_review — run all validators (incl. typecheck), then signal ready
 *
 * Each handler returns a well-formed result and NEVER throws — failures are
 * wrapped in a ValidationResult or generate_migration error shape.
 */

import { tool as sdkTool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { pathToFileURL } from 'node:url'
import { join, resolve as resolvePath } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { enforceFaceValidation } from './face-validation.js'
import { reloadDraftDef } from './app-loader.js'
import { applyMigrations } from '../drafts/draft-db.js'
import { runDraftTypecheck } from '../drafts/draft-typecheck.js'
import type { ValidationError, ValidationResult } from '../drafts/types.js'
import type { AppDefinition, FaceDefinition, ToolDefinition } from './types.js'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface EditMcpToolsDeps {
  draftId: string
  draftDir: string // the draft worktree (cwd)
  shadowDbPath: string // <draftDir>/.shadow/db.sqlite
  markReadyForReview: (summary: string) => void
  // For validate_types (diff-scoped, fail-soft typecheck):
  liveSrcDir: string | null // live app source for the diff baseline; null for new-app
  home: string // Moumantai home (scratch tsconfig under <home>/tmp)
  repoRoot: string // holds apps/tsconfig.json + tsconfig.base.json
}

// ---------------------------------------------------------------------------
// SDK tool result wrapper
// ---------------------------------------------------------------------------

function okContent(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  }
}

function errContent(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: true as const,
  }
}

// ---------------------------------------------------------------------------
// Internal: find face file in the draft worktree
//
// Supports two layouts:
//   Flat:        faces/<face_id>.compact.ts  OR  faces/<face_id>.expanded.ts
//   Per-face:    faces/<face_id>/<face_id>.compact.ts (or .expanded.ts)
// ---------------------------------------------------------------------------

function findFaceFile(draftDir: string, faceId: string): string | undefined {
  const facesDir = join(draftDir, 'faces')
  if (!existsSync(facesDir)) return undefined

  // Flat layout candidates (prefer .compact over .expanded over bare)
  for (const suffix of ['.compact.ts', '.expanded.ts', '.ts']) {
    const flat = join(facesDir, `${faceId}${suffix}`)
    if (existsSync(flat)) return flat
  }

  // Per-face subdir candidates
  const subDir = join(facesDir, faceId)
  if (existsSync(subDir) && statSync(subDir).isDirectory()) {
    for (const suffix of ['.compact.ts', '.expanded.ts', '.ts']) {
      const sub = join(subDir, `${faceId}${suffix}`)
      if (existsSync(sub)) return sub
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Internal: cache-busted dynamic import
// ---------------------------------------------------------------------------

async function cacheBustImport(filePath: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(filePath).href + '?v=' + Date.now()
  return (await import(url)) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Internal: derive migrations folder from the draft's drizzle config or
// conventional location.
//
// ASSUMPTION: drizzle-kit is invoked via `npx drizzle-kit generate` in the
// draftDir cwd. Most Moumantai apps use the conventional out dir "drizzle/"
// next to drizzle.config.ts. If a drizzle.config.ts/js declares a different
// `out`, this reads it best-effort by scanning the config file for the `out`
// property string. Falls back to `<draftDir>/drizzle`.
// ---------------------------------------------------------------------------

function deriveMigrationsFolder(draftDir: string): string {
  const configPaths = [join(draftDir, 'drizzle.config.ts'), join(draftDir, 'drizzle.config.js')]
  for (const cfg of configPaths) {
    if (!existsSync(cfg)) continue
    try {
      const content = readFileSync(cfg, 'utf-8')
      const match = content.match(/\bout\s*:\s*['"]([^'"]+)['"]/m)
      if (match?.[1]) {
        return resolvePath(draftDir, match[1])
      }
    } catch {
      /* ignore */
    }
  }
  return join(draftDir, 'drizzle')
}

// ---------------------------------------------------------------------------
// Internal helpers reused by request_promote_review
// ---------------------------------------------------------------------------

async function validateFaceById(
  draftDir: string,
  shadowDbPath: string,
  faceId: string,
): Promise<ValidationResult> {
  const filePath = findFaceFile(draftDir, faceId)
  if (!filePath) {
    return {
      ok: false,
      errors: [
        {
          target: faceId,
          kind: 'face',
          message: `Face file not found for face_id "${faceId}" under ${draftDir}/faces/`,
        },
      ],
    }
  }

  // Fresh-load (cache-busted)
  let face: FaceDefinition
  try {
    const mod = await cacheBustImport(filePath)
    const defaultExport = mod['default']
    if (!defaultExport || typeof defaultExport !== 'object') {
      return {
        ok: false,
        errors: [
          {
            target: faceId,
            kind: 'face',
            message: `Module default export is not an object in ${filePath}`,
          },
        ],
      }
    }
    face = defaultExport as FaceDefinition
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          target: faceId,
          kind: 'face',
          message: `Failed to import face module: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }

  // Component validation via enforceFaceValidation (throws on errors)
  try {
    enforceFaceValidation(face, filePath)
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          target: faceId,
          kind: 'face',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }

  // Column check: open shadow DB readonly, call face.resolve({ db, params: {} })
  // inside try/catch — a "no such column" error becomes an actionable message.
  if (existsSync(shadowDbPath)) {
    let rawDb: Database.Database | undefined
    try {
      rawDb = new Database(shadowDbPath, { readonly: true })
      // Pass the existing better-sqlite3 instance as `client` (NOT `connection`,
      // which expects a path/config — drizzle then tries to reopen it and hits
      // better-sqlite3 v7's removed `memory` option, erroring out the column
      // check). `casing: 'snake_case'` matches boot-app/draft-db so column-name
      // mapping in face.resolve is correct.
      const db = drizzle({ client: rawDb, casing: 'snake_case' })
      try {
        face.resolve({ db, params: {} })
      } catch (resolveErr) {
        const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
        // Detect missing-column errors from SQLite / Drizzle
        const colMatch = msg.match(/no such column[:\s]+(\S+)/i)
        if (colMatch) {
          const col = colMatch[1] ?? 'unknown'
          return {
            ok: false,
            errors: [
              {
                target: faceId,
                kind: 'face',
                message: `Column '${col}' not found. Did you forget to update schema.ts and call generate_migration first?`,
              },
            ],
          }
        }
        // Other resolve errors are best-effort — don't block validation for
        // side-effecty or data-dependent resolvers.
      }
    } catch (dbErr) {
      // Shadow DB open failed — skip column check rather than hard-failing
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr)
      console.warn(
        `[edit-mcp-tools] validate_face shadow DB open failed (skipping column check): ${msg}`,
      )
    } finally {
      try {
        rawDb?.close()
      } catch {
        /* ignore */
      }
    }
  }

  return { ok: true }
}

/**
 * Shape-check a tool definition the app already registered.
 *
 * Validators work from the `ToolDefinition` objects the app exposes (loaded via
 * `index.ts` + the filename-agnostic supplemental scan), NEVER from a path
 * reconstructed off the tool name. Tool FILES are kebab-case (`follow-team.ts`)
 * while tool `name`s are snake_case (`follow_team`) — two deliberately separate
 * namespaces — so deriving the filename from the name produced spurious "Tool
 * file not found" failures that pushed authors to rename files to match. The
 * loaded object is the source of truth; the on-disk filename is irrelevant.
 */
function validateToolShape(toolName: string, toolDef: unknown): ValidationResult {
  if (!toolDef || typeof toolDef !== 'object') {
    return {
      ok: false,
      errors: [
        { target: toolName, kind: 'tool', message: `Tool "${toolName}" did not load as an object` },
      ],
    }
  }
  const def = toolDef as Partial<ToolDefinition>
  const errors: ValidationError[] = []
  if (typeof def.name !== 'string' || def.name.length === 0) {
    errors.push({
      target: toolName,
      kind: 'tool',
      message: 'Tool definition missing or empty "name" field',
    })
  }
  if (typeof def.execute !== 'function') {
    errors.push({
      target: toolName,
      kind: 'tool',
      message: 'Tool definition missing "execute" function',
    })
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function buildEditMcpTools(deps: EditMcpToolsDeps): unknown[] {
  const { draftId, draftDir, shadowDbPath, markReadyForReview, liveSrcDir, home, repoRoot } = deps

  // One bounded outcome line per tool call — the highest-value debug signal for
  // "is the edit-agent converging or looping on a failing validator?".
  const log = (s: string) => console.log(`[edit-mcp] draft=${draftId} ${s}`)

  // ---- validate_face -------------------------------------------------------

  const validateFaceTool = sdkTool(
    'validate_face',
    'Validate a face definition: fresh-load from disk, component graph check, and shadow-DB column check.',
    { face_id: z.string().describe('The face id to validate (e.g. "notes-list")') },
    async ({ face_id }: { face_id: string }) => {
      try {
        const result = await validateFaceById(draftDir, shadowDbPath, face_id)
        log(
          `validate_face face=${face_id} ok=${result.ok} errors=${result.ok ? 0 : result.errors.length}`,
        )
        return result.ok ? okContent(result) : errContent(result)
      } catch (err) {
        log(`validate_face face=${face_id} ok=false errors=1 (unexpected)`)
        const result: ValidationResult = {
          ok: false,
          errors: [
            {
              target: face_id,
              kind: 'face',
              message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
        return errContent(result)
      }
    },
  )

  // ---- validate_tool -------------------------------------------------------

  const validateToolTool = sdkTool(
    'validate_tool',
    'Validate a tool definition: load the app and shape-check the registered tool (name + execute function). Tools are resolved by their registered name, not by filename.',
    { tool_name: z.string().describe('The tool name to validate (e.g. "add_note")') },
    async ({ tool_name }: { tool_name: string }) => {
      try {
        let appDef: AppDefinition
        try {
          appDef = await reloadDraftDef(draftDir)
        } catch (err) {
          log(`validate_tool tool=${tool_name} ok=false errors=1 (app def load failed)`)
          return errContent({
            ok: false,
            errors: [
              {
                target: 'index.ts',
                kind: 'tool',
                message: `Failed to load app definition: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          } satisfies ValidationResult)
        }
        const toolDef = appDef.tools.find((t) => t.name === tool_name)
        if (!toolDef) {
          log(`validate_tool tool=${tool_name} ok=false errors=1 (not registered)`)
          return errContent({
            ok: false,
            errors: [
              {
                target: tool_name,
                kind: 'tool',
                message: `No tool named "${tool_name}" is registered. Import the tool file and add it to the tools: [...] array in index.ts.`,
              },
            ],
          } satisfies ValidationResult)
        }
        const result = validateToolShape(tool_name, toolDef)
        log(
          `validate_tool tool=${tool_name} ok=${result.ok} errors=${result.ok ? 0 : result.errors.length}`,
        )
        return result.ok ? okContent(result) : errContent(result)
      } catch (err) {
        log(`validate_tool tool=${tool_name} ok=false errors=1 (unexpected)`)
        const result: ValidationResult = {
          ok: false,
          errors: [
            {
              target: tool_name,
              kind: 'tool',
              message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
        return errContent(result)
      }
    },
  )

  // ---- generate_migration --------------------------------------------------
  //
  // Invokes `npx drizzle-kit generate` in draftDir (standard app layout).
  // stdio is piped so drizzle-kit >=0.21 rename prompts are captured as
  // errors rather than blocking. Timeout 60s; shell:true on Windows for npx.

  const generateMigrationTool = sdkTool(
    'generate_migration',
    'Run drizzle-kit generate against the draft schema and apply the result to the shadow DB.',
    {},
    async () => {
      type GenerateResult =
        | { ok: true; generated_file_path: string; sql_summary: string }
        | { ok: false; errors: ValidationError[] }

      const migrationsFolder = deriveMigrationsFolder(draftDir)

      // Step 1: run drizzle-kit generate
      let stdout = ''
      let stderr = ''
      try {
        const out = execFileSync('npx', ['drizzle-kit', 'generate'], {
          cwd: draftDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60_000,
          encoding: 'utf-8',
          shell: process.platform === 'win32',
        })
        stdout = typeof out === 'string' ? out : ''
      } catch (err) {
        // execFileSync throws on non-zero exit; capture output from the error
        const execErr = err as NodeJS.ErrnoException & {
          stdout?: string | Buffer
          stderr?: string | Buffer
          status?: number
        }
        stdout =
          typeof execErr.stdout === 'string'
            ? execErr.stdout
            : execErr.stdout instanceof Buffer
              ? execErr.stdout.toString()
              : ''
        stderr =
          typeof execErr.stderr === 'string'
            ? execErr.stderr
            : execErr.stderr instanceof Buffer
              ? execErr.stderr.toString()
              : ''
        const msg = `drizzle-kit generate failed (exit ${execErr.status ?? '?'}): ${stderr || execErr.message}`
        log('generate_migration ok=false (drizzle-kit generate failed)')
        const result: GenerateResult = {
          ok: false,
          errors: [{ target: 'schema.ts', kind: 'schema', message: msg }],
        }
        return errContent(result)
      }

      // Step 2: find the generated file (newest .sql in migrationsFolder)
      let generatedFilePath = ''
      try {
        if (existsSync(migrationsFolder)) {
          const sqlFiles = readdirSync(migrationsFolder)
            .filter((f) => f.endsWith('.sql'))
            .map((f) => join(migrationsFolder, f))
            .sort((a, b) => {
              try {
                return statSync(b).mtimeMs - statSync(a).mtimeMs
              } catch {
                return 0
              }
            })
          generatedFilePath = sqlFiles[0] ?? ''
        }
      } catch {
        /* best-effort */
      }

      // Step 3: apply migrations to shadow DB
      try {
        applyMigrations(shadowDbPath, migrationsFolder)
      } catch (err) {
        const msg = `Migration apply to shadow DB failed: ${err instanceof Error ? err.message : String(err)}`
        log('generate_migration ok=false (apply to shadow DB failed)')
        const result: GenerateResult = {
          ok: false,
          errors: [{ target: 'schema.ts', kind: 'schema', message: msg }],
        }
        return errContent(result)
      }

      // Build a short SQL summary from drizzle-kit stdout
      const combined = (stdout + '\n' + stderr).trim()
      const sqlSummary =
        combined
          .split('\n')
          .filter((l) => /CREATE|ALTER|DROP|generated/i.test(l))
          .slice(0, 8)
          .join(' | ')
          .trim() || 'migration generated and applied'

      log(`generate_migration ok=true file=${generatedFilePath || '(none)'}`)
      const result: GenerateResult = {
        ok: true,
        generated_file_path: generatedFilePath,
        sql_summary: sqlSummary,
      }
      return okContent(result)
    },
  )

  // ---- validate_types ------------------------------------------------------

  const validateTypesTool = sdkTool(
    'validate_types',
    'Typecheck the draft with tsc, scoped to the files you changed (pre-existing errors elsewhere do not block). Returns ValidationResult; type errors must be fixed before promote. Fail-soft: skips with a note if the toolchain is unavailable.',
    {},
    async () => {
      try {
        const res = runDraftTypecheck({ draftId, draftDir, liveSrcDir, home, repoRoot })
        if (res.skipped) {
          log(`validate_types skipped (${res.skipped})`)
          return okContent({ ok: true, note: `typecheck skipped: ${res.skipped}` })
        }
        log(`validate_types ok=${res.ok} errors=${res.ok ? 0 : res.errors.length}`)
        return res.ok
          ? okContent({ ok: true } satisfies ValidationResult)
          : errContent({ ok: false, errors: res.errors } satisfies ValidationResult)
      } catch (err) {
        log('validate_types ok=false errors=1 (unexpected)')
        return errContent({
          ok: false,
          errors: [
            {
              target: 'typecheck',
              kind: 'typecheck',
              message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        } satisfies ValidationResult)
      }
    },
  )

  // ---- request_promote_review ----------------------------------------------

  const requestPromoteReviewTool = sdkTool(
    'request_promote_review',
    'Validate the draft (loads the app, validates every face + tool, and runs a diff-scoped typecheck). If all pass, mark the draft ready for review. Returns ValidationResult.',
    { summary: z.string().describe('One-paragraph summary of what was built / changed') },
    async ({ summary }: { summary: string }) => {
      const allErrors: ValidationError[] = []

      // --- Load the app def to enumerate faces + tools ---
      //
      // This load surfaces import/compile errors that break module evaluation.
      // Static type errors that don't break evaluation (wrong enum, undefined
      // handling) are caught by the diff-scoped `validate_types` step below —
      // which resolves `moumantai` via a generated tsconfig (see draft-typecheck),
      // the proper fix for the earlier "tsc can't resolve the SDK" deadloop.
      let appFaceIds: string[] = []
      let appToolDefs: ToolDefinition[] = []

      try {
        const appDef = await reloadDraftDef(draftDir)
        appFaceIds = appDef.faces.map((f) => f.id)
        appToolDefs = appDef.tools
      } catch (err) {
        // If the app def won't even load, there is nothing to enumerate —
        // return the load error immediately.
        log('request_promote_review ok=false (app def failed to load)')
        return errContent({
          ok: false,
          errors: [
            {
              target: 'index.ts',
              kind: 'typecheck',
              message: `Failed to load app definition: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        } satisfies ValidationResult)
      }

      // --- Validate each face (fresh import + component graph + column check) ---
      for (const faceId of appFaceIds) {
        const res = await validateFaceById(draftDir, shadowDbPath, faceId)
        if (!res.ok) allErrors.push(...res.errors)
      }

      // --- Validate each tool's shape on the loaded definition ---
      // The app already imported every tool via index.ts, so validate those
      // objects directly — never reconstruct a path from the tool name.
      for (const toolDef of appToolDefs) {
        const res = validateToolShape(toolDef.name, toolDef)
        if (!res.ok) allErrors.push(...res.errors)
      }

      // --- Diff-scoped typecheck (fail-soft; final static gate) ---
      const tc = runDraftTypecheck({ draftId, draftDir, liveSrcDir, home, repoRoot })
      if (tc.skipped) log(`request_promote_review typecheck skipped (${tc.skipped})`)
      else if (!tc.ok) allErrors.push(...tc.errors)

      if (allErrors.length > 0) {
        log(
          `request_promote_review ok=false errors=${allErrors.length} (faces=${appFaceIds.length} tools=${appToolDefs.length})`,
        )
        const result: ValidationResult = { ok: false, errors: allErrors }
        return errContent(result)
      }

      // All passed — signal ready for review
      log(`request_promote_review ok=true (faces=${appFaceIds.length} tools=${appToolDefs.length})`)
      markReadyForReview(summary)
      const result: ValidationResult = { ok: true }
      return okContent(result)
    },
  )

  return [
    validateFaceTool,
    validateToolTool,
    validateTypesTool,
    generateMigrationTool,
    requestPromoteReviewTool,
  ]
}
