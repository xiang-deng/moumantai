/**
 * Integration: UI-tap escalation — when a required arg is empty, handleInvokeTool
 * drives one agent turn to ask the user, appends the question to chat, dedupes
 * retaps, and returns `escalated: true`. The mutation tool itself does not run
 * until the user's typed reply.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AppEngine } from '../../src/server/agent/app-engine.js'
import {
  handleInvokeTool,
  clearPendingEscalation,
  clearPendingEscalationsByScope,
  _resetPendingEscalationsForTesting,
  type RunEscalationTurn,
} from '../../src/server/agent/action-handler.js'
import { DedupStore } from '../../src/server/agent/dedup-store.js'
import { FaceParamsStore } from '../../src/server/agent/face-params-store.js'
import { ConversationStore } from '../../src/server/conversations/store.js'
import { messages } from '../../src/server/conversations/schema.js'
import { eq, asc } from 'drizzle-orm'
import { createTestAppDef } from '../fixtures/test-app/index.js'
import {
  freshPlatformDb,
  newConversation,
  type PlatformDb,
} from '../helpers/face-params-fixtures.js'
import type { ToolDefinition } from '../../src/server/agent/types.js'

const APP_ID = 'test-app'
const SCOPE = `app:${APP_ID}`

describe('UI-tap escalation to chat dialog', () => {
  let engine: AppEngine
  let platformDb: PlatformDb
  let faceParamsStore: FaceParamsStore
  let dedupStore: DedupStore
  let conversationStore: ConversationStore
  let convId: string

  // Tool registered so handleInvokeTool can find it; `kcal` is the empty required arg.
  const setDailyGoal: ToolDefinition = {
    name: 'set_daily_goal',
    description: 'Set the daily kcal target',
    parameters: {
      kcal: { type: 'number', required: true, description: 'daily kcal target' },
    },
    execute: async ({ params }) => ({ result: { kcal: params.kcal } }),
  }

  beforeEach(async () => {
    _resetPendingEscalationsForTesting()
    engine = new AppEngine()
    platformDb = freshPlatformDb()
    faceParamsStore = new FaceParamsStore(platformDb)
    dedupStore = new DedupStore(platformDb)
    conversationStore = new ConversationStore(platformDb)
    engine.register(createTestAppDef())
    await engine.bootAll()
    engine.getApp(APP_ID)!.toolRegistry.set(setDailyGoal.name, setDailyGoal)
    convId = newConversation(platformDb, SCOPE)
  })

  afterEach(() => {
    _resetPendingEscalationsForTesting()
    engine.shutdown()
  })

  function deps(extras: Partial<Parameters<typeof handleInvokeTool>[2]> = {}) {
    const app = engine.getApp(APP_ID)!
    return {
      toolRegistry: app.toolRegistry,
      faceRegistry: app.faceRegistry,
      db: app.db,
      appId: APP_ID,
      sendFaceUpdate: () => {},
      faceParamsStore,
      dedupStore,
      conversationStore,
      conversationId: convId,
      sourceFaceId: 'goals',
      clientRequestId: '00000000-0000-0000-0000-000000000001',
      ...extras,
    }
  }

  it('empty required arg → escalation closure fires, assistant question appended, dedup recorded', async () => {
    const calls: string[] = []
    const runEscalationTurn: RunEscalationTurn = async (promptText) => {
      calls.push(promptText)
      return {
        success: true,
        text: "What's your daily kcal target?",
        toolCalls: [],
      }
    }

    const outcome = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn }),
    )

    expect(outcome.error).toBeNull()
    expect(outcome.escalated).toBe(true)
    expect(outcome.deduped).toBe(false)
    expect(outcome.result).toBeNull()

    expect(calls).toHaveLength(1) // closure invoked exactly once
    expect(calls[0]).toContain('[ui_action] face=goals tool=set_daily_goal')
    expect(calls[0]).toContain('missing=[kcal:number "daily kcal target"]')

    // Assistant question landed; no synthetic [ui_action] row.
    const rows = platformDb
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(asc(messages.seq))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('assistant')
    expect(rows[0]!.text).toBe("What's your daily kcal target?")
    expect(rows.some((r) => r.text.startsWith('[ui_action]'))).toBe(false)

    // Dedup row ensures a retap with the same CRID doesn't fire a second LLM turn.
    const reqId = '00000000-0000-0000-0000-000000000001'
    expect(dedupStore.lookup(convId, reqId)).not.toBeNull()
  })

  it('retap with same client_request_id is blocked — no second LLM turn, no second chat row, still gets escalated:true (refocus chat)', async () => {
    let invocations = 0
    const runEscalationTurn: RunEscalationTurn = async () => {
      invocations++
      return { success: true, text: 'q1', toolCalls: [] }
    }

    const reqId = '00000000-0000-0000-0000-000000000077'
    const first = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn, clientRequestId: reqId }),
    )
    expect(first.escalated).toBe(true)
    expect(invocations).toBe(1)

    const second = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn, clientRequestId: reqId }),
    )
    expect(second.deduped).toBe(true)
    // Pending-block runs before dedup-lookup, so `escalated:true` is still set —
    // this lets onEscalationStarted fire again and refocus chat on the retap.
    expect(second.escalated).toBe(true)
    expect(invocations).toBe(1) // closure not re-invoked

    const rows = platformDb.select().from(messages).where(eq(messages.conversationId, convId)).all()
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1) // only one question
  })

  it('binds the SDK session id when the escalation turn reports one', async () => {
    const runEscalationTurn: RunEscalationTurn = async () => ({
      success: true,
      text: 'question?',
      toolCalls: [],
      sdkSessionId: 'sdk-session-abc',
    })

    await handleInvokeTool('set_daily_goal', { kcal: '' }, deps({ runEscalationTurn }))

    const conv = conversationStore.getById(convId)!
    expect(conv.sdkSessionId).toBe('sdk-session-abc')
    expect(conv.sdkBoundAt).not.toBeNull()
  })

  it('failure inside the closure surfaces as internal error, no chat row appended', async () => {
    const runEscalationTurn: RunEscalationTurn = async () => ({
      success: false,
      text: 'adapter blew up',
      toolCalls: [],
    })

    const outcome = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn }),
    )
    expect(outcome.error?.code).toBe('internal')
    expect(outcome.error?.message).toBe('adapter blew up')
    expect(outcome.escalated).toBeFalsy()

    const rows = platformDb.select().from(messages).where(eq(messages.conversationId, convId)).all()
    expect(rows).toHaveLength(0)
  })

  it('without a runEscalationTurn closure, missing arg degrades to a normal tool_validation error', async () => {
    const outcome = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps(), // no runEscalationTurn
    )
    expect(outcome.error?.code).toBe('tool_validation')
    expect(outcome.error?.message).toMatch(/Missing required parameter.*"kcal"/)
    expect(outcome.escalated).toBeFalsy()
  })

  it('non-empty required arg fires the tool directly — no escalation', async () => {
    let escalationCalled = false
    const runEscalationTurn: RunEscalationTurn = async () => {
      escalationCalled = true
      return { success: true, text: 'q', toolCalls: [] }
    }

    const outcome = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '1800' }, // string from $form text input
      deps({ runEscalationTurn }),
    )
    expect(escalationCalled).toBe(false)
    expect(outcome.error).toBeNull()
    expect(outcome.escalated).toBeFalsy()
    expect((outcome.result?.result as { kcal: number }).kcal).toBe(1800)
  })

  it('onEscalationStarted fires BEFORE the LLM closure is awaited (chat opens fast)', async () => {
    const events: string[] = []
    let releaseClosure!: () => void
    const closureGate = new Promise<void>((resolve) => {
      releaseClosure = resolve
    })
    const runEscalationTurn: RunEscalationTurn = async () => {
      events.push('llm-start')
      await closureGate
      events.push('llm-end')
      return { success: true, text: 'q', toolCalls: [] }
    }
    const onEscalationStarted = (scope: string) => {
      events.push(`onEscalationStarted:${scope}`)
    }

    const outcomePromise = handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn, onEscalationStarted }),
    )
    // Yield so the escalation reaches the LLM call; early hint must already have fired.
    await new Promise((r) => setTimeout(r, 5))
    expect(events).toEqual([`onEscalationStarted:${SCOPE}`, 'llm-start'])

    releaseClosure()
    const outcome = await outcomePromise
    expect(outcome.escalated).toBe(true)
    expect(events).toEqual([`onEscalationStarted:${SCOPE}`, 'llm-start', 'llm-end'])
  })

  it('repeat tap with DIFFERENT clientRequestId during pending → blocked, only one LLM turn, only one chat row, both escalated:true', async () => {
    let invocations = 0
    let releaseClosure!: () => void
    const closureGate = new Promise<void>((resolve) => {
      releaseClosure = resolve
    })
    const runEscalationTurn: RunEscalationTurn = async () => {
      invocations++
      await closureGate
      return { success: true, text: "What's your daily kcal target?", toolCalls: [] }
    }
    const onEscalationStartedCount = { n: 0 }
    const onEscalationStarted = () => {
      onEscalationStartedCount.n++
    }

    const firstPromise = handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        runEscalationTurn,
        onEscalationStarted,
        clientRequestId: '00000000-0000-0000-0000-aaaaaaaaaaa1',
      }),
    )
    await new Promise((r) => setTimeout(r, 5)) // let #1 enter the LLM closure
    const second = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        runEscalationTurn,
        onEscalationStarted,
        clientRequestId: '00000000-0000-0000-0000-aaaaaaaaaaa2',
      }),
    )

    expect(second.escalated).toBe(true)
    expect(second.deduped).toBe(true)
    expect(invocations).toBe(1) // tap #2 did not call the closure

    releaseClosure()
    const first = await firstPromise
    expect(first.escalated).toBe(true)
    expect(invocations).toBe(1)

    expect(onEscalationStartedCount.n).toBe(2) // both taps refocused chat

    const assistantRows = platformDb
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .all()
      .filter((r) => r.role === 'assistant')
    expect(assistantRows).toHaveLength(1)
  })

  it('clearPendingEscalation aborts the in-flight LLM turn AND empties the map (user-types-during-escalation case)', async () => {
    let signalSeen: AbortSignal | undefined
    let aborted = false
    const runEscalationTurn: RunEscalationTurn = async (_promptText, signal) => {
      signalSeen = signal
      // Wait until aborted.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve()
          return
        }
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        )
      })
      return { success: false, text: '', toolCalls: [] }
    }

    const outcomePromise = handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn }),
    )
    await new Promise((r) => setTimeout(r, 10)) // let the closure register its abort listener
    expect(signalSeen).toBeDefined()
    expect(signalSeen!.aborted).toBe(false)

    clearPendingEscalation(convId)

    const outcome = await outcomePromise
    expect(aborted).toBe(true)
    // Closure returned success:false → surfaces as internal error; pending flag cleared.
    expect(outcome.escalated).toBeFalsy()

    // Subsequent tap with a different CRID must run a fresh escalation.
    const fresh: RunEscalationTurn = async () => ({ success: true, text: 'q2', toolCalls: [] })
    const second = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        runEscalationTurn: fresh,
        clientRequestId: '00000000-0000-0000-0000-bbbbbbbbbbbb',
      }),
    )
    expect(second.escalated).toBe(true)
  })

  it('failure clears pending so a subsequent tap proceeds (clear-on-failure)', async () => {
    const failingClosure: RunEscalationTurn = async () => {
      throw new Error('adapter exploded')
    }
    const first = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn: failingClosure }),
    )
    expect(first.error?.code).toBe('internal')
    expect(first.error?.message).toContain('adapter exploded')

    // Pending flag cleared in try/finally — subsequent tap proceeds.
    const successClosure: RunEscalationTurn = async () => ({
      success: true,
      text: 'q',
      toolCalls: [],
    })
    const second = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        runEscalationTurn: successClosure,
        clientRequestId: '00000000-0000-0000-0000-cccccccccccc',
      }),
    )
    expect(second.escalated).toBe(true)
  })

  // Templated escalation: author-supplied `escalationPrompt` bypasses the LLM.

  it('templated path: author prompt lands verbatim with no LLM call, dedup recorded, pending carries synthetic context', async () => {
    let escalationInvoked = false
    const runEscalationTurn: RunEscalationTurn = async () => {
      escalationInvoked = true
      return { success: true, text: 'LLM-AUTHORED (should not appear)', toolCalls: [] }
    }

    const reqId = '00000000-0000-0000-0000-eeeeeeeeee01'
    const outcome = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        runEscalationTurn,
        clientRequestId: reqId,
        escalationPrompt: 'What kcal goal do you want?',
      }),
    )

    expect(outcome.escalated).toBe(true)
    expect(outcome.error).toBeNull()
    expect(outcome.result).toBeNull()

    expect(escalationInvoked).toBe(false) // LLM closure must not fire

    const rows = platformDb
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(asc(messages.seq))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('assistant')
    expect(rows[0]!.text).toBe('What kcal goal do you want?')

    expect(dedupStore.lookup(convId, reqId)).not.toBeNull() // dedup recorded

    // Pending entry carries the synthetic [ui_action] context for main.ts:onChatInput.
    const cleared = clearPendingEscalation(convId)
    expect(cleared).not.toBeNull()
    expect(cleared!.syntheticPrompt).toContain('[ui_action] face=goals tool=set_daily_goal')
    expect(cleared!.syntheticPrompt).toContain('missing=[kcal:number "daily kcal target"]')
  })

  it('templated path works even without a runEscalationTurn closure (no LLM needed)', async () => {
    const outcome = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        // No runEscalationTurn — would normally degrade to tool_validation.
        escalationPrompt: 'Just tell me a number, fam.',
      }),
    )

    expect(outcome.escalated).toBe(true)
    expect(outcome.error).toBeNull()

    const rows = platformDb.select().from(messages).where(eq(messages.conversationId, convId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('Just tell me a number, fam.')
  })

  it('templated re-tap with same CRID short-circuits — no second chat row, escalated:true (refocus chat)', async () => {
    const reqId = '00000000-0000-0000-0000-eeeeeeeeee02'
    const onEscalationStartedCount = { n: 0 }
    const onEscalationStarted = () => {
      onEscalationStartedCount.n++
    }

    const first = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        clientRequestId: reqId,
        escalationPrompt: 'kcal please',
        onEscalationStarted,
      }),
    )
    expect(first.escalated).toBe(true)

    const second = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        clientRequestId: reqId,
        escalationPrompt: 'kcal please',
        onEscalationStarted,
      }),
    )
    expect(second.escalated).toBe(true)
    expect(second.deduped).toBe(true)

    expect(onEscalationStartedCount.n).toBe(2) // both taps fired onEscalationStarted

    const rows = platformDb
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .all()
      .filter((r) => r.role === 'assistant')
    expect(rows).toHaveLength(1)
  })

  it('non-missing args on templated path: tool fires directly, no escalation', async () => {
    const outcome = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '2000' },
      deps({ escalationPrompt: 'unused' }),
    )
    expect(outcome.escalated).toBeFalsy()
    expect(outcome.error).toBeNull()
    expect((outcome.result?.result as { kcal: number }).kcal).toBe(2000)

    const rows = platformDb.select().from(messages).where(eq(messages.conversationId, convId)).all()
    expect(rows).toHaveLength(0) // no chat row — escalation didn't run
  })

  it('templated path does NOT bind an SDK session (no LLM turn ran)', async () => {
    await handleInvokeTool('set_daily_goal', { kcal: '' }, deps({ escalationPrompt: 'kcal?' }))
    const conv = conversationStore.getById(convId)!
    expect(conv.sdkSessionId).toBeNull()
    expect(conv.sdkBoundAt).toBeNull()
  })

  it('LLM-path entry has no syntheticPrompt (only templated entries carry it)', async () => {
    const runEscalationTurn: RunEscalationTurn = async () => ({
      success: true,
      text: 'q',
      toolCalls: [],
    })
    await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn }), // no escalationPrompt → takes LLM path
    )
    const cleared = clearPendingEscalation(convId)
    expect(cleared).not.toBeNull()
    expect(cleared!.syntheticPrompt).toBeUndefined()
  })

  it('clearPendingEscalationsByScope unblocks all conversations on the matching scope (reset case)', async () => {
    let releaseClosure!: () => void
    const closureGate = new Promise<void>((resolve) => {
      releaseClosure = resolve
    })
    const runEscalationTurn: RunEscalationTurn = async () => {
      await closureGate
      return { success: true, text: 'q', toolCalls: [] }
    }

    const firstPromise = handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({ runEscalationTurn }),
    )
    await new Promise((r) => setTimeout(r, 5))

    // Reset: clears pending for the scope.
    clearPendingEscalationsByScope(SCOPE)

    // After clear, a new conversation on the same scope must not be blocked.
    const newConvId = newConversation(platformDb, SCOPE)
    const fresh: RunEscalationTurn = async () => ({ success: true, text: 'fresh', toolCalls: [] })
    const second = await handleInvokeTool(
      'set_daily_goal',
      { kcal: '' },
      deps({
        runEscalationTurn: fresh,
        conversationId: newConvId,
        clientRequestId: '00000000-0000-0000-0000-dddddddddddd',
      }),
    )
    expect(second.escalated).toBe(true)

    releaseClosure() // drain the original aborted call
    await firstPromise.catch(() => {})
  })
})
