import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../../../src/server/config.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-cfg-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults on a fresh home', () => {
    const cfg = loadConfig({ home: tmpHome })
    expect(cfg.home).toBe(tmpHome)
    expect(cfg.port).toBe(3000)
    expect(cfg.backend).toBe('claude')
    expect(cfg.hotReload).toBe(true)
    expect(cfg.devModeEnabled).toBe(false)
    expect(cfg.anthropicApiKey).toBeUndefined()
    // Fresh home: apps-src is empty, so we fall back to repo's ../apps for dev.
    // Resolved to absolute against process.cwd() at config-load time.
    expect(cfg.appDirs).toEqual([path.resolve(process.cwd(), '..', 'apps')])
    // Default config.json was written
    expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true)
  })

  // Per-field env-override semantics live in workspace/config-loader.test.ts
  // (mergeEnvOverrides). The tests below cover only what's UNIQUE to
  // loadConfig: the .env-into-process.env wiring and the file-beats-defaults
  // composition that loadConfig orchestrates.

  it('loads <home>/.env without overwriting real env', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.env'),
      'ANTHROPIC_API_KEY=from-file\nOTHER=also-from-file\n',
    )
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-real-env')
    const cfg = loadConfig({ home: tmpHome })
    expect(cfg.anthropicApiKey).toBe('from-real-env')
    // OTHER got injected into process.env from file
    expect(process.env.OTHER).toBe('also-from-file')
  })

  it('persisted config.json beats schema defaults', () => {
    fs.writeFileSync(
      path.join(tmpHome, 'config.json'),
      JSON.stringify({ port: 5555, backend: 'claude' }),
    )
    const cfg = loadConfig({ home: tmpHome })
    expect(cfg.port).toBe(5555)
    expect(cfg.backend).toBe('claude')
  })
})
