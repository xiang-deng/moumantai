/**
 * Platform DB schema — persistent chat and conversation binding.
 *
 * At most one active conversation per (scope, kind) pair, enforced by a
 * partial unique index on `(scope, kind) WHERE archived_at IS NULL`. This
 * allows one 'chat' and one 'dev' conversation per scope simultaneously.
 *
 * SDK session binding: `sdk_session_id` + `sdk_backend` are decoupled from
 * `conversations.id` because the SDK rejects reuse of a session id once
 * metadata is written, and sessions are not portable across backends.
 * See `conversations/store.ts` (`bindSdkSession`).
 */

import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { id, timestamps } from '../db/conventions.js'

export const conversations = sqliteTable(
  'conversations',
  {
    ...id(),
    scope: text('scope').notNull(),
    /**
     * Conversation kind. 'chat' is the normal user-facing conversation;
     * 'dev' is a coding-agent draft session driven by an edit-agent.
     * The composite unique index allows one active 'chat' AND one active
     * 'dev' conversation per scope simultaneously.
     */
    kind: text('kind', { enum: ['chat', 'dev'] })
      .notNull()
      .default('chat'),
    /**
     * Links a kind='dev' conversation to its pending draft. Populated at
     * create time for dev conversations so the routing layer can map an
     * incoming dev-chat message to the correct edit-agent instance without
     * an extra lookup. Null for kind='chat' conversations.
     */
    draftId: text('draft_id'),
    /**
     * ISO-8601, stamped on the first successful assistant-row append. Null
     * means no usable SDK session yet; the next turn must create rather than
     * resume. Aborted or failed first turns leave this null.
     */
    sdkBoundAt: text('sdk_bound_at'),
    /**
     * UUID the SDK uses for this conversation's jsonl. Decoupled from
     * `conversations.id` because the SDK rejects reuse of a session id once
     * metadata is written. Stamped alongside `sdkBoundAt` on first assistant
     * row; subsequent turns resume via this id.
     */
    sdkSessionId: text('sdk_session_id'),
    /**
     * Which LLM backend produced `sdk_session_id` ('claude' | 'pi'). When
     * `config.backend` differs, the adapter mints a fresh session and overwrites
     * both columns — sessions are not portable across backends. Existing rows
     * are backfilled with 'claude' by migration.
     */
    sdkBackend: text('sdk_backend'),
    /** ISO-8601 set on reset; never cleared. Archived rows are never deleted. */
    archivedAt: text('archived_at'),
    lastActiveAt: text('last_active_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
      .$onUpdate(() => new Date().toISOString()),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // One active conversation per (scope, kind). Archived rows are exempt.
    // Allows simultaneous active 'chat' and 'dev' conversations for the same scope.
    uniqueIndex('conversations_scope_kind_active_unique')
      .on(t.scope, t.kind)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
)

export const messages = sqliteTable(
  'messages',
  {
    ...id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    /** Monotonic per conversation. Assigned in the same txn as the insert. */
    seq: integer('seq').notNull(),
    /** 'user' | 'assistant' | 'system' */
    role: text('role').notNull(),
    text: text('text').notNull(),
    /** 'direct_user_chat' | 'delegated_from_home' | null (system rows). */
    turnMode: text('turn_mode'),
    /** 'home' for delegated entries in a target app's log; null otherwise. */
    source: text('source'),
    /** JSON-serialized tool_calls; only populated for assistant rows. */
    toolCallsJson: text('tool_calls_json'),
    /**
     * Client-generated idempotency key on the outbound `chatInput`. Persisted so
     * a retry of the same clientMsgId across reconnect/restart is a DB-level
     * no-op (partial unique index), and so reconnecting clients can reconcile
     * their optimistic bubble against the server's authoritative row.
     *
     * Null for server-originated rows (assistant, system, delegated-app-echo).
     */
    clientMsgId: text('client_msg_id'),
    /**
     * Turn lifecycle: 'pending' → 'running' → 'completed' | 'failed' |
     * 'timed_out' | 'aborted'. Assistant/system rows are always 'completed'.
     * Stored on the user row (one row = one turn); clients derive all
     * "thinking" state from this, never a local flag.
     */
    status: text('status').notNull().default('completed'),
    /**
     * Short tag populated when status is failed/timed_out/aborted:
     * 'sdk_timeout' | 'sdk_stream_stalled' | 'server_interrupted' |
     * 'internal_error' | 'aborted'. Null otherwise.
     */
    failureReason: text('failure_reason'),
    /**
     * Stable deviceId of the originating device. Survives reconnect, server
     * restart. Populated only on user rows; assistant/system rows leave NULL.
     * Set by `appendTurn` from the originating connection's deviceId.
     */
    originDeviceId: text('origin_device_id'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('messages_conversation_seq_unique').on(t.conversationId, t.seq),
    // Partial unique: dedups idempotent retries of the same chatInput across
    // reconnect/restart. Scoped to (conversation_id, client_msg_id) — matches
    // the per-conversation dedup check in ConversationStore.appendTurn so two
    // conversations can coincidentally share a clientMsgId without colliding.
    // Null values are excluded (server-originated rows carry no clientMsgId).
    uniqueIndex('messages_conv_client_msg_id_unique')
      .on(t.conversationId, t.clientMsgId)
      .where(sql`${t.clientMsgId} IS NOT NULL`),
  ],
)

/**
 * Per-conversation, per-app, per-face view-state. Upserted by `view_<faceId>`;
 * `{}` resets to defaults. Swept on `paramsVersion` mismatch at boot/reload;
 * lazily dropped on schema validation failure; bulk-deleted on app uninstall.
 *
 * No `onDelete: cascade` — `PRAGMA foreign_keys` defaults OFF; conversation
 * rows are archived rather than deleted.
 */
export const faceParams = sqliteTable(
  'face_params',
  {
    ...id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    appId: text('app_id').notNull(),
    faceId: text('face_id').notNull(),
    /** JSON-serialized params object; `{}` means reset to defaults. */
    params: text('params').notNull(),
    paramsVersion: integer('params_version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [uniqueIndex('face_params_conv_app_face_unique').on(t.conversationId, t.appId, t.faceId)],
)

/**
 * Dedup table for client-initiated tool invocations. Keyed
 * `(conversation_id, client_request_id)` — a duplicate invocation (offline
 * replay, retry, double-tap) is a no-op and reuses the cached result.
 * Survives restart; a background sweep prunes rows older than 24h.
 */
export const invokeDedup = sqliteTable(
  'invoke_dedup',
  {
    conversationId: text('conversation_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    /** JSON-serialized tool result snapshot returned to the deduped retry. */
    resultJson: text('result_json'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('invoke_dedup_conv_req_unique').on(t.conversationId, t.clientRequestId),
    // Backs the TTL sweep's `created_at < cutoff` delete.
    index('invoke_dedup_created_at_idx').on(t.createdAt),
  ],
)

/**
 * Per-device durable identity and active-view SSOT.
 *
 * Each device generates a UUIDv4 on first launch; every `ClientHello` carries
 * it. The server upserts this row on every connect. `setDeviceFocus` writes
 * here; reconnect bootstrap reads from here. Profile dimensions are cached so
 * the server can classify a device (sizeClass etc.) while it's offline.
 * `messages.origin_device_id` is a soft reference (no FK).
 */
export const devices = sqliteTable('devices', {
  /** UUIDv4 generated client-side, stable across reconnects. */
  deviceId: text('device_id').primaryKey(),
  /**
   * Active scope's app id ('home' | '<plugin-app-id>'). Server-SSOT for the
   * device's UI focus. Updated on every `viewing` (and on `chatInput` as a
   * safety net). Read on (re)connect to drive the bootstrap snapshot.
   */
  lastActiveApp: text('last_active_app').notNull().default('home'),
  /** Optional active-face hint within `last_active_app`. Null = first face. */
  lastActiveFace: text('last_active_face'),
  /** Cached `DeviceClass` enum value from the latest `ClientHello`. */
  deviceClass: integer('device_class'),
  /** Cached width from `DeviceProfile`. Used for sizeClass classification. */
  deviceProfileWidth: integer('device_profile_width'),
  /** Cached height from `DeviceProfile`. */
  deviceProfileHeight: integer('device_profile_height'),
  /**
   * User-friendly display name ("Kitchen panel"). Set on `device approve
   * --name` and `device rename` via the CLI; shown in `device list`.
   */
  deviceLabel: text('device_label'),
  /**
   * Pairing allowlist flag. When `pairingRequired` is on, only paired devices
   * get a session; unpaired devices are rejected with `CLOSE_CODE_PAIRING_REQUIRED`.
   * The deviceId (122-bit random UUIDv4) is the credential — approving just flips
   * this flag. The introducing migration grandfathers existing rows to true so
   * upgrades don't lock devices out.
   */
  paired: integer('paired', { mode: 'boolean' }).notNull().default(false),
  /** ISO-8601 of when this device was paired (approved). Null while pending. */
  pairedAt: text('paired_at'),
  /**
   * User-Agent from the WebSocket handshake of the latest connect. Browsers
   * send a rich string ("...iPhone...Safari"); native clients send coarse ones
   * (okhttp, esp-idf). Shown in `device list` to help tell devices apart; not
   * a trust signal.
   */
  deviceUa: text('device_ua'),
  /** ISO-8601 of the most recent `ClientHello` from this device. */
  lastSeenAt: text('last_seen_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdate(() => new Date().toISOString()),
  /** ISO-8601 first-seen. */
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
})

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type FaceParams = typeof faceParams.$inferSelect
export type NewFaceParams = typeof faceParams.$inferInsert
export type InvokeDedup = typeof invokeDedup.$inferSelect
export type NewInvokeDedup = typeof invokeDedup.$inferInsert
export type Device = typeof devices.$inferSelect
export type NewDevice = typeof devices.$inferInsert
