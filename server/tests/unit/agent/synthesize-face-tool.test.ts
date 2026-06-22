/**
 * synthesize-face-tool unit tests.
 *
 * Runs with an in-memory platform DB (persist + read path is end-to-end).
 * Transport is a fake that records broadcast calls to assert navigate-iff-same-scope.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { FaceParamsStore } from '../../../src/server/agent/face-params-store.js'
import { synthesizeFaceTool } from '../../../src/server/agent/synthesize-face-tool.js'
import type { FaceDefinition } from '../../../src/server/agent/types.js'
import {
  FakeTransport,
  freshPlatformDb,
  newConversation,
  type PlatformDb,
} from '../../helpers/face-params-fixtures.js'

function makeFaceParam(): FaceDefinition {
  return {
    id: 'summary',
    label: 'Summary',
    position: 0,
    components: [],
    resolve: ({ params }) => ({
      total: 100,
      month: (params as { month?: string }).month ?? 'default',
    }),
    params: {
      month: { type: 'string', description: 'YYYY-MM' },
    },
    paramsVersion: 1,
    viewToolDescription: 'Show monthly summary.',
  }
}

describe('synthesizeFaceTool — shape', () => {
  it('synthesizes a tool for params-less faces (empty parameters schema)', () => {
    const paramsLess: FaceDefinition = {
      id: 'about',
      label: 'About',
      position: 0,
      viewToolDescription: 'Show the About face.',
      components: [],
      resolve: () => ({ version: '1.0' }),
    }
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face: paramsLess,
      faceParamsStore: new FaceParamsStore(freshPlatformDb()),
      transport: new FakeTransport(),
    })
    expect(tool.name).toBe('view_about')
    expect(tool.description).toBe('Show the About face.')
    expect(tool.parameters).toEqual({})
  })

  it('produces a ToolDefinition mirroring the face contract for parameterized faces', () => {
    const face = makeFaceParam()
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face,
      faceParamsStore: new FaceParamsStore(freshPlatformDb()),
      transport: new FakeTransport(),
    })
    expect(tool.name).toBe('view_summary')
    expect(tool.description).toBe('Show monthly summary.')
    expect(tool.parameters).toBe(face.params)
  })
})

describe('synthesizeFaceTool — execute side effects', () => {
  let appDb: BetterSQLite3Database
  let platformDb: PlatformDb
  let store: FaceParamsStore
  let transport: FakeTransport
  let face: FaceDefinition
  let conv1Id: string

  beforeEach(() => {
    appDb = drizzle({ connection: ':memory:' }) as BetterSQLite3Database
    platformDb = freshPlatformDb()
    store = new FaceParamsStore(platformDb)
    transport = new FakeTransport()
    face = makeFaceParam()
    conv1Id = newConversation(platformDb)
  })

  it('persists params, returns ok+data, mutates focus for origin device when scope matches', async () => {
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face,
      faceParamsStore: store,
      transport,
    })
    const result = await tool.execute({
      params: { month: '2026-02' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:spend-tracker',
      originDeviceId: 'device-A',
    })

    // Persisted
    expect(store.get(conv1Id, 'spend-tracker', 'summary')).toEqual({
      params: { month: '2026-02' },
      version: 1,
    })

    // Tool returned shape: {ok, params, data} with $params auto-merged
    const r = result.result as {
      ok: boolean
      params: unknown
      faceId: string
      data: Record<string, unknown>
    }
    expect(r.ok).toBe(true)
    expect(r.faceId).toBe('summary')
    expect(r.params).toEqual({ month: '2026-02' })
    expect(r.data).toMatchObject({ total: 100, month: '2026-02', $params: { month: '2026-02' } })

    // Per-device focus, not broadcast.
    expect(transport.broadcasts.length).toBe(0)
    expect(transport.focusChanges).toEqual([
      { deviceId: 'device-A', appId: 'spend-tracker', faceId: 'summary' },
    ])
  })

  it('does NOT mutate focus when calling scope differs from face scope (delegated home->app)', async () => {
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face,
      faceParamsStore: store,
      transport,
    })
    await tool.execute({
      params: { month: '2026-02' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'home', // delegated call from home
      originDeviceId: 'device-A',
    })

    expect(store.get(conv1Id, 'spend-tracker', 'summary')?.params).toEqual({ month: '2026-02' })
    expect(transport.focusChanges).toEqual([])
  })

  it('does NOT mutate focus when originDeviceId is unset (server-internal turn)', async () => {
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face,
      faceParamsStore: store,
      transport,
    })
    await tool.execute({
      params: { month: '2026-02' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:spend-tracker',
      // originDeviceId omitted
    })

    expect(store.get(conv1Id, 'spend-tracker', 'summary')?.params).toEqual({ month: '2026-02' })
    expect(transport.focusChanges).toEqual([])
  })

  it('errors when conversationId is missing (no place to persist)', async () => {
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face,
      faceParamsStore: store,
      transport,
    })
    const result = await tool.execute({
      params: { month: '2026-02' },
      db: appDb,
      // conversationId omitted
    })
    expect(result.error).toMatch(/conversationId/)
    expect(result.result).toBeNull()
  })

  it('paramsKey isolates view-state storage from the routing appId (draft scoping)', async () => {
    // Drafts pass a draft-scoped paramsKey so an edit draft (which shares the
    // live app id) never writes view-state under the live app's key. Routing
    // (scope compare + setDeviceFocus) must still use the real appId.
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face,
      faceParamsStore: store,
      transport,
      paramsKey: 'draft:abc123',
    })
    await tool.execute({
      params: { month: '2026-02' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:spend-tracker',
      originDeviceId: 'device-A',
    })

    // Persisted under the DRAFT key, NOT the live app key.
    expect(store.get(conv1Id, 'draft:abc123', 'summary')?.params).toEqual({ month: '2026-02' })
    expect(store.get(conv1Id, 'spend-tracker', 'summary')?.params).toBeUndefined()

    // Routing still uses the real appId — focus targets 'spend-tracker'.
    expect(transport.focusChanges).toEqual([
      { deviceId: 'device-A', appId: 'spend-tracker', faceId: 'summary' },
    ])
  })

  it('view_<faceId>({}) resets view-state by upserting an empty object', async () => {
    const tool = synthesizeFaceTool({
      appId: 'spend-tracker',
      face,
      faceParamsStore: store,
      transport,
    })
    // First set non-default params
    await tool.execute({
      params: { month: '2026-02' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:spend-tracker',
    })
    // Then reset
    await tool.execute({
      params: {},
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:spend-tracker',
    })

    // Row exists with empty params (NOT deleted)
    expect(store.get(conv1Id, 'spend-tracker', 'summary')).toEqual({
      params: {},
      version: 1,
    })
  })
})

describe('synthesizeFaceTool — paramsMerge: "merge"', () => {
  // Scoreboard-shape face: two independent dimensions that should compose.
  function makeMergeFace(): FaceDefinition {
    return {
      id: 'scoreboard',
      label: 'Scoreboard',
      position: 0,
      components: [],
      resolve: ({ params }) => {
        const p = params as { day?: string; league?: string }
        return {
          day: p.day ?? 'today',
          league: p.league ?? 'nhl',
        }
      },
      params: {
        day: { type: 'string', description: 'yesterday/today/upcoming' },
        league: { type: 'string', description: 'nhl/nba/nfl/mlb' },
      },
      paramsVersion: 1,
      paramsMerge: 'merge',
      viewToolDescription: 'Switch the scoreboard view; partial params merge.',
    }
  }

  let appDb: BetterSQLite3Database
  let platformDb: PlatformDb
  let store: FaceParamsStore
  let transport: FakeTransport
  let conv1Id: string

  beforeEach(() => {
    appDb = drizzle({ connection: ':memory:' }) as BetterSQLite3Database
    platformDb = freshPlatformDb()
    store = new FaceParamsStore(platformDb)
    transport = new FakeTransport()
    conv1Id = newConversation(platformDb)
  })

  it('successive partial calls compose into the full params bag', async () => {
    const tool = synthesizeFaceTool({
      appId: 'scoreboard',
      face: makeMergeFace(),
      faceParamsStore: store,
      transport,
    })

    await tool.execute({
      params: { league: 'nba' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:scoreboard',
    })
    expect(store.get(conv1Id, 'scoreboard', 'scoreboard')?.params).toEqual({ league: 'nba' })

    // Tap "Today" — under merge mode the league filter must NOT be lost.
    const second = await tool.execute({
      params: { day: 'today' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:scoreboard',
    })

    expect(store.get(conv1Id, 'scoreboard', 'scoreboard')?.params).toEqual({
      league: 'nba',
      day: 'today',
    })

    // The immediate render reflects the merged state, not just the input delta —
    // otherwise the chip-tap response would briefly show the wrong league.
    const r = second.result as { params: unknown; data: Record<string, unknown> }
    expect(r.params).toEqual({ league: 'nba', day: 'today' })
    expect(r.data).toMatchObject({
      league: 'nba',
      day: 'today',
      $params: { league: 'nba', day: 'today' },
    })
  })

  it('view_<id>({}) is a no-op under merge mode (existing params preserved)', async () => {
    const tool = synthesizeFaceTool({
      appId: 'scoreboard',
      face: makeMergeFace(),
      faceParamsStore: store,
      transport,
    })

    await tool.execute({
      params: { league: 'nba', day: 'today' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:scoreboard',
    })
    // Empty bag must not wipe state — that's the whole point of opt-in merge.
    await tool.execute({
      params: {},
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:scoreboard',
    })

    expect(store.get(conv1Id, 'scoreboard', 'scoreboard')?.params).toEqual({
      league: 'nba',
      day: 'today',
    })
  })

  it('null field acts as a per-dimension reset (resolver picks default)', async () => {
    const tool = synthesizeFaceTool({
      appId: 'scoreboard',
      face: makeMergeFace(),
      faceParamsStore: store,
      transport,
    })

    await tool.execute({
      params: { league: 'nba', day: 'yesterday' },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:scoreboard',
    })
    // User clears day. Stored row keeps day=null; the resolver's
    // ?? fallback picks 'today' from defaults at render time.
    const result = await tool.execute({
      params: { day: null },
      db: appDb,
      conversationId: conv1Id,
      scope: 'app:scoreboard',
    })

    expect(store.get(conv1Id, 'scoreboard', 'scoreboard')?.params).toEqual({
      league: 'nba',
      day: null,
    })
    const r = result.result as { data: Record<string, unknown> }
    // The fixture resolver applies `params.day ?? 'today'`, so day reverts.
    expect(r.data).toMatchObject({ day: 'today', league: 'nba' })
  })
})
