import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  AgentEvent,
  AgentRequest,
  ToolSchema,
  ToolResult,
} from '../../../../src/server/agent/types.js'

// ---------------------------------------------------------------------------
// Mock the Claude Agent SDK
// ---------------------------------------------------------------------------

/** Callback set by each test to control what query() yields. */
let queryBehavior: (opts: { prompt: string; options: any }) => AsyncIterable<any>

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (opts: any) => queryBehavior(opts),
    tool: (name: string, description: string, _schema: any, handler: Function) => ({
      name,
      description,
      handler,
    }),
    createSdkMcpServer: (opts: any) => ({
      type: 'sdk',
      name: opts.name,
      tools: opts.tools,
    }),
    renameSession: vi.fn(async () => {}),
    tagSession: vi.fn(async () => {}),
  }
})

// Must import AFTER vi.mock so the mock takes effect
import {
  ANTHROPIC_IMAGE_MIME_TYPES,
  ClaudeAgentAdapter,
  buildZodSchema,
  isAnthropicImageMime,
} from '../../../../src/server/agent/claude/adapter.js'
import { buildSystemPrompt } from '../../../../src/server/agent/system-prompt.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    conversationId: 'test-session',
    message: 'hello',
    mode: 'direct_user_chat',
    tools: [],
    cwd: '/tmp/moumantai-test',
    sdkBound: false,
    context: {
      appId: 'home',
      manifest: {
        id: 'home',
        name: 'Home',
        icon: 'chat',
        description: 'Home assistant',
      },
      turnMode: 'direct_user_chat',
    },
    ...overrides,
  }
}

describe('isAnthropicImageMime', () => {
  it('accepts each MIME type Anthropic vision supports', () => {
    for (const mime of ANTHROPIC_IMAGE_MIME_TYPES) {
      expect(isAnthropicImageMime(mime)).toBe(true)
    }
  })

  it.each([
    'image/bmp',
    'image/tiff',
    'image/svg+xml',
    'image/heic',
    'application/octet-stream',
    'text/plain',
    '',
    'IMAGE/JPEG', // case-sensitive — must match exactly
    'image/jpeg; charset=utf-8', // no extra parameters
  ])('rejects %s', (mime) => {
    expect(isAnthropicImageMime(mime)).toBe(false)
  })
})

const expenseTools: ToolSchema[] = [
  {
    name: 'add_expense',
    description: 'Add a new expense',
    parameters: {
      amount: {
        type: 'number',
        required: true,
        description: 'Amount in dollars',
      },
      description: { type: 'string', required: true },
      category: { type: 'string' },
    },
  },
  {
    name: 'query_expenses',
    description: 'List expenses',
    parameters: {},
  },
]

/**
 * Collect all events, auto-submitting tool results so the generator doesn't hang.
 * Filters `sessionBound` (bookkeeping noise); tests that need it call `adapter.run` directly.
 */
async function collectEvents(
  adapter: ClaudeAgentAdapter,
  request: AgentRequest,
  toolResultFn?: (event: AgentEvent & { type: 'toolCall' }) => ToolResult,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of adapter.run(request)) {
    if (event.type === 'sessionBound') continue
    events.push(event)
    if (event.type === 'toolCall') {
      const result = toolResultFn ? toolResultFn(event) : { result: { success: true } }
      adapter.submitToolResult(request.conversationId, event.callId, result)
    }
  }
  return events
}

/** Helper to create an async iterable from an array of SDK messages. */
async function* sdkMessages(msgs: any[]): AsyncIterable<any> {
  for (const msg of msgs) {
    yield msg
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeAgentAdapter', () => {
  let adapter: ClaudeAgentAdapter
  const origOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const origApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    adapter = new ClaudeAgentAdapter()
    // Ensure tests have a valid auth env
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })

  afterEach(() => {
    // Restore env
    if (origOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = origOAuth
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (origApiKey !== undefined) process.env.ANTHROPIC_API_KEY = origApiKey
    else delete process.env.ANTHROPIC_API_KEY
  })

  describe('lifecycle', () => {
    it('yields error if run() is called before connect', async () => {
      const events: AgentEvent[] = []
      for await (const event of adapter.run(makeRequest())) events.push(event)
      expect(events).toEqual([{ type: 'error', message: 'ClaudeAgentAdapter: not connected' }])
    })

    it('connect accepts OAuth token or apiKey; rejects when neither is set', async () => {
      // OAuth-token path
      delete process.env.ANTHROPIC_API_KEY
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
      await expect(adapter.connect({ type: 'claude' })).resolves.toBeUndefined()

      // apiKey-from-config path: sets env var
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.ANTHROPIC_API_KEY
      await adapter.connect({ type: 'claude', apiKey: 'from-config' })
      expect(process.env.ANTHROPIC_API_KEY).toBe('from-config')

      // No-auth path
      const adapter2 = new ClaudeAgentAdapter()
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.ANTHROPIC_API_KEY
      await expect(adapter2.connect({ type: 'claude' })).rejects.toThrow(
        'Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY',
      )
    })
  })

  describe('text-only response', () => {
    it('yields one text event from the result.result string OR accumulated assistant blocks', async () => {
      await adapter.connect({ type: 'claude' })

      // Path 1: result.result string is authoritative — emitted as one text event.
      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 'sdk-session-1' },
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Hello! How can I help?' }] },
          },
          { type: 'result', subtype: 'success', is_error: false, result: 'Hello! How can I help?' },
        ])
      expect(await collectEvents(adapter, makeRequest())).toEqual([
        { type: 'text', text: 'Hello! How can I help?' },
        { type: 'done' },
      ])

      // Path 2: no result.result → accumulator falls back to assistant blocks.
      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'First. ' },
                { type: 'text', text: 'Second.' },
              ],
            },
          },
          { type: 'result', is_error: false },
        ])
      expect(await collectEvents(adapter, makeRequest())).toEqual([
        { type: 'text', text: 'First. Second.' },
        { type: 'done' },
      ])
    })
  })

  describe('TodoWrite progress', () => {
    it('emits a todosUpdate event from a TodoWrite tool_use block (mapped + defensive)', async () => {
      await adapter.connect({ type: 'claude' })

      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Planning.' },
                {
                  type: 'tool_use',
                  id: 'tw-1',
                  name: 'TodoWrite',
                  input: {
                    todos: [
                      { content: 'Add face', status: 'in_progress', activeForm: 'Adding face' },
                      { content: 'Wire tool', status: 'pending', activeForm: 'Wiring tool' },
                      // Defensive cases: missing activeForm falls back to content;
                      // unknown status falls back to pending; empty content dropped.
                      { content: 'No activeForm', status: 'completed' },
                      { content: 'Weird', status: 'bogus', activeForm: 'Weirding' },
                      { content: '', status: 'pending', activeForm: 'dropped' },
                    ],
                  },
                },
              ],
            },
          },
          { type: 'result', is_error: false, result: 'done' },
        ])

      const events = await collectEvents(adapter, makeRequest({ allowedTools: ['TodoWrite'] }))

      expect(events).toContainEqual({
        type: 'todosUpdate',
        todos: [
          { content: 'Add face', status: 'in_progress', activeForm: 'Adding face' },
          { content: 'Wire tool', status: 'pending', activeForm: 'Wiring tool' },
          { content: 'No activeForm', status: 'completed', activeForm: 'No activeForm' },
          { content: 'Weird', status: 'pending', activeForm: 'Weirding' },
        ],
      })
      expect(events.at(-1)).toEqual({ type: 'done' })
    })

    it('does not emit todosUpdate for a normal (non-TodoWrite) tool_use block', async () => {
      await adapter.connect({ type: 'claude' })

      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'x-1',
                  name: 'mcp__edit__validate_face',
                  input: { face_id: 'x' },
                },
              ],
            },
          },
          { type: 'result', is_error: false, result: 'ok' },
        ])

      const events = await collectEvents(adapter, makeRequest({ allowedTools: ['Read'] }))
      expect(events.some((e) => e.type === 'todosUpdate')).toBe(false)
    })
  })

  describe('edit-agent permission wiring (queryOptions)', () => {
    it('enables built-ins via `tools`, auto-approves only the safe subset, gates via hooks + dontAsk', async () => {
      await adapter.connect({ type: 'claude' })

      let captured: Record<string, unknown> | undefined
      queryBehavior = (opts) => {
        captured = opts.options as Record<string, unknown>
        return sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          { type: 'result', is_error: false, result: 'ok' },
        ])
      }

      const hooks = {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
              }),
            ],
          },
        ],
      }
      await collectEvents(
        adapter,
        makeRequest({
          builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
          allowedTools: ['TodoWrite', 'mcp__edit__validate_face'],
          permissionMode: 'dontAsk',
          hooks,
        }),
      )

      // `tools` (enabled built-ins) comes from builtinTools verbatim.
      expect(captured!.tools).toEqual([
        'Read',
        'Edit',
        'Write',
        'Glob',
        'Grep',
        'Bash',
        'TodoWrite',
      ])
      // allowedTools (auto-approve) must NOT contain the file/Bash built-ins — the
      // original bug auto-approved them, bypassing the gate.
      for (const t of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']) {
        expect(captured!.allowedTools as string[]).not.toContain(t)
      }
      expect(captured!.allowedTools as string[]).toContain('TodoWrite')
      // PreToolUse hook passed through, dontAsk set, bypassPermissions NOT set.
      expect(captured!.hooks).toBe(hooks)
      expect(captured!.permissionMode).toBe('dontAsk')
      expect(captured!.allowDangerouslySkipPermissions).toBeUndefined()
    })

    it('app-agent path is unchanged: no builtinTools/hooks → tools:[] (MCP-only)', async () => {
      await adapter.connect({ type: 'claude' })
      let captured: Record<string, unknown> | undefined
      queryBehavior = (opts) => {
        captured = opts.options as Record<string, unknown>
        return sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          { type: 'result', is_error: false, result: 'ok' },
        ])
      }
      await collectEvents(adapter, makeRequest()) // plain app-agent request
      expect(captured!.tools).toEqual([])
      expect(captured!.hooks).toBeUndefined()
      expect(captured!.permissionMode).toBe('bypassPermissions')
      expect(captured!.allowDangerouslySkipPermissions).toBe(true)
    })

    // Regression: hooks/canUseTool are delivered over the SDK control protocol, which only
    // exists in STREAMING-INPUT mode (prompt = AsyncIterable). A bare-string prompt silently
    // drops them, so the edit-agent policy would never run.
    it('edit-agent (hooks present) uses streaming-input prompt so hooks fire', async () => {
      await adapter.connect({ type: 'claude' })
      let capturedPrompt: unknown
      queryBehavior = (opts) => {
        capturedPrompt = (opts as { prompt: unknown }).prompt
        return sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          { type: 'result', is_error: false, result: 'ok' },
        ])
      }
      const hooks = {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
              }),
            ],
          },
        ],
      }
      await collectEvents(adapter, makeRequest({ message: 'rename label', hooks }))
      expect(typeof capturedPrompt).not.toBe('string')
      expect((capturedPrompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBeTypeOf(
        'function',
      )
    })

    it('app-agent (no hooks, no attachments) keeps the bare-string prompt', async () => {
      await adapter.connect({ type: 'claude' })
      let capturedPrompt: unknown
      queryBehavior = (opts) => {
        capturedPrompt = (opts as { prompt: unknown }).prompt
        return sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          { type: 'result', is_error: false, result: 'ok' },
        ])
      }
      await collectEvents(adapter, makeRequest({ message: 'hello' }))
      expect(capturedPrompt).toBe('hello')
    })
  })

  describe('tool call bridge', () => {
    it('yields toolCall, pauses for daemon execution, then continues', async () => {
      await adapter.connect({ type: 'claude' })

      // The mock tool() captures the handler — we'll invoke it from query()
      let capturedHandlers: Map<string, Function> = new Map()

      queryBehavior = (opts) => {
        // Capture MCP tool handlers from the server config
        const server = opts.options.mcpServers?.moumantai
        if (server?.tools) {
          for (const t of server.tools) {
            capturedHandlers.set(t.name, t.handler)
          }
        }

        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's1' }
          yield {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Let me add that.' },
                {
                  type: 'tool_use',
                  id: 'tu-1',
                  name: 'add_expense',
                  input: { amount: 12, description: 'lunch' },
                },
              ],
            },
          }

          // Simulate SDK calling the MCP tool handler
          const handler = capturedHandlers.get('add_expense')!
          const toolResult = await handler({ amount: 12, description: 'lunch' })

          // SDK continues after tool result
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Done! Added $12 for lunch.' }],
            },
          }
          yield { type: 'result', is_error: false, result: 'Done! Added $12 for lunch.' }
        })()
      }

      const events = await collectEvents(
        adapter,
        makeRequest({ message: 'add $12 lunch', tools: expenseTools }),
      )

      // Text is emitted once at the end (from result.result), not per assistant message
      const types = events.map((e) => e.type)
      expect(types).toEqual(['toolCall', 'text', 'done'])

      // Verify the toolCall event has correct data
      const toolCall = events.find((e) => e.type === 'toolCall')!
      expect(toolCall).toMatchObject({
        type: 'toolCall',
        name: 'add_expense',
        args: { amount: 12, description: 'lunch' },
      })
    })
  })

  describe('error handling', () => {
    it('yields error when query() throws', async () => {
      await adapter.connect({ type: 'claude' })

      queryBehavior = () => {
        return (async function* () {
          throw new Error('Rate limited')
        })()
      }

      const events = await collectEvents(adapter, makeRequest())
      expect(events).toEqual([{ type: 'error', message: 'Rate limited' }])
    })

    it('yields error from SDK result message', async () => {
      await adapter.connect({ type: 'claude' })

      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          {
            type: 'result',
            is_error: true,
            errors: ['Max turns exceeded'],
          },
        ])

      const events = await collectEvents(adapter, makeRequest())
      expect(events).toEqual([{ type: 'error', message: 'Max turns exceeded' }, { type: 'done' }])
    })
  })

  describe('session management', () => {
    it('first turn passes a fresh SDK session id; sdkBound=true resumes via stored sdkSessionId', async () => {
      // SDK session id is a freshly-generated UUID, NOT the conversationId.
      // Decoupled so we can recover when the SDK's session metadata goes stale.
      await adapter.connect({ type: 'claude' })

      let lastOptions: any = null
      queryBehavior = (opts) => {
        lastOptions = opts.options
        return sdkMessages([
          { type: 'system', subtype: 'init', session_id: lastOptions.sessionId ?? 'sdk-xyz' },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
          { type: 'result', is_error: false },
        ])
      }

      // First turn: fresh UUID via sessionId, no resume.
      await collectEvents(adapter, makeRequest({ conversationId: 'conv-abc', sdkBound: false }))
      expect(lastOptions.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(lastOptions.sessionId).not.toBe('conv-abc')
      expect(lastOptions.resume).toBeUndefined()

      // Subsequent turn (sdkBound=true): resume via stored sdkSessionId, no fresh sessionId.
      await collectEvents(
        adapter,
        makeRequest({
          conversationId: 'conv-abc',
          sdkBound: true,
          sdkSessionId: 'sdk-xyz',
        }),
      )
      expect(lastOptions.resume).toBe('sdk-xyz')
      expect(lastOptions.sessionId).toBeUndefined()
    })

    it('emits sessionBound with the SDK-assigned id so caller can persist', async () => {
      await adapter.connect({ type: 'claude' })
      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 'sdk-authoritative' },
          { type: 'result', is_error: false },
        ])

      const events: AgentEvent[] = []
      for await (const e of adapter.run(
        makeRequest({ conversationId: 'conv-abc', sdkBound: false }),
      )) {
        events.push(e)
      }
      const bound = events.find((e) => e.type === 'sessionBound')
      expect(bound).toEqual({ type: 'sessionBound', sdkSessionId: 'sdk-authoritative' })
    })
  })

  describe('abort signal', () => {
    it('EventQueue ignores pushes after end (no late-event leak on double-close)', async () => {
      await adapter.connect({ type: 'claude' })

      // Both the abort path and runQuery's finally call events.end(). A stream
      // that emits `result` then keeps producing messages exercises this race:
      // the first end() wins, later pushes must drop.
      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 'conv-late' },
          { type: 'result', is_error: false, result: 'done' },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'too late' }] } },
        ])

      const events = await collectEvents(adapter, makeRequest({ conversationId: 'conv-late' }))
      expect(events.map((e) => e.type)).toEqual(['text', 'done'])
      expect(events.some((e) => e.type === 'text' && e.text === 'too late')).toBe(false)
    })

    it('pre-aborted signal resolves pending tool waiters and closes the stream', async () => {
      await adapter.connect({ type: 'claude' })

      // Aborted before run(): early-abort branch fires cleanup and ends the stream.
      // Generator yields no events and terminates promptly.
      queryBehavior = () =>
        sdkMessages([
          { type: 'system', subtype: 'init', session_id: 'conv-preab' },
          { type: 'result', is_error: false },
        ])

      const controller = new AbortController()
      controller.abort()
      const req = makeRequest({ conversationId: 'conv-preab', signal: controller.signal })
      const events = await collectEvents(adapter, req)
      // Empty — no events before terminator.
      expect(events).toEqual([])
    })
  })

  describe('query options', () => {
    it('passes system prompt and disables built-in tools', async () => {
      await adapter.connect({ type: 'claude' })

      let lastOptions: any = null
      queryBehavior = (opts) => {
        lastOptions = opts.options
        return sdkMessages([
          { type: 'system', subtype: 'init', session_id: 's1' },
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'hi' }] },
          },
          { type: 'result', is_error: false },
        ])
      }

      await collectEvents(
        adapter,
        makeRequest({
          tools: expenseTools,
          context: {
            appId: 'spend-tracker',
            manifest: {
              id: 'spend-tracker',
              name: 'Spend Tracker',
              icon: 'wallet',
              description: 'Track expenses',
            },
            skill: 'You manage expense tracking.',
            turnMode: 'direct_user_chat',
          },
        }),
      )

      expect(lastOptions.systemPrompt).toContain('Spend Tracker')
      expect(lastOptions.systemPrompt).toContain('You manage expense tracking.')
      expect(lastOptions.tools).toEqual([])
      expect(lastOptions.allowedTools).toEqual([
        'mcp__moumantai__add_expense',
        'mcp__moumantai__query_expenses',
      ])
      expect(lastOptions.permissionMode).toBe('bypassPermissions')
      expect(lastOptions.settingSources).toEqual([])
      expect(lastOptions.maxTurns).toBe(10)
    })

    it('passes request.cwd through as the SDK cwd option', async () => {
      await adapter.connect({ type: 'claude' })

      let lastOptions: any = null
      queryBehavior = (opts) => {
        lastOptions = opts.options
        return sdkMessages([
          { type: 'system', subtype: 'init', session_id: 'test-session' },
          { type: 'result', is_error: false, result: 'ok' },
        ])
      }

      await collectEvents(
        adapter,
        makeRequest({ cwd: '/tmp/moumantai/claude-cwd/apps/spend-tracker' }),
      )
      expect(lastOptions.cwd).toBe('/tmp/moumantai/claude-cwd/apps/spend-tracker')
    })
  })
})

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('buildZodSchema', () => {
  it.each([
    {
      label: 'required string',
      params: { name: { type: 'string', required: true } as const },
      field: 'name',
      optional: false,
    },
    {
      label: 'optional number',
      params: { limit: { type: 'number' } as const },
      field: 'limit',
      optional: true,
    },
    {
      label: 'required boolean',
      params: { active: { type: 'boolean', required: true } as const },
      field: 'active',
      optional: false,
    },
  ])('converts $label param', ({ params, field, optional }) => {
    const shape = buildZodSchema(params)
    expect(shape[field]).toBeDefined()
    expect(shape[field]!.isOptional()).toBe(optional)
  })

  it('throws on unsupported parameter type (names the param)', () => {
    expect(() =>
      buildZodSchema({
        // @ts-expect-error — intentionally invalid type for this test
        tags: { type: 'array', required: true },
      }),
    ).toThrow(/unsupported type "array" on param "tags"/)
  })
})

describe('ClaudeAgentAdapter heartbeat', () => {
  it('emits error + done if the SDK stream yields nothing for 30s', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ClaudeAgentAdapter()
      process.env.ANTHROPIC_API_KEY = 'test-key'
      await adapter.connect({ type: 'claude' })

      // SDK mock that hangs forever — never yields.
      queryBehavior = () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<unknown>>(() => {
                /* never resolves — simulates a wedged stream */
              }),
          }
        },
      })

      const events: AgentEvent[] = []
      const collector = (async () => {
        for await (const e of adapter.run(makeRequest())) events.push(e)
      })()

      // Let the runQuery microtask settle (queue the heartbeat setTimeout).
      await vi.advanceTimersByTimeAsync(0)
      // Advance past the 30s heartbeat.
      await vi.advanceTimersByTimeAsync(30_000)

      await collector

      expect(events).toEqual([
        {
          type: 'error',
          message: expect.stringMatching(/SDK stream stalled.*30s/),
        },
        { type: 'done' },
      ])

      await adapter.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('buildSystemPrompt', () => {
  it('includes app info and skill but never tool names', () => {
    const prompt = buildSystemPrompt(
      {
        appId: 'test',
        manifest: {
          id: 'test',
          name: 'Test App',
          icon: 'test',
          description: 'A test app',
        },
        skill: 'Do testing.',
        turnMode: 'direct_user_chat',
      },
      [
        {
          name: 'do_thing',
          description: 'Does thing',
          parameters: { x: { type: 'string', required: true } },
        },
      ],
    )
    expect(prompt).toContain('Test App')
    expect(prompt).toContain('Do testing.')
    expect(prompt).not.toContain('do_thing')
  })

  it('includes delegation context', () => {
    const prompt = buildSystemPrompt(
      {
        appId: 'test',
        manifest: {
          id: 'test',
          name: 'Test App',
          icon: 'test',
          description: 'A test',
        },
        turnMode: 'delegated_from_home',
      },
      [],
    )
    expect(prompt).toContain('delegated from the home assistant')
  })
})
