/**
 * ConversationStore — the only module that reads or writes chat state.
 *
 * Owns: conversation lifecycle (create on first reference, archive on reset),
 * monotonic per-conversation seq, event emission for broadcast fan-out.
 *
 * Callers never touch Drizzle tables directly. Everything goes through the
 * narrow surface below.
 */

import { and, desc, eq, inArray, isNull, lt, max, ne, or } from 'drizzle-orm'
import type { PlatformDb } from '../db/platform-db.js'
import {
  conversations,
  devices,
  messages,
  type Conversation,
  type Device,
  type Message,
} from './schema.js'
import { TypedEmitter, type ConversationEvents } from './events.js'
import { purgeArchivedConversations } from '../db/maintenance.js'

/** Terminal failure reasons for a user turn. Persisted on the user row. */
export type FailureReason =
  | 'sdk_timeout'
  | 'sdk_stream_stalled'
  | 'server_interrupted'
  | 'internal_error'
  | 'aborted'

export interface AppendEntry {
  role: 'user' | 'assistant' | 'system'
  text: string
  turnMode?: string | null
  source?: string | null
  toolCalls?: unknown
  /**
   * Client-generated UUID supplied on `chatInput`. Persisted in
   * `messages.client_msg_id` with a partial unique index: a retry of the same
   * clientMsgId across reconnect/restart is an idempotent no-op (returns the
   * existing row). Null for server-originated rows (assistant/system).
   */
  clientMsgId?: string
  /**
   * Initial status. User rows start 'pending' by default; assistant/system
   * rows start 'completed'. Callers override to write a synthetic failure /
   * interrupted row directly.
   */
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out' | 'aborted'
  /** Populated alongside a terminal failure status. */
  failureReason?: FailureReason | null
  /**
   * Stable deviceId of the originating device. Survives reconnect and server
   * restart. Persisted on user rows only; assistant/system rows leave NULL.
   */
  originDeviceId?: string
}

export interface GetWindowResult {
  conversationId: string
  entries: Message[]
}

export interface GetOlderResult {
  conversationId: string
  entries: Message[]
  /** True when more messages exist below the oldest entry returned. */
  hasMore: boolean
}

export interface ResetResult {
  archived: Conversation | null
  fresh: Conversation
}

export class ConversationStore extends TypedEmitter<ConversationEvents> {
  constructor(private readonly db: PlatformDb) {
    super()
  }

  /**
   * Return the active conversation for (scope, kind), creating one if needed.
   * Idempotent. `kind` defaults to 'chat'. For kind='dev', `draftId` is
   * persisted and used by `findDevConversationByDraft` to route messages.
   */
  getActive(scope: string, kind: 'chat' | 'dev' = 'chat', draftId?: string): Conversation {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.scope, scope),
            eq(conversations.kind, kind),
            isNull(conversations.archivedAt),
          ),
        )
        .get()
      if (existing) return existing

      const inserted = tx
        .insert(conversations)
        .values({
          scope,
          kind,
          draftId: draftId ?? null,
        })
        .returning()
        .get()
      return inserted
    })
  }

  /**
   * Return the last `limit` messages for the active conversation of a scope
   * (auto-created if absent). Default 50 — sent on every (re)connect;
   * older entries are loadable on demand via FetchOlderMsg.
   */
  getWindow(scope: string, limit: number = 50, kind: 'chat' | 'dev' = 'chat'): GetWindowResult {
    const conv = this.getActive(scope, kind)
    const rows = this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.seq))
      .limit(limit)
      .all()
    return { conversationId: conv.id, entries: rows.reverse() }
  }

  /**
   * Return up to `limit` messages older than `beforeSeq`, ascending seq order,
   * plus a `hasMore` flag. Drives fetchOlder pagination: clients page upward
   * by passing their oldest cached seq as `beforeSeq`. `beforeSeq <= 0` means
   * "from newest" (same as `getWindow`). Archived conversations are not exposed.
   */
  getOlder(
    scope: string,
    beforeSeq: number,
    limit: number = 50,
    kind: 'chat' | 'dev' = 'chat',
  ): GetOlderResult {
    const conv = this.getActive(scope, kind)
    const cap = Math.max(1, Math.min(limit, 200))
    const baseQuery =
      beforeSeq > 0
        ? this.db
            .select()
            .from(messages)
            .where(and(eq(messages.conversationId, conv.id), lt(messages.seq, beforeSeq)))
        : this.db.select().from(messages).where(eq(messages.conversationId, conv.id))
    const rows = baseQuery
      .orderBy(desc(messages.seq))
      .limit(cap + 1)
      .all()
    const hasMore = rows.length > cap
    const sliced = hasMore ? rows.slice(0, cap) : rows
    return {
      conversationId: conv.id,
      entries: sliced.reverse(),
      hasMore,
    }
  }

  /**
   * Append one message. Monotonic seq is assigned in the same transaction.
   * Idempotent on `clientMsgId` — duplicate sends across reconnect/restart
   * return the existing row without inserting or emitting. Emits `append`
   * after commit.
   */
  appendTurn(conversationId: string, entry: AppendEntry): Message {
    const now = new Date().toISOString()
    const defaultStatus = entry.status ?? (entry.role === 'user' ? 'pending' : 'completed')

    const txResult = this.db.transaction((tx) => {
      const conv = tx.select().from(conversations).where(eq(conversations.id, conversationId)).get()
      if (!conv) {
        throw new Error(`ConversationStore.appendTurn: conversation ${conversationId} not found`)
      }
      if (conv.archivedAt) {
        // Rows written to an archived conversation are invisible to getWindow.
        throw new Error(
          `ConversationStore.appendTurn: conversation ${conversationId} is archived (scope=${conv.scope})`,
        )
      }

      // Idempotency check on clientMsgId (persistent, survives restart).
      if (entry.clientMsgId) {
        const existing = tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.clientMsgId, entry.clientMsgId),
            ),
          )
          .get()
        if (existing) return { row: existing, scope: conv.scope, deduped: true }
      }

      const { maxSeq } = tx
        .select({ maxSeq: max(messages.seq) })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .get() ?? { maxSeq: null }

      const nextSeq = (maxSeq ?? 0) + 1

      const inserted = tx
        .insert(messages)
        .values({
          conversationId,
          seq: nextSeq,
          role: entry.role,
          text: entry.text,
          turnMode: entry.turnMode ?? null,
          source: entry.source ?? null,
          toolCallsJson: entry.toolCalls === undefined ? null : JSON.stringify(entry.toolCalls),
          clientMsgId: entry.clientMsgId ?? null,
          status: defaultStatus,
          failureReason: entry.failureReason ?? null,
          // Only user rows carry origin attribution. Assistant/system rows
          // leave NULL so sibling suppression logic doesn't self-match on an
          // echoed server-generated row.
          originDeviceId: entry.role === 'user' ? (entry.originDeviceId ?? null) : null,
        })
        .returning()
        .get()

      // sdk_bound_at is stamped by bindSdkSession() when the adapter emits
      // sessionBound — not here. Only bump lastActiveAt on row inserts.
      tx.update(conversations)
        .set({ lastActiveAt: now })
        .where(eq(conversations.id, conversationId))
        .run()
      return { row: inserted, scope: conv.scope, deduped: false }
    })

    if (txResult.deduped) {
      return txResult.row // original append already fired; don't re-broadcast
    }

    this.emit('append', {
      scope: txResult.scope,
      conversationId,
      row: txResult.row,
    })
    return txResult.row
  }

  /**
   * Mark a user row as `running` (adapter accepted the turn). Broadcast via
   * `update` so multi-client subscribers see the "thinking" state.
   */
  markTurnRunning(userMessageId: string): void {
    this.transitionTurn(userMessageId, 'running', null)
  }

  /**
   * Stamp the SDK session UUID + backend. Four cases via a single SQL OR:
   * 1. Legacy row (`sdk_backend IS NULL`) — write all columns.
   * 2. Same backend, first bind (`sdk_session_id IS NULL`) — write session id.
   * 3. Same backend, already bound — no-op (write-once).
   * 4. Different backend — overwrite both (stored id is for the wrong SDK).
   */
  bindSdkSession(conversationId: string, sdkSessionId: string, backend: string): void {
    const now = new Date().toISOString()
    this.db
      .update(conversations)
      .set({ sdkSessionId, sdkBackend: backend, sdkBoundAt: now, lastActiveAt: now })
      .where(
        and(
          eq(conversations.id, conversationId),
          or(
            // Case 1: legacy row, no backend recorded yet.
            isNull(conversations.sdkBackend),
            // Case 2: same backend, first bind (write-once gate).
            and(eq(conversations.sdkBackend, backend), isNull(conversations.sdkSessionId)),
            // Case 4: different backend — stored id is for the wrong SDK.
            ne(conversations.sdkBackend, backend),
          ),
        ),
      )
      .run()
  }

  /**
   * Mark a user row as `completed` (assistant row has landed). Called by the
   * turn runner alongside appending the assistant row.
   */
  markTurnCompleted(userMessageId: string): void {
    this.transitionTurn(userMessageId, 'completed', null)
  }

  /**
   * Terminal failure: flip user-row status + append a synthetic assistant row.
   * Status mapping: 'sdk_timeout'/'sdk_stream_stalled' → 'timed_out',
   * 'aborted' → 'aborted', 'server_interrupted'/'internal_error' → 'failed'.
   *
   * Silent on already-archived conversations (the /reset flow can archive
   * after abort). Status flip still persists for forensics; synthetic row
   * is skipped to avoid throwing on an archived conversation.
   */
  markTurnFailed(userMessageId: string, reason: FailureReason): void {
    const status = failureReasonToStatus(reason)
    const userRow = this.transitionTurn(userMessageId, status, reason)
    // Skip synthetic row if the conv is already archived (see doc comment).
    const conv = this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, userRow.conversationId))
      .get()
    if (!conv || conv.archivedAt) return
    this.appendTurn(userRow.conversationId, {
      role: 'assistant',
      text: syntheticFailureText(reason),
      turnMode: userRow.turnMode ?? 'direct_user_chat',
    })
  }

  /**
   * Crash-recovery sweep: flip any pending/running user row to
   * `failed:server_interrupted` with a synthetic assistant follow-up.
   * Called once at startup before the WS listener accepts connections.
   */
  recoverOrphans(): { recovered: number } {
    const orphans = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.role, 'user'), inArray(messages.status, ['pending', 'running'])))
      .all()
    for (const orphan of orphans) {
      this.markTurnFailed(orphan.id, 'server_interrupted')
    }
    return { recovered: orphans.length }
  }

  /**
   * Shared transition path for markTurn{Running,Completed,Failed}. Skips
   * the `update` emit on archived conversations — status flip still persists,
   * but no client is viewing an archived scope.
   */
  private transitionTurn(
    userMessageId: string,
    status: 'running' | 'completed' | 'failed' | 'timed_out' | 'aborted',
    failureReason: FailureReason | null,
  ): Message {
    const now = new Date().toISOString()
    const { row, scope, archived } = this.db.transaction((tx) => {
      const existing = tx.select().from(messages).where(eq(messages.id, userMessageId)).get()
      if (!existing) {
        throw new Error(`ConversationStore.transitionTurn: message ${userMessageId} not found`)
      }
      if (existing.role !== 'user') {
        throw new Error(
          `ConversationStore.transitionTurn: message ${userMessageId} is role=${existing.role}, not user`,
        )
      }
      const updated = tx
        .update(messages)
        .set({ status, failureReason })
        .where(eq(messages.id, userMessageId))
        .returning()
        .get()

      const conv = tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, existing.conversationId))
        .get()
      tx.update(conversations)
        .set({ lastActiveAt: now })
        .where(eq(conversations.id, existing.conversationId))
        .run()
      return {
        row: updated,
        scope: conv?.scope ?? '',
        archived: conv?.archivedAt != null,
      }
    })

    if (scope && !archived) {
      this.emit('update', { scope, conversationId: row.conversationId, row })
    }
    return row
  }

  /**
   * Archive the active (scope, kind) conversation and insert a fresh one.
   * Messages and the archived row's id are preserved. For kind='dev', pass
   * `draftId` so the fresh row keeps the draft link that routing and reconnect
   * replay rely on.
   */
  reset(scope: string, kind: 'chat' | 'dev' = 'chat', draftId?: string): ResetResult {
    const now = new Date().toISOString()
    const result = this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.scope, scope),
            eq(conversations.kind, kind),
            isNull(conversations.archivedAt),
          ),
        )
        .get()

      let archived: Conversation | null = null
      if (current) {
        tx.update(conversations)
          .set({ archivedAt: now, lastActiveAt: now })
          .where(eq(conversations.id, current.id))
          .run()
        archived = { ...current, archivedAt: now, lastActiveAt: now }
      }

      const fresh = tx
        .insert(conversations)
        .values({ scope, kind, draftId: draftId ?? null })
        .returning()
        .get()
      return { archived, fresh }
    })

    this.emit('reset', { scope, newConversationId: result.fresh.id, kind })
    return result
  }

  /**
   * Archive a single conversation without inserting a replacement — used when
   * a draft's dev conversation ends (Promote/Discard). Idempotent.
   */
  archive(conversationId: string): void {
    const now = new Date().toISOString()
    const conv = this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conv || conv.archivedAt) return
    this.db
      .update(conversations)
      .set({ archivedAt: now, lastActiveAt: now })
      .where(eq(conversations.id, conversationId))
      .run()
  }

  /**
   * Return non-archived conversation ids for `app:<appId>`, across all kinds.
   * Used by the eviction sweep; in practice at most two (one chat, one dev).
   */
  activeConversationIdsForApp(appId: string): string[] {
    const scope = `app:${appId}`
    const rows = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.scope, scope), isNull(conversations.archivedAt)))
      .all()
    return rows.map((r) => r.id)
  }

  /** Escape hatch for adapter / telemetry — don't use for business logic. */
  getById(conversationId: string): Conversation | undefined {
    return this.db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  }

  /**
   * Return the active kind='dev' conversation whose `draft_id` matches, or
   * undefined if none exists. Used by the routing layer to deliver an
   * incoming dev-chat message to the correct edit-agent instance.
   */
  findDevConversationByDraft(draftId: string): Conversation | undefined {
    return this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.kind, 'dev'),
          eq(conversations.draftId, draftId),
          isNull(conversations.archivedAt),
        ),
      )
      .get()
  }

  /**
   * Drop archived conversations (and their messages) older than `days`.
   * Throws if `days <= 0`. Used by the periodic maintenance loop and `db purge`.
   */
  purgeArchivedOlderThan(days: number): { conversationsDeleted: number; messagesDeleted: number } {
    return purgeArchivedConversations(this.db, days)
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  /**
   * Upsert a device row on every ClientHello. On existing rows, updates cached
   * metadata + `last_seen_at` but never overwrites `last_active_app`/`last_active_face`
   * (those belong to `setDeviceFocus`). `initialApp`/`initialFace` seed focus
   * only at insert time for clients that still send `ClientHello.currentAppId`.
   */
  upsertDevice(args: {
    deviceId: string
    deviceClass?: number
    deviceProfileWidth?: number
    deviceProfileHeight?: number
    userAgent?: string
    initialApp?: string
    initialFace?: string | null
  }): void {
    const now = new Date().toISOString()
    const existing = this.db.select().from(devices).where(eq(devices.deviceId, args.deviceId)).get()
    if (existing) {
      this.db
        .update(devices)
        .set({
          deviceClass: args.deviceClass ?? existing.deviceClass,
          deviceProfileWidth: args.deviceProfileWidth ?? existing.deviceProfileWidth,
          deviceProfileHeight: args.deviceProfileHeight ?? existing.deviceProfileHeight,
          deviceUa: args.userAgent ?? existing.deviceUa,
          lastSeenAt: now,
        })
        .where(eq(devices.deviceId, args.deviceId))
        .run()
      return
    }
    this.db
      .insert(devices)
      .values({
        deviceId: args.deviceId,
        lastActiveApp: args.initialApp ?? 'home',
        lastActiveFace: args.initialFace ?? null,
        deviceClass: args.deviceClass ?? null,
        deviceProfileWidth: args.deviceProfileWidth ?? null,
        deviceProfileHeight: args.deviceProfileHeight ?? null,
        deviceUa: args.userAgent ?? null,
        deviceLabel: null,
        lastSeenAt: now,
        createdAt: now,
      })
      .run()
  }

  getDevice(deviceId: string): Device | undefined {
    return this.db.select().from(devices).where(eq(devices.deviceId, deviceId)).get()
  }

  /**
   * Server-SSOT write for device active view. Upserts to handle the edge case
   * where focus is set before the device's first ClientHello.
   */
  setDeviceFocus(deviceId: string, appId: string, faceId: string | null = null): void {
    const now = new Date().toISOString()
    const existing = this.db.select().from(devices).where(eq(devices.deviceId, deviceId)).get()
    if (existing) {
      this.db
        .update(devices)
        .set({ lastActiveApp: appId, lastActiveFace: faceId, lastSeenAt: now })
        .where(eq(devices.deviceId, deviceId))
        .run()
    } else {
      this.db
        .insert(devices)
        .values({
          deviceId,
          lastActiveApp: appId,
          lastActiveFace: faceId,
          lastSeenAt: now,
          createdAt: now,
        })
        .run()
    }
  }

  // --- Pairing (device allowlist) ---------------------------------------
  //
  // The deviceId itself is the credential (a 122-bit random UUIDv4). Approving
  // flips `paired`; the handshake gate (transport) reads `isDevicePaired` and
  // rejects unpaired devices when `pairingRequired` is on. The CLI `device`
  // commands drive `setDevicePaired` / `renameDevice` / `forgetDevice`.

  /** True only if the device exists and is approved. Unknown device → false. */
  isDevicePaired(deviceId: string): boolean {
    const row = this.db
      .select({ paired: devices.paired })
      .from(devices)
      .where(eq(devices.deviceId, deviceId))
      .get()
    return row?.paired ?? false
  }

  /**
   * Approve or revoke a device. Upserts so a deviceId can be approved before
   * its first connect. `label` is applied when provided. `pairedAt` is stamped
   * on first approval and cleared on revoke. Returns false when revoking an
   * unknown device.
   */
  setDevicePaired(deviceId: string, paired: boolean, label?: string): boolean {
    const now = new Date().toISOString()
    const existing = this.db.select().from(devices).where(eq(devices.deviceId, deviceId)).get()
    if (existing) {
      this.db
        .update(devices)
        .set({
          paired,
          pairedAt: paired ? (existing.pairedAt ?? now) : null,
          ...(label !== undefined ? { deviceLabel: label } : {}),
        })
        .where(eq(devices.deviceId, deviceId))
        .run()
      return true
    }
    if (!paired) return false
    this.db
      .insert(devices)
      .values({
        deviceId,
        paired: true,
        pairedAt: now,
        deviceLabel: label ?? null,
        lastSeenAt: now,
        createdAt: now,
      })
      .run()
    return true
  }

  /** Set the display label (works in any pairing state). False if not found. */
  renameDevice(deviceId: string, label: string): boolean {
    const r = this.db
      .update(devices)
      .set({ deviceLabel: label })
      .where(eq(devices.deviceId, deviceId))
      .run()
    return (r.changes ?? 0) > 0
  }

  /** Delete the device row. Later reconnect is treated as brand-new. `messages.origin_device_id` is a soft reference; historical chat rows are unaffected. False if absent. */
  forgetDevice(deviceId: string): boolean {
    const r = this.db.delete(devices).where(eq(devices.deviceId, deviceId)).run()
    return (r.changes ?? 0) > 0
  }

  /**
   * Bulk-delete device rows for `device prune`. Returns the number deleted.
   *  - `all`: wipe every device row (re-pair survivors afterward).
   *  - `unpaired`: delete pending (paired=false) rows.
   *  - `olderThanDays`: delete rows not seen within N days.
   * `unpaired` + `olderThanDays` together delete the union (unpaired OR stale).
   * With no option set, deletes nothing (returns 0).
   */
  pruneDevices(opts: { all?: boolean; unpaired?: boolean; olderThanDays?: number }): number {
    if (opts.all) {
      return this.db.delete(devices).run().changes ?? 0
    }
    const conds = []
    if (opts.unpaired) conds.push(eq(devices.paired, false))
    if (opts.olderThanDays != null) {
      const cutoff = new Date(Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000).toISOString()
      conds.push(lt(devices.lastSeenAt, cutoff))
    }
    if (conds.length === 0) return 0
    const where = conds.length === 1 ? conds[0] : or(...conds)
    return this.db.delete(devices).where(where).run().changes ?? 0
  }

  /**
   * All devices for `device list`, newest-seen first. By default hides unpaired
   * rows not seen in the last 24h (avoids scanner noise). Paired devices are
   * always shown. `includeOldPending` shows everything.
   */
  listDevices(opts: { includeOldPending?: boolean } = {}): Device[] {
    const rows = this.db.select().from(devices).orderBy(desc(devices.lastSeenAt)).all()
    if (opts.includeOldPending) return rows
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    return rows.filter((d) => d.paired || d.lastSeenAt >= cutoff)
  }
}

function failureReasonToStatus(reason: FailureReason): 'failed' | 'timed_out' | 'aborted' {
  switch (reason) {
    case 'sdk_timeout':
    case 'sdk_stream_stalled':
      return 'timed_out'
    case 'aborted':
      return 'aborted'
    case 'server_interrupted':
    case 'internal_error':
      return 'failed'
  }
}

function syntheticFailureText(reason: FailureReason): string {
  switch (reason) {
    case 'sdk_timeout':
    case 'sdk_stream_stalled':
      return '(timed out)'
    case 'aborted':
      return '(aborted)'
    case 'server_interrupted':
      return '(server interrupted)'
    case 'internal_error':
      return '(internal error)'
  }
}
