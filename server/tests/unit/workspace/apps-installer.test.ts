import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  installApp,
  uninstallApp,
  updateApp,
  deleteAppRuntimeState,
  listInstalled,
  extractManifest,
  parseInstallSource,
} from '../../../src/server/workspace/apps-installer.js'
import { ensureHomeLayout, appPaths, homeLayout } from '../../../src/server/workspace/home.js'

let tmpRoot: string
let home: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-installer-'))
  home = path.join(tmpRoot, 'home')
  ensureHomeLayout(home)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeApp(
  id: string,
  opts: { version?: string; moumantaiMinVersion?: string } = {},
): string {
  const src = path.join(tmpRoot, 'src', id)
  fs.mkdirSync(src, { recursive: true })
  const version = opts.version ?? '0.1.0'
  const minLine = opts.moumantaiMinVersion
    ? `, moumantaiMinVersion: '${opts.moumantaiMinVersion}'`
    : ''
  fs.writeFileSync(
    path.join(src, 'manifest.ts'),
    `export const manifest = { id: '${id}', version: '${version}', name: 'X'${minLine} }\n`,
  )
  fs.writeFileSync(path.join(src, 'index.ts'), `export default { manifest }\n`)
  return src
}

describe('extractManifest', () => {
  it('extracts id from manifest.ts', () => {
    const dir = makeApp('spend-tracker')
    expect(extractManifest(dir, { requireVersion: false }).id).toBe('spend-tracker')
  })

  it('falls back to directory basename when manifest is absent', () => {
    const dir = path.join(tmpRoot, 'foo', 'no-manifest-app')
    fs.mkdirSync(dir, { recursive: true })
    expect(extractManifest(dir, { requireVersion: false }).id).toBe('no-manifest-app')
  })
})

describe('installApp', () => {
  it('symlinks (or junctions on Windows) the source into apps-src/<id>/', () => {
    const src = makeApp('spend-tracker')
    const result = installApp(home, src)
    expect(result.id).toBe('spend-tracker')
    // On systems where symlinks are permitted we expect 'link'; on others
    // the fallback kicks in. Both are correct.
    expect(['link', 'copy']).toContain(result.type)

    const installed = path.join(home, 'apps-src', 'spend-tracker')
    expect(fs.existsSync(installed)).toBe(true)
    // Manifest is reachable through the install (whether link or copy)
    const txt = fs.readFileSync(path.join(installed, 'manifest.ts'), 'utf8')
    expect(txt).toContain("id: 'spend-tracker'")
  })

  it('rejects invalid app ids', () => {
    const src = path.join(tmpRoot, 'BadCase')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(
      path.join(src, 'manifest.ts'),
      `export const manifest = { id: 'BadCase', version: '0.1.0' }\n`,
    )
    expect(() => installApp(home, src)).toThrow(/Invalid app id/)
  })

  it('is idempotent: re-install replaces previous entry', () => {
    const src = makeApp('diet-tracker')
    installApp(home, src)
    expect(() => installApp(home, src)).not.toThrow()
    expect(fs.existsSync(path.join(home, 'apps-src', 'diet-tracker'))).toBe(true)
  })

  it('throws on non-existent source', () => {
    expect(() => installApp(home, path.join(tmpRoot, 'nope'))).toThrow(/not a directory/)
  })

  it('falls back to copy when symlink throws EPERM', () => {
    const src = makeApp('copy-tracker')
    const orig = fs.symlinkSync
    vi.spyOn(fs, 'symlinkSync').mockImplementationOnce(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    const result = installApp(home, src)
    expect(result.type).toBe('copy')
    expect(result.warning).toMatch(/Symlinks not permitted/)
    // Verify the installed entry is a real directory + has copied content
    const installed = path.join(home, 'apps-src', 'copy-tracker')
    expect(fs.lstatSync(installed).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(installed, 'manifest.ts'), 'utf8')).toContain('copy-tracker')
    void orig
  })
})

describe('listInstalled', () => {
  it('returns sorted list with type info', () => {
    installApp(home, makeApp('a-app'))
    installApp(home, makeApp('b-app'))
    const apps = listInstalled(home)
    expect(apps.map((a) => a.id)).toEqual(['a-app', 'b-app'])
    for (const a of apps) {
      expect(['link', 'copy']).toContain(a.type)
    }
  })

  it('returns [] when apps-src is empty', () => {
    expect(listInstalled(home)).toEqual([])
  })
})

describe('uninstallApp + deleteAppRuntimeState', () => {
  it('removes apps-src entry but reports runtime state separately', () => {
    const src = makeApp('spend-tracker')
    installApp(home, src)

    // Simulate runtime state existing
    const ap = appPaths(home, 'spend-tracker')
    fs.mkdirSync(ap.root, { recursive: true })
    fs.writeFileSync(ap.dbFile, 'BYTES')

    const result = uninstallApp(home, 'spend-tracker')
    expect(result.removedSrc).toBe(true)
    expect(result.hasRuntimeState).toBe(true)
    expect(result.runtimeStateDir).toBe(ap.root)
    expect(fs.existsSync(path.join(home, 'apps-src', 'spend-tracker'))).toBe(false)
    // Runtime state still on disk — only deleted by explicit follow-up call
    expect(fs.existsSync(ap.dbFile)).toBe(true)

    deleteAppRuntimeState(home, 'spend-tracker')
    expect(fs.existsSync(ap.root)).toBe(false)
  })

  it('uninstall is idempotent for absent app', () => {
    const result = uninstallApp(home, 'never-installed')
    expect(result.removedSrc).toBe(false)
    expect(result.hasRuntimeState).toBe(false)
  })
})

describe('parseInstallSource', () => {
  it.each([
    ['./local', { kind: 'local', path: './local' }],
    ['/abs/path', { kind: 'local', path: '/abs/path' }],
    ['D:/win/path', { kind: 'local', path: 'D:/win/path' }],
    ['https://github.com/x/r', { kind: 'git', url: 'https://github.com/x/r', ref: 'HEAD' }],
    [
      'https://github.com/x/r#v0.2.0',
      { kind: 'git', url: 'https://github.com/x/r', ref: 'v0.2.0' },
    ],
    [
      'https://github.com/x/r#main:apps/foo',
      { kind: 'git', url: 'https://github.com/x/r', ref: 'main', subdir: 'apps/foo' },
    ],
    [
      'git+https://github.com/x/r#main',
      { kind: 'git', url: 'https://github.com/x/r', ref: 'main' },
    ],
    ['git@github.com:x/r.git#v1', { kind: 'git', url: 'git@github.com:x/r.git', ref: 'v1' }],
  ])('parses %s', (input, expected) => {
    expect(parseInstallSource(input)).toEqual(expected)
  })

  it('rejects empty input', () => {
    expect(() => parseInstallSource('')).toThrow(/Empty install source/)
  })
})

describe('manifest version validation', () => {
  it('throws actionable error when version is missing', () => {
    const src = path.join(tmpRoot, 'src', 'no-version')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(
      path.join(src, 'manifest.ts'),
      `export const manifest = { id: 'no-version', name: 'X' }\n`,
    )
    expect(() => installApp(home, src)).toThrow(/missing required field `version`/)
  })

  it('throws on invalid SemVer', () => {
    const src = path.join(tmpRoot, 'src', 'bad-ver')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(
      path.join(src, 'manifest.ts'),
      `export const manifest = { id: 'bad-ver', version: 'abc', name: 'X' }\n`,
    )
    expect(() => installApp(home, src)).toThrow(/Invalid SemVer version/)
  })

  it('throws on moumantaiMinVersion higher than engine version', () => {
    const src = makeApp('future-app', { moumantaiMinVersion: '99.0.0' })
    expect(() => installApp(home, src)).toThrow(/requires Moumantai >= 99\.0\.0/)
  })
})

// ---------------------------------------------------------------------------
// Git source — set up a local bare repo as the "remote".
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || 'exit ' + r.status}`)
  return r.stdout
}

function setupBareWithApp(opts: { id: string; version: string; subdir?: string }): {
  bareUrl: string
  workDir: string
} {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'remote-'))
  const bare = path.join(root, 'remote.git')
  const work = path.join(root, 'work')
  spawnSync('git', ['init', '--bare', '--quiet', bare], { encoding: 'utf8' })
  spawnSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { encoding: 'utf8' })
  spawnSync('git', ['init', '--quiet', '--initial-branch=main', work], { encoding: 'utf8' })
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'Test')

  const dir = opts.subdir ? path.join(work, opts.subdir) : work
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.ts'),
    `export const manifest = { id: '${opts.id}', version: '${opts.version}', name: 'X' }\n`,
  )
  fs.writeFileSync(path.join(dir, 'index.ts'), `export default {}\n`)
  git(work, 'add', '.')
  git(work, 'commit', '--quiet', '-m', 'initial')
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '--quiet', 'origin', 'main')
  return { bareUrl: bare, workDir: work }
}

describe('git-source install', () => {
  it('clones, materializes, writes meta, and is up-to-date for update', () => {
    const { bareUrl } = setupBareWithApp({ id: 'remote-app', version: '0.1.0' })
    const result = installApp(home, `file://${bareUrl}`)
    expect(result.id).toBe('remote-app')
    expect(result.version).toBe('0.1.0')
    expect(result.origin.type).toBe('git')

    // Source materialized
    const installed = path.join(home, 'apps-src', 'remote-app')
    expect(fs.existsSync(path.join(installed, 'manifest.ts'))).toBe(true)

    // Meta file written
    const meta = JSON.parse(
      fs.readFileSync(path.join(homeLayout(home).appsMetaDir, 'remote-app.json'), 'utf8'),
    )
    expect(meta.id).toBe('remote-app')
    expect(meta.version).toBe('0.1.0')
    expect(meta.origin.type).toBe('git')
    expect(meta.origin.commit).toMatch(/^[0-9a-f]{40}$/)

    // No update available initially
    const r = updateApp(home, 'remote-app')
    expect(r.updated).toBe(false)
    expect(r.reason).toMatch(/up to date/)
  })

  it('subdir fragment installs only the requested subtree', () => {
    const { bareUrl } = setupBareWithApp({
      id: 'sub-app',
      version: '0.2.0',
      subdir: 'apps/sub-app',
    })
    const result = installApp(home, `file://${bareUrl}#main:apps/sub-app`)
    expect(result.id).toBe('sub-app')
    if (result.origin.type === 'git') {
      expect(result.origin.subdir).toBe('apps/sub-app')
      expect(result.origin.ref).toBe('main')
    }
  })

  it('updateApp re-fetches when commit advances', () => {
    const { bareUrl, workDir } = setupBareWithApp({ id: 'evolving', version: '0.1.0' })
    installApp(home, `file://${bareUrl}`)

    // Push a new commit bumping version → 0.2.0
    fs.writeFileSync(
      path.join(workDir, 'manifest.ts'),
      `export const manifest = { id: 'evolving', version: '0.2.0', name: 'X' }\n`,
    )
    git(workDir, 'add', '.')
    git(workDir, 'commit', '--quiet', '-m', 'bump')
    git(workDir, 'push', '--quiet', 'origin', 'main')

    const r = updateApp(home, 'evolving')
    expect(r.updated).toBe(true)
    expect(r.fromVersion).toBe('0.1.0')
    expect(r.toVersion).toBe('0.2.0')
    expect(r.fromCommit).not.toBe(r.toCommit)
  })
})

describe('updateApp on local installs', () => {
  it('returns updated=false with a clear reason', () => {
    const src = makeApp('local-link-app')
    installApp(home, src)
    const r = updateApp(home, 'local-link-app')
    expect(r.updated).toBe(false)
    expect(r.reason).toMatch(/local/i)
  })
})

describe('listInstalled with meta', () => {
  it('reports version + origin from meta when present', () => {
    const src = makeApp('with-meta', { version: '0.3.0' })
    installApp(home, src)
    const apps = listInstalled(home)
    const found = apps.find((a) => a.id === 'with-meta')
    expect(found?.version).toBe('0.3.0')
    expect(found?.origin?.type).toBe('local')
  })
})
