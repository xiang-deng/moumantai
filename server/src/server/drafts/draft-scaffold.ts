/**
 * Pre-stamp a generic app skeleton into a NEW-APP draft worktree so it arrives
 * pre-scaffolded (symmetric with EDIT drafts). The skeleton is id-agnostic —
 * the agent fills id/name per its plan. Reads templates from the build skill
 * as the single source of truth. Fail-soft: missing templates dir logs and
 * returns false without aborting draft creation.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Generic substitutions: the agent fills id/name/desc later. */
const GENERIC_SUBS: Record<string, string> = {
  __PASCAL_NAME__: 'App', // → createAppDef (loader accepts create*Def)
  __APP_ID__: '', // agent sets manifest.id per the approved plan
  __APP_ID_SNAKE__: 'app', // placeholder table name (agent replaces schema)
  __APP_ID_UNDERSCORE__: 'app',
  __APP_NAME__: '',
  __APP_DESC__: '',
  __ICON__: 'widgets',
}

function stamp(templatesDir: string, tmpl: string, destPath: string): void {
  const src = path.join(templatesDir, tmpl)
  if (!fs.existsSync(src)) return
  let content = fs.readFileSync(src, 'utf8')
  for (const [k, v] of Object.entries(GENERIC_SUBS)) content = content.split(k).join(v)
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, content)
}

/**
 * Stamp the generic skeleton into `draftDir`. `skillsRepoDir` is the repo's
 * skills dir (`<repo>/.claude/skills`); templates live under
 * `build-moumantai-app/templates/`. Returns false (and logs) if missing.
 */
export function scaffoldNewAppDraft(skillsRepoDir: string, draftDir: string): boolean {
  const templatesDir = path.join(skillsRepoDir, 'build-moumantai-app', 'templates')
  if (!fs.existsSync(templatesDir)) {
    console.warn(`[draft-scaffold] templates missing, skipping skeleton: ${templatesDir}`)
    return false
  }
  stamp(templatesDir, 'index.ts.tmpl', path.join(draftDir, 'index.ts'))
  stamp(templatesDir, 'manifest.ts.tmpl', path.join(draftDir, 'manifest.ts'))
  stamp(templatesDir, 'schema.ts.tmpl', path.join(draftDir, 'schema.ts'))
  stamp(templatesDir, 'design.md.tmpl', path.join(draftDir, 'design.md'))
  for (const d of ['tools', 'faces', 'drizzle']) {
    fs.mkdirSync(path.join(draftDir, d), { recursive: true })
  }
  return true
}
