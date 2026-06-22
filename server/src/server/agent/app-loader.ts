/**
 * Dynamic app plugin loader.
 *
 * Discovers, loads, and validates AppDefinition plugins from
 * configurable directories. Each subdirectory with an index.ts/js
 * entry point is treated as a plugin app.
 */

import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve, join, isAbsolute } from 'path'
import { pathToFileURL } from 'url'
import { createRequire, isBuiltin } from 'module'
import { build, type Plugin } from 'esbuild'
import type { AppDefinition, ToolDefinition, FaceDefinition } from './types.js'
import type { FaceRegistry } from './face-loader.js'
import { SizeClass } from '@moumantai/protocol/generated/moumantai/v1'

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan `appDirs` for subdirectories containing an index.ts or index.js,
 * resolved relative to `serverDir`. Missing directories are skipped with a
 * warning. Returns a sorted list of absolute entry paths.
 */
export function discoverApps(appDirs: string[], serverDir: string): string[] {
  const entries: string[] = []

  for (const dir of appDirs) {
    const absDir = resolve(serverDir, dir)
    if (!existsSync(absDir)) {
      console.warn(`[app-loader] Directory not found, skipping: ${absDir}`)
      continue
    }

    let children: string[]
    try {
      children = readdirSync(absDir)
    } catch {
      console.warn(`[app-loader] Cannot read directory, skipping: ${absDir}`)
      continue
    }

    for (const child of children) {
      const childPath = join(absDir, child)
      try {
        if (!statSync(childPath).isDirectory()) continue
      } catch {
        continue
      }
      // Look for index.ts or index.js
      for (const ext of ['index.ts', 'index.js']) {
        const entry = join(childPath, ext)
        if (existsSync(entry)) {
          entries.push(entry)
          break
        }
      }
    }
  }

  return entries.sort()
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Extract an AppDefinition from an imported module namespace.
 * Supports: default export (object or factory fn), named create*Def factory,
 * named createAppDef, or the module namespace as-is.
 */
function resolveModuleExport(mod: Record<string, unknown>): unknown {
  // 1. Prefer default export (object or factory)
  if (mod.default != null) {
    return typeof mod.default === 'function' ? (mod.default as () => unknown)() : mod.default
  }

  // 2. Look for any named export that is a factory function (create*Def pattern)
  for (const key of Object.keys(mod)) {
    if (typeof mod[key] === 'function' && /^create.+Def$/i.test(key)) {
      return (mod[key] as () => unknown)()
    }
  }

  // 3. Look for a named createAppDef
  if (typeof mod.createAppDef === 'function') {
    return (mod.createAppDef as () => unknown)()
  }

  // 4. Return the module namespace as-is
  return mod
}

/**
 * Dynamically import an app module and extract its AppDefinition.
 * On Windows, absolute paths need file:// URLs for Node's ESM loader.
 */
export async function loadAppModule(entryPath: string): Promise<unknown> {
  const mod = await import(pathToFileURL(entryPath).href)
  return resolveModuleExport(mod)
}

/**
 * Like `loadAppModule` but appends `?v=<t>` to bust the ESM cache for the
 * entry only. Transitive imports stay cached — edits to `parts.ts`,
 * `resolve.ts`, `schema.ts` are not picked up. Use `reloadAppBundled` when
 * the whole app graph must reflect on-disk changes.
 */
export async function reloadAppModule(entryPath: string): Promise<unknown> {
  const mod = await import(pathToFileURL(entryPath).href + `?v=${Date.now()}`)
  return resolveModuleExport(mod)
}

/** Find the index.ts or index.js entry file in an app directory. */
export function findEntryFile(appDir: string): string | undefined {
  for (const name of ['index.ts', 'index.js']) {
    const entry = join(appDir, name)
    if (existsSync(entry)) return entry
  }
  return undefined
}

/**
 * Reload a single app from its directory (cache-busting).
 * Returns the validated AppDefinition.
 */
export async function reloadSingleApp(appDir: string): Promise<AppDefinition> {
  const entry = findEntryFile(appDir)
  if (!entry) {
    throw new Error(`No index.ts or index.js found in ${appDir}`)
  }
  const raw = await reloadAppModule(entry)
  return validateAppDef(raw, entry)
}

/**
 * esbuild plugin: bundle the app's OWN files (relative + absolute paths), but
 * leave every package/builtin import EXTERNAL — resolved to an ABSOLUTE path so
 * the emitted bundle resolves them no matter where the scratch file is written.
 * `moumantai`, `drizzle-orm`, `better-sqlite3`, … stay as real runtime imports
 * (and hit the already-loaded module cache), so the bundle only re-evaluates
 * the app's own graph.
 */
function externalizeDepsToAbsolute(entryPath: string): Plugin {
  const req = createRequire(entryPath)
  return {
    name: 'externalize-deps-to-absolute',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return null
        if (args.path.startsWith('.') || isAbsolute(args.path)) return null // bundle app file
        // Node builtins (bare `path`/`url`/… or `node:`-prefixed) stay BARE —
        // never run them through req.resolve (which yields a bogus file path).
        if (args.path.startsWith('node:') || isBuiltin(args.path)) {
          return { path: args.path, external: true }
        }
        try {
          return { path: pathToFileURL(req.resolve(args.path)).href, external: true }
        } catch {
          return { path: args.path, external: true } // let Node resolve at import time
        }
      })
    },
  }
}

/**
 * Reload an app by re-evaluating its entire module graph from disk, bypassing
 * the ESM cache. Used where edits to non-entry files (`resolve.ts`, `parts.ts`,
 * `schema.ts`, …) must take effect — `reloadAppModule` can't guarantee this.
 *
 * esbuild bundles the app's own files into one module (no separately-cached
 * children), with `import.meta.url` pinned to the real entry. The scratch file
 * is unique per call and removed after import.
 *
 * `scratchDir` must NOT be watched by the hot-reload watcher — writing into a
 * live appDir would trigger a reload cascade.
 */
export async function reloadAppBundled(
  entryPath: string,
  scratchDir: string,
): Promise<AppDefinition> {
  const mod = await bundleAndImport(entryPath, scratchDir)
  return validateAppDef(resolveModuleExport(mod), entryPath)
}

/**
 * Bundle a single module's own graph and import it, returning the namespace.
 * Unlike a `?t=` import (which serves transitive imports from the stale ESM
 * cache), this inlines relative imports so edits to `resolve.ts`/`parts.ts`
 * are reflected. `import.meta.url` is pinned to the real file; package deps
 * stay external. Scratch must be in an un-watched directory.
 */
export async function bundleAndImport(
  filePath: string,
  scratchDir: string,
): Promise<Record<string, unknown>> {
  const result = await build({
    entryPoints: [filePath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    sourcemap: 'inline',
    logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(filePath).href) },
    plugins: [externalizeDepsToAbsolute(filePath)],
  })
  const code = result.outputFiles[0]?.text ?? ''
  mkdirSync(scratchDir, { recursive: true })
  const scratch = join(
    scratchDir,
    `.mmt-reload-${process.pid}-${Date.now()}-${bundleCounter++}.mjs`,
  )
  writeFileSync(scratch, code)
  try {
    return (await import(pathToFileURL(scratch).href)) as Record<string, unknown>
  } finally {
    try {
      rmSync(scratch, { force: true })
    } catch {
      /* best-effort */
    }
  }
}
let bundleCounter = 0

/** Convenience: bundle-reload a draft. Scratch goes in the draft's (un-watched,
 *  promote-excluded) `.shadow/` dir so a stray scratch can never leak into a
 *  promote. Throws the friendly pre-scaffold error when there's no entry yet. */
export async function reloadDraftDef(draftDir: string): Promise<AppDefinition> {
  const entry = findEntryFile(draftDir)
  if (!entry) {
    throw new Error(`No index.ts or index.js found in ${draftDir}`)
  }
  return reloadAppBundled(entry, join(draftDir, '.shadow'))
}

/** Module loader used by the supplemental scan. Default re-imports with a
 *  `?t=` cache-bust (live hot-reload — entry-only freshness). Drafts inject a
 *  `bundleAndImport`-based loader so edited variant CHILDREN are fresh too. */
export type ModuleLoader = (filePath: string) => Promise<Record<string, unknown>>

/** A draft loader: bundle each scanned file into the draft's `.shadow/`. */
export function draftBundleLoader(draftDir: string): ModuleLoader {
  return (filePath) => bundleAndImport(filePath, join(draftDir, '.shadow'))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const APP_ID_RE = /^[a-z][a-z0-9-]*$/

/**
 * Duck-type validate a loaded module as an AppDefinition. Throws on failure.
 *
 * Component-graph validation is NOT done here — it runs at FaceRegistry
 * registration time, which is the choke point for all registration paths
 * (static load, hot-reload, draft edits).
 */
export function validateAppDef(raw: unknown, sourcePath: string): AppDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[${sourcePath}] Export is not an object`)
  }
  const obj = raw as Record<string, unknown>

  // manifest
  if (!obj.manifest || typeof obj.manifest !== 'object') {
    throw new Error(`[${sourcePath}] Missing or invalid 'manifest'`)
  }
  const m = obj.manifest as Record<string, unknown>
  for (const field of ['id', 'name', 'icon', 'description']) {
    if (typeof m[field] !== 'string' || !(m[field] as string).length) {
      throw new Error(`[${sourcePath}] manifest.${field} must be a non-empty string`)
    }
  }
  if (!APP_ID_RE.test(m.id as string)) {
    throw new Error(`[${sourcePath}] manifest.id "${m.id}" must match ${APP_ID_RE}`)
  }
  if (m.id === 'home') {
    throw new Error(`[${sourcePath}] manifest.id "home" is reserved`)
  }

  // tools
  if (!Array.isArray(obj.tools)) {
    throw new Error(`[${sourcePath}] 'tools' must be an array`)
  }
  for (let i = 0; i < obj.tools.length; i++) {
    const tool = obj.tools[i]
    if (typeof tool?.name !== 'string') {
      throw new Error(`[${sourcePath}] tools[${i}].name must be a string`)
    }
    if (typeof tool?.execute !== 'function') {
      throw new Error(`[${sourcePath}] tools[${i}].execute must be a function`)
    }
  }

  // faces
  if (!Array.isArray(obj.faces)) {
    throw new Error(`[${sourcePath}] 'faces' must be an array`)
  }
  for (let i = 0; i < obj.faces.length; i++) {
    const face = obj.faces[i]
    if (typeof face?.id !== 'string') {
      throw new Error(`[${sourcePath}] faces[${i}].id must be a string`)
    }
    if (typeof face?.resolve !== 'function') {
      throw new Error(`[${sourcePath}] faces[${i}].resolve must be a function`)
    }
  }

  // Optional fields
  if (obj.schema !== undefined && (typeof obj.schema !== 'object' || obj.schema === null)) {
    throw new Error(`[${sourcePath}] 'schema' must be an object if present`)
  }
  if (obj.skill !== undefined && typeof obj.skill !== 'string') {
    throw new Error(`[${sourcePath}] 'skill' must be a string if present`)
  }

  return raw as AppDefinition
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadAppsResult {
  loaded: AppDefinition[]
  errors: Array<{ path: string; error: Error }>
}

/**
 * Discover, load, and validate plugin apps from the given directories.
 * Per-app errors are non-fatal — they're collected in `errors`.
 * Duplicate manifest IDs are treated as errors (second one wins nothing).
 */
export async function loadApps(appDirs: string[], serverDir: string): Promise<LoadAppsResult> {
  const entries = discoverApps(appDirs, serverDir)
  const loaded: AppDefinition[] = []
  const errors: Array<{ path: string; error: Error }> = []
  const seenIds = new Set<string>()

  for (const entryPath of entries) {
    try {
      const raw = await loadAppModule(entryPath)
      const appDef = validateAppDef(raw, entryPath)

      if (seenIds.has(appDef.manifest.id)) {
        throw new Error(`Duplicate manifest.id "${appDef.manifest.id}"`)
      }
      seenIds.add(appDef.manifest.id)
      loaded.push(appDef)
    } catch (err) {
      errors.push({ path: entryPath, error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  return { loaded, errors }
}

// ---------------------------------------------------------------------------
// Supplemental scan (promoted files added on disk since boot)
// ---------------------------------------------------------------------------

/**
 * Scan an app dir's `tools/` and `faces/` for files not returned by `index.ts`,
 * and register them onto a booted app's registries. This is how size variants
 * are registered: `*.expanded.ts` files are discovered here and added via
 * `registerVariant` so phone clients get the expanded layout.
 *
 * Shared by the live boot path and the draft boot path so PREVIEW registers
 * the same variant set as LIVE.
 */
export async function applySupplementalScan(opts: {
  appDir: string
  toolRegistry: Map<string, ToolDefinition>
  faceRegistry: FaceRegistry
  source: string
  /** Override how each scanned file is loaded (drafts bundle for child-freshness). */
  load?: ModuleLoader
}): Promise<void> {
  const { appDir, toolRegistry, faceRegistry, source, load } = opts
  const existingToolNames = new Set(toolRegistry.keys())
  for (const tool of await scanSupplementalTools(join(appDir, 'tools'), existingToolNames, load)) {
    toolRegistry.set(tool.name, tool)
  }
  const existingFaceIds = new Set(faceRegistry.list().map((f) => f.id))
  for (const { face, sizeClass } of await scanSupplementalFaces(
    join(appDir, 'faces'),
    existingFaceIds,
    load,
  )) {
    if (sizeClass) faceRegistry.registerVariant(face.id, sizeClass, face, { source })
    else faceRegistry.register(face, { source })
  }
}

/** Default supplemental-scan loader: re-import with a `?t=` cache-bust. */
const defaultScanLoader: ModuleLoader = (filePath) =>
  import(pathToFileURL(filePath).href + `?t=${Date.now()}`) as Promise<Record<string, unknown>>

/**
 * Scan a tools/ directory for .ts files not already registered.
 * Each file must `export default` a ToolDefinition.
 */
export async function scanSupplementalTools(
  toolsDir: string,
  exclude: Set<string>,
  load: ModuleLoader = defaultScanLoader,
): Promise<ToolDefinition[]> {
  if (!existsSync(toolsDir)) return []
  const tools: ToolDefinition[] = []

  let files: string[]
  try {
    files = readdirSync(toolsDir)
  } catch {
    return []
  }

  for (const name of files) {
    if (!name.endsWith('.ts')) continue
    const filePath = join(toolsDir, name)
    try {
      if (!statSync(filePath).isFile()) continue
      const mod = await load(filePath)
      const toolDef = mod.default as ToolDefinition
      if (toolDef?.name && typeof toolDef.execute === 'function' && !exclude.has(toolDef.name)) {
        tools.push(toolDef)
      }
    } catch (err) {
      console.warn(
        `[app-loader] Failed to load supplemental tool ${filePath}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return tools
}

/** Result of scanning face files — includes variant info. */
export interface ScannedFace {
  face: FaceDefinition
  sizeClass?: SizeClass // undefined = default, otherwise the variant's sizeClass
}

/**
 * SizeClass variant suffixes recognized in face filenames. The on-disk
 * convention uses lowercase suffixes (`summary.expanded.ts`); these map to
 * the proto SizeClass numeric enum used everywhere else in the server.
 */
const FILENAME_TO_SIZE_CLASS: Record<string, SizeClass> = {
  compact: SizeClass.COMPACT,
  expanded: SizeClass.EXPANDED,
}
const SKIP_SUFFIXES = ['.resolve.ts', '.parts.ts']

/**
 * Parse a face filename to extract faceId and sizeClass.
 *
 * Expected convention: `<faceId>.compact.ts` / `<faceId>.expanded.ts`.
 * Files without an explicit suffix return null — implicit `.ts` face files
 * are not supported.
 */
export function parseFaceFile(name: string): { faceId: string; sizeClass?: SizeClass } | null {
  if (!name.endsWith('.ts')) return null
  if (SKIP_SUFFIXES.some((s) => name.endsWith(s))) return null

  const base = name.slice(0, -3) // strip .ts
  for (const [suffix, sc] of Object.entries(FILENAME_TO_SIZE_CLASS)) {
    if (base.endsWith(`.${suffix}`)) {
      return { faceId: base.slice(0, -(suffix.length + 1)), sizeClass: sc }
    }
  }
  return null
}

/**
 * Scan a faces/ directory for .ts files not already registered.
 * Expects the explicit-suffix convention: `<faceId>.compact.ts` / `<faceId>.expanded.ts`.
 * Skips .resolve.ts, .parts.ts, and any file without a recognized suffix.
 *
 * Supports two layouts:
 *   - Flat:    faces/summary.compact.ts, faces/summary.expanded.ts
 *   - Per-face subdir: faces/summary/summary.compact.ts, faces/summary/summary.expanded.ts
 *
 * The subdir walk is one level only; deeper nesting is ignored.
 */
export async function scanSupplementalFaces(
  facesDir: string,
  exclude: Set<string>,
  load: ModuleLoader = defaultScanLoader,
): Promise<ScannedFace[]> {
  if (!existsSync(facesDir)) return []
  const results: ScannedFace[] = []

  const candidates: { filePath: string; fileName: string }[] = []

  let entries: string[]
  try {
    entries = readdirSync(facesDir)
  } catch {
    return []
  }

  for (const name of entries) {
    const fullPath = join(facesDir, name)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      // One-level recurse into per-face subdir
      let subEntries: string[]
      try {
        subEntries = readdirSync(fullPath)
      } catch {
        continue
      }
      for (const subName of subEntries) {
        const subPath = join(fullPath, subName)
        try {
          if (!statSync(subPath).isFile()) continue
        } catch {
          continue
        }
        candidates.push({ filePath: subPath, fileName: subName })
      }
      continue
    }

    if (st.isFile()) {
      candidates.push({ filePath: fullPath, fileName: name })
    }
  }

  for (const { filePath, fileName } of candidates) {
    const parsed = parseFaceFile(fileName)
    if (!parsed) continue
    // Variant files (sizeClass suffix) are additive; don't skip them even if
    // the primary face id is already registered. Default (no-suffix) faces are
    // excluded to avoid double-registering what `faces: [...]` already declared.
    if (!parsed.sizeClass && exclude.has(parsed.faceId)) continue

    try {
      const mod = await load(filePath)
      const faceDef = mod.default as FaceDefinition
      if (faceDef?.id && typeof faceDef.resolve === 'function') {
        results.push({ face: faceDef, sizeClass: parsed.sizeClass })
      }
    } catch (err) {
      console.warn(
        `[app-loader] Failed to load face ${filePath}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return results
}
