import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { secretField } from '../../../src/server/framework/secret-field.js'
import {
  loadAppConfig,
  saveAppConfig,
  envKeyFor,
  configFilePath,
  envFilePath,
} from '../../../src/server/framework/app-config.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'moumantai-cfg-'))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

const APP_ID = 'sports'

describe('envKeyFor', () => {
  it('uppercases app id and field name with underscore separator', () => {
    expect(envKeyFor('sports', 'api_key')).toBe('SPORTS_API_KEY')
  })
  it('replaces dashes in app id with underscores', () => {
    expect(envKeyFor('spend-tracker', 'tier')).toBe('SPEND_TRACKER_TIER')
  })
})

describe('loadAppConfig: empty / missing schema', () => {
  it('returns {} when no schema is provided', () => {
    expect(loadAppConfig({ home: tmpHome, appId: APP_ID })).toEqual({})
  })

  it('returns {} when schema is not a Zod schema', () => {
    expect(loadAppConfig({ home: tmpHome, appId: APP_ID, schema: { foo: 'bar' } })).toEqual({})
  })
})

describe('loadAppConfig: defaults applied when files missing', () => {
  it('applies Zod defaults for missing fields with no config.json', () => {
    const schema = z.object({
      default_league: z.string().default('nhl'),
      default_view: z.string().default('today'),
    })
    const result = loadAppConfig({ home: tmpHome, appId: APP_ID, schema })
    expect(result).toEqual({ default_league: 'nhl', default_view: 'today' })
  })
})

describe('loadAppConfig: reads from config.json', () => {
  it('returns parsed values from config.json', () => {
    const schema = z.object({
      default_league: z.string().default('nhl'),
    })
    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_league: 'nba' }))

    const result = loadAppConfig({ home: tmpHome, appId: APP_ID, schema })
    expect(result).toEqual({ default_league: 'nba' })
  })

  it('throws on invalid JSON', () => {
    const schema = z.object({ default_league: z.string().default('nhl') })
    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'config.json'), '{ this is not json')
    expect(() => loadAppConfig({ home: tmpHome, appId: APP_ID, schema })).toThrow(/Invalid JSON/)
  })

  it('throws with Zod path-and-message on validation failure', () => {
    const schema = z.object({
      default_league: z.enum(['nhl', 'nba', 'nfl', 'mlb']).default('nhl'),
    })
    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_league: 'cricket' }))
    expect(() => loadAppConfig({ home: tmpHome, appId: APP_ID, schema })).toThrow(/default_league/)
  })
})

describe('loadAppConfig: secret fields routed to .env', () => {
  it('reads secret field from .env, non-secret from config.json', () => {
    const schema = z.object({
      api_endpoint: z.string().default('https://api.example.com'),
      api_key: secretField(z.string().min(1)),
    })

    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ api_endpoint: 'https://override.example.com' }),
    )
    writeFileSync(path.join(root, '.env'), 'SPORTS_API_KEY=supersecret\n')

    const result = loadAppConfig({ home: tmpHome, appId: APP_ID, schema })
    expect(result).toEqual({
      api_endpoint: 'https://override.example.com',
      api_key: 'supersecret',
    })
  })

  it('fails validation when required secret is missing', () => {
    const schema = z.object({
      api_key: secretField(z.string().min(1)),
    })
    expect(() => loadAppConfig({ home: tmpHome, appId: APP_ID, schema })).toThrow(/api_key/)
  })

  it('quoted values in .env are parsed correctly', () => {
    const schema = z.object({ token: secretField(z.string()) })
    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, '.env'), 'SPORTS_TOKEN="secret with spaces"\n')

    const result = loadAppConfig({ home: tmpHome, appId: APP_ID, schema })
    expect(result.token).toBe('secret with spaces')
  })
})

describe('saveAppConfig: writes', () => {
  it('writes only config.json when no secrets', () => {
    const schema = z.object({
      default_league: z.string().default('nhl'),
    })
    saveAppConfig({ home: tmpHome, appId: APP_ID, schema }, { default_league: 'nba' })

    const cfg = JSON.parse(readFileSync(configFilePath({ home: tmpHome, appId: APP_ID }), 'utf8'))
    expect(cfg).toEqual({ default_league: 'nba' })
    expect(existsSync(envFilePath({ home: tmpHome, appId: APP_ID }))).toBe(false)
  })

  it('splits secret fields to .env', () => {
    const schema = z.object({
      endpoint: z.string().default('https://api.example.com'),
      api_key: secretField(z.string()),
    })
    saveAppConfig(
      { home: tmpHome, appId: APP_ID, schema },
      { endpoint: 'https://api.example.com', api_key: 'shh' },
    )

    const cfg = JSON.parse(readFileSync(configFilePath({ home: tmpHome, appId: APP_ID }), 'utf8'))
    expect(cfg).toEqual({ endpoint: 'https://api.example.com' })
    expect(cfg).not.toHaveProperty('api_key')

    const envText = readFileSync(envFilePath({ home: tmpHome, appId: APP_ID }), 'utf8')
    expect(envText).toContain('SPORTS_API_KEY=shh')
  })

  it('round-trips: save then load returns the same values', () => {
    const schema = z.object({
      endpoint: z.string().default('https://api.example.com'),
      api_key: secretField(z.string()),
      verbose: z.boolean().default(false),
    })
    const values = { endpoint: 'https://x.example', api_key: 'k', verbose: true }
    saveAppConfig({ home: tmpHome, appId: APP_ID, schema }, values)
    const loaded = loadAppConfig({ home: tmpHome, appId: APP_ID, schema })
    expect(loaded).toEqual(values)
  })

  it('throws on invalid values without writing', () => {
    const schema = z.object({
      league: z.enum(['nhl', 'nba']),
    })
    expect(() =>
      saveAppConfig({ home: tmpHome, appId: APP_ID, schema }, { league: 'cricket' as never }),
    ).toThrow()
    expect(existsSync(configFilePath({ home: tmpHome, appId: APP_ID }))).toBe(false)
  })

  it('quotes env values containing whitespace', () => {
    const schema = z.object({ token: secretField(z.string()) })
    saveAppConfig({ home: tmpHome, appId: APP_ID, schema }, { token: 'has spaces here' })
    const envText = readFileSync(envFilePath({ home: tmpHome, appId: APP_ID }), 'utf8')
    expect(envText).toContain('SPORTS_TOKEN="has spaces here"')
  })
})
