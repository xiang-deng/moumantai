/**
 * Moumantai Home — resolution + layout management.
 *
 * The "Moumantai Home" is a single directory that owns runtime config + data:
 *
 *   <home>/config.json       structured config (Zod-validated)
 *   <home>/.env              secrets (API keys)
 *   <home>/platform.db       chat history + SDK session bindings
 *   <home>/apps-src/<id>/    installed plugin source (symlink or copy)
 *   <home>/apps/<id>/        per-app runtime state
 *     ├── db.sqlite          per-app Drizzle DB
 *     └── cwd/               synthetic SDK working dir
 *   <home>/apps/home/cwd/    home-app SDK working dir
 *
 * Resolution precedence (first hit wins):
 *   1. MOUMANTAI_HOME env var                              — explicit override
 *   2. <ancestor>/.moumantai/ walker from cwd              — "I'm in THIS checkout"
 *   3. Pointer file at the platform-canonical location     — wizard's persistent choice
 *   4. ~/.moumantai/                                       — default fallback
 *
 * The walker beats the pointer so cd-ing into a checkout targets that workspace,
 * not the daily-use one. The pointer beats the default so cron/systemd/launchd
 * find the wizard's choice without a shell env var.
 *
 * Pointer file location (one file holding one absolute path):
 *   - Windows: %APPDATA%\moumantai\home
 *   - macOS:   ~/Library/Application Support/moumantai/home
 *   - Linux/BSD/WSL: ${XDG_CONFIG_HOME:-~/.config}/moumantai/home
 *
 * `MOUMANTAI_HOME` must be a real env var — it cannot be read from `<home>/.env`
 * (chicken/egg: we need it to find `.env` itself).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ResolveHomeOptions {
  /** Used by tests + by boot to detect <cwd>/.moumantai/. Defaults to process.cwd(). */
  cwd?: string
  /** Override env source for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /**
   * Pointer file path. Tests pass an explicit value (often a tmp path) to
   * opt out of reading the user's real pointer. Pass `null` to disable the
   * pointer step entirely. `undefined` uses the platform default.
   */
  pointerPath?: string | null
  /** Platform override for tests — defaults to `process.platform`. */
  platform?: NodeJS.Platform
}

/**
 * Platform-canonical pointer file location. One file, one absolute path,
 * UTF-8 text (trailing newline tolerated).
 *
 * Linux/BSD honors `XDG_CONFIG_HOME`; falls back to `~/.config/`. macOS uses
 * `~/Library/Application Support/`. Windows uses `%APPDATA%`, with a sane
 * fallback for environments where the env var is missing.
 */
export function defaultPointerPath(
  opts: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    homedir?: string
  } = {},
): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const homedir = opts.homedir ?? os.homedir()

  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming')
    return path.join(appData, 'moumantai', 'home')
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'moumantai', 'home')
  }
  // Linux / BSD / WSL / Android / freebsd / openbsd / everything else → XDG
  const xdg =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
      ? env.XDG_CONFIG_HOME.trim()
      : path.join(homedir, '.config')
  return path.join(xdg, 'moumantai', 'home')
}

/**
 * Read the pointer file. Returns the resolved absolute path if the file exists,
 * parses cleanly, and the path is a directory. Otherwise returns null — the
 * resolver falls through. Malformed pointers never throw.
 */
export function readHomePointer(pointerPath: string): string | null {
  try {
    const raw = fs.readFileSync(pointerPath, 'utf8').trim()
    if (!raw) return null
    const resolved = path.resolve(raw)
    // Stale-pointer guard: if the path no longer exists or isn't a directory, fall through.
    try {
      if (!fs.statSync(resolved).isDirectory()) return null
    } catch {
      return null
    }
    return resolved
  } catch {
    return null
  }
}

/**
 * Atomically write the pointer file. Creates the parent dir if needed.
 * Throws on filesystem failure — callers should catch and report.
 */
export function writeHomePointer(home: string, pointerPath: string): void {
  const resolved = path.resolve(home)
  const dir = path.dirname(pointerPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${pointerPath}.tmp`
  fs.writeFileSync(tmp, `${resolved}\n`, { encoding: 'utf8' })
  fs.renameSync(tmp, pointerPath)
}

/**
 * Delete the pointer file. Idempotent — missing file is not an error.
 */
export function deleteHomePointer(pointerPath: string): void {
  try {
    fs.unlinkSync(pointerPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
}

/**
 * Resolve the Moumantai home directory using the documented precedence.
 * Returns an absolute path. Does not create the directory — call ensureHomeLayout() for that.
 */
export function resolveMoumantaiHome(opts: ResolveHomeOptions = {}): string {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()

  // 1. env var
  const override = env.MOUMANTAI_HOME
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim())
  }

  // 2. Walk up cwd looking for `.moumantai/`. Stop at $HOME to avoid falsely matching ~/.moumantai.
  const homeDir = os.homedir()
  let cur = path.resolve(cwd)
  for (let depth = 0; depth < 32; depth++) {
    const candidate = path.join(cur, '.moumantai')
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate
      }
    } catch {
      // not present — keep walking
    }
    const parent = path.dirname(cur)
    if (parent === cur) break // hit filesystem root
    if (parent === homeDir) break // don't walk through $HOME (would falsely match ~/.moumantai)
    cur = parent
  }

  // 3. Pointer file. opts.pointerPath === null means "tests opted out".
  if (opts.pointerPath !== null) {
    const pointerPath =
      opts.pointerPath ??
      defaultPointerPath({
        ...(opts.platform ? { platform: opts.platform } : {}),
        env,
        homedir: homeDir,
      })
    const pointed = readHomePointer(pointerPath)
    if (pointed) return pointed
  }

  // 4. Default fallback
  return path.join(homeDir, '.moumantai')
}

/** Source-of-resolution tag — used by the `workspace path` command to explain. */
export type HomeSource = 'env' | 'walker' | 'pointer' | 'default'

export interface ResolveHomeResult {
  home: string
  source: HomeSource
}

/**
 * Like `resolveMoumantaiHome` but also returns the source tag. Used by
 * the `workspace path` command; not used by the boot path.
 */
export function resolveMoumantaiHomeWithSource(opts: ResolveHomeOptions = {}): ResolveHomeResult {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()

  const override = env.MOUMANTAI_HOME
  if (override && override.trim().length > 0) {
    return { home: path.resolve(override.trim()), source: 'env' }
  }

  const homeDir = os.homedir()
  let cur = path.resolve(cwd)
  for (let depth = 0; depth < 32; depth++) {
    const candidate = path.join(cur, '.moumantai')
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return { home: candidate, source: 'walker' }
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    if (parent === homeDir) break
    cur = parent
  }

  if (opts.pointerPath !== null) {
    const pointerPath =
      opts.pointerPath ??
      defaultPointerPath({
        ...(opts.platform ? { platform: opts.platform } : {}),
        env,
        homedir: homeDir,
      })
    const pointed = readHomePointer(pointerPath)
    if (pointed) return { home: pointed, source: 'pointer' }
  }

  return { home: path.join(homeDir, '.moumantai'), source: 'default' }
}

/** Standard subdirectory paths under <home>. */
export interface HomeLayout {
  home: string
  configFile: string
  envFile: string
  platformDb: string
  appsSrcDir: string
  appsDir: string
  /**
   * Per-install metadata files (`<id>.json`). Stored outside apps-src so meta
   * can be written even when apps-src/<id>/ is a symlink we don't own.
   */
  appsMetaDir: string
  homeAppCwd: string
  /** Draft worktrees (`<home>/apps-drafts/<draftId>/`). Created only in dev mode. */
  appsDraftsDir: string
  /** Persistent caches (git clones, registry fetches). Safe to delete. */
  cacheDir: string
  /** Bare git clones keyed by sha1(url) — see workspace/git.ts. */
  gitCacheDir: string
}

export function homeLayout(home: string): HomeLayout {
  return {
    home,
    configFile: path.join(home, 'config.json'),
    envFile: path.join(home, '.env'),
    platformDb: path.join(home, 'platform.db'),
    appsSrcDir: path.join(home, 'apps-src'),
    appsDir: path.join(home, 'apps'),
    appsMetaDir: path.join(home, 'apps-meta'),
    homeAppCwd: path.join(home, 'apps', 'home', 'cwd'),
    appsDraftsDir: path.join(home, 'apps-drafts'),
    cacheDir: path.join(home, 'cache'),
    gitCacheDir: path.join(home, 'cache', 'git'),
  }
}

/** Per-app paths derived from home + appId. */
export function appPaths(
  home: string,
  appId: string,
): { dbFile: string; cwd: string; root: string } {
  const root = path.join(home, 'apps', appId)
  return {
    root,
    dbFile: path.join(root, 'db.sqlite'),
    cwd: path.join(root, 'cwd'),
  }
}

/**
 * Per-draft paths under `<home>/apps-drafts/<draftId>/`:
 *   - `dir`           the draft worktree root (app source at top level)
 *   - `shadowDbFile`  `<dir>/.shadow/db.sqlite` — server-owned shadow DB
 *   - `metaFile`      `<dir>/.meta.json` — server-owned draft metadata
 *   - `skillDir`      `<dir>/.claude/skills/` — materialized skill (SDK loads it)
 * The dotted paths are server-owned: the edit-agent may read but not write
 * them, and they are excluded from the promote copy.
 */
export function draftPaths(
  home: string,
  draftId: string,
): {
  dir: string
  shadowDir: string
  shadowDbFile: string
  metaFile: string
  skillDir: string
} {
  const dir = path.join(home, 'apps-drafts', draftId)
  const shadowDir = path.join(dir, '.shadow')
  return {
    dir,
    shadowDir,
    shadowDbFile: path.join(shadowDir, 'db.sqlite'),
    metaFile: path.join(dir, '.meta.json'),
    skillDir: path.join(dir, '.claude', 'skills'),
  }
}

/**
 * Idempotently create the home dir and standard subdirs. Does NOT create
 * config.json or .env — the config-loader handles those.
 */
export function ensureHomeLayout(home: string): HomeLayout {
  const layout = homeLayout(home)
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(layout.appsSrcDir, { recursive: true })
  fs.mkdirSync(layout.appsDir, { recursive: true })
  fs.mkdirSync(layout.appsMetaDir, { recursive: true })
  fs.mkdirSync(layout.homeAppCwd, { recursive: true })
  fs.mkdirSync(layout.gitCacheDir, { recursive: true })
  return layout
}
