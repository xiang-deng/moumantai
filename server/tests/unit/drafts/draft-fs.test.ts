/**
 * Unit tests for draft-fs.ts — isEphemeralDraftPath (pure) + the
 * symlinked-source-root copy guard in materializeDraftWorktree.
 */

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isEphemeralDraftPath,
  materializeDraftWorktree,
  mirrorInto,
  changedAppFiles,
} from '../../../src/server/drafts/draft-fs.js'

describe('isEphemeralDraftPath', () => {
  // ---- TRUE cases: server-owned / scratch paths that must be excluded ----

  it('returns true for .shadow (bare)', () => {
    expect(isEphemeralDraftPath('.shadow')).toBe(true)
  })

  it('returns true for .shadow/db.sqlite (file under .shadow)', () => {
    expect(isEphemeralDraftPath('.shadow/db.sqlite')).toBe(true)
  })

  it('returns true for .shadow/ deep paths', () => {
    expect(isEphemeralDraftPath('.shadow/nested/file.db')).toBe(true)
  })

  it('returns true for .claude (bare)', () => {
    expect(isEphemeralDraftPath('.claude')).toBe(true)
  })

  it('returns true for .claude/skills/x', () => {
    expect(isEphemeralDraftPath('.claude/skills/edit-moumantai-app')).toBe(true)
  })

  it('returns true for .claude/settings.json', () => {
    expect(isEphemeralDraftPath('.claude/settings.json')).toBe(true)
  })

  it('returns true for .meta.json', () => {
    expect(isEphemeralDraftPath('.meta.json')).toBe(true)
  })

  it('returns true for .progress.md', () => {
    expect(isEphemeralDraftPath('.progress.md')).toBe(true)
  })

  // ---- FALSE cases: app source paths that should be promoted ----

  it('returns false for index.ts (app entry)', () => {
    expect(isEphemeralDraftPath('index.ts')).toBe(false)
  })

  it('returns false for faces/x.ts', () => {
    expect(isEphemeralDraftPath('faces/x.ts')).toBe(false)
  })

  it('returns false for design.md (deliberately promoted)', () => {
    expect(isEphemeralDraftPath('design.md')).toBe(false)
  })

  it('returns false for empty string (root itself)', () => {
    expect(isEphemeralDraftPath('')).toBe(false)
  })

  it('returns false for schema.ts', () => {
    expect(isEphemeralDraftPath('schema.ts')).toBe(false)
  })

  it('returns false for tools/add-note.ts', () => {
    expect(isEphemeralDraftPath('tools/add-note.ts')).toBe(false)
  })

  it('returns false for drizzle/0001_init.sql', () => {
    expect(isEphemeralDraftPath('drizzle/0001_init.sql')).toBe(false)
  })

  it('returns false for manifest.ts', () => {
    expect(isEphemeralDraftPath('manifest.ts')).toBe(false)
  })

  // ---- Edge: paths that START WITH an ephemeral name but are not it ----

  it('returns false for .shadow.backup (not a prefix match)', () => {
    // ".shadow.backup" !== ".shadow" and does not start with ".shadow/"
    expect(isEphemeralDraftPath('.shadow.backup')).toBe(false)
  })

  it('returns false for .claude-settings (not a prefix match)', () => {
    expect(isEphemeralDraftPath('.claude-settings')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// materializeDraftWorktree — symlinked-source-root guard
//
// Regression: in dev, apps-src/<id> is a SYMLINK into the repo checkout.
// fs.cpSync lstats a symlinked source ROOT as a non-directory and refuses to
// copy it onto the real draftDir ("Cannot overwrite directory … with
// non-directory …"). materializeDraftWorktree must realpath the source first.
// ---------------------------------------------------------------------------

describe('materializeDraftWorktree (symlinked source)', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  // Some CI environments forbid symlink creation; skip gracefully there.
  function canSymlink(root: string): boolean {
    try {
      const t = path.join(root, '_t')
      const l = path.join(root, '_l')
      fs.mkdirSync(t)
      fs.symlinkSync(t, l, 'junction')
      fs.rmSync(l, { force: true })
      fs.rmSync(t, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  it('copies real files when liveSrcDir is a symlink into another dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-draftfs-'))
    tmpDirs.push(base)
    if (!canSymlink(base)) return // environment can't symlink — skip assertion

    // Real app source with a nested file.
    const realApp = path.join(base, 'apps', 'spend-tracker')
    fs.mkdirSync(path.join(realApp, 'faces'), { recursive: true })
    fs.writeFileSync(path.join(realApp, 'index.ts'), 'export const x = 1\n')
    fs.writeFileSync(path.join(realApp, 'faces', 'a.ts'), 'export const a = 2\n')

    // apps-src/<id> symlink → real app (the dev layout).
    const appsSrc = path.join(base, 'apps-src')
    fs.mkdirSync(appsSrc, { recursive: true })
    const liveSrcDir = path.join(appsSrc, 'spend-tracker')
    fs.symlinkSync(realApp, liveSrcDir, 'junction')

    const draftDir = path.join(base, 'apps-drafts', 'draft-1')

    // Before the fix this threw "Cannot overwrite directory … with non-directory …".
    expect(() => materializeDraftWorktree({ liveSrcDir, draftDir })).not.toThrow()

    // Files copied as REAL files (not symlinks).
    expect(fs.readFileSync(path.join(draftDir, 'index.ts'), 'utf8')).toContain('export const x = 1')
    expect(fs.readFileSync(path.join(draftDir, 'faces', 'a.ts'), 'utf8')).toContain(
      'export const a = 2',
    )
    expect(fs.lstatSync(path.join(draftDir, 'index.ts')).isSymbolicLink()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mirrorInto — promote/rollback's copy primitive
//
// Contract: dest's promotable subset ends up IDENTICAL to src — overwrites
// changed files, ADDS new ones, DELETES orphans (renames/deletes), leaves
// ephemerals + the dev `apps-src/<id>` symlink alone. This is what makes a
// promote land cleanly and a rollback fully revert.
// ---------------------------------------------------------------------------

describe('mirrorInto', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function canSymlink(root: string): boolean {
    try {
      const t = path.join(root, '_t')
      const l = path.join(root, '_l')
      fs.mkdirSync(t)
      fs.symlinkSync(t, l, 'junction')
      fs.rmSync(l, { force: true })
      fs.rmSync(t, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  it('makes a symlinked dest identical to src: overwrite + add + delete orphans, keep ephemerals', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-promote-'))
    tmpDirs.push(base)
    if (!canSymlink(base)) return // environment can't symlink — skip assertion

    // Live app (symlink target) with an OLD entry, a soon-to-be-renamed tool,
    // and a server-owned shadow DB that must survive.
    const realApp = path.join(base, 'apps', 'spend-tracker')
    fs.mkdirSync(path.join(realApp, 'tools'), { recursive: true })
    fs.mkdirSync(path.join(realApp, '.shadow'), { recursive: true })
    fs.writeFileSync(path.join(realApp, 'index.ts'), 'export const old = 1\n')
    fs.writeFileSync(path.join(realApp, 'tools', 'add-expense.ts'), 'kebab\n') // orphan after rename
    fs.writeFileSync(path.join(realApp, '.shadow', 'db.sqlite'), 'LIVE-DB')

    // Dev layout: apps-src/<id> is a symlink → real app.
    const appsSrc = path.join(base, 'apps-src')
    fs.mkdirSync(appsSrc, { recursive: true })
    const destSrcDir = path.join(appsSrc, 'spend-tracker')
    fs.symlinkSync(realApp, destSrcDir, 'junction')

    // Draft: entry changed, tool renamed kebab→snake, new face added, its own
    // ephemeral shadow DB (must NOT be promoted).
    const draftDir = path.join(base, 'apps-drafts', 'draft-1')
    fs.mkdirSync(path.join(draftDir, 'tools'), { recursive: true })
    fs.mkdirSync(path.join(draftDir, 'faces'), { recursive: true })
    fs.mkdirSync(path.join(draftDir, '.shadow'), { recursive: true })
    fs.writeFileSync(path.join(draftDir, 'index.ts'), 'export const updated = 2\n')
    fs.writeFileSync(path.join(draftDir, 'tools', 'add_expense.ts'), 'snake\n')
    fs.writeFileSync(path.join(draftDir, 'faces', 'new.ts'), 'export const n = 3\n')
    fs.writeFileSync(path.join(draftDir, '.shadow', 'db.sqlite'), 'DRAFT-DB')

    // Before the mirror fix this threw on the symlinked dest, and (when it ran)
    // left the orphaned kebab file behind.
    expect(() => mirrorInto(draftDir, destSrcDir)).not.toThrow()

    // Overwrote + added through the symlink, into the real tree.
    expect(fs.readFileSync(path.join(realApp, 'index.ts'), 'utf8')).toContain(
      'export const updated = 2',
    )
    expect(fs.readFileSync(path.join(realApp, 'tools', 'add_expense.ts'), 'utf8')).toContain(
      'snake',
    )
    expect(fs.readFileSync(path.join(realApp, 'faces', 'new.ts'), 'utf8')).toContain(
      'export const n = 3',
    )
    // Pruned the renamed orphan.
    expect(fs.existsSync(path.join(realApp, 'tools', 'add-expense.ts'))).toBe(false)
    // Draft's ephemeral was not promoted; live's shadow DB was left intact.
    expect(fs.readFileSync(path.join(realApp, '.shadow', 'db.sqlite'), 'utf8')).toBe('LIVE-DB')
    // Symlink preserved (not clobbered into a real dir).
    expect(fs.lstatSync(destSrcDir).isSymbolicLink()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// changedAppFiles — diff-scope baseline for the typecheck
// ---------------------------------------------------------------------------

describe('changedAppFiles', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function mk(base: string, rel: string, content: string): void {
    const p = path.join(base, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }

  it('EDIT: only files that differ from (or are absent in) the live baseline', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-changed-'))
    tmpDirs.push(base)
    const live = path.join(base, 'live')
    const draft = path.join(base, 'draft')
    // identical files in both
    mk(live, 'index.ts', 'A')
    mk(draft, 'index.ts', 'A')
    mk(live, 'faces/keep.ts', 'K')
    mk(draft, 'faces/keep.ts', 'K')
    // changed + new in the draft
    mk(live, 'faces/edit.ts', 'OLD')
    mk(draft, 'faces/edit.ts', 'NEW')
    mk(draft, 'faces/added.ts', 'X')
    // ephemerals + tests must be excluded even when changed
    mk(draft, '.shadow/db.sqlite', 'bin')
    mk(draft, 'faces/edit.test.ts', 'test')

    const rels = changedAppFiles(draft, live)
      .map((p) => path.relative(draft, p).split(path.sep).join('/'))
      .sort()
    expect(rels).toEqual(['faces/added.ts', 'faces/edit.ts'])
  })

  it('NEW-APP (liveSrcDir null): every app .ts counts, ephemerals/tests excluded', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-changed-'))
    tmpDirs.push(base)
    const draft = path.join(base, 'draft')
    mk(draft, 'index.ts', 'A')
    mk(draft, 'faces/x.ts', 'B')
    mk(draft, '.claude/skills/s.ts', 'skill') // ephemeral
    mk(draft, 'x.test.ts', 'test') // test

    const rels = changedAppFiles(draft, null)
      .map((p) => path.relative(draft, p).split(path.sep).join('/'))
      .sort()
    expect(rels).toEqual(['faces/x.ts', 'index.ts'])
  })
})
