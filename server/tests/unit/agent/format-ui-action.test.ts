import { describe, it, expect } from 'vitest'
import { formatUiActionPrompt } from '../../../src/server/agent/format-ui-action.js'
import type { ToolDefinition } from '../../../src/server/agent/types.js'

function makeTool(parameters: ToolDefinition['parameters']): ToolDefinition {
  return {
    name: 'set_daily_goal',
    description: 'Set the daily kcal goal',
    parameters,
    execute: async () => ({ result: 'ok' }),
  }
}

describe('formatUiActionPrompt', () => {
  it('emits the canonical [ui_action] line with face + tool + missing-spec + provided', () => {
    const tool = makeTool({
      kcal: { type: 'number', required: true, description: 'daily kcal target' },
    })
    const out = formatUiActionPrompt({
      faceId: 'goals',
      tool,
      missing: ['kcal'],
      provided: {},
    })
    expect(out).toBe(
      '[ui_action] face=goals tool=set_daily_goal missing=[kcal:number "daily kcal target"] provided={}',
    )
  })

  it('includes provided JSON when partial prefill present', () => {
    const tool = makeTool({
      meal: { type: 'string', required: true, description: 'meal name' },
      kcal: { type: 'number', required: true, description: 'kcal' },
    })
    const out = formatUiActionPrompt({
      faceId: 'today',
      tool,
      missing: ['meal'],
      provided: { kcal: 250 },
    })
    expect(out).toContain('missing=[meal:string "meal name"]')
    expect(out).toContain('provided={"kcal":250}')
  })

  it('falls back to bare name:type when no description', () => {
    const tool = makeTool({
      x: { type: 'number', required: true },
    })
    const out = formatUiActionPrompt({ faceId: 'f', tool, missing: ['x'], provided: {} })
    expect(out).toContain('missing=[x:number]')
    expect(out).not.toContain('"undefined"')
  })

  it('joins multiple missing fields with comma', () => {
    const tool = makeTool({
      a: { type: 'number', required: true, description: 'A' },
      b: { type: 'string', required: true, description: 'B' },
    })
    const out = formatUiActionPrompt({ faceId: 'f', tool, missing: ['a', 'b'], provided: {} })
    expect(out).toContain('missing=[a:number "A", b:string "B"]')
  })
})
