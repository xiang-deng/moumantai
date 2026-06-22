import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  RegistryFileSchema,
  fetchRegistry,
  resolveAppFromRegistry,
} from '../../../src/server/workspace/registry.js'
import { ensureHomeLayout } from '../../../src/server/workspace/home.js'

let tmpRoot: string
let home: string

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || 'exit ' + r.status}`)
  return r.stdout
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-registry-'))
  home = path.join(tmpRoot, 'home')
  ensureHomeLayout(home)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('RegistryFileSchema', () => {
  it('defaults version + apps to []', () => {
    const f = RegistryFileSchema.parse({ name: 'empty' })
    expect(f.version).toBe('1')
    expect(f.apps).toEqual([])
  })
})

describe('fetchRegistry from local path', () => {
  it('reads registry.json from a directory', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'registry.json'),
      JSON.stringify({ name: 'local', apps: [{ id: 'a', version: '0.1.0' }] }),
    )
    const r = fetchRegistry(home, tmpRoot)
    expect(r.registry.name).toBe('local')
    expect(r.registry.apps[0]?.id).toBe('a')
  })

  it('throws on missing registry.json', () => {
    expect(() => fetchRegistry(home, tmpRoot)).toThrow(/No registry\.json/)
  })

  it('throws on invalid JSON', () => {
    fs.writeFileSync(path.join(tmpRoot, 'registry.json'), '{ broken')
    expect(() => fetchRegistry(home, tmpRoot)).toThrow(/Invalid JSON/)
  })
})

describe('fetchRegistry from git URL', () => {
  it('fetches from a local bare repo and parses', () => {
    // Set up a tiny bare repo with a registry.json at HEAD.
    const bare = path.join(tmpRoot, 'remote.git')
    const work = path.join(tmpRoot, 'work')
    spawnSync('git', ['init', '--bare', '--quiet', bare])
    spawnSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    spawnSync('git', ['init', '--quiet', '--initial-branch=main', work])
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'Test')
    fs.writeFileSync(
      path.join(work, 'registry.json'),
      JSON.stringify({
        name: 'git-registry',
        apps: [{ id: 'foo', version: '0.1.0', subdir: 'foo' }],
      }),
    )
    git(work, 'add', 'registry.json')
    git(work, 'commit', '--quiet', '-m', 'initial')
    git(work, 'remote', 'add', 'origin', bare)
    git(work, 'push', '--quiet', 'origin', 'main')

    const r = fetchRegistry(home, `file://${bare}`)
    expect(r.registry.name).toBe('git-registry')
    expect(r.registry.apps[0]?.id).toBe('foo')
  })
})

describe('resolveAppFromRegistry', () => {
  it('resolves a known id to a git InstallSource using the registry URL', () => {
    const resolved = resolveAppFromRegistry(
      {
        url: 'https://github.com/x/repo',
        registry: {
          name: 'r',
          version: '1',
          apps: [{ id: 'foo', version: '0.1.0', subdir: 'foo' }],
        },
      },
      'foo',
    )
    expect(resolved).toEqual({
      kind: 'git',
      url: 'https://github.com/x/repo',
      ref: 'HEAD',
      subdir: 'foo',
    })
  })

  it('respects per-entry repo + ref overrides', () => {
    const resolved = resolveAppFromRegistry(
      {
        url: 'https://github.com/curator/registry',
        registry: {
          name: 'curator',
          version: '1',
          apps: [{ id: 'foo', version: '0.1.0', repo: 'https://github.com/other/repo', ref: 'v1' }],
        },
      },
      'foo',
    )
    expect(resolved).toEqual({ kind: 'git', url: 'https://github.com/other/repo', ref: 'v1' })
  })

  it('throws with known-id list when id not found', () => {
    expect(() =>
      resolveAppFromRegistry(
        {
          url: 'x',
          registry: {
            name: 'r',
            version: '1',
            apps: [
              { id: 'a', version: '0.1.0' },
              { id: 'b', version: '0.1.0' },
            ],
          },
        },
        'missing',
      ),
    ).toThrow(/not found.*Known: a, b/)
  })

  it('errors if the registry was loaded from a local path with no per-entry repo override', () => {
    expect(() =>
      resolveAppFromRegistry(
        {
          url: '/local/path',
          registry: { name: 'local', version: '1', apps: [{ id: 'foo', version: '0.1.0' }] },
        },
        'foo',
      ),
    ).toThrow(/loaded from a local path/)
  })
})
