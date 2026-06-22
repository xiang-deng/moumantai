/**
 * App registry — discovery layer for browsing/installing plugins by id.
 *
 * A registry is a JSON document at the root of a git repo (or a local dir):
 *
 *   {
 *     "name": "moumantai-examples",
 *     "version": "1",
 *     "apps": [
 *       { "id": "spend-tracker", "version": "0.1.0", "subdir": "spend-tracker",
 *         "description": "...", "moumantaiMinVersion": "0.1.0" },
 *       ...
 *     ]
 *   }
 *
 * `fetchRegistry()` resolves a URL or local path → `RegistryFile`. For git URLs,
 * it reuses the workspace's git cache (`<home>/cache/git/`) so a `--from <url>`
 * call is essentially free after the first fetch.
 *
 * `resolveAppFromRegistry()` takes a registry + id → `InstallSource` ready for
 * `installApp()`. The default repo URL is the registry's URL itself; an entry
 * may override via `repo:` to point at a different repo (e.g., when one
 * registry curates apps from many repos).
 */

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { homeLayout } from './home.js'
import { ensureGitClone, materializeWorktree } from './git.js'
import type { InstallSource } from './apps-installer.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/, 'Invalid SemVer')

export const RegistryAppEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case'),
  version: SemVer,
  /** Path inside the registry's repo where this app's source lives. Default = repo root. */
  subdir: z.string().optional(),
  description: z.string().optional(),
  /** Override repo URL when this registry curates apps from elsewhere. */
  repo: z.string().optional(),
  /** Override ref (default: registry's HEAD). */
  ref: z.string().optional(),
  moumantaiMinVersion: SemVer.optional(),
})

export const RegistryFileSchema = z.object({
  name: z.string().min(1),
  version: z.string().default('1'),
  apps: z.array(RegistryAppEntrySchema).default([]),
})

export type RegistryFile = z.infer<typeof RegistryFileSchema>
export type RegistryAppEntry = z.infer<typeof RegistryAppEntrySchema>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedRegistry {
  /** The original URL or local path the caller passed. */
  url: string
  /** The fully-validated registry document. */
  registry: RegistryFile
}

const GIT_PREFIXES = ['https://', 'http://', 'git+', 'git@', 'ssh://', 'file://']

function looksLikeGitUrl(s: string): boolean {
  return GIT_PREFIXES.some((p) => s.startsWith(p))
}

/**
 * Fetch a registry by URL or local path. For git URLs, ensures the cache
 * clone is up to date and reads `registry.json` from a freshly materialized
 * worktree at HEAD. For local paths, reads `<path>/registry.json` directly.
 */
export function fetchRegistry(home: string, url: string): ResolvedRegistry {
  const text = looksLikeGitUrl(url) ? fetchRegistryFromGit(home, url) : fetchRegistryFromLocal(url)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`Invalid JSON in registry at ${url}: ${(err as Error).message}`)
  }
  const registry = RegistryFileSchema.parse(parsed)
  return { url, registry }
}

/**
 * Resolve a registry entry → an `InstallSource` for `installApp()`. The
 * registry's URL is the default repo URL unless the entry overrides via `repo:`.
 */
export function resolveAppFromRegistry(reg: ResolvedRegistry, id: string): InstallSource {
  const entry = reg.registry.apps.find((a) => a.id === id)
  if (!entry) {
    const known = reg.registry.apps.map((a) => a.id).join(', ') || '(none)'
    throw new Error(`App "${id}" not found in registry "${reg.registry.name}". Known: ${known}`)
  }
  // If the registry itself was a local-path source, the repo URL must be
  // explicit (a local dir is not a git remote we can clone). Force callers
  // to either use a git registry or override `repo:` per entry.
  const repoUrl = entry.repo ?? (looksLikeGitUrl(reg.url) ? reg.url : undefined)
  if (!repoUrl) {
    throw new Error(
      `Registry "${reg.registry.name}" was loaded from a local path (${reg.url}); ` +
        `entry "${id}" must specify \`repo:\` to be installable, or use a git URL for the registry itself.`,
    )
  }
  return {
    kind: 'git',
    url: repoUrl,
    ref: entry.ref ?? 'HEAD',
    ...(entry.subdir ? { subdir: entry.subdir } : {}),
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function fetchRegistryFromLocal(p: string): string {
  const file = path.join(path.resolve(p), 'registry.json')
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No registry.json at ${p}`)
    }
    throw err
  }
}

function fetchRegistryFromGit(home: string, url: string): string {
  const layout = homeLayout(home)
  fs.mkdirSync(layout.gitCacheDir, { recursive: true })
  const cacheDir = ensureGitClone(url, layout.gitCacheDir)
  // Worktree at HEAD lets us read registry.json without inspecting the bare
  // clone's pack files. Cheap; cleanup is best-effort.
  const wt = materializeWorktree(cacheDir, 'HEAD')
  try {
    const registryFile = path.join(wt.workdir, 'registry.json')
    if (!fs.existsSync(registryFile)) {
      throw new Error(`Registry repo ${url} has no registry.json at HEAD`)
    }
    return fs.readFileSync(registryFile, 'utf8')
  } finally {
    wt.cleanup()
  }
}
