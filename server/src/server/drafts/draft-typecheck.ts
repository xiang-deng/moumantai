/**
 * Diff-scoped TypeScript typecheck for a draft worktree.
 *
 * The draft lives outside the npm workspace, so we generate a self-contained
 * tsconfig in `<home>/tmp/` that extends `tsconfig.base.json` (flags only),
 * sets an absolute `baseUrl` = repo root, and reads `paths` from
 * `apps/tsconfig.json` (SSOT) rebased to the repo root so `moumantai` /
 * `@moumantai/*` / `drizzle-orm` resolve to the SDK source.
 *
 * Errors are scoped to files the draft changed — pre-existing type errors in
 * untouched files don't block an unrelated edit. Fail-soft: if `tsc` or the
 * tsconfig files are absent (prod packaging), the check skips rather than fails.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ValidationError } from './types.js'
import { changedAppFiles } from './draft-fs.js'

export interface DraftTypecheckOpts {
  draftId: string
  draftDir: string
  /** Live app source dir for the diff baseline; null for new-app (all files). */
  liveSrcDir: string | null
  /** Moumantai home (for the `<home>/tmp` scratch config). */
  home: string
  /** Repo root (holds `apps/tsconfig.json` + `tsconfig.base.json`). */
  repoRoot: string
}

export interface DraftTypecheckResult {
  ok: boolean
  /** When set, the check was skipped (fail-soft) for this reason — treated as ok. */
  skipped?: string
  errors: ValidationError[]
}

/** Normalize an absolute path to a draft-relative, slash+lowercased key. */
function relKey(draftDir: string, abs: string): string {
  return path.relative(draftDir, abs).split(path.sep).join('/').toLowerCase()
}

/** Rebase an `apps/tsconfig.json` path target (relative to `apps/`) to a path
 *  relative to the repo root (the generated config's `baseUrl`). */
function rebasePathTarget(repoRoot: string, target: string): string {
  const abs = path.resolve(repoRoot, 'apps', target)
  return path.relative(repoRoot, abs).split(path.sep).join('/')
}

/** Read `apps/tsconfig.json`'s `paths`, rebased to repo-root-relative. Returns
 *  null if the file is missing/unparseable (→ caller skips, fail-soft). */
function readRebasedPaths(repoRoot: string): Record<string, string[]> | null {
  const appsTsconfig = path.join(repoRoot, 'apps', 'tsconfig.json')
  if (!fs.existsSync(appsTsconfig)) return null
  let parsed: { compilerOptions?: { paths?: Record<string, string[]> } }
  try {
    parsed = JSON.parse(fs.readFileSync(appsTsconfig, 'utf8'))
  } catch {
    return null
  }
  const paths = parsed.compilerOptions?.paths
  if (!paths) return null
  const out: Record<string, string[]> = {}
  for (const [key, targets] of Object.entries(paths)) {
    out[key] = targets.map((t) => rebasePathTarget(repoRoot, t))
  }
  return out
}

const SDK_SPECIFIERS = ['moumantai', '@moumantai/', 'drizzle-orm']
/** True when the error is an SDK resolution failure, not an app code error. */
function isSdkResolutionError(line: string): boolean {
  if (!/error TS2307/.test(line)) return false
  const m = line.match(/Cannot find module '([^']+)'/)
  if (!m) return false
  const spec = m[1] ?? ''
  return SDK_SPECIFIERS.some((s) => spec === s || spec.startsWith(s))
}

interface ParsedTscError {
  absPath: string
  message: string
  line: string
}

/** Parse `tsc --pretty false` output lines: `path(line,col): error TSxxxx: msg`. */
function parseTscErrors(out: string, cwd: string): ParsedTscError[] {
  const errors: ParsedTscError[] = []
  for (const raw of out.split(/\r?\n/)) {
    const m = raw.match(/^(.+?)\((\d+),(\d+)\): (error TS\d+: .+)$/)
    if (!m) continue
    const [, file, , , message] = m
    errors.push({ absPath: path.resolve(cwd, file!), message: message!, line: raw })
  }
  return errors
}

/**
 * Run the diff-scoped, fail-soft typecheck. Never throws.
 */
export function runDraftTypecheck(opts: DraftTypecheckOpts): DraftTypecheckResult {
  const { draftId, draftDir, liveSrcDir, home, repoRoot } = opts

  const baseTsconfig = path.join(repoRoot, 'tsconfig.base.json')
  const paths = readRebasedPaths(repoRoot)
  if (!paths || !fs.existsSync(baseTsconfig)) {
    return { ok: true, skipped: 'apps/tsconfig.json or tsconfig.base.json not found', errors: [] }
  }

  const fwd = (p: string) => p.split(path.sep).join('/')
  const config = {
    extends: fwd(baseTsconfig),
    compilerOptions: {
      baseUrl: fwd(repoRoot),
      paths,
      types: ['node'],
      noEmit: true,
      lib: ['ES2020'],
    },
    include: [`${fwd(draftDir)}/**/*.ts`],
    exclude: [
      `${fwd(draftDir)}/.shadow/**`,
      `${fwd(draftDir)}/.claude/**`,
      `${fwd(draftDir)}/drizzle/**`,
      `${fwd(draftDir)}/**/*.test.ts`,
    ],
  }

  const tmpDir = path.join(home, 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const configPath = path.join(tmpDir, `typecheck-${draftId}.tsconfig.json`)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  let out = ''
  try {
    // Success (no type errors) → exits 0, empty output.
    execFileSync('npx', ['tsc', '--noEmit', '--pretty', 'false', '-p', configPath], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer }
    if (e.code === 'ENOENT') {
      // `npx`/`tsc` not available (prod packaging) → fail-soft.
      try {
        fs.rmSync(configPath, { force: true })
      } catch {
        /* ignore */
      }
      return { ok: true, skipped: 'tsc not available', errors: [] }
    }
    const toStr = (v?: string | Buffer) =>
      typeof v === 'string' ? v : v instanceof Buffer ? v.toString() : ''
    out = `${toStr(e.stdout)}\n${toStr(e.stderr)}`
  } finally {
    try {
      fs.rmSync(configPath, { force: true })
    } catch {
      /* ignore */
    }
  }

  const parsed = parseTscErrors(out, repoRoot)
  if (parsed.length === 0) return { ok: true, errors: [] }

  // Fail-soft: if every error is an SDK resolution failure, skip rather than block.
  if (parsed.every((p) => isSdkResolutionError(p.line))) {
    return { ok: true, skipped: 'SDK types unresolvable in this environment', errors: [] }
  }

  // Keep only errors in files the draft changed.
  const changed = new Set(changedAppFiles(draftDir, liveSrcDir).map((p) => relKey(draftDir, p)))
  const scoped = parsed.filter((p) => changed.has(relKey(draftDir, p.absPath)))
  if (scoped.length === 0) return { ok: true, errors: [] }

  return {
    ok: false,
    errors: scoped.map((p) => ({
      target: path.relative(draftDir, p.absPath).split(path.sep).join('/'),
      kind: 'typecheck' as const,
      message: p.message,
    })),
  }
}
