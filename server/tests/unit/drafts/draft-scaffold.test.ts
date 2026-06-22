/**
 * Unit test for draft-scaffold.ts — a new-app draft arrives pre-scaffolded with
 * a generic, valid skeleton stamped from the build-skill templates.
 */

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scaffoldNewAppDraft } from '../../../src/server/drafts/draft-scaffold.js'

// skillsRepoDir = <repo>/.claude/skills (server cwd's parent), matching main.ts.
const SKILLS_REPO_DIR = path.resolve(process.cwd(), '..', '.claude', 'skills')

describe('scaffoldNewAppDraft', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('stamps a generic skeleton (entry + manifest + schema + dirs)', () => {
    const draft = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-scaffold-'))
    tmpDirs.push(draft)

    expect(scaffoldNewAppDraft(SKILLS_REPO_DIR, draft)).toBe(true)

    // Files + dirs present.
    for (const f of ['index.ts', 'manifest.ts', 'schema.ts']) {
      expect(fs.existsSync(path.join(draft, f))).toBe(true)
    }
    for (const d of ['tools', 'faces', 'drizzle']) {
      expect(fs.statSync(path.join(draft, d)).isDirectory()).toBe(true)
    }
    // Generic factory the loader accepts; no leftover __PASCAL_NAME__ token.
    const index = fs.readFileSync(path.join(draft, 'index.ts'), 'utf8')
    expect(index).toContain('export function createAppDef(): AppDefinition')
    // No leftover template placeholders (but __dirname is legitimately present).
    expect(index).not.toContain('__APP')
    expect(index).not.toContain('__PASCAL')
    // Manifest carries the required version (the template was missing it).
    expect(fs.readFileSync(path.join(draft, 'manifest.ts'), 'utf8')).toContain("version: '0.1.0'")
  })

  it('fail-soft: returns false (no throw) when the templates dir is absent', () => {
    const draft = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-scaffold-'))
    tmpDirs.push(draft)
    expect(scaffoldNewAppDraft(path.join(draft, 'nope'), draft)).toBe(false)
  })
})
