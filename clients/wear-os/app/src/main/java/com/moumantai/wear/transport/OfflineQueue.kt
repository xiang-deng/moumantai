package com.moumantai.wear.transport

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import java.io.File

/**
 * Persistent FIFO queue for user-originated messages lost before the transport
 * delivered them. Mirrors Android's `OfflineQueue` in semantics but stores metadata
 * in Preferences DataStore (JSON list under a single key); voice blobs stay in
 * `filesDir/offline-voice/` to keep DataStore reads small.
 *
 * Tighter caps than Android: 16 total entries, 2 voice utterances (watch storage/battery).
 * Overflow drops the oldest FIFO. Each item carries a stable [Item.clientMsgId] for
 * server-side dedup on replay.
 */
class OfflineQueue internal constructor(
    private val dataStore: DataStore<Preferences>,
    private val filesDir: File,
) {
    /** Production constructor — uses a DataStore rooted under this process's private files. */
    constructor(context: Context) : this(
        dataStore = context.offlineQueueDataStore,
        filesDir = context.applicationContext.filesDir,
    )

    private val voiceDir = File(filesDir, VOICE_DIR_NAME).also { it.mkdirs() }
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    @Serializable
    data class Item(
        /** Stable id across retries for server dedup: `clientMsgId` (text/voice) or
         *  `clientRequestId` (invoke_tool via the `invoke_dedup` table). */
        val clientMsgId: String,
        val scope: String,
        /** "text" | "voice" | "invoke_tool". */
        val kind: String,
        /** For kind=="text". */
        val text: String? = null,
        /** For kind=="voice": path under [voiceDir] relative to filesDir. */
        val voiceBlobPath: String? = null,
        val sampleRate: Int = 16000,
        val format: String = "pcm16",
        /** Unix ms. */
        val enqueuedAt: Long,
        /** Conversation id at enqueue time. Sent as `originConversationId` on drain;
         *  server rejects if another device advanced the conversation during the outage.
         *  Null for items persisted before this field existed (drain without staleness check). */
        val originConversationId: String? = null,
        /** For kind=="invoke_tool": tool name to dispatch. */
        val toolName: String? = null,
        /** For kind=="invoke_tool": JSON-encoded args (string, not JsonElement, to avoid
         *  kotlinx.serialization polymorphism issues with Map<String, Any?>). */
        val argsJson: String? = null,
        /** For kind=="invoke_tool": face id the action originated from. */
        val sourceFaceId: String? = null,
    )

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Enqueue a text message for later replay. [clientMsgId] MUST be stable
     * across retries — the server deduplicates on reconnect using it.
     */
    suspend fun enqueueText(
        scope: String,
        text: String,
        clientMsgId: String,
        originConversationId: String? = null,
    ): Item {
        val item = Item(
            clientMsgId = clientMsgId,
            scope = scope,
            kind = "text",
            text = text,
            enqueuedAt = System.currentTimeMillis(),
            originConversationId = originConversationId,
        )
        update { list -> (list + item).trimToCap() }
        return item
    }

    /**
     * Persist a completed voice utterance. Caller supplies the raw PCM
     * bytes; they are written to disk so the DataStore payload stays small.
     * Returns null if the blob couldn't be written.
     */
    suspend fun enqueueVoice(
        scope: String,
        clientMsgId: String,
        pcm: ByteArray,
        sampleRate: Int = 16000,
        originConversationId: String? = null,
    ): Item? {
        val blob = File(voiceDir, "$clientMsgId.pcm")
        try {
            blob.writeBytes(pcm)
        } catch (_: Throwable) {
            return null
        }
        val item = Item(
            clientMsgId = clientMsgId,
            scope = scope,
            kind = "voice",
            voiceBlobPath = "$VOICE_DIR_NAME/${blob.name}",
            sampleRate = sampleRate,
            enqueuedAt = System.currentTimeMillis(),
            originConversationId = originConversationId,
        )
        update { list ->
            // Bound voice utterances separately — they're far heavier than
            // text. Drop the oldest voice entry when we'd exceed [MAX_VOICE].
            val voices = list.filter { it.kind == "voice" }
            val trimmed = if (voices.size >= MAX_VOICE) {
                val oldest = voices.first()
                deleteBlob(oldest)
                list.filterNot { it.clientMsgId == oldest.clientMsgId }
            } else {
                list
            }
            (trimmed + item).trimToCap()
        }
        return item
    }

    /**
     * Read the raw PCM bytes for a queued voice [item], or null if the
     * blob has been deleted / is unreadable.
     */
    fun readVoiceBlob(item: Item): ByteArray? {
        val rel = item.voiceBlobPath ?: return null
        return try {
            File(filesDir, rel).readBytes()
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Persist a UI-driven tool invocation that didn't make it onto the wire
     * before the socket dropped. Same dedup semantics as text: the server
     * `invoke_dedup` table keys on (conversation_id, client_request_id) so
     * replays-after-server-restart are also safe.
     */
    suspend fun enqueueInvokeTool(
        scope: String,
        toolName: String,
        args: Map<String, Any?>?,
        sourceFaceId: String,
        clientRequestId: String,
        originConversationId: String? = null,
    ): Item {
        val item = Item(
            clientMsgId = clientRequestId,
            scope = scope,
            kind = "invoke_tool",
            enqueuedAt = System.currentTimeMillis(),
            originConversationId = originConversationId,
            toolName = toolName,
            argsJson = if (args != null) json.encodeToString(JsonElement.serializer(), args.toJsonElement()) else null,
            sourceFaceId = sourceFaceId,
        )
        update { list -> (list + item).trimToCap() }
        return item
    }

    /**
     * Decode an invoke-tool item's `argsJson` back into a `Map<String, Any?>`
     * suitable for `Transport.sendInvokeTool`. Returns null if the item isn't
     * an invoke_tool (or has no args).
     */
    fun readInvokeToolArgs(item: Item): Map<String, Any?>? {
        val raw = item.argsJson ?: return null
        return try {
            val element = json.parseToJsonElement(raw)
            (element.toAnyOrNull() as? Map<String, Any?>) ?: emptyMap()
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Drain queued items FIFO through [transport]; stop on first failure to preserve order.
     * Remaining items stay queued for the next connect. Items older than [EXPIRY_MS] are
     * dropped silently. No-op when the queue is empty.
     */
    suspend fun flushOnConnect(transport: Transport) {
        val snapshot = peek()
        if (snapshot.isEmpty()) return

        val remaining = snapshot.toMutableList()
        val now = System.currentTimeMillis()

        for (item in snapshot) {
            if (now - item.enqueuedAt > EXPIRY_MS) {
                remaining.remove(item)
                if (item.kind == "voice") deleteBlob(item)
                continue
            }
            val ok = try {
                send(transport, item)
            } catch (_: Throwable) {
                false
            }
            if (ok) {
                remaining.remove(item)
                if (item.kind == "voice") deleteBlob(item)
            } else {
                // Preserve order: stop on the first failure and retry on
                // the next connect.
                break
            }
        }

        update { remaining }
    }

    /**
     * Drop queued items whose [Item.originConversationId] is non-null and
     * disagrees with [currentConversationId] for [scope]. Items predating
     * this field (originConversationId == null) are left intact and rely on
     * the server's per-message stale check.
     *
     * Called whenever the client receives an authoritative `chatWindow` for
     * [scope] — that frame carries the current conversation id and is the
     * canonical signal that prior queued content may be obsolete (e.g.,
     * server-side `/reset` or DB wipe). Returns the number of items
     * dropped, for logging / telemetry.
     */
    suspend fun pruneStale(scope: String, currentConversationId: String): Int {
        if (currentConversationId.isEmpty()) return 0
        var dropped = 0
        update { list ->
            val (toKeep, toDrop) = list.partition { item ->
                item.scope != scope ||
                    item.originConversationId == null ||
                    item.originConversationId == currentConversationId
            }
            toDrop.forEach { if (it.kind == "voice") deleteBlob(it) }
            dropped = toDrop.size
            toKeep
        }
        return dropped
    }

    /** Snapshot for tests / settings UI. */
    suspend fun peek(): List<Item> {
        val raw = dataStore.data.first()[KEY_QUEUE] ?: return emptyList()
        return decode(raw)
    }

    /** Wipe the queue and delete all voice blobs. */
    suspend fun clear() {
        val current = peek()
        current.forEach { if (it.kind == "voice") deleteBlob(it) }
        dataStore.edit { it.remove(KEY_QUEUE) }
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    private fun send(transport: Transport, item: Item): Boolean {
        return when (item.kind) {
            "text" -> {
                val text = item.text ?: return true // corrupt entry — drop
                // Pass the enqueue-time conv id through so the server can
                // reject drains whose conversation advanced during the
                // outage (`stale_conversation`).
                transport.sendChatInput(
                    item.scope,
                    text,
                    clientMsgId = item.clientMsgId,
                    originConversationId = item.originConversationId,
                )
                true
            }
            "voice" -> {
                val pcm = readVoiceBlob(item) ?: return true
                transport.sendAudioInput(
                    data = pcm,
                    format = item.format,
                    sampleRate = item.sampleRate,
                    final = true,
                    scope = item.scope,
                    clientMsgId = item.clientMsgId,
                )
                true
            }
            "invoke_tool" -> {
                // Replay with the SAME client_request_id so the server's
                // invoke_dedup table short-circuits if the tool already ran
                // (e.g. socket dropped after server processed but before client
                // got the ack). Args reconstituted from the persisted JSON.
                val toolName = item.toolName ?: return true
                val faceId = item.sourceFaceId ?: ""
                val args = readInvokeToolArgs(item)
                transport.sendInvokeTool(
                    toolName = toolName,
                    args = args,
                    sourceFaceId = faceId,
                    clientRequestId = item.clientMsgId,
                )
                true
            }
            else -> true // unknown kind, drop silently
        }
    }

    private suspend fun update(transform: (List<Item>) -> List<Item>) {
        dataStore.edit { prefs ->
            val current = prefs[KEY_QUEUE]?.let { decode(it) } ?: emptyList()
            val next = transform(current)
            prefs[KEY_QUEUE] = encode(next)
        }
    }

    private fun decode(raw: String): List<Item> = try {
        json.decodeFromString<List<Item>>(raw)
    } catch (_: Throwable) {
        emptyList()
    }

    private fun encode(list: List<Item>): String = json.encodeToString(list)

    private fun deleteBlob(item: Item) {
        val rel = item.voiceBlobPath ?: return
        try {
            File(filesDir, rel).delete()
        } catch (_: Throwable) { /* best effort */ }
    }

    /** Enforce [MAX_ITEMS], dropping oldest FIFO. Deletes voice blobs for dropped entries. */
    private fun List<Item>.trimToCap(): List<Item> {
        if (size <= MAX_ITEMS) return this
        val dropped = dropLast(MAX_ITEMS) // everything *before* the tail
        dropped.forEach { if (it.kind == "voice") deleteBlob(it) }
        return takeLast(MAX_ITEMS)
    }

    companion object {
        private const val VOICE_DIR_NAME = "offline-voice"

        /** Max total queued items. Tighter than Android's 20 — watch storage budget. */
        private const val MAX_ITEMS = 16

        /** Cap on voice utterances to bound disk usage. Android allows 3. */
        private const val MAX_VOICE = 2

        /** Items older than 24h are dropped silently on drain. */
        private const val EXPIRY_MS = 24L * 60 * 60 * 1000

        private val KEY_QUEUE = stringPreferencesKey("offline_queue_v1")
    }
}

/**
 * DataStore dedicated to the offline queue. Separate from the settings DataStore
 * so their different write cadences don't contend on the same WAL file.
 */
val Context.offlineQueueDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "offline_queue",
)

// ---------------------------------------------------------------------------
// JsonElement <-> Map<String, Any?> helpers (kotlinx.serialization can't
// serialize Map<String, Any?> directly). Keep in sync with Android's OfflineQueue.kt.
// ---------------------------------------------------------------------------

private fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is String -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(
        entries.associate { (k, v) ->
            (k?.toString() ?: "") to v.toJsonElement()
        },
    )
    is Iterable<*> -> JsonArray(map { it.toJsonElement() })
    is Array<*> -> JsonArray(map { it.toJsonElement() })
    else -> JsonPrimitive(toString())
}

private fun JsonElement.toAnyOrNull(): Any? = when (this) {
    is JsonNull -> null
    is JsonPrimitive -> when {
        booleanOrNull != null -> boolean
        contentOrNull?.toLongOrNull() != null -> content.toLong()
        doubleOrNull != null -> double
        isString -> content
        else -> contentOrNull
    }
    is JsonObject -> entries.associate { (k, v): Map.Entry<String, JsonElement> -> k to v.toAnyOrNull() }
    is JsonArray -> map { it.toAnyOrNull() }
}
