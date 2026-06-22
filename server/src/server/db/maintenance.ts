/**
 * Platform DB maintenance — periodic hygiene run by the server.
 *
 * - **VACUUM**: reclaims free pages after large DELETEs. Run on a 24h cadence
 *   only when the server is idle, since VACUUM holds an exclusive lock.
 * - **purgeArchivedConversations**: drops archived conversations and their
 *   messages older than N days. /reset only sets `archived_at`; without
 *   purging, the messages table grows unboundedly.
 *
 * Plugin apps prune their own cache_* tables within refresh tasks.
 */

import { and, eq, isNotNull, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { PlatformDb } from './platform-db.js'
import { conversations, messages } from '../conversations/schema.js'

// ---------------------------------------------------------------------------
// Native client access (better-sqlite3 escape hatch)
// ---------------------------------------------------------------------------

/**
 * Drizzle's better-sqlite3 wrapper exposes the native `Database` via `$client`.
 * Centralizing this cast keeps the unsafe `as unknown` out of every callsite.
 */
interface NativeSqliteClient {
  pragma?: (cmd: string, opts?: { simple?: boolean }) => unknown
  exec?: (sql: string) => unknown
  close?: () => void
}

export function getNativeClient(
  db: BetterSQLite3Database<Record<string, unknown>> | PlatformDb,
): NativeSqliteClient | undefined {
  return (db as unknown as { $client?: NativeSqliteClient }).$client
}

// ---------------------------------------------------------------------------
// PRAGMA optimize
// ---------------------------------------------------------------------------

/**
 * Run `PRAGMA optimize=0x10002` on open. SQLite-recommended for long-running
 * apps: lightly re-ANALYZEs tables whose stats are stale (analysis_limit=1000,
 * usually a no-op). Non-fatal on failure — planner falls back to existing stats.
 * https://sqlite.org/pragma.html#pragma_optimize
 */
export function runOptimize(db: BetterSQLite3Database<Record<string, unknown>> | PlatformDb): void {
  try {
    getNativeClient(db)?.pragma?.('optimize=0x10002')
  } catch {
    // Non-fatal — planner falls back to existing stats.
  }
}

// ---------------------------------------------------------------------------
// VACUUM
// ---------------------------------------------------------------------------

export interface VacuumIfIdleOpts {
  /**
   * Returns true if any user turn is currently pending or running across
   * the whole server. VACUUM holds an exclusive lock; we skip when busy
   * to avoid blocking interactive work.
   */
  isBusy: () => boolean
  /** Optional: structured log hook for telemetry. Defaults to console.log. */
  log?: (event: { type: string; [k: string]: unknown }) => void
}

/** Run `VACUUM` when idle. No-op when busy. Returns true if VACUUM ran. */
export function vacuumIfIdle(db: PlatformDb, opts: VacuumIfIdleOpts): boolean {
  if (opts.isBusy()) {
    opts.log?.({ type: 'maintenance_vacuum_skipped', reason: 'busy' })
    return false
  }
  try {
    getNativeClient(db)?.exec?.('VACUUM')
    opts.log?.({ type: 'maintenance_vacuum_ran' })
    return true
  } catch (err) {
    opts.log?.({
      type: 'maintenance_vacuum_failed',
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

// ---------------------------------------------------------------------------
// Archive purge
// ---------------------------------------------------------------------------

export interface PurgeArchivedResult {
  conversationsDeleted: number
  messagesDeleted: number
}

/**
 * Delete archived conversations (and their messages) older than `olderThanDays`.
 * Active conversations are untouched. `PRAGMA foreign_keys` is off, so messages
 * are deleted first, then conversations. Atomic via `db.transaction`.
 */
export function purgeArchivedConversations(
  db: PlatformDb,
  olderThanDays: number,
): PurgeArchivedResult {
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new Error(`purgeArchivedConversations: olderThanDays must be > 0; got ${olderThanDays}`)
  }
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString()

  return db.transaction((tx) => {
    // Find every archived conversation older than cutoff.
    const victims = tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(isNotNull(conversations.archivedAt), lt(conversations.archivedAt, cutoff)))
      .all()

    if (victims.length === 0) {
      return { conversationsDeleted: 0, messagesDeleted: 0 }
    }

    // Delete messages before conversations (no FK cascade).
    let messagesDeleted = 0
    for (const v of victims) {
      const result = tx.delete(messages).where(eq(messages.conversationId, v.id)).run() as {
        changes?: number
      }
      messagesDeleted += result.changes ?? 0
    }
    let conversationsDeleted = 0
    for (const v of victims) {
      const result = tx.delete(conversations).where(eq(conversations.id, v.id)).run() as {
        changes?: number
      }
      conversationsDeleted += result.changes ?? 0
    }
    return { conversationsDeleted, messagesDeleted }
  })
}
