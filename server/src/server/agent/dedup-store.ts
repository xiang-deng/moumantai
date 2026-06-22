/**
 * Persistent dedup store for client-initiated tool invocations.
 *
 * Keyed `(conversation_id, client_request_id)` with a 24h TTL — long enough
 * to cover Wear's offline-queue replay window even across server restarts,
 * short enough that the table doesn't grow unboundedly.
 *
 * On retry: if a row exists, the cached `result_json` is returned without
 * re-executing the tool. On first success: a row is written carrying the
 * tool result. The sweep job runs on a 1h interval and discards rows older
 * than the TTL.
 *
 * Symmetric with `messages.client_msg_id` partial-unique-index dedup, but
 * stored in its own table because:
 *   1. Tool invocations don't always produce a chat row (view_<faceId> doesn't),
 *   2. The result payload is small + structured (we cache it for replay).
 */

import { eq, and, lt } from 'drizzle-orm'
import type { PlatformDb } from '../db/platform-db.js'
import { invokeDedup, type InvokeDedup } from '../conversations/schema.js'
import type { ToolResult } from './types.js'

/** TTL for dedup rows; matches Wear OfflineQueue expiry. */
export const DEDUP_TTL_MS = 24 * 60 * 60 * 1000

/** Sweep interval; well below TTL so we never approach unbounded growth. */
export const DEDUP_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface DedupHit {
  /** The cached result returned to the deduped retry. May be null if the
   * original execution returned no usable result (e.g. view_<faceId>). */
  result: ToolResult | null
}

export class DedupStore {
  constructor(private readonly db: PlatformDb) {}

  /**
   * Look up a prior invocation. Returns the cached result on hit; null on miss.
   * Rows older than TTL are treated as misses (and swept on the next sweep).
   */
  lookup(conversationId: string, clientRequestId: string): DedupHit | null {
    if (!conversationId || !clientRequestId) return null
    const row: InvokeDedup | undefined = this.db
      .select()
      .from(invokeDedup)
      .where(
        and(
          eq(invokeDedup.conversationId, conversationId),
          eq(invokeDedup.clientRequestId, clientRequestId),
        ),
      )
      .get()
    if (!row) return null
    const ageMs = Date.now() - new Date(row.createdAt).getTime()
    if (ageMs > DEDUP_TTL_MS) return null
    if (!row.resultJson) return { result: null }
    try {
      const result = JSON.parse(row.resultJson) as ToolResult
      return { result }
    } catch {
      return { result: null }
    }
  }

  /**
   * Record a successful invocation so future retries are deduped. `result`
   * may be null — view_<faceId> and other side-effect-only tools persist a
   * row with `result_json = NULL` to flag "already ran, no payload".
   */
  record(conversationId: string, clientRequestId: string, result: ToolResult | null): void {
    if (!conversationId || !clientRequestId) return
    const resultJson = result ? JSON.stringify(result) : null
    this.db
      .insert(invokeDedup)
      .values({
        conversationId,
        clientRequestId,
        resultJson,
      })
      .onConflictDoNothing()
      .run()
  }

  /** Discard rows older than the TTL. Returns the row count purged. */
  sweepStale(now: number = Date.now()): number {
    const cutoff = new Date(now - DEDUP_TTL_MS).toISOString()
    const result = this.db.delete(invokeDedup).where(lt(invokeDedup.createdAt, cutoff)).run()
    return result.changes ?? 0
  }
}

/**
 * Schedule a recurring sweep on the dedup store. Returns a stop fn for tests.
 * `setInterval` with `unref()` so it doesn't block process exit.
 */
export function startDedupSweep(store: DedupStore): () => void {
  const handle = setInterval(() => {
    try {
      store.sweepStale()
    } catch (err) {
      console.warn('[dedup-store] sweep failed:', err)
    }
  }, DEDUP_SWEEP_INTERVAL_MS)
  // Don't keep the event loop alive on the timer alone.
  if (typeof handle.unref === 'function') handle.unref()
  return () => clearInterval(handle)
}
