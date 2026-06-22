/**
 * Integration: DraftStore end-to-end — createDraft (edit + new-app),
 * countDataRows, markDirty/markReadyForReview/incrementMsgCount,
 * promoteDraft, discardDraft.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { openPlatformDb } from '../../src/server/db/platform-db.js'
import { ConversationStore } from '../../src/server/conversations/store.js'
import { AppEngine } from '../../src/server/agent/app-engine.js'
import { FaceParamsStore } from '../../src/server/agent/face-params-store.js'
import { DraftRegistry } from '../../src/server/drafts/draft-registry.js'
import { DraftStore } from '../../src/server/drafts/draft-store.js'
import { countDataRows } from '../../src/server/drafts/draft-db.js'
import {
  homeLayout,
  appPaths,
  draftPaths,
  ensureHomeLayout,
} from '../../src/server/workspace/home.js'
import type { BroadcastTransport } from '../../src/server/agent/broadcast.js'
import type { ServerMessage } from '@moumantai/protocol/generated/moumantai/v1'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/test-app')

const stubTransport: BroadcastTransport = {
  broadcast(_msg: ServerMessage) {},
  send(_sessionId: string, _msg: ServerMessage) {},
}

interface TestHarness {
  home: string
  platformDb: ReturnType<typeof openPlatformDb>
  conversationStore: ConversationStore
  engine: AppEngine
  faceParamsStore: FaceParamsStore
  draftRegistry: DraftRegistry
  promotions: Array<{
    draftId: string
    appId: string
    promotedAt: string
    summary?: string
    msgCount: number
  }>
  draftStore: DraftStore
}

async function buildHarness(): Promise<TestHarness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-drafts-test-'))
  ensureHomeLayout(home)

  const appsSrcTestApp = path.join(homeLayout(home).appsSrcDir, 'test-app')
  fs.cpSync(FIXTURE_DIR, appsSrcTestApp, { recursive: true })

  const platformDb = openPlatformDb(home)
  const conversationStore = new ConversationStore(platformDb)

  const engine = new AppEngine({ home })

  // Boot test-app so appPaths(home,'test-app').dbFile is created.
  const { createTestAppDef } = await import('../fixtures/test-app/index.js')
  const def = createTestAppDef()
  engine.register(def)
  await engine.boot('test-app')

  const faceParamsStore = new FaceParamsStore(platformDb)

  const draftRegistry = new DraftRegistry({
    home,
    faceParamsStore,
    transport: stubTransport,
  })

  const promotions: TestHarness['promotions'] = []

  const draftStore = new DraftStore({
    home,
    draftRegistry,
    conversationStore,
    appEngine: engine,
    skillsRepoDir: path.join(home, 'no-skills'), // nonexistent: materializeSkill warns + skips
    recordPromotion: (p) => {
      promotions.push(p)
    },
  })

  return {
    home,
    platformDb,
    conversationStore,
    engine,
    faceParamsStore,
    draftRegistry,
    promotions,
    draftStore,
  }
}

function teardownHarness(h: TestHarness): void {
  try {
    h.engine.shutdown()
  } catch {
    /* best-effort */
  }
  try {
    ;(h.platformDb as unknown as { $client: Database.Database }).$client.close()
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(h.home, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/** Seed N notes rows into the live app DB. Returns N. */
function seedLiveNotes(home: string, count: number): number {
  const dbFile = appPaths(home, 'test-app').dbFile
  const db = new Database(dbFile)
  try {
    for (let i = 0; i < count; i++) {
      const id = `note-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO notes (id, content, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, `note content ${i}`, 'general', now, now)
    }
  } finally {
    db.close()
  }
  return count
}

describe('drafts integration', () => {
  let h: TestHarness

  beforeEach(async () => {
    h = await buildHarness()
  })

  afterEach(() => {
    teardownHarness(h)
  })

  it('EDIT createDraft: returns draftId/conversationId/meta; worktree + shadow + meta exist; dev conv created; registry booted', async () => {
    seedLiveNotes(h.home, 3)

    const result = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })

    expect(result.draftId).toBeTruthy()
    expect(result.conversationId).toBeTruthy()
    expect(result.meta).toMatchObject({
      draftId: result.draftId,
      appId: 'test-app',
      kind: 'edit',
      readyForReview: false,
      msgCount: 0,
    })
    expect(typeof result.meta.createdAt).toBe('number')

    // Worktree directory exists.
    const dp = draftPaths(h.home, result.draftId)
    expect(fs.existsSync(dp.dir)).toBe(true)

    // Shadow DB exists.
    expect(fs.existsSync(dp.shadowDbFile)).toBe(true)

    // .meta.json on disk matches returned meta.
    const onDiskMeta = JSON.parse(fs.readFileSync(dp.metaFile, 'utf8'))
    expect(onDiskMeta).toMatchObject({ draftId: result.draftId, kind: 'edit', appId: 'test-app' })

    // The dev conversation exists and is linked to this draft.
    const devConv = h.conversationStore.findDevConversationByDraft(result.draftId)
    expect(devConv).toBeTruthy()
    expect(devConv!.id).toBe(result.conversationId)
    expect(devConv!.kind).toBe('dev')
    expect(devConv!.draftId).toBe(result.draftId)

    // Registry has the draft booted.
    const entry = h.draftRegistry.get(result.draftId)
    expect(entry).toBeTruthy()
    expect(entry!.draftId).toBe(result.draftId)
    expect(entry!.appId).toBe('test-app')
    expect(entry!.kind).toBe('edit')
    expect(entry!.booted).toBeTruthy()
  })

  it('countDataRows: shadow has same row count as seeded live; cache_* tables excluded', async () => {
    const N = 4
    seedLiveNotes(h.home, N)

    const result = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })
    const dp = draftPaths(h.home, result.draftId)

    // __drizzle_migrations excluded; only notes contributes, so count = N.
    expect(countDataRows(dp.shadowDbFile)).toBe(N)

    // cache_* tables must not be counted.
    const shadowDb = new Database(dp.shadowDbFile)
    try {
      shadowDb.exec(`CREATE TABLE IF NOT EXISTS cache_foo (id TEXT PRIMARY KEY, val TEXT)`)
      shadowDb.exec(`INSERT INTO cache_foo VALUES ('k1', 'v1')`)
    } finally {
      shadowDb.close()
    }

    expect(countDataRows(dp.shadowDbFile)).toBe(N)
  })

  it('countDataRows returns 0 for a nonexistent file', () => {
    expect(countDataRows('/nonexistent/path/to/db.sqlite')).toBe(0)
  })

  it('markDirty clears readyForReview', async () => {
    seedLiveNotes(h.home, 1)
    const { draftId } = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })

    // Mark ready, then dirty.
    h.draftStore.markReadyForReview(draftId, 'looks great')
    let meta = h.draftStore.getDraft(draftId)
    expect(meta!.readyForReview).toBe(true)
    expect(meta!.summary).toBe('looks great')

    h.draftStore.markDirty(draftId)
    meta = h.draftStore.getDraft(draftId)
    expect(meta!.readyForReview).toBe(false)
    expect(meta!.summary).toBe('looks great') // markDirty only clears readyForReview
  })

  it('markReadyForReview sets readyForReview + summary', async () => {
    seedLiveNotes(h.home, 1)
    const { draftId } = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })

    h.draftStore.markReadyForReview(draftId, 'agent summary here')
    const meta = h.draftStore.getDraft(draftId)
    expect(meta!.readyForReview).toBe(true)
    expect(meta!.summary).toBe('agent summary here')
  })

  it('incrementMsgCount bumps msgCount and sets lastMsgAt', async () => {
    seedLiveNotes(h.home, 1)
    const { draftId } = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })

    const before = Date.now()
    h.draftStore.incrementMsgCount(draftId)
    h.draftStore.incrementMsgCount(draftId)
    const after = Date.now()

    const meta = h.draftStore.getDraft(draftId)
    expect(meta!.msgCount).toBe(2)
    expect(meta!.lastMsgAt).toBeGreaterThanOrEqual(before)
    expect(meta!.lastMsgAt).toBeLessThanOrEqual(after)
  })

  it('resetMsgCount zeros msgCount but leaves readyForReview + summary intact', async () => {
    seedLiveNotes(h.home, 1)
    const { draftId } = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })

    h.draftStore.incrementMsgCount(draftId)
    h.draftStore.incrementMsgCount(draftId)
    h.draftStore.markReadyForReview(draftId, 'adds a chart')
    expect(h.draftStore.getDraft(draftId)!.msgCount).toBe(2)

    // Resetting the dev-conversation empties the thread but leaves the draft code state intact.
    h.draftStore.resetMsgCount(draftId)
    const meta = h.draftStore.getDraft(draftId)
    expect(meta!.msgCount).toBe(0)
    expect(meta!.readyForReview).toBe(true)
    expect(meta!.summary).toBe('adds a chart')
  })

  it('EDIT promoteDraft: worktree removed; registry cleared; promotion recorded; live data preserved (extra shadow row discarded)', async () => {
    const N = 3
    seedLiveNotes(h.home, N)

    const { draftId } = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })
    const dp = draftPaths(h.home, draftId)

    // Extra row in shadow only — must not survive promotion.
    const shadowDb = new Database(dp.shadowDbFile)
    try {
      const extraId = `shadow-extra-${Date.now()}`
      const now = new Date().toISOString()
      shadowDb
        .prepare(
          `INSERT INTO notes (id, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(extraId, 'shadow-only note', 'preview', now, now)
    } finally {
      shadowDb.close()
    }

    expect(countDataRows(dp.shadowDbFile)).toBe(N + 1) // shadow has extra row; live still N

    const outcome = await h.draftStore.promoteDraft(draftId)
    expect(outcome).toMatchObject({ ok: true })

    // Worktree is gone.
    expect(fs.existsSync(dp.dir)).toBe(false)

    // Registry entry is gone.
    expect(h.draftRegistry.get(draftId)).toBeUndefined()

    // Promotion was recorded.
    expect(h.promotions).toHaveLength(1)
    expect(h.promotions[0]).toMatchObject({ appId: 'test-app', draftId })

    const devConv = h.conversationStore.findDevConversationByDraft(draftId)
    expect(devConv).toBeUndefined()

    // Shadow's extra row must not have been promoted into live.
    const liveDb = appPaths(h.home, 'test-app').dbFile
    expect(countDataRows(liveDb)).toBe(N)
  })

  it('discardDraft: worktree removed; registry entry gone; dev conversation archived', async () => {
    seedLiveNotes(h.home, 2)
    const { draftId } = await h.draftStore.createDraft({ kind: 'edit', appId: 'test-app' })
    const dp = draftPaths(h.home, draftId)

    expect(fs.existsSync(dp.dir)).toBe(true) // sanity: worktree exists before discard
    expect(h.draftRegistry.get(draftId)).toBeTruthy()

    const outcome = h.draftStore.discardDraft(draftId)
    expect(outcome).toMatchObject({ ok: true })

    expect(fs.existsSync(dp.dir)).toBe(false)
    expect(h.draftRegistry.get(draftId)).toBeUndefined()

    const devConv = h.conversationStore.findDevConversationByDraft(draftId)
    expect(devConv).toBeUndefined()
  })

  it('NEW-APP createDraft: worktree + shadow dir exist; meta kind=new-app; appId=draftId; home-scope dev conv; NOT in registry', async () => {
    const result = await h.draftStore.createDraft({ kind: 'new-app' })

    expect(result.draftId).toBeTruthy()
    expect(result.conversationId).toBeTruthy()
    expect(result.meta).toMatchObject({
      draftId: result.draftId,
      appId: result.draftId, // appId is a placeholder until the app is named
      kind: 'new-app',
      readyForReview: false,
      msgCount: 0,
    })

    const dp = draftPaths(h.home, result.draftId)

    // Worktree directory exists.
    expect(fs.existsSync(dp.dir)).toBe(true)

    expect(fs.existsSync(dp.shadowDir)).toBe(true) // db created lazily on first boot

    // .meta.json on disk is correct.
    const onDiskMeta = JSON.parse(fs.readFileSync(dp.metaFile, 'utf8'))
    expect(onDiskMeta.kind).toBe('new-app')
    expect(onDiskMeta.appId).toBe(result.draftId)

    // Dev conversation uses 'home' scope.
    const devConv = h.conversationStore.findDevConversationByDraft(result.draftId)
    expect(devConv).toBeTruthy()
    expect(devConv!.scope).toBe('home')
    expect(devConv!.kind).toBe('dev')

    expect(h.draftRegistry.get(result.draftId)).toBeUndefined() // boots on first post-scaffold reload
  })
})
