import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveMoumantaiHome,
  resolveMoumantaiHomeWithSource,
  ensureHomeLayout,
  defaultPointerPath,
  readHomePointer,
  writeHomePointer,
  deleteHomePointer,
} from '../../../src/server/workspace/home.js'

// Guards two silent-breakage scenarios: home resolution precedence (wrong order
// silently relocates all user data) and layout creation idempotency (re-boot must not throw).

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-home-test-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('resolveMoumantaiHome', () => {
  it('honors MOUMANTAI_HOME env var first', () => {
    const target = path.join(tmpRoot, 'override')
    const home = resolveMoumantaiHome({
      env: { MOUMANTAI_HOME: target },
      cwd: tmpRoot,
      pointerPath: null,
    })
    expect(home).toBe(path.resolve(target))
  })

  it('falls through to project-local <cwd>/.moumantai/ if it exists', () => {
    const projectLocal = path.join(tmpRoot, '.moumantai')
    fs.mkdirSync(projectLocal)
    const home = resolveMoumantaiHome({ env: {}, cwd: tmpRoot, pointerPath: null })
    expect(home).toBe(projectLocal)
  })

  it('walks up to find <ancestor>/.moumantai/ when invoked from a subdir', () => {
    // Mirrors `npm run dev` in <repo>/server/: cwd is a child, but the
    // repo-root .moumantai/ should still win.
    const projectLocal = path.join(tmpRoot, '.moumantai')
    fs.mkdirSync(projectLocal)
    const subdir = path.join(tmpRoot, 'server', 'nested')
    fs.mkdirSync(subdir, { recursive: true })
    const home = resolveMoumantaiHome({ env: {}, cwd: subdir, pointerPath: null })
    expect(home).toBe(projectLocal)
  })

  it('falls back to ~/.moumantai/ when neither env nor project-local nor pointer present', () => {
    const home = resolveMoumantaiHome({ env: {}, cwd: tmpRoot, pointerPath: null })
    expect(home).toBe(path.join(os.homedir(), '.moumantai'))
  })

  it('ignores empty/whitespace MOUMANTAI_HOME (otherwise `MOUMANTAI_HOME=" "` would silently relocate the workspace to "/")', () => {
    const home = resolveMoumantaiHome({
      env: { MOUMANTAI_HOME: '   ' },
      cwd: tmpRoot,
      pointerPath: null,
    })
    expect(home).toBe(path.join(os.homedir(), '.moumantai'))
  })

  it('respects the pointer file when env + walker miss', () => {
    const target = path.join(tmpRoot, 'workspace')
    fs.mkdirSync(target)
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, `${target}\n`, 'utf8')
    const home = resolveMoumantaiHome({ env: {}, cwd: tmpRoot, pointerPath: pointer })
    expect(home).toBe(target)
  })

  it('walker beats pointer (cwd is the loudest signal of intent)', () => {
    const projectLocal = path.join(tmpRoot, '.moumantai')
    fs.mkdirSync(projectLocal)
    const pointerTarget = path.join(tmpRoot, 'other-workspace')
    fs.mkdirSync(pointerTarget)
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, pointerTarget, 'utf8')
    const home = resolveMoumantaiHome({ env: {}, cwd: tmpRoot, pointerPath: pointer })
    expect(home).toBe(projectLocal)
  })

  it('stale pointer (path no longer exists) falls through to default', () => {
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, '/nonexistent/path/that/was/removed', 'utf8')
    const home = resolveMoumantaiHome({ env: {}, cwd: tmpRoot, pointerPath: pointer })
    expect(home).toBe(path.join(os.homedir(), '.moumantai'))
  })

  it('malformed/empty pointer is silently ignored (never crashes resolution)', () => {
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, '', 'utf8')
    expect(() =>
      resolveMoumantaiHome({ env: {}, cwd: tmpRoot, pointerPath: pointer }),
    ).not.toThrow()
  })

  it('env var still beats the pointer', () => {
    const envTarget = path.join(tmpRoot, 'from-env')
    const pointerTarget = path.join(tmpRoot, 'from-pointer')
    fs.mkdirSync(pointerTarget)
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, pointerTarget, 'utf8')
    const home = resolveMoumantaiHome({
      env: { MOUMANTAI_HOME: envTarget },
      cwd: tmpRoot,
      pointerPath: pointer,
    })
    expect(home).toBe(path.resolve(envTarget))
  })
})

describe('resolveMoumantaiHomeWithSource', () => {
  it('tags env-var resolution as source=env', () => {
    const { source } = resolveMoumantaiHomeWithSource({
      env: { MOUMANTAI_HOME: tmpRoot },
      cwd: tmpRoot,
      pointerPath: null,
    })
    expect(source).toBe('env')
  })

  it('tags walker resolution as source=walker', () => {
    fs.mkdirSync(path.join(tmpRoot, '.moumantai'))
    const { source } = resolveMoumantaiHomeWithSource({ env: {}, cwd: tmpRoot, pointerPath: null })
    expect(source).toBe('walker')
  })

  it('tags pointer-file resolution as source=pointer', () => {
    const target = path.join(tmpRoot, 'workspace')
    fs.mkdirSync(target)
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, target, 'utf8')
    const { source } = resolveMoumantaiHomeWithSource({
      env: {},
      cwd: tmpRoot,
      pointerPath: pointer,
    })
    expect(source).toBe('pointer')
  })

  it('tags default fallback as source=default', () => {
    const { source } = resolveMoumantaiHomeWithSource({ env: {}, cwd: tmpRoot, pointerPath: null })
    expect(source).toBe('default')
  })
})

describe('defaultPointerPath (cross-platform)', () => {
  it('Linux uses XDG_CONFIG_HOME when set', () => {
    const p = defaultPointerPath({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/custom/xdg' },
      homedir: '/home/u',
    })
    expect(p).toBe(path.join('/custom/xdg', 'moumantai', 'home'))
  })

  it('Linux falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    const p = defaultPointerPath({ platform: 'linux', env: {}, homedir: '/home/u' })
    expect(p).toBe(path.join('/home/u', '.config', 'moumantai', 'home'))
  })

  it('Linux falls back to ~/.config when XDG_CONFIG_HOME is whitespace', () => {
    const p = defaultPointerPath({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '   ' },
      homedir: '/home/u',
    })
    expect(p).toBe(path.join('/home/u', '.config', 'moumantai', 'home'))
  })

  it('macOS uses ~/Library/Application Support', () => {
    const p = defaultPointerPath({ platform: 'darwin', env: {}, homedir: '/Users/u' })
    expect(p).toBe(path.join('/Users/u', 'Library', 'Application Support', 'moumantai', 'home'))
  })

  it('Windows uses %APPDATA% when set', () => {
    const p = defaultPointerPath({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      homedir: 'C:\\Users\\u',
    })
    expect(p).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'moumantai', 'home'))
  })

  it('Windows falls back to ~/AppData/Roaming when APPDATA missing', () => {
    const p = defaultPointerPath({
      platform: 'win32',
      env: {},
      homedir: 'C:\\Users\\u',
    })
    expect(p).toBe(path.join('C:\\Users\\u', 'AppData', 'Roaming', 'moumantai', 'home'))
  })
})

describe('pointer file round-trip', () => {
  it('writeHomePointer + readHomePointer reproduces an absolute path', () => {
    const target = path.join(tmpRoot, 'workspace')
    fs.mkdirSync(target)
    const pointer = path.join(tmpRoot, 'nested', 'dir', 'pointer') // exercises mkdir parent
    writeHomePointer(target, pointer)
    expect(readHomePointer(pointer)).toBe(path.resolve(target))
  })

  it('readHomePointer returns null when the pointed path does not exist', () => {
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, '/nonexistent/path', 'utf8')
    expect(readHomePointer(pointer)).toBeNull()
  })

  it('readHomePointer returns null when the pointed path is a file (not a directory)', () => {
    const file = path.join(tmpRoot, 'a-file')
    fs.writeFileSync(file, 'I am a regular file', 'utf8')
    const pointer = path.join(tmpRoot, 'pointer')
    fs.writeFileSync(pointer, file, 'utf8')
    expect(readHomePointer(pointer)).toBeNull()
  })

  it('readHomePointer returns null when pointer file is missing', () => {
    const pointer = path.join(tmpRoot, 'never-written')
    expect(readHomePointer(pointer)).toBeNull()
  })

  it('deleteHomePointer is idempotent (no error on missing file)', () => {
    const pointer = path.join(tmpRoot, 'never-existed')
    expect(() => deleteHomePointer(pointer)).not.toThrow()
  })

  it('writeHomePointer is atomic (no .tmp leftover)', () => {
    const target = path.join(tmpRoot, 'workspace')
    fs.mkdirSync(target)
    const pointer = path.join(tmpRoot, 'pointer')
    writeHomePointer(target, pointer)
    expect(fs.existsSync(`${pointer}.tmp`)).toBe(false)
    expect(fs.existsSync(pointer)).toBe(true)
  })
})

describe('ensureHomeLayout', () => {
  it('creates all standard subdirs idempotently', () => {
    const home = path.join(tmpRoot, 'h')
    const layout = ensureHomeLayout(home)
    expect(fs.statSync(layout.appsSrcDir).isDirectory()).toBe(true)
    expect(fs.statSync(layout.appsDir).isDirectory()).toBe(true)
    expect(fs.statSync(layout.homeAppCwd).isDirectory()).toBe(true)

    // Re-running is a no-op
    expect(() => ensureHomeLayout(home)).not.toThrow()
  })
})

// homeLayout/appPaths are pure path.join helpers; covered transitively by installApp tests.
