/**
 * Plugin app install / uninstall / list / update.
 *
 * Sources accepted by `installApp(home, src)`:
 *   - Local path:   `/abs/path` or `./relative` or `D:\path` — symlink (junction
 *                   on Windows) into apps-src; copy fallback on EPERM.
 *   - Git URL:      `https://...`, `git@...`, `git+https://...`, `ssh://...`,
 *                   or `file://...`. Optional `#<ref>` and `:<subdir>` fragment
 *                   (asdf-style): `https://github.com/x/repo#v0.2.0:subdir`.
 *                   Bare clone is cached at `<home>/cache/git/<hash(url)>/`;
 *                   each install materializes a worktree at the target commit
 *                   and copies the (sub)tree into apps-src/<id>/.
 *
 * Per-install metadata at `<home>/apps-meta/<id>.json` (outside apps-src so
 * meta can be written even when apps-src/<id>/ is a symlink we don't own).
 * Legacy installs without meta are tolerated — `listInstalled()` falls back
 * to fs-derived info.
 *
 * Runtime state (`<home>/apps/<id>/{db.sqlite,cwd/}`) is owned by the app
 * engine and is NEVER touched here. `uninstallApp()` reports whether it exists
 * so the caller can prompt before calling `deleteAppRuntimeState()`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appPaths, homeLayout } from './home.js'
import { ensureGitClone, materializeWorktree, resolveCommit } from './git.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallSource =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; ref: string; subdir?: string }

export type InstallOrigin =
  | { type: 'local'; source: string; linkType: 'link' | 'copy' }
  | { type: 'git'; url: string; ref: string; subdir?: string; commit: string; registry?: string }

export interface AppMeta {
  id: string
  version: string
  origin: InstallOrigin
  installedAt: string
}

export interface InstalledApp {
  id: string
  /** Absolute path to `<home>/apps-src/<id>/`. */
  srcDir: string
  /** Manifest version when installed (read from apps-meta or apps-src manifest). */
  version: string
  /** 'link' = symlink/junction; 'copy' = file copy fallback. */
  type: 'link' | 'copy'
  /** Where the link points (only for type='link'). */
  target?: string
  /** Full origin info if a meta file is present. */
  origin?: InstallOrigin
}

export interface InstallResult {
  id: string
  version: string
  type: 'link' | 'copy'
  origin: InstallOrigin
  warning?: string
}

export interface UninstallResult {
  removedSrc: boolean
  hasRuntimeState: boolean
  runtimeStateDir: string
}

export interface UpdateResult {
  id: string
  updated: boolean
  /** Set when no update happened (already up-to-date, or local install). */
  reason?: string
  fromCommit?: string
  toCommit?: string
  fromVersion?: string
  toVersion?: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

// Canonical schemes that mean "this is a git URL, not a local path".
const GIT_URL_PREFIXES = ['https://', 'http://', 'git+', 'git@', 'ssh://', 'file://']

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an install spec into a tagged source. Inputs:
 *   - `https://github.com/x/repo`             → git, ref=HEAD
 *   - `https://github.com/x/repo#v0.2.0`      → git, ref=v0.2.0
 *   - `https://github.com/x/repo#main:apps/a` → git, ref=main, subdir=apps/a
 *   - `/abs/path` | `./rel` | `D:\path`       → local
 */
export function parseInstallSource(spec: string): InstallSource {
  const s = spec.trim()
  if (!s) throw new Error('Empty install source')

  const isGit = GIT_URL_PREFIXES.some((p) => s.startsWith(p))
  if (!isGit) {
    return { kind: 'local', path: s }
  }

  // `git+` is an npm-isms prefix — strip it for the actual git URL.
  const stripped = s.startsWith('git+') ? s.slice(4) : s
  const hashIdx = stripped.indexOf('#')
  if (hashIdx === -1) {
    return { kind: 'git', url: stripped, ref: 'HEAD' }
  }
  const url = stripped.slice(0, hashIdx)
  const fragment = stripped.slice(hashIdx + 1)
  const colonIdx = fragment.indexOf(':')
  if (colonIdx === -1) {
    return { kind: 'git', url, ref: fragment || 'HEAD' }
  }
  const ref = fragment.slice(0, colonIdx) || 'HEAD'
  const subdir = fragment.slice(colonIdx + 1) || undefined
  return { kind: 'git', url, ref, subdir }
}

/**
 * Install (or re-install) an app from a local path or git URL.
 * Idempotent: if `<home>/apps-src/<id>/` already exists, it is removed first.
 * Runtime state at `<home>/apps/<id>/` is left alone.
 */
export function installApp(home: string, spec: string | InstallSource): InstallResult {
  const source = typeof spec === 'string' ? parseInstallSource(spec) : spec
  return source.kind === 'git' ? installFromGit(home, source) : installFromLocal(home, source)
}

/**
 * Re-resolve the origin and re-materialize if the commit changed.
 * Local installs are no-ops (symlinks are live; copies require reinstall).
 */
export function updateApp(home: string, id: string): UpdateResult {
  const meta = readMeta(home, id)
  if (!meta) {
    throw new Error(`No installed app "${id}" (no meta file at ${metaPath(home, id)})`)
  }

  if (meta.origin.type === 'local') {
    return {
      id,
      updated: false,
      reason:
        meta.origin.linkType === 'link'
          ? 'local symlink — already live; no fetch needed'
          : 'local copy — re-run `app install <path>` to refresh',
    }
  }

  // Git origin: re-fetch and re-resolve. If commit unchanged, no-op.
  const layout = homeLayout(home)
  const cacheDir = ensureGitClone(meta.origin.url, layout.gitCacheDir)
  const newCommit = resolveCommit(cacheDir, meta.origin.ref)
  if (newCommit === meta.origin.commit) {
    return { id, updated: false, reason: 'up to date' }
  }

  const fromCommit = meta.origin.commit
  const fromVersion = meta.version

  // Re-materialize the new commit into apps-src/<id>/.
  const wt = materializeWorktree(cacheDir, newCommit)
  try {
    const subSrc = meta.origin.subdir ? path.join(wt.workdir, meta.origin.subdir) : wt.workdir
    if (!isDir(subSrc)) {
      throw new Error(
        `Update fetched ${newCommit.slice(0, 7)} but subdir "${meta.origin.subdir ?? ''}" not found in tree`,
      )
    }
    const manifest = extractManifest(subSrc, { requireVersion: true })
    if (manifest.id !== id) {
      throw new Error(
        `Update would change app id ${id} → ${manifest.id} (refusing — uninstall + reinstall instead)`,
      )
    }
    const dest = path.join(layout.appsSrcDir, id)
    fs.mkdirSync(layout.appsSrcDir, { recursive: true })
    removeIfPresent(dest)
    fs.cpSync(subSrc, dest, { recursive: true })
    writeMeta(home, {
      id,
      version: manifest.version,
      origin: { ...meta.origin, commit: newCommit },
      installedAt: new Date().toISOString(),
    })
    return {
      id,
      updated: true,
      fromCommit,
      toCommit: newCommit,
      fromVersion,
      toVersion: manifest.version,
    }
  } finally {
    wt.cleanup()
  }
}

/**
 * Remove `<home>/apps-src/<id>/` and its meta file. Runtime state is left
 * in place — caller calls `deleteAppRuntimeState()` after prompting the user.
 */
export function uninstallApp(home: string, appId: string): UninstallResult {
  const layout = homeLayout(home)
  const srcDir = path.join(layout.appsSrcDir, appId)
  const removedSrc = removeIfPresent(srcDir)
  removeIfPresent(metaPath(home, appId))
  const ap = appPaths(home, appId)
  return {
    removedSrc,
    hasRuntimeState: fs.existsSync(ap.root),
    runtimeStateDir: ap.root,
  }
}

export function deleteAppRuntimeState(home: string, appId: string): void {
  const ap = appPaths(home, appId)
  fs.rmSync(ap.root, { recursive: true, force: true })
}

/** Enumerate installed apps. Reads meta when present; falls back to fs-derived info. */
export function listInstalled(home: string): InstalledApp[] {
  const layout = homeLayout(home)
  if (!isDir(layout.appsSrcDir)) return []

  const out: InstalledApp[] = []
  for (const entry of fs.readdirSync(layout.appsSrcDir)) {
    const srcDir = path.join(layout.appsSrcDir, entry)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(srcDir)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink() && !stat.isDirectory()) continue

    const meta = readMeta(home, entry)
    const type: 'link' | 'copy' = stat.isSymbolicLink() ? 'link' : 'copy'
    let target: string | undefined
    if (stat.isSymbolicLink()) {
      try {
        target = fs.readlinkSync(srcDir)
      } catch {
        /* dangling */
      }
    }

    let version = meta?.version
    if (!version) {
      try {
        version = extractManifest(srcDir, { requireVersion: false }).version || '0.0.0'
      } catch {
        version = '0.0.0'
      }
    }

    out.push({
      id: entry,
      srcDir,
      version,
      type,
      target,
      origin: meta?.origin,
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// Manifest extraction (regex-based; runtime-independent)
// ---------------------------------------------------------------------------

export interface ExtractedManifest {
  id: string
  version: string
  moumantaiMinVersion?: string
}

/**
 * Regex-extract `id`/`version`/`moumantaiMinVersion` from `<sourceDir>/manifest.{ts,js}`.
 * Falls back to dir basename for `id` when no manifest is found.
 * Throws on missing `version` when `requireVersion` is true.
 */
export function extractManifest(
  sourceDir: string,
  opts: { requireVersion?: boolean } = {},
): ExtractedManifest {
  const requireVersion = opts.requireVersion ?? true
  let text: string | undefined
  for (const ext of ['ts', 'js']) {
    const file = path.join(sourceDir, `manifest.${ext}`)
    try {
      text = fs.readFileSync(file, 'utf8')
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  const id = (text && /\bid\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1]) || path.basename(sourceDir)
  const version = text ? /\bversion\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1] : undefined
  const moumantaiMinVersion = text
    ? /\bmoumantaiMinVersion\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1]
    : undefined

  if (requireVersion && !version) {
    throw new Error(
      `Plugin manifest at ${sourceDir} is missing required field \`version\` (e.g. \`version: '0.1.0'\`).`,
    )
  }

  return {
    id,
    version: version ?? '0.0.0',
    ...(moumantaiMinVersion ? { moumantaiMinVersion } : {}),
  }
}

// ---------------------------------------------------------------------------
// Internals: install paths
// ---------------------------------------------------------------------------

function installFromLocal(home: string, source: { kind: 'local'; path: string }): InstallResult {
  const absSource = path.resolve(source.path)
  if (!isDir(absSource)) {
    throw new Error(`Source is not a directory: ${absSource}`)
  }
  const manifest = extractManifest(absSource)
  validateInstallable(manifest)

  const layout = homeLayout(home)
  const dest = path.join(layout.appsSrcDir, manifest.id)
  fs.mkdirSync(layout.appsSrcDir, { recursive: true })
  removeIfPresent(dest)

  let linkType: 'link' | 'copy' = 'link'
  let warning: string | undefined
  try {
    fs.symlinkSync(absSource, dest, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw err
    fs.cpSync(absSource, dest, { recursive: true })
    linkType = 'copy'
    warning =
      'Symlinks not permitted on this system — installed as a snapshot copy. Edits in the source dir will NOT be picked up; run `task server:cli -- app install` again to refresh.'
  }

  const origin: InstallOrigin = { type: 'local', source: absSource, linkType }
  writeMeta(home, {
    id: manifest.id,
    version: manifest.version,
    origin,
    installedAt: new Date().toISOString(),
  })
  return { id: manifest.id, version: manifest.version, type: linkType, origin, warning }
}

function installFromGit(
  home: string,
  source: { kind: 'git'; url: string; ref: string; subdir?: string },
): InstallResult {
  const layout = homeLayout(home)
  fs.mkdirSync(layout.gitCacheDir, { recursive: true })

  const cacheDir = ensureGitClone(source.url, layout.gitCacheDir)
  const commit = resolveCommit(cacheDir, source.ref)
  const wt = materializeWorktree(cacheDir, commit)
  try {
    const subSrc = source.subdir ? path.join(wt.workdir, source.subdir) : wt.workdir
    if (!isDir(subSrc)) {
      throw new Error(
        `Subdir "${source.subdir ?? ''}" not found in ${source.url} @ ${commit.slice(0, 7)}`,
      )
    }
    const manifest = extractManifest(subSrc)
    validateInstallable(manifest)

    const dest = path.join(layout.appsSrcDir, manifest.id)
    fs.mkdirSync(layout.appsSrcDir, { recursive: true })
    removeIfPresent(dest)
    fs.cpSync(subSrc, dest, { recursive: true })

    const origin: InstallOrigin = {
      type: 'git',
      url: source.url,
      ref: source.ref,
      ...(source.subdir ? { subdir: source.subdir } : {}),
      commit,
    }
    writeMeta(home, {
      id: manifest.id,
      version: manifest.version,
      origin,
      installedAt: new Date().toISOString(),
    })
    return { id: manifest.id, version: manifest.version, type: 'copy', origin }
  } finally {
    wt.cleanup()
  }
}

function validateInstallable(m: ExtractedManifest): void {
  if (!ID_PATTERN.test(m.id)) {
    throw new Error(
      `Invalid app id "${m.id}" — must be lowercase kebab-case (e.g. "spend-tracker").`,
    )
  }
  if (!SEMVER_PATTERN.test(m.version)) {
    throw new Error(`Invalid SemVer version "${m.version}" in manifest for "${m.id}".`)
  }
  if (m.moumantaiMinVersion) {
    const cmp = compareSemver(m.moumantaiMinVersion, ENGINE_VERSION)
    if (cmp > 0) {
      throw new Error(
        `Plugin "${m.id}" requires Moumantai >= ${m.moumantaiMinVersion}; this server is ${ENGINE_VERSION}. ` +
          `Upgrade the server or pick an older plugin version.`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Internals: meta file r/w
// ---------------------------------------------------------------------------

function metaPath(home: string, id: string): string {
  return path.join(homeLayout(home).appsMetaDir, `${id}.json`)
}

function readMeta(home: string, id: string): AppMeta | undefined {
  try {
    const text = fs.readFileSync(metaPath(home, id), 'utf8')
    return JSON.parse(text) as AppMeta
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

function writeMeta(home: string, meta: AppMeta): void {
  const layout = homeLayout(home)
  fs.mkdirSync(layout.appsMetaDir, { recursive: true })
  const file = metaPath(home, meta.id)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function removeIfPresent(p: string): boolean {
  try {
    fs.lstatSync(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  fs.rmSync(p, { recursive: true, force: true })
  return true
}

function compareSemver(a: string, b: string): number {
  const parse = (s: string) =>
    s
      .split(/[-+]/, 1)[0]!
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a)
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b)
  return aMaj - bMaj || aMin - bMin || aPat - bPat
}

const ENGINE_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // src/server/workspace/ → server/package.json
    const pkg = JSON.parse(
      fs.readFileSync(path.join(here, '..', '..', '..', 'package.json'), 'utf8'),
    )
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
