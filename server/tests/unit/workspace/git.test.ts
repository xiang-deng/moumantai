import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ensureGitClone,
  resolveCommit,
  materializeWorktree,
  GitError,
} from '../../../src/server/workspace/git.js'

let tmpRoot: string
let bareUrl: string
let bareCommit: string

function git(cwd: string, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || 'exit ' + r.status}`)
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 0 }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-git-test-'))

  // Build a tiny bare repo with one commit.
  const bare = path.join(tmpRoot, 'remote.git')
  git(tmpRoot, 'init', '--bare', '--quiet', bare)
  // Set a default branch name on the bare too so HEAD is well-defined.
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')

  const work = path.join(tmpRoot, 'work')
  git(tmpRoot, 'init', '--quiet', '--initial-branch=main', work)
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(work, 'hello.txt'), 'hello world\n')
  git(work, 'add', 'hello.txt')
  git(work, 'commit', '--quiet', '-m', 'initial')
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '--quiet', 'origin', 'main')
  bareCommit = git(work, 'rev-parse', 'HEAD').stdout.trim()
  bareUrl = bare
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('ensureGitClone', () => {
  it('creates a bare clone in the cache dir on first call', () => {
    const cacheDir = path.join(tmpRoot, 'cache')
    const slot = ensureGitClone(bareUrl, cacheDir)
    expect(fs.existsSync(path.join(slot, 'HEAD'))).toBe(true)
    // Bare clone — no working tree
    expect(fs.existsSync(path.join(slot, '.git'))).toBe(false)
  })

  it('reuses + fetches into an existing slot on second call', () => {
    const cacheDir = path.join(tmpRoot, 'cache')
    const slot1 = ensureGitClone(bareUrl, cacheDir)
    // Push a new commit to the bare; second call should pull it.
    const work = path.join(tmpRoot, 'work')
    fs.writeFileSync(path.join(work, 'new.txt'), 'newer\n')
    git(work, 'add', 'new.txt')
    git(work, 'commit', '--quiet', '-m', 'second')
    git(work, 'push', '--quiet', 'origin', 'main')
    const newCommit = git(work, 'rev-parse', 'HEAD').stdout.trim()

    const slot2 = ensureGitClone(bareUrl, cacheDir)
    expect(slot2).toBe(slot1) // same hash slot
    expect(resolveCommit(slot2, 'main')).toBe(newCommit)
  })
})

describe('resolveCommit', () => {
  it('resolves "HEAD" + branch name to the same commit', () => {
    const slot = ensureGitClone(bareUrl, path.join(tmpRoot, 'cache'))
    expect(resolveCommit(slot, 'HEAD')).toBe(bareCommit)
    expect(resolveCommit(slot, 'main')).toBe(bareCommit)
  })

  it('throws GitError(BAD_REF) on a missing ref', () => {
    const slot = ensureGitClone(bareUrl, path.join(tmpRoot, 'cache'))
    try {
      resolveCommit(slot, 'no-such-ref')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GitError)
      expect((err as GitError).code).toBe('BAD_REF')
    }
  })
})

describe('materializeWorktree', () => {
  it('checks out the requested commit + cleanup removes the worktree registration', () => {
    const slot = ensureGitClone(bareUrl, path.join(tmpRoot, 'cache'))
    const wt = materializeWorktree(slot, bareCommit)
    try {
      // Windows git applies core.autocrlf on checkout; tolerate both line endings.
      expect(
        fs.readFileSync(path.join(wt.workdir, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'),
      ).toBe('hello world\n')
      // Worktree is registered with the bare clone.
      const list = git(slot, 'worktree', 'list', '--porcelain').stdout
      expect(list).toContain(wt.workdir.replace(/\\/g, '/'))
    } finally {
      wt.cleanup()
    }
    // After cleanup, the worktree dir should be gone (or at least not registered)
    expect(fs.existsSync(wt.workdir)).toBe(false)
  })
})
