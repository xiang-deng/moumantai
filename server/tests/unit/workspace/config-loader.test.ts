import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadConfigFile,
  mergeEnvOverrides,
  loadServerConfig,
  ConfigFileSchema,
} from '../../../src/server/workspace/config-loader.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-config-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ConfigFileSchema defaults', () => {
  it('parse({}) yields a fully-defaulted object (smoke check)', () => {
    const f = ConfigFileSchema.parse({})
    expect(f.port).toBe(3000)
    expect(f.backend).toBe('claude')
    expect(f.voice.sttModel).toBeTruthy()
    expect(f.appEngine.idleMs).toBeGreaterThan(0)
  })
})

describe('loadConfigFile', () => {
  it('writes defaults when file is missing', () => {
    const p = path.join(tmpDir, 'config.json')
    expect(fs.existsSync(p)).toBe(false)
    const f = loadConfigFile(p)
    expect(f.port).toBe(3000)
    expect(fs.existsSync(p)).toBe(true)
    const written = JSON.parse(fs.readFileSync(p, 'utf8'))
    expect(written.port).toBe(3000)
    expect(written.backend).toBe('claude')
  })

  it('rejects invalid backend values', () => {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify({ port: 4001, backend: 'mock' }))
    expect(() => loadConfigFile(p)).toThrow('Invalid config')
  })

  it('reads existing values', () => {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify({ port: 4001, backend: 'claude' }))
    const f = loadConfigFile(p)
    expect(f.port).toBe(4001)
    expect(f.backend).toBe('claude')
    // Unspecified nested objects still get defaults
    expect(f.voice.sttModel).toBe('gpt-4o-mini-transcribe')
  })

  it('throws a readable error on invalid JSON', () => {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, '{ this is not json')
    expect(() => loadConfigFile(p)).toThrow(/Invalid JSON/)
  })

  it('throws a readable error on schema violation', () => {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify({ backend: 'gpt5', port: -1 }))
    expect(() => loadConfigFile(p)).toThrow(/Invalid config/)
  })
})

describe('mergeEnvOverrides', () => {
  const HOME = '/tmp/moumantai-fake'

  it('uses file values when env is empty', () => {
    const file = ConfigFileSchema.parse({ port: 4001, backend: 'claude' })
    const { config, origins } = mergeEnvOverrides(HOME, file, {})
    expect(config.port).toBe(4001)
    expect(config.backend).toBe('claude')
    expect(origins['port']?.origin).toBe('file')
  })

  it('env vars override file values', () => {
    const file = ConfigFileSchema.parse({ port: 4001, backend: 'claude' })
    const { config, origins } = mergeEnvOverrides(HOME, file, {
      MOUMANTAI_PORT: '5005',
      MOUMANTAI_BACKEND: 'claude',
    })
    expect(config.port).toBe(5005)
    expect(config.backend).toBe('claude')
    expect(origins['port']).toEqual({ value: 5005, origin: 'env', envVar: 'MOUMANTAI_PORT' })
    expect(origins['backend']).toEqual({
      value: 'claude',
      origin: 'env',
      envVar: 'MOUMANTAI_BACKEND',
    })
  })

  it('invalid env enum is ignored, falls back to file', () => {
    const file = ConfigFileSchema.parse({ backend: 'claude' })
    const { config } = mergeEnvOverrides(HOME, file, { MOUMANTAI_BACKEND: 'gpt5' })
    expect(config.backend).toBe('claude')
  })

  it('non-numeric env int is ignored, falls back to file', () => {
    const file = ConfigFileSchema.parse({ port: 4001 })
    const { config } = mergeEnvOverrides(HOME, file, { MOUMANTAI_PORT: 'not-a-number' })
    expect(config.port).toBe(4001)
  })

  it('boolean env: only exact "true"/"false" (case-insensitive) parsed; anything else falls back to file', () => {
    const file = ConfigFileSchema.parse({ appEngine: { hotReload: true } })

    // Valid values
    expect(mergeEnvOverrides(HOME, file, { MOUMANTAI_HOT_RELOAD: 'false' }).config.hotReload).toBe(
      false,
    )
    expect(mergeEnvOverrides(HOME, file, { MOUMANTAI_HOT_RELOAD: 'TRUE' }).config.hotReload).toBe(
      true,
    )

    // Invalid values fall back to fileVal — `MOUMANTAI_HOT_RELOAD=1` must not silently DISABLE hot-reload.
    for (const bad of ['1', '0', 'yes', 'no', 'on', 'off', 'maybe', '']) {
      const { config } = mergeEnvOverrides(HOME, file, { MOUMANTAI_HOT_RELOAD: bad })
      expect(config.hotReload, `value=${JSON.stringify(bad)}`).toBe(true)
    }
  })

  it('appDirs default: <home>/apps-src if populated, else ../apps fallback (absolute)', async () => {
    const file = ConfigFileSchema.parse({})
    const path = await import('node:path')

    // Empty (or missing) apps-src → fall back to <cwd>/../apps so dev/test work.
    // Path is resolved to absolute against process.cwd() so a later chdir
    // doesn't break it.
    const { config: cEmpty } = mergeEnvOverrides('/nonexistent/home', file, {})
    expect(cEmpty.appDirs).toHaveLength(1)
    expect(path.isAbsolute(cEmpty.appDirs[0]!)).toBe(true)
    expect(cEmpty.appDirs[0]).toBe(path.resolve(process.cwd(), '..', 'apps'))

    // MOUMANTAI_APP_DIRS still overrides everything (kept as-is from env, not
    // resolved — caller controls absolute vs relative)
    const { config: cEnv } = mergeEnvOverrides('/nonexistent/home', file, {
      MOUMANTAI_APP_DIRS: './a, /abs/b',
    })
    expect(cEnv.appDirs).toEqual(['./a', '/abs/b'])
  })

  it('appDirs prefers <home>/apps-src when it has content', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-appdirs-'))
    fs.mkdirSync(path.join(home, 'apps-src', 'spend-tracker'), { recursive: true })
    try {
      const file = ConfigFileSchema.parse({})
      const { config } = mergeEnvOverrides(home, file, {})
      expect(config.appDirs).toEqual([path.join(home, 'apps-src')])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('flattens voice + appEngine nested file shape into runtime fields', () => {
    const file = ConfigFileSchema.parse({
      voice: { sttModel: 'whisper-1', ttsVoice: 'echo' },
      appEngine: { idleMs: 60000, maxActive: 5 },
    })
    const { config } = mergeEnvOverrides(HOME, file, {})
    expect(config.sttModel).toBe('whisper-1')
    expect(config.ttsVoice).toBe('echo')
    expect(config.appIdleMs).toBe(60000)
    expect(config.maxActiveApps).toBe(5)
  })
})

describe('loadServerConfig (file + env merge end-to-end)', () => {
  it('first run: writes defaults + applies env overrides', () => {
    const configPath = path.join(tmpDir, 'config.json')
    const cfg = loadServerConfig(tmpDir, configPath, { MOUMANTAI_PORT: '7000' })
    expect(cfg.port).toBe(7000)
    expect(cfg.home).toBe(tmpDir)
    expect(fs.existsSync(configPath)).toBe(true)
  })
})
