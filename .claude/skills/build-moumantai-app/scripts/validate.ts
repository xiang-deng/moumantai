#!/usr/bin/env node
/**
 * Phase-gate validator for a mini app under apps/<id>/.
 *
 * Run via:
 *   npx tsx .claude/skills/build-moumantai-app/scripts/validate.ts apps/<id>
 *
 * Checks:
 *   - Required files present (design.md, manifest.ts, index.ts, schema.ts,
 *     drizzle/*.sql, ≥1 tool, ≥1 face, integration test, e2e test).
 *   - At least one face has both default + .expanded.ts variant.
 *   - All imports from whitelisted roots; local imports carry .js extension;
 *     no client/↔server/ crossing.
 *   - Every absolute pathRef('/a/b') in faces/*.ts appears in the integration
 *     test's asserted resolver shape (best-effort static scan).
 *   - TypeScript type-check via `tsc --noEmit -p server` limited to
 *     the app's files (run only if --tsc flag passed to avoid heavy default cost).
 *
 * Exits 0 on pass, 1 on any violation. Prints a short, grouped report.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join, resolve, relative, basename } from 'path'
import { spawnSync } from 'child_process'

interface Finding {
  level: 'error' | 'warn'
  where: string
  msg: string
}

const findings: Finding[] = []

function err(where: string, msg: string) {
  findings.push({ level: 'error', where, msg })
}
function warn(where: string, msg: string) {
  findings.push({ level: 'warn', where, msg })
}

const IMPORT_WHITELIST_PREFIXES = [
  'moumantai',
  'moumantai/ui',
  'drizzle-orm',
  'drizzle-orm/sqlite-core',
  'drizzle-orm/better-sqlite3',
  'path',
  'url',
  'fs',
  'crypto',
  'node:',
  'vitest',
]

function isWhitelistedImport(spec: string): boolean {
  if (spec.startsWith('./') || spec.startsWith('../')) return true
  for (const p of IMPORT_WHITELIST_PREFIXES) {
    if (spec === p || spec.startsWith(p + '/')) return true
  }
  return false
}

function listFiles(dir: string, recurse = false): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (recurse) out.push(...listFiles(full, true))
      continue
    }
    out.push(full)
  }
  return out
}

function checkRequiredFiles(appDir: string): void {
  const mustExist = ['design.md', 'manifest.ts', 'index.ts', 'schema.ts']
  for (const f of mustExist) {
    if (!existsSync(join(appDir, f))) err(f, 'required file missing')
  }

  const drizzleDir = join(appDir, 'drizzle')
  const sqls = listFiles(drizzleDir).filter((f) => f.endsWith('.sql'))
  if (sqls.length === 0)
    err(
      'drizzle/*.sql',
      'no migration SQL committed — run `cd server && npm run db:generate -- <app-id>`',
    )

  const toolFiles = listFiles(join(appDir, 'tools')).filter((f) => f.endsWith('.ts'))
  if (toolFiles.length === 0) err('tools/', 'at least one tool .ts required')

  // Face files may live flat (faces/<id>.ts) or in per-face subdirs (faces/<id>/<id>.ts).
  const facesDir = join(appDir, 'faces')
  const faceFiles = collectFaceFiles(facesDir)
  if (faceFiles.length === 0)
    err(
      'faces/',
      'at least one face .ts required (flat faces/<id>.ts or subdir faces/<id>/<id>.ts)',
    )
}

/** Return all face `.ts` files under faces/, one level deep, excluding .resolve.ts/.parts.ts helpers. */
function collectFaceFiles(
  facesDir: string,
): { absPath: string; relPath: string; fileName: string }[] {
  const out: { absPath: string; relPath: string; fileName: string }[] = []
  if (!existsSync(facesDir)) return out
  for (const entry of readdirSync(facesDir)) {
    const full = join(facesDir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      for (const sub of readdirSync(full)) {
        if (!sub.endsWith('.ts')) continue
        out.push({ absPath: join(full, sub), relPath: `${entry}/${sub}`, fileName: sub })
      }
    } else if (st.isFile() && entry.endsWith('.ts')) {
      out.push({ absPath: full, relPath: entry, fileName: entry })
    }
  }
  return out
}

function checkFaceVariants(
  appDir: string,
): Map<
  string,
  { hasDefault: boolean; hasExpanded: boolean; files: { fileName: string; relPath: string }[] }
> {
  const faces = new Map<
    string,
    { hasDefault: boolean; hasExpanded: boolean; files: { fileName: string; relPath: string }[] }
  >()
  const facesDir = join(appDir, 'faces')
  if (!existsSync(facesDir)) return faces

  for (const fe of collectFaceFiles(facesDir)) {
    if (fe.fileName.endsWith('.resolve.ts') || fe.fileName.endsWith('.parts.ts')) continue
    const base = fe.fileName.slice(0, -3)
    let id = base
    let variant: 'default' | 'compact' | 'expanded' = 'default'
    for (const sc of ['compact', 'expanded'] as const) {
      if (base.endsWith(`.${sc}`)) {
        id = base.slice(0, -(sc.length + 1))
        variant = sc
        break
      }
    }
    const rec = faces.get(id) ?? {
      hasDefault: false,
      hasExpanded: false,
      files: [] as { fileName: string; relPath: string }[],
    }
    rec.files.push({ fileName: fe.fileName, relPath: fe.relPath })
    if (variant === 'default' || variant === 'compact') rec.hasDefault = true
    if (variant === 'expanded') rec.hasExpanded = true
    faces.set(id, rec)
  }

  if ([...faces.values()].every((v) => !v.hasExpanded)) {
    warn(
      'faces/',
      'no face ships an `.expanded.ts` phone variant — compact-only is allowed but unusual',
    )
  }

  // Cross-check `index.ts` vs face files on disk. Two rules:
  //
  // A. Every compact/default face file must be imported + present in the
  //    `faces: [...]` array so the AppEngine registers it as the default.
  // B. Expanded variants must NOT be registered in `faces: [...]`; the
  //    framework's supplemental scan loads them by size class.
  const indexPath = join(appDir, 'index.ts')
  if (existsSync(indexPath)) {
    const indexSrc = readFileSync(indexPath, 'utf8')
    const facesArrayMatch = indexSrc.match(/faces\s*:\s*\[([\s\S]*?)\]/)
    const facesArraySrc = facesArrayMatch ? facesArrayMatch[1]! : ''

    for (const [faceId, rec] of faces.entries()) {
      for (const f of rec.files) {
        const moduleBase = f.fileName.replace(/\.ts$/, '')
        const isExpandedVariant = /\.expanded$/.test(moduleBase)
        // Match any import from this face file — accepts both layouts:
        //   flat:    './faces/<id>.js'
        //   subdir:  './faces/<id>/<id>.js' (or any one-level subdir)
        const importRe = new RegExp(
          `import\\s+(\\w+)\\s+from\\s+['"]\\./faces/(?:[^'"]+/)?${moduleBase.replace(/\./g, '\\.')}\\.js['"]`,
        )
        const importMatch = indexSrc.match(importRe)

        if (!isExpandedVariant) {
          if (!importMatch) {
            err('index.ts', `default face file "faces/${f.relPath}" is not imported`)
            continue
          }
          const name = importMatch[1]!
          if (!new RegExp(`\\b${name}\\b`).test(facesArraySrc)) {
            err(
              'index.ts',
              `default face "${faceId}" is imported as \`${name}\` but not present in the \`faces: [...]\` array`,
            )
          }
        } else {
          if (importMatch) {
            const name = importMatch[1]!
            if (new RegExp(`\\b${name}\\b`).test(facesArraySrc)) {
              err(
                'index.ts',
                `expanded face "faces/${f.relPath}" is registered in \`faces: [...]\` as \`${name}\`. Remove it — expanded variants are auto-loaded by the framework scan.`,
              )
            }
          }
        }
      }
    }
  }
  return faces
}

const IMPORT_RE = /^\s*import\s+(?:(?:[\w*{},\s]+)\s+from\s+)?['"]([^'"]+)['"]/gm

function checkImports(appDir: string): void {
  const tsFiles = [
    join(appDir, 'index.ts'),
    join(appDir, 'manifest.ts'),
    join(appDir, 'schema.ts'),
    ...listFiles(join(appDir, 'tools')).filter((f) => f.endsWith('.ts')),
    ...collectFaceFiles(join(appDir, 'faces')).map((f) => f.absPath),
  ].filter(existsSync)

  for (const file of tsFiles) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(appDir, file)
    IMPORT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1]!

      if (!isWhitelistedImport(spec)) {
        err(rel, `non-whitelisted import: "${spec}"`)
        continue
      }

      if (spec.startsWith('./') || spec.startsWith('../')) {
        if (!spec.endsWith('.js')) {
          err(rel, `local import missing .js extension: "${spec}"`)
        }
        if (spec.includes('/client/') || spec.includes('/server/')) {
          err(rel, `crosses client/server boundary: "${spec}"`)
        }
      }
    }
  }
}

const PATHREF_RE = /pathRef\(\s*['"]([^'"]+)['"]\s*\)/g

function collectPathRefs(appDir: string): Map<string, string[]> {
  // Absolute pathRefs only. Template-scoped '$.foo' needs a different check.
  const out = new Map<string, string[]>()
  for (const fe of collectFaceFiles(join(appDir, 'faces'))) {
    const src = readFileSync(fe.absPath, 'utf8')
    PATHREF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATHREF_RE.exec(src)) !== null) {
      const p = m[1]!
      if (!p.startsWith('/')) continue
      const list = out.get(p) ?? []
      list.push(`faces/${fe.relPath}`)
      out.set(p, list)
    }
  }
  return out
}

function checkRootComponentId(appDir: string): void {
  const facesDir = join(appDir, 'faces')
  for (const fe of collectFaceFiles(facesDir)) {
    if (fe.fileName.endsWith('.resolve.ts') || fe.fileName.endsWith('.parts.ts')) continue
    const src = readFileSync(fe.absPath, 'utf8')
    if (/scaffold\(/.test(src) && !/scaffold\(\s*['"]root['"]/.test(src)) {
      err(`faces/${fe.relPath}`, 'scaffold(...) root component id must be literally "root"')
    }
  }
}

function checkResolverContract(appDir: string, repoRoot: string): void {
  const appId = basename(appDir)
  const testPath = join(repoRoot, 'server', 'tests', 'integration', `${appId}.test.ts`)
  if (!existsSync(testPath)) {
    err('tests/integration/' + appId + '.test.ts', 'integration test file missing')
    return
  }
  const e2ePath = join(repoRoot, 'server', 'tests', 'e2e', `test_${appId.replace(/-/g, '_')}.py`)
  if (!existsSync(e2ePath))
    err('tests/e2e/test_' + appId.replace(/-/g, '_') + '.py', 'e2e test file missing')

  const testSrc = readFileSync(testPath, 'utf8')
  const paths = collectPathRefs(appDir)
  for (const [path, locs] of paths.entries()) {
    const keys = path.split('/').filter(Boolean)
    // Very best-effort: every top-level key should appear as a property name
    // somewhere in the test (this catches the gross "/summary" vs "/summary_display" renames).
    const topKey = keys[0]!
    const re = new RegExp(
      `['"]?\\b${topKey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b['"]?\\s*:`,
      'g',
    )
    if (!re.test(testSrc)) {
      err(
        locs.join(', '),
        `pathRef("${path}") — key "${topKey}" not referenced in integration test. Resolver contract drift?`,
      )
    }
  }
}

function runTsc(appDir: string, repoRoot: string): void {
  const tsconfig = join(repoRoot, 'server', 'tsconfig.json')
  if (!existsSync(tsconfig)) {
    warn('tsc', 'server/tsconfig.json not found; skipping type-check')
    return
  }
  const proc = spawnSync('npx', ['tsc', '--noEmit', '-p', tsconfig], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (proc.status !== 0) {
    const out = (proc.stdout || '') + (proc.stderr || '')
    const appId = basename(appDir)
    const appLines = out
      .split('\n')
      .filter((line) => line.includes(`apps/${appId}/`) || line.includes(`apps\\${appId}\\`))
    if (appLines.length > 0) {
      err(
        'tsc',
        `type-check failed for apps/${appId}:\n    ` + appLines.slice(0, 10).join('\n    '),
      )
    } else {
      warn(
        'tsc',
        `full type-check failed but no errors touch apps/${appId}; may be unrelated:\n    ` +
          out.split('\n').slice(0, 5).join('\n    '),
      )
    }
  }
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  const doTsc = argv.includes('--tsc')
  const targetArg = argv.find((a) => !a.startsWith('--'))
  if (!targetArg) {
    console.error('usage: validate.ts <apps/<id>> [--tsc]')
    process.exit(2)
  }
  const appDir = resolve(targetArg)
  if (!existsSync(appDir)) {
    console.error(`not found: ${appDir}`)
    process.exit(2)
  }

  // repoRoot: walk up from appDir until we find a dir containing .git or CLAUDE.md
  let repoRoot = appDir
  while (repoRoot !== '/' && repoRoot.length > 3) {
    if (existsSync(join(repoRoot, 'CLAUDE.md')) || existsSync(join(repoRoot, '.git'))) break
    const parent = resolve(repoRoot, '..')
    if (parent === repoRoot) break
    repoRoot = parent
  }

  checkRequiredFiles(appDir)
  checkFaceVariants(appDir)
  checkImports(appDir)
  checkRootComponentId(appDir)
  checkResolverContract(appDir, repoRoot)
  if (doTsc) runTsc(appDir, repoRoot)

  const errors = findings.filter((f) => f.level === 'error')
  const warnings = findings.filter((f) => f.level === 'warn')

  if (errors.length === 0 && warnings.length === 0) {
    console.log(`OK: ${relative(repoRoot, appDir)} passes all skill validator checks.`)
    process.exit(0)
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`)
    for (const f of errors) console.log(`  [${f.where}] ${f.msg}`)
  }
  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`)
    for (const f of warnings) console.log(`  [${f.where}] ${f.msg}`)
  }
  process.exit(errors.length > 0 ? 1 : 0)
}

main()
