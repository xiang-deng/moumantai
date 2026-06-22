/**
 * Integration: parameterized-face round-trip — view_<faceId> persists, broadcast
 * carries filtered data, `{}` resets to defaults, and the agent-loop forwards
 * the synth tool result back to the adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import { AppEngine, getToolSchemas } from '../../src/server/agent/app-engine.js'
import { AgentLoop } from '../../src/server/agent/agent-loop.js'
import { FaceParamsStore } from '../../src/server/agent/face-params-store.js'
import { wireSynthFaceTools, viewToolNameFor } from '../../src/server/agent/synthesize-face-tool.js'
import { refreshAllFaces } from '../../src/server/agent/face-refresh.js'
import { createTestAppDef } from '../fixtures/test-app/index.js'
import type { SendFaceUpdate } from '../../src/server/agent/face-refresh.js'
import {
  FakeTransport,
  ScriptedAdapter,
  freshPlatformDb,
  newConversation,
  seedTestAppNotes,
  type PlatformDb,
} from '../helpers/face-params-fixtures.js'

const APP_ID = 'test-app'
const FACE_ID = 'notes-summary'
const SCOPE = `app:${APP_ID}`

describe('parameterized-face round-trip (test-app notes-summary)', () => {
  let engine: AppEngine
  let platformDb: PlatformDb
  let store: FaceParamsStore
  let transport: FakeTransport
  let convId: string

  beforeEach(async () => {
    engine = new AppEngine()
    platformDb = freshPlatformDb()
    store = new FaceParamsStore(platformDb)
    transport = new FakeTransport()

    engine.register(createTestAppDef())
    await engine.bootAll()
    wireSynthFaceTools({ appId: APP_ID, appEngine: engine, faceParamsStore: store, transport })

    seedTestAppNotes(engine.getApp(APP_ID)!.db)
    convId = newConversation(platformDb, SCOPE)
  })

  afterEach(() => {
    engine.shutdown()
  })

  it('synth tool persists params and returns work-filtered data', async () => {
    const app = engine.getApp(APP_ID)!
    const tool = app.toolRegistry.get(viewToolNameFor(FACE_ID))!

    const result = await tool.execute({
      params: { category: 'work' },
      db: app.db,
      conversationId: convId,
      scope: SCOPE,
    })

    expect(store.get(convId, APP_ID, FACE_ID)?.params).toEqual({ category: 'work' })

    const r = result.result as { ok: boolean; data: Record<string, unknown> }
    expect(r.ok).toBe(true)
    const summary = r.data.summary as { count: number; category: string }
    expect(summary.count).toBe(2) // 2 work notes seeded
    expect(summary.category).toBe('work')
  })

  it('refreshAllFaces broadcasts the same filtered data after persist', async () => {
    const app = engine.getApp(APP_ID)!
    const tool = app.toolRegistry.get(viewToolNameFor(FACE_ID))!
    await tool.execute({
      params: { category: 'work' },
      db: app.db,
      conversationId: convId,
      scope: SCOPE,
    })

    const calls: { faceId: string; data: Record<string, unknown> }[] = []
    const paramsByFaceId = store.validateAndLoad(convId, APP_ID, app.faceRegistry)
    refreshAllFaces(
      APP_ID,
      app.faceRegistry,
      { db: app.db, paramsByFaceId },
      (_a, faceId, _r, data) => {
        calls.push({ faceId, data })
      },
    )

    const update = calls.find((c) => c.faceId === FACE_ID)!
    expect((update.data.summary as { count: number }).count).toBe(2)
    expect(update.data.$params).toEqual({ category: 'work' })
  })

  it('skepticism: different category produces different count (filter is real, not echo)', async () => {
    const app = engine.getApp(APP_ID)!
    const tool = app.toolRegistry.get(viewToolNameFor(FACE_ID))!

    const work = await tool.execute({
      params: { category: 'work' },
      db: app.db,
      conversationId: convId,
      scope: SCOPE,
    })
    const personal = await tool.execute({
      params: { category: 'personal' },
      db: app.db,
      conversationId: convId,
      scope: SCOPE,
    })

    const workCount = (work.result as { data: { summary: { count: number } } }).data.summary.count
    const personalCount = (personal.result as { data: { summary: { count: number } } }).data.summary
      .count
    expect(workCount).toBe(2)
    expect(personalCount).toBe(3)
    expect(workCount).not.toBe(personalCount)
  })

  it('view_<faceId>({}) stores empty params and resolver falls back to all categories', async () => {
    const app = engine.getApp(APP_ID)!
    const tool = app.toolRegistry.get(viewToolNameFor(FACE_ID))!

    await tool.execute({
      params: { category: 'work' },
      db: app.db,
      conversationId: convId,
      scope: SCOPE,
    })
    const result = await tool.execute({
      params: {},
      db: app.db,
      conversationId: convId,
      scope: SCOPE,
    })

    expect(store.get(convId, APP_ID, FACE_ID)?.params).toEqual({})
    const summary = (result.result as { data: { summary: { count: number; category: string } } })
      .data.summary
    expect(summary.count).toBe(5) // 2 work + 3 personal
    expect(summary.category).toBe('all')
  })
})

describe('parameterized-face: agent-loop end-to-end (scripted LLM)', () => {
  let engine: AppEngine
  let platformDb: PlatformDb
  let store: FaceParamsStore
  let convId: string
  const sendFaceUpdate: SendFaceUpdate = () => {}

  beforeEach(async () => {
    engine = new AppEngine()
    platformDb = freshPlatformDb()
    store = new FaceParamsStore(platformDb)
    engine.register(createTestAppDef())
    await engine.bootAll()
    wireSynthFaceTools({
      appId: APP_ID,
      appEngine: engine,
      faceParamsStore: store,
      transport: new FakeTransport(),
    })
    seedTestAppNotes(engine.getApp(APP_ID)!.db)
    convId = newConversation(platformDb, SCOPE)
  })

  afterEach(() => {
    engine.shutdown()
  })

  it('forwards the synth tool result back to the adapter (data tree + $params)', async () => {
    const adapter = new ScriptedAdapter()
    adapter.setEvents([
      {
        type: 'toolCall',
        callId: 'c1',
        name: viewToolNameFor(FACE_ID),
        args: { category: 'work' },
      },
      { type: 'text', text: 'Showing work notes.' },
      { type: 'done' },
    ])

    const app = engine.getApp(APP_ID)!
    const loop = new AgentLoop({
      adapter,
      toolRegistry: app.toolRegistry,
      faceRegistry: app.faceRegistry,
      db: app.db,
      appId: APP_ID,
      sendFaceUpdate,
      faceParamsStore: store,
    })
    await loop.runTurn({
      conversationId: convId,
      message: 'show work',
      mode: 'direct_user_chat',
      tools: getToolSchemas(app),
      cwd: path.resolve('.', '.tmp'),
      sdkBound: false,
      context: {
        appId: APP_ID,
        manifest: app.manifest,
        turnMode: 'direct_user_chat',
      },
    })

    expect(adapter.recordedToolResults).toHaveLength(1)
    const r = adapter.recordedToolResults[0]!.result.result as { data: Record<string, unknown> }
    const summary = r.data.summary as { count: number; category: string }
    expect(summary.count).toBe(2)
    expect(summary.category).toBe('work')
    expect(r.data.$params).toEqual({ category: 'work' })
  })
})
