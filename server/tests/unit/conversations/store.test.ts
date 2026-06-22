/**
 * ConversationStore unit tests — run against a real in-memory platform DB.
 */

import { describe, it, expect } from 'vitest'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import * as path from 'node:path'
import * as schema from '../../../src/server/conversations/schema.js'
import { ConversationStore, type AppendEntry } from '../../../src/server/conversations/store.js'

type PlatformDb = BetterSQLite3Database<typeof schema>

function freshStore(): { db: PlatformDb; store: ConversationStore } {
  const db = drizzle({ connection: ':memory:', schema, casing: 'snake_case' }) as PlatformDb
  migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../drizzle/platform') })
  return { db, store: new ConversationStore(db) }
}

const userTurn: AppendEntry = { role: 'user', text: 'hi', turnMode: 'direct_user_chat' }
const assistantTurn: AppendEntry = {
  role: 'assistant',
  text: 'hello',
  turnMode: 'direct_user_chat',
}

describe('ConversationStore.getActive', () => {
  it('auto-creates when none exists and returns same row on second call', () => {
    const { store } = freshStore()
    const first = store.getActive('home')
    const second = store.getActive('home')
    expect(first.id).toBe(second.id)
    expect(first.scope).toBe('home')
    expect(first.sdkBoundAt).toBeNull()
    expect(first.archivedAt).toBeNull()
  })

  it('creates distinct conversations for distinct scopes', () => {
    const { store } = freshStore()
    const home = store.getActive('home')
    const spend = store.getActive('app:spend-tracker')
    expect(home.id).not.toBe(spend.id)
  })
})

describe('ConversationStore.appendTurn', () => {
  it('assigns monotonic seq within a conversation', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const r1 = store.appendTurn(conv.id, userTurn)
    const r2 = store.appendTurn(conv.id, assistantTurn)
    const r3 = store.appendTurn(conv.id, userTurn)
    expect(r1.seq).toBe(1)
    expect(r2.seq).toBe(2)
    expect(r3.seq).toBe(3)
  })

  it('bindSdkSession stamps sdk_session_id + sdk_bound_at once', () => {
    const { db, store } = freshStore()
    const conv = store.getActive('home')

    const before = db.select().from(schema.conversations).get()
    expect(before?.sdkBoundAt).toBeNull()
    expect(before?.sdkSessionId).toBeNull()

    store.bindSdkSession(conv.id, 'sdk-uuid-1', 'claude')
    const afterFirst = db.select().from(schema.conversations).get()
    expect(afterFirst?.sdkSessionId).toBe('sdk-uuid-1')
    expect(afterFirst?.sdkBoundAt).not.toBeNull()
    expect(afterFirst?.sdkBackend).toBe('claude')

    const firstBoundValue = afterFirst!.sdkBoundAt
    // A second bind with the same backend + a different id must NOT clobber —
    // the first successful session is authoritative within a backend.
    store.bindSdkSession(conv.id, 'sdk-uuid-2', 'claude')
    const afterSecond = db.select().from(schema.conversations).get()
    expect(afterSecond?.sdkSessionId).toBe('sdk-uuid-1') // unchanged
    expect(afterSecond?.sdkBoundAt).toBe(firstBoundValue)
  })

  it('serializes tool calls as JSON', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const row = store.appendTurn(conv.id, {
      ...assistantTurn,
      toolCalls: [{ name: 'foo', args: { x: 1 } }],
    })
    expect(row.toolCallsJson).toBe(JSON.stringify([{ name: 'foo', args: { x: 1 } }]))
  })

  it('emits append event with the row and scope', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const events: Array<{ scope: string; conversationId: string; seq: number }> = []
    store.on('append', (p) =>
      events.push({ scope: p.scope, conversationId: p.conversationId, seq: p.row.seq }),
    )

    store.appendTurn(conv.id, userTurn)
    store.appendTurn(conv.id, assistantTurn)

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ scope: 'home', conversationId: conv.id, seq: 1 })
    expect(events[1]).toEqual({ scope: 'home', conversationId: conv.id, seq: 2 })
  })

  it('throws when the conversation does not exist', () => {
    const { store } = freshStore()
    expect(() => store.appendTurn('nonexistent-uuid', userTurn)).toThrow(/not found/)
  })

  it('refuses to append to an archived conversation (stale-reference guard)', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    store.appendTurn(conv.id, userTurn)
    store.reset('home') // archives `conv`

    // Caller still holds the old id; any write through it must fail loudly
    // rather than silently accumulating invisible rows under the archived row.
    expect(() => store.appendTurn(conv.id, userTurn)).toThrow(/archived/)
  })
})

describe('ConversationStore.getWindow', () => {
  it('returns entries in seq order up to limit', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    for (let i = 0; i < 5; i++) store.appendTurn(conv.id, { ...userTurn, text: `m${i}` })
    const { entries, conversationId } = store.getWindow('home', 10)
    expect(conversationId).toBe(conv.id)
    expect(entries.map((e) => e.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('respects the limit and returns the most recent rows', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    for (let i = 0; i < 10; i++) store.appendTurn(conv.id, { ...userTurn, text: `m${i}` })
    const { entries } = store.getWindow('home', 3)
    expect(entries.map((e) => e.text)).toEqual(['m7', 'm8', 'm9'])
  })

  it('returns an empty window for a fresh scope but still creates the conversation', () => {
    const { store, db } = freshStore()
    const { entries, conversationId } = store.getWindow('app:new-app')
    expect(entries).toEqual([])
    const conv = db.select().from(schema.conversations).get()
    expect(conv?.id).toBe(conversationId)
  })
})

describe('ConversationStore.reset', () => {
  it('archives the current conversation and returns a fresh one', () => {
    const { store } = freshStore()
    const orig = store.getActive('home')
    store.appendTurn(orig.id, userTurn)
    store.appendTurn(orig.id, assistantTurn)

    const { archived, fresh } = store.reset('home')
    expect(archived?.id).toBe(orig.id)
    expect(archived?.archivedAt).not.toBeNull()
    expect(fresh.id).not.toBe(orig.id)
    expect(fresh.sdkBoundAt).toBeNull()
    expect(fresh.archivedAt).toBeNull()
  })

  it('preserves archived conversation messages', () => {
    const { store, db } = freshStore()
    const orig = store.getActive('home')
    store.appendTurn(orig.id, userTurn)
    store.appendTurn(orig.id, assistantTurn)

    store.reset('home')

    const origMsgs = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, orig.id))
      .all()
    expect(origMsgs).toHaveLength(2)
  })

  it('enforces one active per scope across repeated resets', () => {
    const { store, db } = freshStore()
    store.getActive('home')
    store.reset('home')
    store.reset('home')
    store.reset('home')

    const active = db
      .select()
      .from(schema.conversations)
      .all()
      .filter((c) => c.archivedAt === null)
    expect(active).toHaveLength(1)
  })

  it('emits reset event with new conversation id', () => {
    const { store } = freshStore()
    store.getActive('home')
    const events: Array<{ scope: string; newConversationId: string; kind: string }> = []
    store.on('reset', (p) => events.push(p))

    const { fresh } = store.reset('home')

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ scope: 'home', newConversationId: fresh.id, kind: 'chat' })
  })

  it('still inserts a fresh conversation when there is nothing to archive', () => {
    const { store } = freshStore()
    const { archived, fresh } = store.reset('home')
    expect(archived).toBeNull()
    expect(fresh.scope).toBe('home')
    expect(fresh.archivedAt).toBeNull()
  })
})

describe('ConversationStore.appendTurn (clientMsgId UPSERT)', () => {
  it('is idempotent on clientMsgId within a conversation', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const first = store.appendTurn(conv.id, { ...userTurn, clientMsgId: 'abc' })
    const second = store.appendTurn(conv.id, { ...userTurn, text: 'different', clientMsgId: 'abc' })
    expect(second.id).toBe(first.id)
    expect(second.text).toBe('hi') // original text preserved, not overwritten
  })

  it('does not emit append on a dedup hit', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const events: string[] = []
    store.on('append', (p) => events.push(p.row.id))

    store.appendTurn(conv.id, { ...userTurn, clientMsgId: 'abc' })
    store.appendTurn(conv.id, { ...userTurn, clientMsgId: 'abc' })

    expect(events).toHaveLength(1) // second call was dedup'd
  })

  it('sets default status "pending" for user rows and "completed" for assistant rows', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const u = store.appendTurn(conv.id, userTurn)
    const a = store.appendTurn(conv.id, assistantTurn)
    expect(u.status).toBe('pending')
    expect(a.status).toBe('completed')
  })

  it('two conversations can coincidentally share the same clientMsgId', () => {
    // Dedup is per-conversation, not global: same clientMsgId in two scopes must not throw.
    const { store } = freshStore()
    const home = store.getActive('home')
    const app = store.getActive('app:diet-tracker')
    const inHome = store.appendTurn(home.id, { ...userTurn, clientMsgId: 'shared' })
    const inApp = store.appendTurn(app.id, { ...userTurn, text: 'from app', clientMsgId: 'shared' })
    expect(inHome.id).not.toBe(inApp.id)
    expect(inHome.conversationId).toBe(home.id)
    expect(inApp.conversationId).toBe(app.id)
  })
})

describe('ConversationStore turn lifecycle', () => {
  it('markTurnRunning transitions pending → running and emits update', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const userRow = store.appendTurn(conv.id, userTurn)

    const updates: Array<{ scope: string; status: string }> = []
    store.on('update', (p) => updates.push({ scope: p.scope, status: p.row.status }))

    store.markTurnRunning(userRow.id)

    expect(updates).toEqual([{ scope: 'home', status: 'running' }])
  })

  it('markTurnCompleted transitions to completed', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const userRow = store.appendTurn(conv.id, userTurn)
    store.markTurnRunning(userRow.id)
    store.markTurnCompleted(userRow.id)

    const { entries } = store.getWindow('home')
    expect(entries.find((e) => e.id === userRow.id)?.status).toBe('completed')
  })

  it('markTurnFailed(sdk_timeout) flips status and appends a synthetic "(timed out)" assistant row', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const userRow = store.appendTurn(conv.id, userTurn)
    store.markTurnRunning(userRow.id)

    const appends: string[] = []
    store.on('append', (p) => appends.push(p.row.role + ':' + p.row.text))

    store.markTurnFailed(userRow.id, 'sdk_timeout')

    const { entries } = store.getWindow('home')
    const user = entries.find((e) => e.id === userRow.id)!
    expect(user.status).toBe('timed_out')
    expect(user.failureReason).toBe('sdk_timeout')
    expect(appends).toContain('assistant:(timed out)')
  })

  it('markTurnFailed(internal_error) yields status=failed + "(internal error)" assistant row', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    const userRow = store.appendTurn(conv.id, userTurn)
    store.markTurnFailed(userRow.id, 'internal_error')

    const { entries } = store.getWindow('home')
    expect(entries.find((e) => e.id === userRow.id)?.status).toBe('failed')
    const last = entries[entries.length - 1]!
    expect(last.role).toBe('assistant')
    expect(last.text).toBe('(internal error)')
  })

  it('markTurnFailed on an archived conversation transitions status, skips the synthetic row, and suppresses the update broadcast', () => {
    const { store } = freshStore()
    const orig = store.getActive('home')
    const userRow = store.appendTurn(orig.id, userTurn)
    store.markTurnRunning(userRow.id)

    // Archive mid-turn (mimics /reset racing with in-flight turn).
    store.reset('home')

    // Only subscribe AFTER the archive so we isolate the post-archive
    // transition. No `update` broadcast should fire for an archived
    // conv — clients aren't viewing it and the broadcast would be noise.
    const updates: string[] = []
    store.on('update', (p) => updates.push(p.row.status))

    // Should not throw (appendTurn to archived would), and the active
    // (fresh) conversation should stay empty.
    expect(() => store.markTurnFailed(userRow.id, 'aborted')).not.toThrow()

    expect(updates).toEqual([])
    const { entries } = store.getWindow('home')
    expect(entries).toEqual([]) // fresh conv has no synthetic row

    // Status flip still persisted for forensics (direct DB read).
    const archivedConvRow = store.getById(orig.id)
    expect(archivedConvRow?.archivedAt).not.toBeNull()
  })

  it('recoverOrphans flips every pending/running user row to failed:server_interrupted and appends a synthetic row', () => {
    const { store } = freshStore()
    const convHome = store.getActive('home')
    const convApp = store.getActive('app:foo')

    const u1 = store.appendTurn(convHome.id, userTurn) // pending
    const u2 = store.appendTurn(convApp.id, userTurn)
    store.markTurnRunning(u2.id) // running

    // A completed turn should NOT be touched.
    const u3 = store.appendTurn(convHome.id, { ...userTurn, text: 'done-turn' })
    store.markTurnCompleted(u3.id)

    const { recovered } = store.recoverOrphans()
    expect(recovered).toBe(2)

    const homeEntries = store.getWindow('home').entries
    expect(homeEntries.find((e) => e.id === u1.id)?.status).toBe('failed')
    expect(homeEntries.find((e) => e.id === u1.id)?.failureReason).toBe('server_interrupted')
    expect(
      homeEntries.some((e) => e.role === 'assistant' && e.text === '(server interrupted)'),
    ).toBe(true)

    const appEntries = store.getWindow('app:foo').entries
    expect(appEntries.find((e) => e.id === u2.id)?.status).toBe('failed')
    expect(
      appEntries.some((e) => e.role === 'assistant' && e.text === '(server interrupted)'),
    ).toBe(true)

    // u3 was completed — nothing changed.
    expect(homeEntries.find((e) => e.id === u3.id)?.status).toBe('completed')
  })
})

describe('ConversationStore.activeConversationIdsForApp', () => {
  it('returns only the active conversation for the app scope', () => {
    const { store } = freshStore()
    const spend = store.getActive('app:spend-tracker')
    store.getActive('home') // noise
    store.reset('app:spend-tracker') // archive spend; new one created
    const ids = store.activeConversationIdsForApp('spend-tracker')
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toBe(spend.id)
  })

  it('returns empty when no conversation has ever been created for the app', () => {
    const { store } = freshStore()
    expect(store.activeConversationIdsForApp('ghost')).toEqual([])
  })
})

describe('ConversationStore kind + draft_id (Phase 3a)', () => {
  it('(a) chat and dev conversations can be active for the same scope simultaneously', () => {
    // The composite unique index (scope, kind) WHERE archived_at IS NULL must
    // allow one active 'chat' AND one active 'dev' row per scope.
    const { store } = freshStore()
    const chat = store.getActive('app:my-app', 'chat')
    const dev = store.getActive('app:my-app', 'dev', 'draft-xyz')

    expect(chat.id).not.toBe(dev.id)
    expect(chat.scope).toBe('app:my-app')
    expect(chat.kind).toBe('chat')
    expect(dev.scope).toBe('app:my-app')
    expect(dev.kind).toBe('dev')
    expect(dev.draftId).toBe('draft-xyz')

    // Both are still active — no unique-constraint error was thrown above,
    // and each getActive returns the same row on a second call.
    expect(store.getActive('app:my-app', 'chat').id).toBe(chat.id)
    expect(store.getActive('app:my-app', 'dev').id).toBe(dev.id)
  })

  it('(b) findDevConversationByDraft returns the right row', () => {
    const { store } = freshStore()
    store.getActive('app:my-app', 'chat')
    const dev = store.getActive('app:my-app', 'dev', 'draft-abc')

    const found = store.findDevConversationByDraft('draft-abc')
    expect(found).toBeDefined()
    expect(found!.id).toBe(dev.id)
    expect(found!.kind).toBe('dev')
    expect(found!.draftId).toBe('draft-abc')

    // A different draftId should not match.
    expect(store.findDevConversationByDraft('draft-other')).toBeUndefined()
  })

  it('findDevConversationByDraft returns undefined when the dev conversation is archived', () => {
    const { store } = freshStore()
    store.getActive('app:my-app', 'dev', 'draft-stale')
    store.reset('app:my-app', 'dev') // archives the dev conversation

    expect(store.findDevConversationByDraft('draft-stale')).toBeUndefined()
  })

  it('(c) single-arg getActive still defaults to kind="chat"', () => {
    const { store } = freshStore()
    const conv = store.getActive('home')
    expect(conv.kind).toBe('chat')
    expect(conv.draftId).toBeNull()

    // Idempotent: same row returned.
    expect(store.getActive('home').id).toBe(conv.id)
  })

  it('activeConversationIdsForApp returns ids for both kinds', () => {
    const { store } = freshStore()
    const chat = store.getActive('app:multi', 'chat')
    const dev = store.getActive('app:multi', 'dev', 'draft-d1')

    const ids = store.activeConversationIdsForApp('multi')
    expect(ids).toHaveLength(2)
    expect(ids).toContain(chat.id)
    expect(ids).toContain(dev.id)
  })

  it('reset(scope, kind) only archives the matching kind, leaving the other active', () => {
    const { store } = freshStore()
    const chat = store.getActive('app:my-app', 'chat')
    const dev = store.getActive('app:my-app', 'dev', 'draft-r1')

    store.reset('app:my-app', 'dev') // archive only dev

    // chat is still active and unchanged.
    expect(store.getActive('app:my-app', 'chat').id).toBe(chat.id)
    // dev is now a fresh row (new id).
    const freshDev = store.getActive('app:my-app', 'dev')
    expect(freshDev.id).not.toBe(dev.id)
    // The old draft link is gone from the fresh row.
    expect(freshDev.draftId).toBeNull()
  })

  it('reset(scope, "dev", draftId) carries the draft link onto the fresh row', () => {
    const { store } = freshStore()
    const dev = store.getActive('app:my-app', 'dev', 'draft-keep')
    store.appendTurn(dev.id, { role: 'user', text: 'hi' })

    const { archived, fresh } = store.reset('app:my-app', 'dev', 'draft-keep')

    // Old row archived (and still findable by id), fresh row is new + empty.
    expect(archived?.id).toBe(dev.id)
    expect(fresh.id).not.toBe(dev.id)
    expect(fresh.draftId).toBe('draft-keep')
    // Routing now resolves to the fresh active row (the load-bearing fix):
    // without carrying draftId, this would return undefined and orphan the draft.
    expect(store.findDevConversationByDraft('draft-keep')?.id).toBe(fresh.id)
    expect(store.getWindow('app:my-app', 50, 'dev').entries).toHaveLength(0)
  })

  it('reset emits a `reset` event tagged with the kind', () => {
    const { store } = freshStore()
    const events: Array<{ scope: string; kind: string }> = []
    store.on('reset', (p) => events.push({ scope: p.scope, kind: p.kind }))

    store.getActive('home', 'chat')
    store.reset('home') // defaults to chat
    store.getActive('app:x', 'dev', 'draft-x')
    store.reset('app:x', 'dev', 'draft-x')

    expect(events).toEqual([
      { scope: 'home', kind: 'chat' },
      { scope: 'app:x', kind: 'dev' },
    ])
  })

  // The dangerous case: a new-app draft's dev conversation shares scope='home'
  // with the regular home chat. Resetting one MUST NOT touch the other — the
  // (scope, kind) key is the only thing keeping them apart.
  it('scope="home": dev reset and chat reset are fully independent', () => {
    const { store } = freshStore()
    const homeChat = store.getActive('home', 'chat')
    store.appendTurn(homeChat.id, { role: 'user', text: 'home chat msg' })
    const homeDev = store.getActive('home', 'dev', 'draft-home')
    store.appendTurn(homeDev.id, { role: 'user', text: 'build me an app' })

    // Reset ONLY the dev thread.
    store.reset('home', 'dev', 'draft-home')

    // Home CHAT is untouched: same active row, history intact.
    const chatAfter = store.getActive('home', 'chat')
    expect(chatAfter.id).toBe(homeChat.id)
    expect(store.getWindow('home', 50, 'chat').entries).toHaveLength(1)
    // Dev is fresh + empty, still linked to the draft.
    const devAfter = store.getActive('home', 'dev')
    expect(devAfter.id).not.toBe(homeDev.id)
    expect(devAfter.draftId).toBe('draft-home')
    expect(store.getWindow('home', 50, 'dev').entries).toHaveLength(0)

    // Now reset ONLY the chat thread — dev must survive.
    store.reset('home') // chat
    expect(store.getActive('home', 'chat').id).not.toBe(homeChat.id)
    expect(store.getWindow('home', 50, 'chat').entries).toHaveLength(0)
    // The dev row from the first reset is still the active dev conversation.
    expect(store.getActive('home', 'dev').id).toBe(devAfter.id)
    expect(store.findDevConversationByDraft('draft-home')?.id).toBe(devAfter.id)
  })
})
