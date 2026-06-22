/**
 * User-initiated tool invocations FIFO-order behind in-flight agent-loop turns
 * via `TurnQueue`. Prevents races between LLM tool calls and user button-taps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AppEngine } from '../../src/server/agent/app-engine.js'
import { handleInvokeTool } from '../../src/server/agent/action-handler.js'
import { TurnQueue } from '../../src/server/agent/turn-queue.js'
import { DedupStore } from '../../src/server/agent/dedup-store.js'
import { FaceParamsStore } from '../../src/server/agent/face-params-store.js'
import { ConversationStore } from '../../src/server/conversations/store.js'
import { createTestAppDef } from '../fixtures/test-app/index.js'
import {
  freshPlatformDb,
  newConversation,
  type PlatformDb,
} from '../helpers/face-params-fixtures.js'

const APP_ID = 'test-app'
const SCOPE = `app:${APP_ID}`

describe('concurrent LLM-vs-user serialization via TurnQueue', () => {
  let engine: AppEngine
  let platformDb: PlatformDb
  let faceParamsStore: FaceParamsStore
  let dedupStore: DedupStore
  let conversationStore: ConversationStore
  let turnQueue: TurnQueue
  let convId: string

  beforeEach(async () => {
    engine = new AppEngine()
    platformDb = freshPlatformDb()
    faceParamsStore = new FaceParamsStore(platformDb)
    dedupStore = new DedupStore(platformDb)
    conversationStore = new ConversationStore(platformDb)
    turnQueue = new TurnQueue()
    engine.register(createTestAppDef())
    await engine.bootAll()
    convId = newConversation(platformDb, SCOPE)
  })

  afterEach(() => {
    engine.shutdown()
  })

  function userDeps() {
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
      sourceFaceId: 'notes-list',
      turnQueue,
    }
  }

  it('user invocation FIFO-orders behind an in-flight TurnQueue task', async () => {
    let releaseAgent!: () => void
    const agentGate = new Promise<void>((resolve) => {
      releaseAgent = resolve
    })
    const completionOrder: string[] = []

    const agentTaskPromise = turnQueue.enqueue(convId, {
      run: async () => {
        await agentGate
        conversationStore.appendTurn(convId, {
          role: 'assistant',
          text: '[agent_marker]',
          status: 'completed',
        })
        completionOrder.push('agent')
        return 'agent_done'
      },
    })

    const userPromise = handleInvokeTool(
      'add_note',
      { content: 'user-tap' },
      { ...userDeps(), clientRequestId: '00000000-0000-0000-0000-000000000010' },
    ).then((outcome) => {
      completionOrder.push('user')
      return outcome
    })

    // Let the user invocation reach the enqueue before asserting.
    await new Promise((r) => setTimeout(r, 20))
    expect(completionOrder).toEqual([])

    releaseAgent()

    const [agentResult, userOutcome] = await Promise.all([agentTaskPromise, userPromise])
    expect(agentResult).toBe('agent_done')
    expect(userOutcome.error).toBeNull()
    // FIFO order: user invocation resolves only after the agent task releases the head.
    expect(completionOrder).toEqual(['agent', 'user'])
  })

  it('returns session_busy when the queue depth is exceeded', async () => {
    // Fill the queue to maxDepth 5 (head + 4 pending); the 6th must return session_busy.
    let releaseHead!: () => void
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve
    })
    const headPromise = turnQueue.enqueue(convId, {
      run: async () => {
        await headGate
        return 'head_done'
      },
    })

    const inFlight: Array<Promise<unknown>> = []
    for (let i = 0; i < 4; i++) {
      inFlight.push(
        handleInvokeTool(
          'add_note',
          { content: `n${i}` },
          {
            ...userDeps(),
            clientRequestId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
          },
        ),
      )
    }
    await new Promise((r) => setTimeout(r, 10))

    const overflowOutcome = await handleInvokeTool(
      'add_note',
      { content: 'overflow' },
      {
        ...userDeps(),
        clientRequestId: '00000000-0000-0000-0000-deadbeefdead',
      },
    )
    expect(overflowOutcome.error?.code).toBe('internal')
    expect(overflowOutcome.error?.message).toBe('session_busy')

    releaseHead()
    await headPromise
    await Promise.all(inFlight)
  })
})
