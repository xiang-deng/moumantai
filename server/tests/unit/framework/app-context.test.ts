import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import {
  loadAppContext,
  saveAppContext,
  setContextField,
  contextFilePath,
} from '../../../src/server/framework/app-context.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'moumantai-ctx-'))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

const APP_ID = 'sports'

const sportsContext = z.object({
  default_league: z.enum(['nhl', 'nba', 'nfl', 'mlb']).default('nhl'),
  default_view: z.enum(['yesterday', 'today', 'upcoming']).default('today'),
})

describe('loadAppContext', () => {
  it('returns {} when schema is missing', () => {
    expect(loadAppContext({ home: tmpHome, appId: APP_ID })).toEqual({})
  })

  it('applies Zod defaults when context.json is missing', () => {
    const result = loadAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext })
    expect(result).toEqual({ default_league: 'nhl', default_view: 'today' })
  })

  it('reads parsed values from context.json', () => {
    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'context.json'), JSON.stringify({ default_league: 'nba' }))

    const result = loadAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext })
    expect(result).toEqual({ default_league: 'nba', default_view: 'today' })
  })

  it('throws on schema-invalid values with path-and-message', () => {
    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'context.json'), JSON.stringify({ default_league: 'cricket' }))

    expect(() => loadAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext })).toThrow(
      /default_league/,
    )
  })

  it('throws on invalid JSON', () => {
    const root = path.join(tmpHome, 'apps', APP_ID)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'context.json'), '{ broken')

    expect(() => loadAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext })).toThrow(
      /Invalid JSON/,
    )
  })
})

describe('saveAppContext', () => {
  it('writes validated values to context.json', () => {
    saveAppContext(
      { home: tmpHome, appId: APP_ID, schema: sportsContext },
      { default_league: 'nba', default_view: 'today' },
    )

    const text = readFileSync(contextFilePath({ home: tmpHome, appId: APP_ID }), 'utf8')
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({ default_league: 'nba', default_view: 'today' })
  })

  it('round-trips: save → load returns same values', () => {
    const values = { default_league: 'nfl', default_view: 'upcoming' }
    saveAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext }, values)
    const loaded = loadAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext })
    expect(loaded).toEqual(values)
  })

  it('throws on invalid values without writing', () => {
    expect(() =>
      saveAppContext(
        { home: tmpHome, appId: APP_ID, schema: sportsContext },
        { default_league: 'cricket' as never },
      ),
    ).toThrow()
    expect(existsSync(contextFilePath({ home: tmpHome, appId: APP_ID }))).toBe(false)
  })
})

describe('setContextField', () => {
  it('updates one field, preserves others', async () => {
    saveAppContext(
      { home: tmpHome, appId: APP_ID, schema: sportsContext },
      { default_league: 'nhl', default_view: 'today' },
    )
    await setContextField(
      { home: tmpHome, appId: APP_ID, schema: sportsContext },
      'default_league',
      'nba',
    )
    const loaded = loadAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext })
    expect(loaded).toEqual({ default_league: 'nba', default_view: 'today' })
  })

  it('rejects values that fail field-level validation', async () => {
    saveAppContext(
      { home: tmpHome, appId: APP_ID, schema: sportsContext },
      { default_league: 'nhl', default_view: 'today' },
    )
    await expect(
      setContextField(
        { home: tmpHome, appId: APP_ID, schema: sportsContext },
        'default_league',
        'cricket',
      ),
    ).rejects.toThrow(/default_league/)
    // Original value should be preserved
    const loaded = loadAppContext({ home: tmpHome, appId: APP_ID, schema: sportsContext })
    expect(loaded.default_league).toBe('nhl')
  })

  it('throws when no schema declared', async () => {
    await expect(setContextField({ home: tmpHome, appId: APP_ID }, 'k', 'v')).rejects.toThrow(
      /no context schema/,
    )
  })

  it('rejects unknown field names (caught by validation)', async () => {
    // strict() schemas reject unknown fields; default object schemas pass-through
    // depending on Zod's mode. Test the strict case.
    const strict = z
      .object({
        mode: z.enum(['a', 'b']).default('a'),
      })
      .strict()
    await expect(
      setContextField({ home: tmpHome, appId: APP_ID, schema: strict }, 'unknown_key', 'x'),
    ).rejects.toThrow()
  })
})
