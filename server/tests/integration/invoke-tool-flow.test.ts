/**
 * Invoke-tool end-to-end: handleInvokeTool → executeTool → face refresh broadcasts.
 * Drives the handler directly with the synthetic test-app fixture; skips the
 * WebSocket transport layer (covered elsewhere).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AppEngine } from '../../src/server/agent/app-engine.js'
import { handleInvokeTool } from '../../src/server/agent/action-handler.js'
import { wireSynthFaceTools } from '../../src/server/agent/synthesize-face-tool.js'
import { DedupStore } from '../../src/server/agent/dedup-store.js'
import { FaceParamsStore } from '../../src/server/agent/face-params-store.js'
import { ConversationStore } from '../../src/server/conversations/store.js'
import { messages } from '../../src/server/conversations/schema.js'
import { eq } from 'drizzle-orm'
import { createTestAppDef } from '../fixtures/test-app/index.js'
import {
  FakeTransport,
  freshPlatformDb,
  newConversation,
  type PlatformDb,
} from '../helpers/face-params-fixtures.js'

const APP_ID = 'test-app'
const SCOPE = `app:${APP_ID}`

interface FaceUpdateCapture {
  appId: string
  faceId: string
  data: unknown
}

describe('invoke-tool flow — happy path', () => {
  let engine: AppEngine
  let platformDb: PlatformDb
  let faceParamsStore: FaceParamsStore
  let dedupStore: DedupStore
  let conversationStore: ConversationStore
  let convId: string
  let faceUpdates: FaceUpdateCapture[]

  beforeEach(async () => {
    engine = new AppEngine()
    platformDb = freshPlatformDb()
    faceParamsStore = new FaceParamsStore(platformDb)
    dedupStore = new DedupStore(platformDb)
    conversationStore = new ConversationStore(platformDb)
    engine.register(createTestAppDef())
    await engine.bootAll()
    wireSynthFaceTools({
      appId: APP_ID,
      appEngine: engine,
      faceParamsStore,
      transport: new FakeTransport(),
    })
    convId = newConversation(platformDb, SCOPE)
    faceUpdates = []
  })

  afterEach(() => {
    engine.shutdown()
  })

  function deps() {
    const app = engine.getApp(APP_ID)!
    return {
      toolRegistry: app.toolRegistry,
      faceRegistry: app.faceRegistry,
      db: app.db,
      appId: APP_ID,
      sendFaceUpdate: (appId: string, faceId: string, _registry: unknown, data: unknown) => {
        faceUpdates.push({ appId, faceId, data })
      },
      faceParamsStore,
      dedupStore,
      conversationStore,
      conversationId: convId,
      sourceFaceId: 'notes-list',
      clientRequestId: '00000000-0000-0000-0000-000000000001',
    }
  }

  it('runs the tool, broadcasts face updates, and writes nothing to chat display', async () => {
    const outcome = await handleInvokeTool(
      'add_note',
      { content: 'hello', category: 'work' },
      deps(),
    )

    expect(outcome.error).toBeNull()
    expect(outcome.deduped).toBe(false)
    expect((outcome.result?.result as { id?: string })?.id).toMatch(/^[0-9a-f-]{36}$/i)

    expect(faceUpdates.length).toBeGreaterThanOrEqual(1) // face refresh broadcast
    const faceIds = faceUpdates.map((u) => u.faceId).sort()
    expect(faceIds).toContain('notes-list')

    // No synthetic [ui_action] row in chat — breadcrumb lives only in SDK jsonl.
    const rows = platformDb.select().from(messages).where(eq(messages.conversationId, convId)).all()
    const uiAction = rows.find((r) => r.text.startsWith('[ui_action]'))
    expect(uiAction).toBeUndefined()
  })

  it('tool_not_found returns an error and writes nothing to chat display', async () => {
    const outcome = await handleInvokeTool('does_not_exist', {}, deps())
    expect(outcome.error?.code).toBe('tool_not_found')

    const rows = platformDb.select().from(messages).where(eq(messages.conversationId, convId)).all()
    expect(rows).toHaveLength(0)
  })

  it('user-driven view_<faceId> persists params and re-broadcasts the parameterized face', async () => {
    const outcome = await handleInvokeTool(
      'view_notes-summary',
      { category: 'work' },
      { ...deps(), clientRequestId: '00000000-0000-0000-0000-000000000002' },
    )
    expect(outcome.error).toBeNull()

    const stored = faceParamsStore.get(convId, APP_ID, 'notes-summary')
    expect(stored?.params).toEqual({ category: 'work' })

    // Face broadcast carries the new params merged into data.
    const summaryUpdate = faceUpdates.find((u) => u.faceId === 'notes-summary')
    expect(summaryUpdate).toBeDefined()
    expect(summaryUpdate?.data).toMatchObject({ $params: { category: 'work' } })
  })
})

describe('invoke-tool flow — dedup across retries', () => {
  let engine: AppEngine
  let platformDb: PlatformDb
  let faceParamsStore: FaceParamsStore
  let dedupStore: DedupStore
  let conversationStore: ConversationStore
  let convId: string

  beforeEach(async () => {
    engine = new AppEngine()
    platformDb = freshPlatformDb()
    faceParamsStore = new FaceParamsStore(platformDb)
    dedupStore = new DedupStore(platformDb)
    conversationStore = new ConversationStore(platformDb)
    engine.register(createTestAppDef())
    await engine.bootAll()
    wireSynthFaceTools({
      appId: APP_ID,
      appEngine: engine,
      faceParamsStore,
      transport: new FakeTransport(),
    })
    convId = newConversation(platformDb, SCOPE)
  })

  afterEach(() => {
    engine.shutdown()
  })

  function deps(reqId: string) {
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
      clientRequestId: reqId,
    }
  }

  it('repeats with the same client_request_id execute once and return deduped:true on subsequent calls', async () => {
    const reqId = '00000000-0000-0000-0000-aaaaaaaaaaaa'
    const first = await handleInvokeTool('add_note', { content: 'one' }, deps(reqId))
    expect(first.deduped).toBe(false)
    const firstId = (first.result?.result as { id: string }).id

    const second = await handleInvokeTool('add_note', { content: 'one' }, deps(reqId))
    expect(second.deduped).toBe(true)
    expect((second.result?.result as { id: string }).id).toBe(firstId) // cached result

    const rows = platformDb.select().from(messages).where(eq(messages.conversationId, convId)).all()
    const uiActions = rows.filter((r) => r.text.startsWith('[ui_action]'))
    expect(uiActions).toHaveLength(0)
  })

  it('dedup table survives a "server restart" (re-instantiated DedupStore on the same DB)', async () => {
    const reqId = '00000000-0000-0000-0000-bbbbbbbbbbbb'
    const first = await handleInvokeTool('add_note', { content: 'two' }, deps(reqId))
    expect(first.deduped).toBe(false)

    // Simulate restart: new DedupStore handle on the same DB reads the persisted row.
    const newDedupStore = new DedupStore(platformDb)
    const app = engine.getApp(APP_ID)!
    const second = await handleInvokeTool(
      'add_note',
      { content: 'two' },
      {
        toolRegistry: app.toolRegistry,
        faceRegistry: app.faceRegistry,
        db: app.db,
        appId: APP_ID,
        sendFaceUpdate: () => {},
        faceParamsStore,
        dedupStore: newDedupStore,
        conversationStore,
        conversationId: convId,
        sourceFaceId: 'notes-list',
        clientRequestId: reqId,
      },
    )
    expect(second.deduped).toBe(true)
  })
})
