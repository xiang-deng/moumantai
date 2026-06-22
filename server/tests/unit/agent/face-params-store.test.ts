/**
 * FaceParamsStore unit tests — run against an in-memory platform DB so the
 * Drizzle schema, migrations, and SQL paths are all exercised end-to-end.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FaceParamsStore } from '../../../src/server/agent/face-params-store.js'
import { FaceRegistry } from '../../../src/server/agent/face-loader.js'
import { ConversationStore } from '../../../src/server/conversations/store.js'
import type { FaceDefinition } from '../../../src/server/agent/types.js'
import {
  freshPlatformDb as freshDb,
  newConversation,
  paramFace,
  type PlatformDb,
} from '../../helpers/face-params-fixtures.js'

function makeRegistry(faces: FaceDefinition[]): FaceRegistry {
  const reg = new FaceRegistry()
  for (const f of faces) reg.register(f, { skipValidation: true })
  return reg
}

describe('FaceParamsStore — get / set / clear round-trip', () => {
  it('set then get returns the same params + version', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    const row = store.get(convId, 'spend-tracker', 'summary')
    expect(row).toEqual({ params: { month: '2026-02' }, version: 1 })
  })

  it('set is overwrite (not merge)', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02', category: 'food' }, 1)
    store.set(convId, 'spend-tracker', 'summary', { month: '2026-03' }, 1)
    const row = store.get(convId, 'spend-tracker', 'summary')
    // category is gone — overwrite, not merge
    expect(row?.params).toEqual({ month: '2026-03' })
  })

  it('set with {} stores empty object (reset semantics)', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    store.set(convId, 'spend-tracker', 'summary', {}, 1)
    const row = store.get(convId, 'spend-tracker', 'summary')
    expect(row?.params).toEqual({})
  })

  it('setMerged shallow-merges into existing params at matching version', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    store.set(convId, 'scoreboard', 'scoreboard', { league: 'nba' }, 1)
    const merged = store.setMerged(convId, 'scoreboard', 'scoreboard', { day: 'today' }, 1)
    expect(merged).toEqual({ league: 'nba', day: 'today' })
    expect(store.get(convId, 'scoreboard', 'scoreboard')?.params).toEqual({
      league: 'nba',
      day: 'today',
    })
  })

  it('setMerged falls back to overwrite when paramsVersion differs (stale schema)', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    store.set(convId, 'scoreboard', 'scoreboard', { league: 'nba', legacy_field: 'gone' }, 1)
    // Version 2 row arrives — stale v1 row must NOT merge into the new schema.
    const merged = store.setMerged(convId, 'scoreboard', 'scoreboard', { day: 'today' }, 2)
    expect(merged).toEqual({ day: 'today' })
    expect(store.get(convId, 'scoreboard', 'scoreboard')).toEqual({
      params: { day: 'today' },
      version: 2,
    })
  })

  it('setMerged on a missing row writes the input as-is at the current version', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    const merged = store.setMerged(convId, 'scoreboard', 'scoreboard', { day: 'today' }, 1)
    expect(merged).toEqual({ day: 'today' })
    expect(store.get(convId, 'scoreboard', 'scoreboard')).toEqual({
      params: { day: 'today' },
      version: 1,
    })
  })

  it('clear removes only the targeted row', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    store.set(convId, 'spend-tracker', 'categories', { sort: 'amount' }, 1)
    store.clear(convId, 'spend-tracker', 'summary')
    expect(store.get(convId, 'spend-tracker', 'summary')).toBeNull()
    expect(store.get(convId, 'spend-tracker', 'categories')).not.toBeNull()
  })

  it('getAll returns a faceId-keyed map for the (conv, app) tuple', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)

    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    store.set(convId, 'spend-tracker', 'categories', { sort: 'amount' }, 1)
    const all = store.getAll(convId, 'spend-tracker')
    expect(Object.keys(all).sort()).toEqual(['categories', 'summary'])
    expect(all.summary).toEqual({ params: { month: '2026-02' }, version: 1 })
  })
})

describe('FaceParamsStore — validateAndLoad (lazy drift cleanup)', () => {
  it('drops rows whose paramsVersion mismatches the current face', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)
    const registry = makeRegistry([paramFace({ paramsVersion: 2 })])

    // Stored with version 1; current schema is version 2 — should drop.
    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = store.validateAndLoad(convId, 'spend-tracker', registry)
    warn.mockRestore()

    expect(out).toEqual({})
    expect(store.get(convId, 'spend-tracker', 'summary')).toBeNull()
  })

  it('drops rows whose stored params fail the current schema', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)
    const registry = makeRegistry([paramFace()])

    // Stored params include a number where the schema expects a string.
    store.set(convId, 'spend-tracker', 'summary', { month: 999 as unknown as string }, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = store.validateAndLoad(convId, 'spend-tracker', registry)
    warn.mockRestore()

    expect(out).toEqual({})
    expect(store.get(convId, 'spend-tracker', 'summary')).toBeNull()
  })

  it('drops rows for faces no longer in the registry', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)
    const registry = makeRegistry([]) // face removed

    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = store.validateAndLoad(convId, 'spend-tracker', registry)
    warn.mockRestore()

    expect(out).toEqual({})
    expect(store.get(convId, 'spend-tracker', 'summary')).toBeNull()
  })

  it('returns valid rows untouched', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)
    const registry = makeRegistry([paramFace()])

    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    const out = store.validateAndLoad(convId, 'spend-tracker', registry)

    expect(out).toEqual({ summary: { month: '2026-02' } })
    expect(store.get(convId, 'spend-tracker', 'summary')).not.toBeNull()
  })
})

describe('FaceParamsStore — sweepStaleVersions (eager cleanup)', () => {
  it('removes stale rows across ALL conversations in one pass', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    // Three different conversations, each with a row at the OLD version.
    const conv1 = newConversation(db, 'app:spend-tracker')
    const conv2 = new ConversationStore(db).reset('app:spend-tracker').fresh.id
    const conv3 = new ConversationStore(db).reset('app:spend-tracker').fresh.id
    for (const c of [conv1, conv2, conv3]) {
      store.set(c, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    }
    expect(Object.keys(store.getAll(conv1, 'spend-tracker')).length).toBe(1)
    expect(Object.keys(store.getAll(conv2, 'spend-tracker')).length).toBe(1)
    expect(Object.keys(store.getAll(conv3, 'spend-tracker')).length).toBe(1)

    // Author bumped paramsVersion to 2 — sweep should drop all 3 rows.
    const registry = makeRegistry([paramFace({ paramsVersion: 2 })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dropped = store.sweepStaleVersions('spend-tracker', registry)
    warn.mockRestore()

    expect(dropped).toBe(3)
    for (const c of [conv1, conv2, conv3]) {
      expect(store.get(c, 'spend-tracker', 'summary')).toBeNull()
    }
  })

  it('does not touch faces without params', () => {
    const db = freshDb()
    const store = new FaceParamsStore(db)
    const convId = newConversation(db)
    store.set(convId, 'spend-tracker', 'summary', { month: '2026-02' }, 1)

    const registry = makeRegistry([{ ...paramFace(), params: undefined }])
    const dropped = store.sweepStaleVersions('spend-tracker', registry)
    // Face is no longer parameterized — sweep skips it. validateAndLoad is the
    // separate gate that handles this case.
    expect(dropped).toBe(0)
  })
})

describe('FaceParamsStore — bulk delete', () => {
  let db: PlatformDb
  let store: FaceParamsStore
  let convA: string
  let convB: string

  beforeEach(() => {
    db = freshDb()
    store = new FaceParamsStore(db)
    const cs = new ConversationStore(db)
    convA = cs.getActive('app:spend-tracker').id
    convB = cs.reset('app:spend-tracker').fresh.id
    // Seed rows across two apps for both conversations
    store.set(convA, 'spend-tracker', 'summary', { month: '2026-02' }, 1)
    store.set(convA, 'spend-tracker', 'categories', { sort: 'amount' }, 1)
    store.set(convA, 'diet-tracker', 'today', { meal: 'breakfast' }, 1)
    store.set(convB, 'spend-tracker', 'summary', { month: '2026-03' }, 1)
  })

  it('deleteByApp removes rows for one app across all conversations', () => {
    const dropped = store.deleteByApp('spend-tracker')
    expect(dropped).toBe(3)
    expect(Object.keys(store.getAll(convA, 'spend-tracker')).length).toBe(0)
    expect(Object.keys(store.getAll(convB, 'spend-tracker')).length).toBe(0)
    // Other app untouched
    expect(Object.keys(store.getAll(convA, 'diet-tracker')).length).toBe(1)
  })
})
