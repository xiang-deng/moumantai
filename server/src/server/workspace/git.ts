/**
 * Minimal `git` CLI wrapper for the plugin installer.
 *
 * Uses `child_process.spawnSync('git', ...)` — no deps. The installer keeps a
 * bare clone of every install URL under `<home>/cache/git/<hash(url)>/`, then
 * materializes a per-install worktree via `git worktree add --detach`. This is
 * the cheapest reproducible "give me the tree at this commit" primitive that
 * works against bare clones on Windows + macOS + Linux.
 *
 * Friendly errors:
 *   - `git` not on PATH         → GitError 'NO_GIT'
 *   - clone / fetch / checkout  → GitError with the specific code
 */

import crypto from 'node:crypto'
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type GitErrorCode =
  | 'NO_GIT'
  | 'CLONE_FAILED'
  | 'FETCH_FAILED'
  | 'BAD_REF'
  | 'CHECKOUT_FAILED'

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: GitErrorCode,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface MaterializedWorktree {
  /** Absolute path to a tempdir containing the checked-out tree. */
  workdir: string
  /** Resolved 40-char commit SHA. */
  commit: string
  /**
   * Best-effort removal of the worktree (errors swallowed). Always safe to
   * call multiple times. Caller MUST invoke this when done.
   */
  cleanup(): void
}

/**
 * Ensure a bare clone of `url` exists at `<gitCacheDir>/<sha1(url)/16>/`.
 * If the cache slot exists, runs `git fetch --prune` to pull updates so
 * subsequent `resolveCommit()` sees new tags/branches.
 */
export function ensureGitClone(url: string, gitCacheDir: string): string {
  const slot = path.join(gitCacheDir, hashUrl(url))
  // A bare clone has HEAD directly under its root.
  if (fs.existsSync(path.join(slot, 'HEAD'))) {
    runGit(['fetch', '--prune', '--quiet'], { cwd: slot }, 'FETCH_FAILED', `fetch ${url}`)
    return slot
  }
  fs.mkdirSync(path.dirname(slot), { recursive: true })
  // --mirror = --bare + sets remote.origin.fetch = '+refs/*:refs/*'. Plain
  // --bare leaves no fetch refspec, so subsequent `git fetch` is a no-op and
  // the cache never sees new commits.
  runGit(['clone', '--mirror', '--quiet', url, slot], {}, 'CLONE_FAILED', `clone ${url}`)
  return slot
}

/**
 * Resolve a ref (branch / tag / sha / "HEAD") to a 40-char commit SHA in the
 * given bare cache. Throws GitError('BAD_REF') if the ref doesn't exist.
 */
export function resolveCommit(cacheDir: string, ref: string): string {
  const out = runGit(
    ['rev-parse', '--verify', `${ref}^{commit}`],
    { cwd: cacheDir },
    'BAD_REF',
    `resolve "${ref}"`,
  )
  return out.trim()
}

/**
 * Materialize a worktree of `commit` from the bare cache into a fresh tempdir.
 * Caller MUST invoke `.cleanup()` to release the worktree registration in the
 * cache (otherwise `git worktree list` accumulates stale entries).
 */
export function materializeWorktree(cacheDir: string, commit: string): MaterializedWorktree {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-git-'))
  try {
    runGit(
      ['worktree', 'add', '--detach', '--quiet', workdir, commit],
      { cwd: cacheDir },
      'CHECKOUT_FAILED',
      `worktree add ${commit}`,
    )
  } catch (err) {
    try {
      fs.rmSync(workdir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    throw err
  }
  return {
    workdir,
    commit,
    cleanup: () => {
      try {
        runGit(
          ['worktree', 'remove', '--force', workdir],
          { cwd: cacheDir },
          'CHECKOUT_FAILED',
          `worktree remove ${workdir}`,
        )
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(workdir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function runGit(
  args: string[],
  opts: SpawnSyncOptions,
  errCode: GitErrorCode,
  what: string,
): string {
  const result = spawnSync('git', args, { encoding: 'utf8', ...opts })
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitError(
        `'git' not found on PATH. Install it from https://git-scm.com/ then retry.`,
        'NO_GIT',
      )
    }
    throw new GitError(`git ${args[0]} (${what}): ${result.error.message}`, errCode)
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim() || `exit ${result.status}`
    throw new GitError(`git ${args[0]} (${what}): ${detail}`, errCode)
  }
  return String(result.stdout ?? '')
}

function hashUrl(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)
}
