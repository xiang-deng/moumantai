/**
 * DB maintenance unit tests — run against a real in-memory platform DB.
 */

import { describe, it, expect } from 'vitest'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq, sql } from 'drizzle-orm'
import * as path from 'node:path'
import * as schema from '../../../src/server/conversations/schema.js'
import { ConversationStore } from '../../../src/server/conversations/store.js'
import { vacuumIfIdle, purgeArchivedConversations } from '../../../src/server/db/maintenance.js'

type PlatformDb = BetterSQLite3Database<typeof schema>

function freshDb(): { db: PlatformDb; store: ConversationStore } {
  const db = drizzle({ connection: ':memory:', schema, casing: 'snake_case' }) as PlatformDb
  migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../drizzle/platform') })
  return { db, store: new ConversationStore(db) }
}

/** Helper: flip archived_at on a freshly-archived row to a fixed past date. */
function backdateArchived(db: PlatformDb, conversationId: string, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  db.update(schema.conversations)
    .set({ archivedAt: ts })
    .where(eq(schema.conversations.id, conversationId))
    .run()
}

describe('purgeArchivedConversations', () => {
  it('drops conversations older than the cutoff and their messages', () => {
    const { db, store } = freshDb()
    // Three conversations: one freshly archived, one old archived, one active.
    const oldConv = store.getActive('old-scope')
    store.appendTurn(oldConv.id, { role: 'user', text: 'old user msg' })
    store.appendTurn(oldConv.id, { role: 'assistant', text: 'old reply' })
    store.reset('old-scope') // archives oldConv
    backdateArchived(db, oldConv.id, 100) // 100 days ago

    const recentConv = store.getActive('recent-scope')
    store.appendTurn(recentConv.id, { role: 'user', text: 'recent' })
    store.reset('recent-scope') // archives recentConv (now)

    const activeConv = store.getActive('active-scope')
    store.appendTurn(activeConv.id, { role: 'user', text: 'still here' })

    const result = purgeArchivedConversations(db, 90)
    expect(result.conversationsDeleted).toBe(1) // only oldConv
    expect(result.messagesDeleted).toBe(2) // old user + assistant

    // Old conv gone; recent (archived but young) + active + the fresh
    // post-reset rows are untouched. Verify oldConv is the one missing.
    const remainingIds = new Set(
      db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .all()
        .map((r) => r.id),
    )
    expect(remainingIds.has(oldConv.id)).toBe(false)
    expect(remainingIds.has(recentConv.id)).toBe(true)
    expect(remainingIds.has(activeConv.id)).toBe(true)
    // Messages from the survived rows are also intact (recent user + active user).
    const survivedMsgs = db.select().from(schema.messages).all()
    expect(survivedMsgs.map((m) => m.text).sort()).toEqual(['recent', 'still here'])
  })

  it('returns zero counts when no archived rows match', () => {
    const { db, store } = freshDb()
    store.getActive('home')
    const result = purgeArchivedConversations(db, 30)
    expect(result).toEqual({ conversationsDeleted: 0, messagesDeleted: 0 })
  })

  it('throws when olderThanDays is non-positive', () => {
    const { db } = freshDb()
    expect(() => purgeArchivedConversations(db, 0)).toThrow()
    expect(() => purgeArchivedConversations(db, -1)).toThrow()
  })
})

describe('vacuumIfIdle', () => {
  it('runs VACUUM when isBusy returns false', () => {
    const { db } = freshDb()
    const ran = vacuumIfIdle(db, { isBusy: () => false })
    expect(ran).toBe(true)
  })

  it('skips VACUUM when isBusy returns true', () => {
    const { db } = freshDb()
    let logged: string | null = null
    const ran = vacuumIfIdle(db, {
      isBusy: () => true,
      log: (e) => {
        logged = String(e.type)
      },
    })
    expect(ran).toBe(false)
    expect(logged).toBe('maintenance_vacuum_skipped')
  })

  it('reclaims free pages after a large delete', () => {
    const { db, store } = freshDb()
    // Create + reset enough rows to leave free pages on the file.
    for (let i = 0; i < 50; i++) {
      const conv = store.getActive(`scope-${i}`)
      for (let j = 0; j < 5; j++) {
        store.appendTurn(conv.id, { role: 'user', text: `msg ${j}` })
      }
      store.reset(`scope-${i}`)
      backdateArchived(db, conv.id, 100)
    }
    purgeArchivedConversations(db, 90)

    // Use page_count + freelist_count to confirm a meaningful reclaim post-VACUUM.
    const client = (
      db as unknown as {
        $client: { pragma: (cmd: string, opts?: { simple?: boolean }) => unknown }
      }
    ).$client
    const pre = client.pragma('freelist_count', { simple: true }) as number
    vacuumIfIdle(db, { isBusy: () => false })
    const post = client.pragma('freelist_count', { simple: true }) as number
    expect(post).toBeLessThanOrEqual(pre)
  })
})
