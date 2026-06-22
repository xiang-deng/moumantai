/**
 * Filesystem operations for draft worktrees.
 *
 * A draft worktree is `<home>/apps-drafts/<draftId>/`. EDIT drafts start as a
 * copy of the live app source (`apps-src/<id>/`); NEW-APP drafts start empty
 * and the agent scaffolds them. The worktree also holds server-owned,
 * agent-read-only, promote-excluded paths: `.shadow/`, `.claude/`, `.meta.json`,
 * `.progress.md`.
 *
 * All ops are synchronous (`cpSync`/`rmSync`). `dereference: true` flattens the
 * symlinked dev `apps-src/<id>` into real files so the agent edits files, not a
 * symlink.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Top-level worktree paths that are server-owned and excluded from promote.
 *  `.progress.md` is a file; the rest match both the name and everything beneath. */
const EPHEMERAL_DRAFT_ENTRIES = ['.shadow', '.claude', '.meta.json', '.progress.md']

/**
 * True if `rel` (a path RELATIVE to the draft worktree root) is a server-owned
 * / scratch path that must NOT be promoted into apps-src. `design.md` is
 * deliberately NOT excluded — it is promoted with the app.
 */
export function isEphemeralDraftPath(rel: string): boolean {
  const norm = rel.split(path.sep).join('/')
  return EPHEMERAL_DRAFT_ENTRIES.some((e) => norm === e || norm.startsWith(e + '/'))
}

/**
 * Resolve a directory to its real path before passing to `fs.cpSync`. In dev,
 * `apps-src/<id>` is a symlink; `cpSync` lstat's a symlinked root as
 * non-directory and fails on both source ("Cannot overwrite directory with
 * non-directory") and destination ("Cannot overwrite non-directory with
 * directory"). Resolving sidesteps both. Falls back to the original path when
 * the dir doesn't exist yet (e.g. a new-app promote destination).
 */
function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

/**
 * Materialize a draft worktree.
 *  - EDIT (`liveSrcDir` set): deep-copy live app source, resolving symlinks.
 *  - NEW-APP (`liveSrcDir` null): create `draftDir` only; agent scaffolds from scratch.
 * Does not create `.shadow/`, `.claude/`, or `.meta.json` — caller adds those.
 */
export function materializeDraftWorktree(opts: {
  liveSrcDir: string | null
  draftDir: string
}): void {
  const { liveSrcDir, draftDir } = opts
  fs.mkdirSync(draftDir, { recursive: true })
  if (liveSrcDir) {
    fs.cpSync(realDir(liveSrcDir), draftDir, { recursive: true, dereference: true })
  }
}

/**
 * Copy a skill directory from `<repo>/.claude/skills/<name>` into the draft's
 * `.claude/skills/<name>`. Returns false (and warns) when the source is absent,
 * so draft creation succeeds even if skill files are not yet present.
 */
export function materializeSkill(repoSkillDir: string, destSkillDir: string): boolean {
  if (!fs.existsSync(repoSkillDir)) {
    console.warn(`[draft-fs] skill source missing, skipping materialize: ${repoSkillDir}`)
    return false
  }
  fs.mkdirSync(path.dirname(destSkillDir), { recursive: true })
  // dereference: resolves the `references/` symlink into real files.
  fs.cpSync(repoSkillDir, destSkillDir, { recursive: true, dereference: true })
  return true
}

/**
 * Mirror `srcDir`'s promotable content into `destDir`: copy/overwrite all
 * source files AND prune destination files the source no longer has (so a
 * rename like `add-expense.ts` → `add_expense.ts` doesn't leave the old file
 * loadable). An overlay copy can't handle deletions, which is why both Promote
 * and its rollback go through here.
 *
 * Excluded (never copied, never pruned): `.shadow/`, `.claude/`, `.meta.json`,
 * `.progress.md`, `.git/`.
 */
export function mirrorInto(srcDir: string, destDir: string): void {
  // Resolve both ends: a symlinked root confuses cpSync (see realDir). mkdir
  // the dest first so realDir returns it unchanged for brand-new destinations.
  const realSrc = realDir(srcDir)
  fs.mkdirSync(destDir, { recursive: true })
  const realDest = realDir(destDir)

  // 1. Copy/overwrite the source's promotable files into the destination.
  fs.cpSync(realSrc, realDest, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (s) => {
      const rel = path.relative(realSrc, s)
      if (rel === '') return true // the root itself
      return !isEphemeralDraftPath(rel)
    },
  })

  // 2. Prune destination entries the source no longer has (deletions/renames),
  //    never touching ephemerals or `.git`.
  pruneOrphans(realSrc, realDest)
}

/**
 * Recursively delete entries under `destRoot` that have no counterpart under
 * `srcRoot`, skipping ephemeral/server-owned paths and `.git`. Descends into
 * surviving directories so a renamed file deep in the tree is still pruned.
 */
function pruneOrphans(srcRoot: string, destRoot: string): void {
  const walk = (relDir: string): void => {
    const absDestDir = path.join(destRoot, relDir)
    for (const name of fs.readdirSync(absDestDir)) {
      const rel = relDir ? path.join(relDir, name) : name
      const relPosix = rel.split(path.sep).join('/')
      if (relPosix === '.git' || relPosix.startsWith('.git/')) continue
      if (isEphemeralDraftPath(relPosix)) continue
      const absDest = path.join(destRoot, rel)
      if (!fs.existsSync(path.join(srcRoot, rel))) {
        fs.rmSync(absDest, { recursive: true, force: true })
        continue
      }
      if (fs.statSync(absDest).isDirectory()) walk(rel)
    }
  }
  walk('')
}

/**
 * App `.ts` files the draft has changed relative to its live baseline —
 * used to diff-scope the typecheck so pre-existing errors in untouched files
 * don't block an unrelated edit. Returns absolute paths (to match `tsc` output).
 *  - EDIT: a file is "changed" if absent in `liveSrcDir` or content differs.
 *  - NEW-APP (`liveSrcDir == null`): every app `.ts` counts.
 * Excludes ephemerals and `*.test.ts`.
 */
export function changedAppFiles(draftDir: string, liveSrcDir: string | null): string[] {
  const realDraft = realDir(draftDir)
  const realLive = liveSrcDir ? realDir(liveSrcDir) : null
  const out: string[] = []
  const walk = (relDir: string): void => {
    const absDir = path.join(realDraft, relDir)
    let entries: string[]
    try {
      entries = fs.readdirSync(absDir)
    } catch {
      return
    }
    for (const name of entries) {
      const rel = relDir ? path.join(relDir, name) : name
      const relPosix = rel.split(path.sep).join('/')
      if (isEphemeralDraftPath(relPosix)) continue
      const abs = path.join(realDraft, rel)
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(rel)
        continue
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      if (!realLive) {
        out.push(abs)
        continue
      } // new-app: all files are new
      let changed: boolean
      try {
        changed = fs.readFileSync(abs, 'utf8') !== fs.readFileSync(path.join(realLive, rel), 'utf8')
      } catch {
        changed = true // absent in live (or unreadable) → treat as changed
      }
      if (changed) out.push(abs)
    }
  }
  walk('')
  return out
}

/** Snapshot a directory for promote rollback. Caller places it under `<home>/tmp/`. */
export function snapshotDir(srcDir: string, destDir: string): void {
  fs.mkdirSync(path.dirname(destDir), { recursive: true })
  // In dev, snapshot source may be a symlink into the repo checkout — resolve it.
  fs.cpSync(realDir(srcDir), destDir, { recursive: true, dereference: true })
}

/**
 * Remove a draft worktree (includes `.shadow/`, `.claude/`, `.meta.json`).
 * Idempotent. `maxRetries`/`retryDelay`: on Windows, an in-flight SQLite handle
 * on `.shadow/db.sqlite` can briefly hold a lock during abort; the retry
 * rides out that window (EBUSY/EPERM/ENOTEMPTY).
 */
export function removeDraftWorktree(draftDir: string): void {
  fs.rmSync(draftDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** Remove a tmp path (rollback snapshot / migration-check clone). Idempotent. */
export function removeTmpPath(p: string): void {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
