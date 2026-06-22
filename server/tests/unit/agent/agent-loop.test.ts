import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '../../../src/server/agent/agent-loop.js'
import { FaceRegistry } from '../../../src/server/agent/face-loader.js'
import type { AgentRequest, ToolDefinition } from '../../../src/server/agent/types.js'
import { ScriptedAdapter } from '../../helpers/face-params-fixtures.js'

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    conversationId: 'test',
    message: 'test message',
    mode: 'direct_user_chat',
    tools: [],
    cwd: '/tmp/moumantai-test',
    sdkBound: false,
    context: {
      appId: 'test-app',
      manifest: { id: 'test-app', name: 'Test', icon: 'test', description: 'Test' },
      turnMode: 'direct_user_chat',
    },
    ...overrides,
  }
}

function makeTool(name: string, executeFn?: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: {},
    execute: executeFn ?? (async () => ({ result: { ok: true } })),
  }
}

function makeLoop(
  adapter: ScriptedAdapter,
  tools: ToolDefinition[] = [],
  faces: FaceRegistry = new FaceRegistry(),
) {
  const toolRegistry = new Map(tools.map((t) => [t.name, t]))
  const sendFaceUpdate = vi.fn()
  const loop = new AgentLoop({
    adapter,
    toolRegistry,
    faceRegistry: faces,
    db: {} as any,
    docs: {} as any,
    appId: 'test-app',
    sendFaceUpdate,
  })
  return { loop, sendFaceUpdate }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  describe('text-only turn', () => {
    it('returns accumulated text with no tool calls', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world!' },
        { type: 'done' },
      ])

      const { loop } = makeLoop(adapter)
      const result = await loop.runTurn(makeRequest())

      expect(result.text).toBe('Hello world!')
      expect(result.toolCalls).toEqual([])
      expect(result.success).toBe(true)
    })
  })

  describe('single tool call', () => {
    it('executes tool and returns result in toolCalls', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'toolCall', callId: 'c1', name: 'my_tool', args: { x: 1 } },
        { type: 'text', text: 'Done!' },
        { type: 'done' },
      ])

      const tool = makeTool('my_tool', async ({ params }) => ({
        result: { doubled: (params.x as number) * 2 },
      }))

      const { loop } = makeLoop(adapter, [tool])
      const result = await loop.runTurn(makeRequest())

      expect(result.success).toBe(true)
      expect(result.text).toBe('Done!')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0]).toEqual({
        name: 'my_tool',
        args: { x: 1 },
        result: { doubled: 2 },
      })
    })

    it('calls submitToolResult on the adapter', async () => {
      const adapter = new ScriptedAdapter()
      const submitSpy = vi.spyOn(adapter, 'submitToolResult')
      adapter.setEvents([
        { type: 'toolCall', callId: 'c1', name: 'my_tool', args: {} },
        { type: 'done' },
      ])

      const { loop } = makeLoop(adapter, [makeTool('my_tool')])
      await loop.runTurn(makeRequest())

      expect(submitSpy).toHaveBeenCalledWith('test', 'c1', { result: { ok: true } })
    })

    it('refreshes all faces after tool execution', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'toolCall', callId: 'c1', name: 'my_tool', args: {} },
        { type: 'done' },
      ])

      const faces = new FaceRegistry()
      faces.register(
        {
          id: 'main',
          label: 'Main',
          position: 0,
          components: [{ id: 'root', component: 'Text' }],
          resolve: () => ({ val: 42 }),
        },
        { skipValidation: true },
      )

      const { loop, sendFaceUpdate } = makeLoop(adapter, [makeTool('my_tool')], faces)
      await loop.runTurn(makeRequest())

      expect(sendFaceUpdate).toHaveBeenCalledWith('test-app', 'main', faces, {
        val: 42,
        $params: {},
      })
    })
  })

  describe('multiple sequential tool calls', () => {
    it('executes tools in order, refreshes faces after each', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'toolCall', callId: 'c1', name: 'tool_a', args: {} },
        { type: 'toolCall', callId: 'c2', name: 'tool_b', args: {} },
        { type: 'text', text: 'Both done.' },
        { type: 'done' },
      ])

      const executionOrder: string[] = []
      const toolA = makeTool('tool_a', async () => {
        executionOrder.push('a')
        return { result: 'a-result' }
      })
      const toolB = makeTool('tool_b', async () => {
        executionOrder.push('b')
        return { result: 'b-result' }
      })

      const faces = new FaceRegistry()
      faces.register({ id: 'f', label: 'F', position: 0, components: [], resolve: () => ({}) })

      const { loop, sendFaceUpdate } = makeLoop(adapter, [toolA, toolB], faces)
      const result = await loop.runTurn(makeRequest())

      expect(executionOrder).toEqual(['a', 'b'])
      expect(result.toolCalls).toHaveLength(2)
      expect(result.text).toBe('Both done.')
      // Face refresh after each tool = 2 calls
      expect(sendFaceUpdate).toHaveBeenCalledTimes(2)
    })
  })

  describe('todosUpdate event', () => {
    it('forwards todos to the onTodos dep', async () => {
      const adapter = new ScriptedAdapter()
      const todos = [
        { content: 'Add face', status: 'in_progress' as const, activeForm: 'Adding face' },
      ]
      adapter.setEvents([
        { type: 'todosUpdate', todos },
        { type: 'text', text: 'ok' },
        { type: 'done' },
      ])

      const onTodos = vi.fn()
      const loop = new AgentLoop({
        adapter,
        toolRegistry: new Map(),
        faceRegistry: new FaceRegistry(),
        db: {} as any,
        appId: 'test-app',
        sendFaceUpdate: vi.fn(),
        onTodos,
      })
      const result = await loop.runTurn(makeRequest())

      expect(result.success).toBe(true)
      expect(onTodos).toHaveBeenCalledTimes(1)
      expect(onTodos).toHaveBeenCalledWith(todos)
    })

    it('is a no-op when onTodos is omitted (turn still succeeds)', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'todosUpdate', todos: [{ content: 'A', status: 'pending', activeForm: 'A' }] },
        { type: 'done' },
      ])

      const { loop } = makeLoop(adapter)
      const result = await loop.runTurn(makeRequest())

      expect(result.success).toBe(true)
    })
  })

  describe('unknown tool', () => {
    it('returns error result to adapter and records in toolCalls', async () => {
      const adapter = new ScriptedAdapter()
      const submitSpy = vi.spyOn(adapter, 'submitToolResult')
      adapter.setEvents([
        { type: 'toolCall', callId: 'c1', name: 'nonexistent', args: {} },
        { type: 'text', text: 'Hmm.' },
        { type: 'done' },
      ])

      const { loop } = makeLoop(adapter) // no tools registered
      const result = await loop.runTurn(makeRequest())

      expect(result.success).toBe(true) // loop completed successfully
      expect(result.toolCalls[0].result).toBe('Unknown tool: nonexistent')
      expect(submitSpy).toHaveBeenCalledWith('test', 'c1', {
        result: null,
        error: 'Unknown tool: nonexistent',
      })
    })
  })

  describe('adapter error event', () => {
    it('returns error result immediately', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'text', text: 'Starting...' },
        { type: 'error', message: 'Backend unavailable' },
      ])

      const { loop } = makeLoop(adapter)
      const result = await loop.runTurn(makeRequest())

      expect(result.success).toBe(false)
      expect(result.text).toBe('Backend unavailable')
    })
  })

  describe('cancellation', () => {
    it('discards buffered text when cancelled mid-turn via tool', async () => {
      // Use a tool that cancels the loop during execution.
      // After the tool, the cancel flag is checked before processing more events.
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'toolCall', callId: 'c1', name: 'cancel_trigger', args: {} },
        { type: 'text', text: 'This will be discarded' },
        { type: 'done' },
      ])

      let loopRef: AgentLoop
      const cancelTool = makeTool('cancel_trigger', async () => {
        loopRef.cancel()
        return { result: 'trigger-done' }
      })

      const { loop } = makeLoop(adapter, [cancelTool])
      loopRef = loop
      const result = await loop.runTurn(makeRequest())

      // Tool completed (side effects committed), but text discarded
      expect(result.toolCalls).toHaveLength(1)
      expect(result.text).toBe('')
      expect(result.success).toBe(false)
    })

    it('preserves tool calls completed before cancellation', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'toolCall', callId: 'c1', name: 'real_work', args: {} },
        { type: 'toolCall', callId: 'c2', name: 'cancel_trigger', args: {} },
        { type: 'text', text: 'This text discarded' },
        { type: 'done' },
      ])

      let loopRef: AgentLoop
      const realTool = makeTool('real_work', async () => ({ result: 'work-done' }))
      const cancelTool = makeTool('cancel_trigger', async () => {
        loopRef.cancel()
        return { result: 'cancelled' }
      })

      const { loop } = makeLoop(adapter, [realTool, cancelTool])
      loopRef = loop
      const result = await loop.runTurn(makeRequest())

      // Both tools completed, but text after cancel is discarded
      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0].result).toBe('work-done')
      expect(result.text).toBe('')
      expect(result.success).toBe(false)
    })
  })

  describe('stream ends without done', () => {
    it('treats end-of-stream as done', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([
        { type: 'text', text: 'Partial response' },
        // No 'done' event
      ])

      const { loop } = makeLoop(adapter)
      const result = await loop.runTurn(makeRequest())

      expect(result.text).toBe('Partial response')
      expect(result.success).toBe(true)
    })
  })

  describe('AbortSignal', () => {
    it('returns immediately with success=false when the signal is already aborted', async () => {
      const adapter = new ScriptedAdapter()
      adapter.setEvents([{ type: 'text', text: 'should not appear' }, { type: 'done' }])

      const { loop } = makeLoop(adapter)
      const controller = new AbortController()
      controller.abort()

      const result = await loop.runTurn(makeRequest({ signal: controller.signal }))

      expect(result.success).toBe(false)
      expect(result.text).toBe('')
    })

    it('aborts mid-turn: signal fires during a tool, loop returns without further text', async () => {
      const adapter = new ScriptedAdapter()
      // Tool blocks until we release the gate — gives us a deterministic
      // point at which to abort.
      let releaseTool!: () => void
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve
      })
      const tool = makeTool('foo', async () => {
        await toolGate
        return { result: { ok: true } }
      })

      adapter.setEvents([
        { type: 'text', text: 'before' },
        { type: 'toolCall', callId: 'c1', name: 'foo', args: {} },
        { type: 'text', text: 'after' }, // should NOT be accumulated after abort
        { type: 'done' },
      ])

      const { loop } = makeLoop(adapter, [tool])
      const controller = new AbortController()
      const running = loop.runTurn(makeRequest({ signal: controller.signal }))

      // Give the loop a microtask cycle to start the tool.
      await new Promise((r) => setTimeout(r, 10))
      controller.abort()
      // Now release the tool so the loop unblocks and checks cancelRequested.
      releaseTool()

      const result = await running
      expect(result.success).toBe(false)
      expect(result.text).toBe('')
    })
  })
})
