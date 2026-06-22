import { describe, it, expect, vi } from 'vitest'
import { handleInvokeTool } from '../../../src/server/agent/action-handler.js'
import { FaceRegistry } from '../../../src/server/agent/face-loader.js'
import type { ToolDefinition } from '../../../src/server/agent/types.js'

function makeTool(name: string, executeFn?: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: {},
    execute: executeFn ?? (async () => ({ result: { ok: true } })),
  }
}

function makeDeps(tools: ToolDefinition[] = [], faces: FaceRegistry = new FaceRegistry()) {
  const sendFaceUpdate = vi.fn()
  return {
    deps: {
      toolRegistry: new Map(tools.map((t) => [t.name, t])),
      faceRegistry: faces,
      db: {} as never,
      appId: 'test-app',
      sendFaceUpdate,
    },
    sendFaceUpdate,
  }
}

describe('handleInvokeTool', () => {
  it('executes matching tool and returns result on success', async () => {
    const tool = makeTool('increment', async ({ params }) => ({
      result: { newValue: ((params.current as number) ?? 0) + 1 },
    }))
    const { deps } = makeDeps([tool])

    const outcome = await handleInvokeTool('increment', { current: 5 }, deps)
    expect(outcome.error).toBeNull()
    expect(outcome.deduped).toBe(false)
    expect(outcome.result).toEqual({ result: { newValue: 6 } })
  })

  it('returns tool_not_found error when no matching tool', async () => {
    const { deps } = makeDeps()
    const outcome = await handleInvokeTool('nonexistent', {}, deps)
    expect(outcome.result).toBeNull()
    expect(outcome.error?.code).toBe('tool_not_found')
    expect(outcome.error?.message).toContain('nonexistent')
  })

  it('refreshes all faces after a successful tool invocation', async () => {
    const tool = makeTool('update_data')
    const faces = new FaceRegistry()
    faces.register(
      {
        id: 'main',
        label: 'Main',
        position: 0,
        viewToolDescription: 'View main',
        components: [{ id: 'root', component: 'Text' }],
        resolve: () => ({ count: 10 }),
      } as never,
      { skipValidation: true },
    )

    const { deps, sendFaceUpdate } = makeDeps([tool], faces)
    await handleInvokeTool('update_data', {}, deps)

    expect(sendFaceUpdate).toHaveBeenCalledWith('test-app', 'main', faces, {
      count: 10,
      $params: {},
    })
  })

  it('does not refresh faces when tool not found', async () => {
    const faces = new FaceRegistry()
    faces.register(
      {
        id: 'main',
        label: 'Main',
        position: 0,
        viewToolDescription: 'View main',
        components: [],
        resolve: () => ({}),
      } as never,
      { skipValidation: true },
    )

    const { deps, sendFaceUpdate } = makeDeps([], faces)
    await handleInvokeTool('missing', {}, deps)

    expect(sendFaceUpdate).not.toHaveBeenCalled()
  })

  it('passes args as tool params', async () => {
    let receivedParams: Record<string, unknown> = {}
    const tool = makeTool('save', async ({ params }) => {
      receivedParams = params
      return { result: 'saved' }
    })

    const { deps } = makeDeps([tool])
    await handleInvokeTool('save', { name: 'test', value: 42 }, deps)

    expect(receivedParams).toEqual({ name: 'test', value: 42 })
  })

  it('surfaces tool throws as internal error (no rethrow)', async () => {
    const tool = makeTool('crash', async () => {
      throw new Error('tool crashed')
    })

    const { deps } = makeDeps([tool])
    const outcome = await handleInvokeTool('crash', {}, deps)

    // executeTool catches throws and wraps them in ToolResult.error;
    // handleInvokeTool surfaces that as `tool_validation`.
    expect(outcome.error?.code).toBe('tool_validation')
    expect(outcome.error?.message).toContain('tool crashed')
  })

  it('returns tool_validation error when ToolResult.error is set', async () => {
    const tool = makeTool('reject', async () => ({ result: null, error: 'kcal must be positive' }))
    const { deps } = makeDeps([tool])
    const outcome = await handleInvokeTool('reject', { kcal: -100 }, deps)
    expect(outcome.error?.code).toBe('tool_validation')
    expect(outcome.error?.message).toBe('kcal must be positive')
  })
})

describe('handleInvokeTool — no synthetic [ui_action] in chat display', () => {
  // Pre-escalation behavior would append a synthetic `[ui_action] ...` row
  // to the user-visible chat for every tap. That's gone — the breadcrumb
  // lives in SDK jsonl only (so the LLM has it on resume), and chat display
  // only shows the assistant's question / confirmation. See action-handler
  // module-level comment for the (display ↔ jsonl) divergence rationale.
  function makeChatStore() {
    const appended: Array<{ role: string; text: string }> = []
    const conversationStore = {
      appendTurn: (_convId: string, entry: { role: string; text: string }) => {
        appended.push({ role: entry.role, text: entry.text })
        return { id: 'stub', text: entry.text, status: 'completed' }
      },
    } as never
    return { conversationStore, appended }
  }

  const successTool = makeTool('save', async () => ({ result: 'ok' }))
  const validationTool = makeTool('reject', async () => ({ result: null, error: 'bad input' }))

  it.each([
    ['success', 'save', [successTool]],
    ['tool_not_found', 'missing', []],
    ['tool_validation', 'reject', [validationTool]],
  ] as const)('does not append a [ui_action] row on %s', async (_label, name, tools) => {
    const { deps } = makeDeps([...tools])
    const { conversationStore, appended } = makeChatStore()
    await handleInvokeTool(
      name,
      {},
      {
        ...deps,
        conversationStore,
        conversationId: 'c1',
        sourceFaceId: 'face1',
      },
    )
    const uiActionRows = appended.filter((r) => r.text.startsWith('[ui_action]'))
    expect(uiActionRows).toHaveLength(0)
  })
})

describe('handleInvokeTool dedup', () => {
  it('returns deduped:true on a repeat clientRequestId', async () => {
    let executions = 0
    const tool = makeTool('count', async () => ({ result: { n: ++executions } }))
    const { deps } = makeDeps([tool])

    // Minimal in-memory dedup store mock — reuses the persistent-store
    // contract (lookup/record). Confirms the handler hits the cache.
    const cache = new Map<string, { result: unknown }>()
    const dedupStore = {
      lookup: (convId: string, reqId: string) => {
        const hit = cache.get(`${convId}:${reqId}`)
        return hit ? { result: hit.result as never } : null
      },
      record: (convId: string, reqId: string, result: unknown) => {
        cache.set(`${convId}:${reqId}`, { result })
      },
      sweepStale: () => 0,
    } as never

    const depsWithDedup = {
      ...deps,
      dedupStore,
      conversationId: 'conv-1',
      clientRequestId: 'req-abc',
    }

    const first = await handleInvokeTool('count', {}, depsWithDedup)
    expect(first.deduped).toBe(false)
    expect(executions).toBe(1)

    const second = await handleInvokeTool('count', {}, depsWithDedup)
    expect(second.deduped).toBe(true)
    expect(executions).toBe(1) // tool not re-executed
    expect(second.result).toEqual(first.result)
  })
})
