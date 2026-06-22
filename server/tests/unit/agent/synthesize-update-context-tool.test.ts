import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { synthesizeUpdateContextTool } from '../../../src/server/agent/synthesize-update-context-tool.js'

const sportsContext = z.object({
  default_league: z.enum(['nhl', 'nba', 'nfl', 'mlb']).default('nhl'),
  default_view: z.enum(['yesterday', 'today', 'upcoming']).default('today'),
})

describe('synthesizeUpdateContextTool', () => {
  it.each([
    ['no schema declared', undefined],
    ['empty schema object', z.object({})],
  ] as [string, Parameters<typeof synthesizeUpdateContextTool>[0]['contextSchema']][])(
    'returns null when no/empty schema declared (%s)',
    (_, contextSchema) => {
      const tool = synthesizeUpdateContextTool({
        appId: 'sports',
        contextSchema,
        setContext: async () => undefined,
      })
      expect(tool).toBeNull()
    },
  )

  it('synthesizes a tool with field listing in description', () => {
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: sportsContext,
      setContext: async () => undefined,
    })
    expect(tool).not.toBeNull()
    expect(tool!.name).toBe('update_context')
    expect(tool!.description).toContain('default_league')
    expect(tool!.description).toContain('default_view')
    expect(tool!.description).toContain('nhl') // enum value listed
  })

  it('declares string parameters for field and value', () => {
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: sportsContext,
      setContext: async () => undefined,
    })
    expect(tool!.parameters.field).toMatchObject({ type: 'string', required: true })
    expect(tool!.parameters.value).toMatchObject({ type: 'string', required: true })
  })
})

describe('synthesizeUpdateContextTool: execute', () => {
  it('calls setContext with the parsed value on success', async () => {
    const setContext = vi.fn(async () => undefined)
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: sportsContext,
      setContext,
    })!

    const result = await tool.execute({
      params: { field: 'default_league', value: 'nba' },
      db: null as never,
    })
    expect(result.error).toBeUndefined()
    expect(result.result).toEqual({ ok: true, updated: { field: 'default_league', value: 'nba' } })
    expect(setContext).toHaveBeenCalledWith('default_league', 'nba')
  })

  it('returns error when field is missing', async () => {
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: sportsContext,
      setContext: async () => undefined,
    })!

    const result = await tool.execute({
      params: { field: '', value: 'nba' },
      db: null as never,
    })
    expect(result.error).toMatch(/field is required/)
  })

  it('returns error when field is unknown', async () => {
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: sportsContext,
      setContext: async () => undefined,
    })!

    const result = await tool.execute({
      params: { field: 'something_else', value: 'x' },
      db: null as never,
    })
    expect(result.error).toMatch(/unknown field/)
    expect(result.error).toMatch(/default_league/)
  })

  it('surfaces setContext errors as tool errors', async () => {
    const setContext = vi.fn(async () => {
      throw new Error('not in enum')
    })
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: sportsContext,
      setContext,
    })!

    const result = await tool.execute({
      params: { field: 'default_league', value: 'cricket' },
      db: null as never,
    })
    expect(result.error).toMatch(/not in enum/)
    expect(result.result).toBeNull()
  })

  it('coerces "true"/"false" strings to booleans for boolean fields', async () => {
    const schema = z.object({
      verbose: z.boolean().default(false),
    })
    const setContext = vi.fn(async () => undefined)
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: schema,
      setContext,
    })!

    await tool.execute({ params: { field: 'verbose', value: 'true' }, db: null as never })
    expect(setContext).toHaveBeenCalledWith('verbose', true)
  })

  it('coerces numeric strings to numbers for number fields', async () => {
    const schema = z.object({
      max_items: z.number().int().default(10),
    })
    const setContext = vi.fn(async () => undefined)
    const tool = synthesizeUpdateContextTool({
      appId: 'sports',
      contextSchema: schema,
      setContext,
    })!

    await tool.execute({ params: { field: 'max_items', value: '25' }, db: null as never })
    expect(setContext).toHaveBeenCalledWith('max_items', 25)
  })
})
