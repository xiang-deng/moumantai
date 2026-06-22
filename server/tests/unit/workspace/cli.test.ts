import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../../../src/server/cli.js'

let tmpHome: string
let stdoutBuf: string[]
let stderrBuf: string[]

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-cli-'))
  vi.stubEnv('MOUMANTAI_HOME', tmpHome)
  // Suppress noise; capture for assertions.
  stdoutBuf = []
  stderrBuf = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdoutBuf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderrBuf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function out(): string {
  return stdoutBuf.join('')
}
function err(): string {
  return stderrBuf.join('')
}

describe('runCli', () => {
  describe('config (bare) = show, and `init` is the only wizard entry', () => {
    it('bare `config` prints the resolved config (does NOT run the wizard)', async () => {
      // New behavior: `config` with no subcommand is an alias for `config show`.
      // A scripted run returns immediately — if it tried to launch the wizard it
      // would block on stdin instead.
      const code = await runCli(['config'])
      expect(code).toBe(0)
      const o = out()
      expect(o).toMatch(/Moumantai home:/)
      expect(o).toMatch(/port\s+3000/)
      expect(o).toMatch(/backend\s+"claude"/)
    })

    it('old behavior still holds: `config show` and `config edit` are unchanged', async () => {
      // Proves the merge didn't disturb the surviving config subcommands.
      const code = await runCli(['config', 'show'])
      expect(code).toBe(0)
      expect(out()).toMatch(/Moumantai home:/)
    })
  })

  describe('config path removal', () => {
    it('`config path` is gone and points the user at `workspace path`', async () => {
      const code = await runCli(['config', 'path'])
      expect(code).toBe(2)
      expect(err()).toMatch(/`config path` was removed/)
      expect(err()).toMatch(/workspace path/)
    })
  })

  describe('workspace path', () => {
    it('prints the resolved home and its source (replacement for `config path`)', async () => {
      const code = await runCli(['workspace', 'path'])
      expect(code).toBe(0)
      const o = out()
      expect(o).toContain(tmpHome)
      // MOUMANTAI_HOME is stubbed in beforeEach → resolver source is 'env'.
      expect(o).toMatch(/source:\s+env/)
    })
  })

  describe('help is honest about invocation', () => {
    it('shows the real `task server:cli --` path and no removed/fake commands', async () => {
      const code = await runCli(['help'])
      expect(code).toBe(0)
      const o = out()
      expect(o).toMatch(/task server:cli -- <command>/)
      expect(o).toMatch(/There is no `moumantai` binary/)
      // The removed subcommand must not reappear in help.
      expect(o).not.toMatch(/config path/)
    })
  })

  describe('config show', () => {
    it('prints resolved config with origin annotations', async () => {
      const code = await runCli(['config', 'show'])
      expect(code).toBe(0)
      const o = out()
      expect(o).toMatch(/Moumantai home:/)
      expect(o).toMatch(/port\s+3000/)
      expect(o).toMatch(/backend\s+"claude"/)
      expect(o).toMatch(/\(config\.json\)|\(default\)/)
    })

    it('annotates env-overridden values', async () => {
      vi.stubEnv('MOUMANTAI_PORT', '5005')
      const code = await runCli(['config', 'show'])
      expect(code).toBe(0)
      expect(out()).toMatch(/port\s+5005\s+\(env: MOUMANTAI_PORT\)/)
    })
  })

  describe('init --non-interactive', () => {
    it('creates config.json with defaults', async () => {
      const code = await runCli(['init', '--non-interactive'])
      expect(code).toBe(0)
      const cfgPath = path.join(tmpHome, 'config.json')
      expect(fs.existsSync(cfgPath)).toBe(true)
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(cfg.port).toBe(3000)
      expect(cfg.backend).toBe('claude')
    })
  })

  describe('app list / install / uninstall', () => {
    function makeApp(id: string): string {
      const src = path.join(tmpHome, 'srcs', id)
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(
        path.join(src, 'manifest.ts'),
        `export const manifest = { id: '${id}', version: '0.1.0' }\n`,
      )
      return src
    }

    it('app list --from <local-path> prints registry catalog', async () => {
      const regDir = path.join(tmpHome, 'reg')
      fs.mkdirSync(regDir, { recursive: true })
      fs.writeFileSync(
        path.join(regDir, 'registry.json'),
        JSON.stringify({
          name: 'test-registry',
          apps: [
            { id: 'spend-tracker', version: '0.1.0', description: 'expenses' },
            { id: 'diet-tracker', version: '0.2.0', description: 'meals' },
          ],
        }),
      )
      const code = await runCli(['app', 'list', '--from', regDir])
      expect(code).toBe(0)
      const o = out()
      expect(o).toMatch(/Registry: test-registry/)
      expect(o).toMatch(/spend-tracker\s+0\.1\.0\s+— expenses/)
      expect(o).toMatch(/diet-tracker\s+0\.2\.0\s+— meals/)
    })

    it('install + list + uninstall round-trip', async () => {
      const src = makeApp('foo')

      let code = await runCli(['app', 'install', src])
      expect(code).toBe(0)
      expect(out()).toMatch(/Installed "foo"/)
      stdoutBuf.length = 0
      stderrBuf.length = 0

      code = await runCli(['app', 'list'])
      expect(code).toBe(0)
      // New format: "<id>  <version>  local <linkType>: <source>"
      expect(out()).toMatch(/foo\s+0\.1\.0\s+local (link|copy)/)
      stdoutBuf.length = 0

      // Without --force and without TTY, won't delete runtime state — but
      // there is no runtime state here, so it's a clean removal.
      code = await runCli(['app', 'uninstall', 'foo'])
      expect(code).toBe(0)
      expect(out()).toMatch(/Removed source/)
      expect(fs.existsSync(path.join(tmpHome, 'apps-src', 'foo'))).toBe(false)
    })
  })

  describe('registry add / list / remove', () => {
    function makeLocalRegistry(
      id: string,
      apps: { id: string; version: string; description?: string }[],
    ): string {
      const dir = path.join(tmpHome, 'reg', id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ name: id, apps }))
      return dir
    }

    it('add → list → remove round-trip', async () => {
      const reg1 = makeLocalRegistry('reg-one', [{ id: 'foo', version: '0.1.0' }])

      let code = await runCli(['registry', 'add', 'reg-one', reg1])
      expect(code).toBe(0)
      expect(out()).toMatch(/Added registry "reg-one"/)
      expect(out()).toMatch(/1 app\(s\) available/)
      stdoutBuf.length = 0

      code = await runCli(['registry', 'list'])
      expect(code).toBe(0)
      expect(out()).toMatch(/reg-one\s+.*reg-one/)
      stdoutBuf.length = 0

      code = await runCli(['registry', 'remove', 'reg-one'])
      expect(code).toBe(0)
      expect(out()).toMatch(/Removed registry "reg-one"/)
    })

    it('add rejects duplicate name', async () => {
      const reg1 = makeLocalRegistry('dup', [])
      await runCli(['registry', 'add', 'dup', reg1])
      stdoutBuf.length = 0
      stderrBuf.length = 0
      const code = await runCli(['registry', 'add', 'dup', reg1])
      expect(code).toBe(1)
      expect(err()).toMatch(/already configured/)
    })

    it('remove on missing name is an error', async () => {
      const code = await runCli(['registry', 'remove', 'nope'])
      expect(code).toBe(1)
      expect(err()).toMatch(/No registry "nope"/)
    })

    it('app search across configured registries', async () => {
      const reg = makeLocalRegistry('r1', [
        { id: 'spend-tracker', version: '0.1.0', description: 'expenses' },
        { id: 'diet-tracker', version: '0.2.0', description: 'meals' },
      ])
      await runCli(['registry', 'add', 'r1', reg])
      stdoutBuf.length = 0

      const code = await runCli(['app', 'search', 'track'])
      expect(code).toBe(0)
      expect(out()).toMatch(/spend-tracker/)
      expect(out()).toMatch(/diet-tracker/)
      stdoutBuf.length = 0

      // No-match path
      await runCli(['app', 'search', 'no-such-thing-xyz'])
      expect(out()).toMatch(/No apps matching "no-such-thing-xyz"/)
    })

    it('app install <id> with no registries gives actionable error', async () => {
      const code = await runCli(['app', 'install', 'spend-tracker'])
      expect(code).toBe(1)
      expect(err()).toMatch(/No registries configured/)
    })
  })

  describe('config edit (non-interactive)', () => {
    it('reverts on invalid edits when not on a TTY', async () => {
      // Pre-create + corrupt config.json after `loadConfigFile` runs
      const cfgPath = path.join(tmpHome, 'config.json')

      // Use a trivial editor that writes garbage
      const tmpEditor = path.join(tmpHome, 'fake-editor.cjs')
      fs.writeFileSync(tmpEditor, `require('fs').writeFileSync(process.argv[2], '{ broken json')\n`)
      vi.stubEnv('EDITOR', `node ${tmpEditor}`)
      vi.stubEnv('VISUAL', '')
      // Force non-TTY so the auto-revert path runs
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })

      const code = await runCli(['config', 'edit'])
      expect(code).toBe(1)
      // Original (defaults) was restored
      const restored = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(restored.port).toBe(3000)
      expect(err()).toMatch(/Invalid (JSON|config)/)
      expect(err()).toMatch(/Reverted/)
    })

    it('keeps a valid edit', async () => {
      const cfgPath = path.join(tmpHome, 'config.json')
      const tmpEditor = path.join(tmpHome, 'fake-editor.cjs')
      fs.writeFileSync(
        tmpEditor,
        `require('fs').writeFileSync(process.argv[2], JSON.stringify({port: 7777, backend: 'claude'}))\n`,
      )
      vi.stubEnv('EDITOR', `node ${tmpEditor}`)
      vi.stubEnv('VISUAL', '')

      const code = await runCli(['config', 'edit'])
      expect(code).toBe(0)
      const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(after.port).toBe(7777)
      expect(after.backend).toBe('claude')
    })
  })
})
