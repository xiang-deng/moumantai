import { describe, it, expect } from 'vitest'
import {
  executeTool,
  validateParamsAgainstSchema,
} from '../../../src/server/agent/tool-executor.js'
import type { ToolDefinition } from '../../../src/server/agent/types.js'

const mockDeps = { db: {} as any }

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: {
      amount: { type: 'number', required: true, description: 'Amount' },
      label: { type: 'string' },
      active: { type: 'boolean' },
    },
    execute: async ({ params }) => ({ result: { received: params } }),
    ...overrides,
  }
}

describe('executeTool', () => {
  describe('parameter validation', () => {
    it('returns error when required param is missing (LLM-direct, default)', async () => {
      const tool = makeTool()
      const result = await executeTool(tool, { label: 'test' }, mockDeps)
      expect(result.error).toMatch(/Missing required parameter.*"amount"/)
      expect(result.result).toBeNull()
      // LLM-direct path NEVER surfaces `missing` — that's reserved for
      // `isUIInvocation: true` callers. Pinned here so a future regression
      // can't accidentally widen the escalation surface to LLM tool calls.
      expect(result.missing).toBeUndefined()
    })

    it('returns error when required param is null (LLM-direct, default)', async () => {
      const tool = makeTool()
      const result = await executeTool(tool, { amount: null }, mockDeps)
      expect(result.error).toMatch(/Missing required parameter.*"amount"/)
      expect(result.missing).toBeUndefined()
    })

    it('returns error when number param receives string', async () => {
      const tool = makeTool()
      const result = await executeTool(tool, { amount: 'twelve' }, mockDeps)
      expect(result.error).toMatch(/must be a number/)
    })

    it('returns error when string param receives number', async () => {
      const tool = makeTool()
      const result = await executeTool(tool, { amount: 12, label: 42 }, mockDeps)
      expect(result.error).toMatch(/must be a string/)
    })

    it('returns error when boolean param receives string', async () => {
      const tool = makeTool()
      const result = await executeTool(tool, { amount: 12, active: 'yes' }, mockDeps)
      expect(result.error).toMatch(/must be a boolean/)
    })

    it('allows optional params to be omitted', async () => {
      const tool = makeTool()
      const result = await executeTool(tool, { amount: 12 }, mockDeps)
      expect(result.error).toBeUndefined()
      expect(result.result).toEqual({ received: { amount: 12 } })
    })
  })

  describe('UI-invocation missing-required outcome split', () => {
    // Contract for chat escalation: empty required field → `missing` (UI, escalate to chat);
    // wrong type → `error` (toast). LLM-direct path always returns `error`, never `missing`.

    it('empty-string required:number → missing (UI), error (LLM-direct)', async () => {
      const tool = makeTool() // amount: number required

      const ui = await executeTool(tool, { amount: '' }, mockDeps, { isUIInvocation: true })
      expect(ui.missing).toEqual({ fields: ['amount'], provided: {} })
      expect(ui.error).toBeUndefined()
      expect(ui.result).toBeNull()

      const llm = await executeTool(tool, { amount: '' }, mockDeps)
      expect(llm.missing).toBeUndefined()
      expect(llm.error).toMatch(/Missing required parameter.*"amount"/)
    })

    it('absent required → missing (UI), error (LLM-direct)', async () => {
      const tool = makeTool()
      const ui = await executeTool(tool, { label: 'foo' }, mockDeps, { isUIInvocation: true })
      expect(ui.missing).toEqual({ fields: ['amount'], provided: { label: 'foo' } })

      const llm = await executeTool(tool, { label: 'foo' }, mockDeps)
      expect(llm.error).toMatch(/Missing required parameter.*"amount"/)
      expect(llm.missing).toBeUndefined()
    })

    it('multiple missing required fields all surface in one outcome (UI)', async () => {
      const tool: ToolDefinition = {
        name: 'set_goals',
        description: 'set goals',
        parameters: {
          kcal: { type: 'number', required: true, description: 'daily kcal target' },
          protein: { type: 'number', required: true, description: 'daily protein grams' },
          note: { type: 'string' },
        },
        execute: async () => ({ result: 'ok' }),
      }
      const ui = await executeTool(tool, { kcal: '', protein: null, note: 'hi' }, mockDeps, {
        isUIInvocation: true,
      })
      expect(ui.missing?.fields).toEqual(['kcal', 'protein'])
      expect(ui.missing?.provided).toEqual({ note: 'hi' })
    })

    it('shape error (NaN, "yes" boolean) is NOT treated as missing on either path', async () => {
      const tool = makeTool()
      // "twelve" is present but unparseable — that's a shape error, not absence.
      const ui = await executeTool(tool, { amount: 'twelve' }, mockDeps, { isUIInvocation: true })
      expect(ui.missing).toBeUndefined()
      expect(ui.error).toMatch(/must be a number/)

      const llm = await executeTool(tool, { amount: 'twelve' }, mockDeps)
      expect(llm.missing).toBeUndefined()
      expect(llm.error).toMatch(/must be a number/)
    })

    it('coerced numeric string still executes through (no missing, no error)', async () => {
      const tool = makeTool()
      const result = await executeTool(tool, { amount: '12' }, mockDeps, { isUIInvocation: true })
      expect(result.missing).toBeUndefined()
      expect(result.error).toBeUndefined()
      expect(result.result).toEqual({ received: { amount: 12 } })
    })
  })

  // UI-invocation coercion is covered by `form-semantics-conformance.test.ts`.
  // These tests pin the strict path so a future change can't silently widen the LLM contract.
  describe('validateParamsAgainstSchema (strict path)', () => {
    const schema = {
      amount: { type: 'number' as const, required: true },
      active: { type: 'boolean' as const },
    }

    it('rejects numeric strings (no coercion on this path)', () => {
      expect(validateParamsAgainstSchema(schema, { amount: '2000' })).toMatch(/must be a number/)
    })

    it('rejects "true" / "false" strings (no coercion on this path)', () => {
      expect(validateParamsAgainstSchema(schema, { amount: 5, active: 'true' })).toMatch(
        /must be a boolean/,
      )
    })
  })

  describe('successful execution', () => {
    it('passes params and db to execute function', async () => {
      let receivedCtx: any = null
      const tool = makeTool({
        execute: async (ctx) => {
          receivedCtx = ctx
          return { result: 'ok' }
        },
      })
      const db = { expenses: 'mock-db' } as any

      await executeTool(tool, { amount: 5 }, { db })

      expect(receivedCtx.params).toEqual({ amount: 5 })
      expect(receivedCtx.db).toBe(db)
    })

    it('returns the ToolResult from execute', async () => {
      const tool = makeTool({
        execute: async () => ({ result: { id: 42, total: 99.99 } }),
      })
      const result = await executeTool(tool, { amount: 10 }, mockDeps)
      expect(result).toEqual({ result: { id: 42, total: 99.99 } })
    })

    it('works with empty parameters', async () => {
      const tool = makeTool({
        parameters: {},
        execute: async () => ({ result: [] }),
      })
      const result = await executeTool(tool, {}, mockDeps)
      expect(result).toEqual({ result: [] })
    })
  })

  describe('error handling', () => {
    it('catches thrown Error and returns error result', async () => {
      const tool = makeTool({
        execute: async () => {
          throw new Error('DB connection failed')
        },
      })
      const result = await executeTool(tool, { amount: 5 }, mockDeps)
      expect(result.result).toBeNull()
      expect(result.error).toBe('DB connection failed')
    })

    it('catches thrown string and returns error result', async () => {
      const tool = makeTool({
        execute: async () => {
          throw 'raw string error'
        },
      })
      const result = await executeTool(tool, { amount: 5 }, mockDeps)
      expect(result.result).toBeNull()
      expect(result.error).toBe('raw string error')
    })
  })

  describe('timeout', () => {
    it('returns error when tool exceeds timeout', async () => {
      const tool = makeTool({
        execute: async () => {
          await new Promise((r) => setTimeout(r, 500))
          return { result: 'too late' }
        },
      })
      const result = await executeTool(tool, { amount: 5 }, mockDeps, { timeoutMs: 50 })
      expect(result.result).toBeNull()
      expect(result.error).toMatch(/timed out/)
    })

    it('completes normally when within timeout', async () => {
      const tool = makeTool({
        execute: async () => {
          await new Promise((r) => setTimeout(r, 10))
          return { result: 'fast' }
        },
      })
      const result = await executeTool(tool, { amount: 5 }, mockDeps, { timeoutMs: 1000 })
      expect(result).toEqual({ result: 'fast' })
    })
  })
})
