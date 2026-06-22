import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRequest, AgentEvent } from '../../../../src/server/agent/types.js'

// ---------------------------------------------------------------------------
// Pi SDK mock. Exercises the real SessionManager (file lifecycle, continueRecent,
// buildSessionContext) and defineTool. Only stubs surfaces that need network/secrets
// or own the agent loop: AuthStorage, ModelRegistry, DefaultResourceLoader,
// and createAgentSession. The stubbed AgentSession is scriptable synchronously.
// ---------------------------------------------------------------------------

// Captured by the createAgentSession mock so tests can drive the session.
let listener: ((e: unknown) => void) | null = null
let promptScript: () => Promise<void> | void = () => {}
// Latest SessionManager passed to createAgentSession (real instance, mock just captures the ref).
let lastSessionManager: import('@earendil-works/pi-coding-agent').SessionManager | null = null

const fakeModel = { provider: 'anthropic', id: 'claude-opus-4-5' }
let registryFindBehavior: () => unknown = () => fakeModel

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  )
  return {
    ...actual,
    AuthStorage: {
      create: vi.fn(() => ({ setRuntimeApiKey: vi.fn() })),
    },
    ModelRegistry: {
      create: vi.fn(() => ({ find: vi.fn(() => registryFindBehavior()) })),
    },
    DefaultResourceLoader: class {
      async reload(): Promise<void> {}
    },
    createAgentSession: vi.fn(
      async (cfg: { sessionManager: import('@earendil-works/pi-coding-agent').SessionManager }) => {
        lastSessionManager = cfg.sessionManager
        return {
          session: {
            subscribe: vi.fn((l: (e: unknown) => void) => {
              listener = l
              return () => {
                listener = null
              }
            }),
            prompt: vi.fn(async () => {
              await promptScript()
            }),
            abort: vi.fn(async () => {}),
            dispose: vi.fn(() => {}),
          },
          extensionsResult: {},
        }
      },
    ),
  }
})

// Must import after vi.mock so adapter.ts resolves against the mock factory.
import { PiAgentAdapter } from '../../../../src/server/agent/pi/adapter.js'
import { buildTypeBoxSchema } from '../../../../src/server/agent/pi/typebox-schema.js'

// Fire a sequence of Pi events into the captured listener.
function fire(events: unknown[]): void {
  if (!listener) throw new Error('test bug: no Pi listener registered yet')
  for (const e of events) listener(e)
}

// Build an AssistantMessage shaped object good enough for SessionManager._persist
// to recognize as an "assistant message has arrived" and flush the jsonl.
function stubAssistant(text: string): unknown {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function stubUser(text: string): unknown {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// buildTypeBoxSchema (unchanged)
// ---------------------------------------------------------------------------

describe('buildTypeBoxSchema', () => {
  it('maps string/number/boolean primitives', () => {
    const s = buildTypeBoxSchema({
      a: { type: 'string', required: true },
      b: { type: 'number', required: true },
      c: { type: 'boolean', required: true },
    })
    expect(s.type).toBe('object')
    expect(s.properties.a.type).toBe('string')
    expect(s.properties.b.type).toBe('number')
    expect(s.properties.c.type).toBe('boolean')
  })

  it('puts required params in `required`, omits optionals', () => {
    const s = buildTypeBoxSchema({
      keep: { type: 'string', required: true },
      drop: { type: 'string', required: false },
    })
    expect(s.required).toEqual(['keep'])
  })

  it('preserves the description field for the LLM', () => {
    const s = buildTypeBoxSchema({
      x: { type: 'string', required: true, description: 'the X value' },
    })
    expect(s.properties.x.description).toBe('the X value')
  })

  it('throws on unsupported types', () => {
    expect(() =>
      // @ts-expect-error — deliberately invalid for the test
      buildTypeBoxSchema({ bad: { type: 'object', required: true } }),
    ).toThrow(/unsupported type "object"/)
  })
})

// ---------------------------------------------------------------------------
// PiAgentAdapter.connect — validation
// ---------------------------------------------------------------------------

// Module-level test state reset — covers all describe blocks below.
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'moumantai-pi-test-'))
  registryFindBehavior = () => fakeModel
  listener = null
  promptScript = () => {}
  lastSessionManager = null
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('PiAgentAdapter.connect', () => {
  it('throws when home is missing', async () => {
    const adapter = new PiAgentAdapter()
    await expect(
      adapter.connect({
        type: 'pi',
        piProvider: 'anthropic',
        piModel: 'claude-opus-4-5',
      }),
    ).rejects.toThrow(/config\.home is required/)
  })

  it('throws when piProvider is missing', async () => {
    const adapter = new PiAgentAdapter()
    await expect(adapter.connect({ type: 'pi', home, piModel: 'claude-opus-4-5' })).rejects.toThrow(
      /piProvider is required/,
    )
  })

  it('throws when piModel is missing', async () => {
    const adapter = new PiAgentAdapter()
    await expect(adapter.connect({ type: 'pi', home, piProvider: 'anthropic' })).rejects.toThrow(
      /piModel is required/,
    )
  })

  it('throws when ModelRegistry.find returns undefined (not in registry)', async () => {
    registryFindBehavior = () => undefined
    const adapter = new PiAgentAdapter()
    await expect(
      adapter.connect({
        type: 'pi',
        home,
        piProvider: 'anthropic',
        piModel: 'nonexistent-model',
      }),
    ).rejects.toThrow(/not in registry/)
  })

  it('succeeds when home + provider + model resolve', async () => {
    const adapter = new PiAgentAdapter()
    await expect(
      adapter.connect({
        type: 'pi',
        home,
        piProvider: 'anthropic',
        piModel: 'claude-opus-4-5',
      }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// PiAgentAdapter.run — defensive short-circuits + session lifecycle
// ---------------------------------------------------------------------------

describe('PiAgentAdapter.run', () => {
  async function connected(): Promise<PiAgentAdapter> {
    const adapter = new PiAgentAdapter()
    await adapter.connect({
      type: 'pi',
      home,
      piProvider: 'anthropic',
      piModel: 'claude-opus-4-5',
    })
    return adapter
  }

  function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
    return {
      conversationId: 'test-conv-id',
      message: 'hi',
      tools: [],
      cwd: home,
      sdkBound: false,
      context: {
        appId: 'home',
        manifest: { id: 'home', name: 'Home', icon: 'home' },
        turnMode: 'direct_user_chat',
      },
      ...overrides,
    }
  }

  it('emits error + done when an image attachment is present (Pi backend does not support images)', async () => {
    const adapter = await connected()
    const events: AgentEvent[] = []
    for await (const e of adapter.run(
      makeRequest({
        attachments: [{ type: 'image', data: Buffer.from(''), mimeType: 'image/png' }],
      }),
    )) {
      events.push(e)
    }
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/image attachments .* not supported/),
    })
    expect(events[1]).toEqual({ type: 'done' })
  })

  it('emits error + done when called before connect()', async () => {
    const adapter = new PiAgentAdapter()
    const events: AgentEvent[] = []
    for await (const e of adapter.run(makeRequest())) {
      events.push(e)
    }
    expect(events).toEqual([
      { type: 'error', message: 'PiAgentAdapter: not connected' },
      { type: 'done' },
    ])
  })

  it('emits sessionBound on first turn (sdkBound=false), then terminates on agent_end', async () => {
    const adapter = await connected()
    promptScript = () => {
      fire([{ type: 'agent_end', messages: [] }])
    }
    const events: AgentEvent[] = []
    for await (const e of adapter.run(makeRequest())) events.push(e)

    const bound = events.filter((e) => e.type === 'sessionBound')
    expect(bound).toHaveLength(1)
    expect((bound[0] as { type: 'sessionBound'; sdkSessionId: string }).sdkSessionId).toBeTruthy()
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
  })

  // ---------------------------------------------------------------------
  // Bug 1 regression — Pi emits turn_end after every assistant message; only
  // agent_end is terminal. Treating turn_end as terminal silently drops the
  // synthesis text the model produces after a tool call.
  // ---------------------------------------------------------------------
  it('accumulates text across turn_end (multi-turn loop with tool calls)', async () => {
    const adapter = await connected()
    promptScript = () => {
      fire([
        // Turn 1: pre-tool narration
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Let me check.' },
        },
        // Turn 1 ends after tool execution — must NOT terminate the adapter
        { type: 'turn_end', message: {}, toolResults: [] },
        // Turn 2: synthesis after tool result
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: ' You spent $42.' },
        },
        { type: 'agent_end', messages: [] },
      ])
    }
    const events: AgentEvent[] = []
    for await (const e of adapter.run(makeRequest())) events.push(e)

    const textEvents = events.filter((e) => e.type === 'text')
    expect(textEvents).toHaveLength(1)
    expect((textEvents[0] as { type: 'text'; text: string }).text).toBe(
      'Let me check. You spent $42.',
    )
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
  })

  // ---------------------------------------------------------------------
  // Bug 2 regression — continueRecent must rehydrate prior history when the
  // second turn arrives with sdkBound=true.
  // ---------------------------------------------------------------------
  it('continueRecent loads prior history on the second turn', async () => {
    const adapter = await connected()

    // Turn 1: append user + assistant so SessionManager flushes the jsonl
    // (lazy flush — file only writes once an assistant message lands).
    let turn1SessionId = ''
    promptScript = () => {
      lastSessionManager!.appendMessage(stubUser('spent $42 yesterday') as never)
      lastSessionManager!.appendMessage(stubAssistant('noted') as never)
      fire([{ type: 'agent_end', messages: [] }])
    }
    for await (const e of adapter.run(
      makeRequest({ conversationId: 'conv-bug2', sdkBound: false }),
    )) {
      if (e.type === 'sessionBound') turn1SessionId = e.sdkSessionId
    }
    expect(turn1SessionId).toBeTruthy()

    // Turn 2: sdkBound=true — adapter should continueRecent and load the
    // jsonl that turn 1 wrote. Re-emission of sessionBound is suppressed.
    const turn2Events: AgentEvent[] = []
    promptScript = () => {
      fire([{ type: 'agent_end', messages: [] }])
    }
    for await (const e of adapter.run(
      makeRequest({
        conversationId: 'conv-bug2',
        sdkBound: true,
        sdkSessionId: turn1SessionId,
      }),
    )) {
      turn2Events.push(e)
    }

    // continueRecent opens the same jsonl → same session id from header
    expect(lastSessionManager!.getSessionId()).toBe(turn1SessionId)
    // Prior entries replayed into the new SessionManager
    const entries = lastSessionManager!.getEntries()
    expect(
      entries.some((e) => e.type === 'message' && (e.message as { role: string }).role === 'user'),
    ).toBe(true)
    expect(
      entries.some(
        (e) => e.type === 'message' && (e.message as { role: string }).role === 'assistant',
      ),
    ).toBe(true)
    // No sessionBound on resume
    expect(turn2Events.filter((e) => e.type === 'sessionBound')).toHaveLength(0)
  })

  // ---------------------------------------------------------------------
  // Backend-flip — sdkBound=false mid-conversation (config.backend changed) must
  // create a fresh session even if sessionDir holds an older Pi jsonl.
  // continueRecent on the next turn must pick the post-flip session, not the pre-flip one.
  // ---------------------------------------------------------------------
  it('backend-flip create() does not resurrect pre-flip history', async () => {
    const adapter = await connected()

    // Pre-flip Pi turn
    let sessionA = ''
    promptScript = () => {
      lastSessionManager!.appendMessage(stubUser('A-user') as never)
      lastSessionManager!.appendMessage(stubAssistant('A-assistant') as never)
      fire([{ type: 'agent_end', messages: [] }])
    }
    for await (const e of adapter.run(
      makeRequest({ conversationId: 'conv-flip', sdkBound: false }),
    )) {
      if (e.type === 'sessionBound') sessionA = e.sdkSessionId
    }
    expect(sessionA).toBeTruthy()

    // Ensure findMostRecentSession (mtime-based) can distinguish the files.
    // 200ms covers loaded Windows CI where NTFS mtime can lag behind close().
    await new Promise((r) => setTimeout(r, 200))

    // Simulate flip back to Pi: sdkBound=false again → create() writes a new
    // jsonl alongside session A's. (In production this happens when the
    // orchestrator sees conv.sdkBackend !== config.backend.)
    let sessionB = ''
    promptScript = () => {
      lastSessionManager!.appendMessage(stubUser('B-user') as never)
      lastSessionManager!.appendMessage(stubAssistant('B-assistant') as never)
      fire([{ type: 'agent_end', messages: [] }])
    }
    for await (const e of adapter.run(
      makeRequest({ conversationId: 'conv-flip', sdkBound: false }),
    )) {
      if (e.type === 'sessionBound') sessionB = e.sdkSessionId
    }
    expect(sessionB).toBeTruthy()
    expect(sessionB).not.toBe(sessionA)

    // Resume turn: continueRecent must pick session B (newer by mtime), not A.
    promptScript = () => {
      fire([{ type: 'agent_end', messages: [] }])
    }
    for await (const _e of adapter.run(
      makeRequest({
        conversationId: 'conv-flip',
        sdkBound: true,
        sdkSessionId: sessionB,
      }),
    )) {
      // drain
    }
    expect(lastSessionManager!.getSessionId()).toBe(sessionB)
    const entries = lastSessionManager!.getEntries()
    const userTexts = entries
      .filter((e) => e.type === 'message')
      .map((e) => {
        const msg = (e as { message: { content?: unknown } }).message
        const content = msg.content as Array<{ text?: string }> | undefined
        return content?.[0]?.text
      })
    expect(userTexts).toContain('B-user')
    expect(userTexts).not.toContain('A-user')
  })
})
