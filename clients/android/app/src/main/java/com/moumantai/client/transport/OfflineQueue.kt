package com.moumantai.client.transport

import android.content.Context
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
import java.util.UUID

/**
 * Persistent FIFO queue for user-originated messages that didn't make it
 * onto the wire before the socket dropped.
 *
 * Backing store is a single JSON file (`offline-queue.json`) in the app's
 * private files dir. Simpler than Room for our expected sizes: max 20 text
 * items + 3 voice utterances (voice utterances point at a separate blob
 * file under `offline-voice/`).
 *
 * Usage:
 *   queue.enqueueText(scope, text) when offline
 *   queue.drain { item -> send(item); return true }  on reconnect
 *
 * Items with a stable [clientMsgId] so the server can idempotency-dedup
 * on replay.
 */
class OfflineQueue internal constructor(
    private val filesDir: File,
) {
    private val file = File(filesDir, FILE_NAME)
    private val voiceDir = File(filesDir, VOICE_DIR_NAME).also { it.mkdirs() }
    private val imageDir = File(filesDir, IMAGE_DIR_NAME).also { it.mkdirs() }
    private val lock = Any()
    private val json =
        Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }

    constructor(context: Context) : this(context.applicationContext.filesDir)

    init {
        // Defensive sweep: delete any blob file whose owning queue item is no
        // longer in the JSON (orphaned by a crashed write or older build).
        sweepOrphanBlobs()
    }

    @Serializable
    data class Item(
        /** Stable id across retries for server-side dedup (chat: `clientMsgId`; tool: `clientRequestId`). */
        val clientMsgId: String,
        /** Target scope: 'home' or 'app:<appId>'. */
        val scope: String,
        /** "text" | "voice" | "invoke_tool". */
        val kind: String,
        /** For kind=="text". */
        val text: String? = null,
        /** For kind=="voice": path under voiceDir relative to filesDir. */
        val voiceBlobPath: String? = null,
        /** For kind=="text" with an attached image: relative path under filesDir (e.g. `"offline-image/<uuid>.bin"`). */
        val imageBlobPath: String? = null,
        /** For kind=="text" with an attached image: "image/jpeg" or "image/png". */
        val imageMimeType: String? = null,
        val sampleRate: Int = 16000,
        val format: String = "pcm16",
        /** Unix ms. */
        val enqueuedAt: Long,
        /** Conv-id at enqueue time. Sent as `originConversationId`; server rejects stale inputs. Null = no staleness check. */
        val originConversationId: String? = null,
        /** For kind=="invoke_tool": tool name to dispatch. */
        val toolName: String? = null,
        /** For kind=="invoke_tool": JSON-encoded args (string, not JsonElement, to avoid polymorphism issues at decode). */
        val argsJson: String? = null,
        /** For kind=="invoke_tool": face id the action originated from. */
        val sourceFaceId: String? = null,
    )

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Enqueue a chat input (text, image, or both). [clientMsgId] must match
     * the optimistic bubble so the server-echo reconciles to the existing row.
     * Image bytes are written to disk under [IMAGE_DIR_NAME]; deleted on drain.
     */
    fun enqueueChatInput(
        scope: String,
        text: String,
        clientMsgId: String,
        originConversationId: String? = null,
        imageBytes: ByteArray? = null,
        imageMimeType: String? = null,
    ): Item {
        var imageBlobPath: String? = null
        var mimeToStore: String? = null
        if (imageBytes != null && imageMimeType != null) {
            val blob = File(imageDir, "$clientMsgId.bin")
            try {
                blob.writeBytes(imageBytes)
                imageBlobPath = "$IMAGE_DIR_NAME/${blob.name}"
                mimeToStore = imageMimeType
            } catch (_: Throwable) {
                // Disk full / permissions — fall through and enqueue text-only.
            }
        }
        val item =
            Item(
                clientMsgId = clientMsgId,
                scope = scope,
                kind = "text",
                text = text,
                imageBlobPath = imageBlobPath,
                imageMimeType = mimeToStore,
                enqueuedAt = System.currentTimeMillis(),
                originConversationId = originConversationId,
            )
        synchronized(lock) {
            val list = readAll().toMutableList()
            list += item
            trimAndWrite(list)
        }
        return item
    }

    /** Text-only convenience wrapper retained for test ergonomics. */
    fun enqueueText(
        scope: String,
        text: String,
        clientMsgId: String,
        originConversationId: String? = null,
    ): Item = enqueueChatInput(scope, text, clientMsgId, originConversationId, null, null)

    /**
     * Persist a completed voice utterance. Caller supplies the raw PCM bytes;
     * they are written to disk so the main queue file stays small.
     */
    fun enqueueVoice(
        scope: String,
        pcm: ByteArray,
        sampleRate: Int = 16000,
        originConversationId: String? = null,
    ): Item? {
        val id = UUID.randomUUID().toString()
        val blob = File(voiceDir, "$id.pcm")
        try {
            blob.writeBytes(pcm)
        } catch (_: Throwable) {
            return null
        }
        val item =
            Item(
                clientMsgId = id,
                scope = scope,
                kind = "voice",
                voiceBlobPath = "$VOICE_DIR_NAME/${blob.name}",
                sampleRate = sampleRate,
                enqueuedAt = System.currentTimeMillis(),
                originConversationId = originConversationId,
            )
        synchronized(lock) {
            val list = readAll().toMutableList()
            // Voice utterances are expensive — keep only the most recent [MAX_VOICE].
            val voices = list.filter { it.kind == "voice" }.toMutableList()
            if (voices.size >= MAX_VOICE) {
                val oldest = voices.first()
                deleteBlob(oldest)
                list.removeAll { it.clientMsgId == oldest.clientMsgId }
            }
            list += item
            trimAndWrite(list)
        }
        return item
    }

    /**
     * Read and decode the voice blob for a queued voice item, or null if missing.
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
     * Read the inline-image blob for a queued chat item, or null if missing
     * (the item carries no image or the file vanished between enqueue and drain).
     */
    fun readImageBlob(item: Item): ByteArray? {
        val rel = item.imageBlobPath ?: return null
        return try {
            File(filesDir, rel).readBytes()
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Persist a tool invocation that didn't reach the server. Server-side
     * `invoke_dedup` table dedupes on `clientRequestId` across restarts.
     */
    fun enqueueInvokeTool(
        scope: String,
        toolName: String,
        args: Map<String, Any?>?,
        sourceFaceId: String,
        clientRequestId: String,
        originConversationId: String? = null,
    ): Item {
        val item =
            Item(
                clientMsgId = clientRequestId,
                scope = scope,
                kind = "invoke_tool",
                enqueuedAt = System.currentTimeMillis(),
                originConversationId = originConversationId,
                toolName = toolName,
                argsJson = if (args != null) json.encodeToString(JsonElement.serializer(), args.toJsonElement()) else null,
                sourceFaceId = sourceFaceId,
            )
        synchronized(lock) {
            val list = readAll().toMutableList()
            list += item
            trimAndWrite(list)
        }
        return item
    }

    /**
     * Decode an invoke-tool item's `argsJson` back into the `Map<String, Any?>`
     * that `Transport.sendInvokeTool` expects. Returns null if the item isn't
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
     * Drain queued items in FIFO order. The [send] callback must return true
     * if delivery succeeded; false keeps the item in the queue with a bumped
     * retry count. Stale items (> EXPIRY_MS) are silently dropped.
     */
    fun drain(send: (Item) -> Boolean) {
        val items = synchronized(lock) { readAll().toList() }
        val remaining = items.toMutableList()
        val now = System.currentTimeMillis()

        for (item in items) {
            if (now - item.enqueuedAt > EXPIRY_MS) {
                remaining.remove(item)
                deleteBlob(item)
                continue
            }
            val ok =
                try {
                    send(item)
                } catch (_: Throwable) {
                    false
                }
            if (ok) {
                remaining.remove(item)
                deleteBlob(item)
            } else {
                // Stop on first failure so order is preserved; retry later.
                break
            }
        }

        synchronized(lock) { trimAndWrite(remaining) }
    }

    /** For tests / settings UI. */
    fun peek(): List<Item> = synchronized(lock) { readAll() }

    fun clear() {
        synchronized(lock) {
            readAll().forEach { deleteBlob(it) }
            file.delete()
        }
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    private fun readAll(): List<Item> {
        if (!file.exists()) return emptyList()
        return try {
            json.decodeFromString<List<Item>>(file.readText())
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun trimAndWrite(list: List<Item>) {
        val bounded =
            if (list.size > MAX_ITEMS) {
                // Delete blobs of evicted items so `offline-voice/` and
                // `offline-image/` don't leak when newer items push them out.
                val dropped = list.dropLast(MAX_ITEMS)
                dropped.forEach { deleteBlob(it) }
                list.takeLast(MAX_ITEMS)
            } else {
                list
            }
        try {
            file.writeText(json.encodeToString(bounded))
        } catch (_: Throwable) {
            // Disk full, permissions etc. — best effort; the queue is advisory.
        }
    }

    /** Delete any blob files this item references. Silent on missing/error. */
    private fun deleteBlob(item: Item) {
        item.voiceBlobPath?.let {
            try {
                File(filesDir, it).delete()
            } catch (_: Throwable) {
            }
        }
        item.imageBlobPath?.let {
            try {
                File(filesDir, it).delete()
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * On init, list every file in voiceDir + imageDir and delete any whose
     * name is not referenced by a current queue Item. Cheap defense against
     * blob leaks from crashed drains, killed enqueues, or older builds.
     */
    private fun sweepOrphanBlobs() {
        try {
            val items = readAll()
            val referenced =
                buildSet {
                    items.forEach { item ->
                        item.voiceBlobPath?.let { add(it) }
                        item.imageBlobPath?.let { add(it) }
                    }
                }
            sequenceOf(VOICE_DIR_NAME to voiceDir, IMAGE_DIR_NAME to imageDir).forEach { (dirName, dir) ->
                dir.listFiles()?.forEach { f ->
                    val rel = "$dirName/${f.name}"
                    if (rel !in referenced) {
                        try {
                            f.delete()
                        } catch (_: Throwable) {
                        }
                    }
                }
            }
        } catch (_: Throwable) {
            // Best-effort hygiene; never block startup on a failed sweep.
        }
    }

    companion object {
        private const val FILE_NAME = "offline-queue.json"
        private const val VOICE_DIR_NAME = "offline-voice"
        private const val IMAGE_DIR_NAME = "offline-image"

        /** Max total queued items (text + voice + invoke_tool). Wear caps at 16 — phone is roomier. */
        private const val MAX_ITEMS = 20

        /** Separate cap on voice utterances to bound disk usage. Wear caps at 2. */
        private const val MAX_VOICE = 3

        /** Items older than 24h are dropped silently on drain. */
        private const val EXPIRY_MS = 24L * 60 * 60 * 1000
    }
}

// ---------------------------------------------------------------------------
// JsonElement <-> Map<String, Any?> conversion (kotlinx.serialization can't
// serialize Map<String, Any?> directly). Used by enqueueInvokeTool to persist
// the args Struct as JSON, and by readInvokeToolArgs to reconstitute it.
// ---------------------------------------------------------------------------

private fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is String -> JsonPrimitive(this)
    is Map<*, *> ->
        JsonObject(
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
    is JsonPrimitive ->
        when {
            booleanOrNull != null -> boolean
            // Prefer Long for whole numbers; fall back to Double for fractional.
            // Kotlin Map<String, Any?> consumers (e.g. the proto args) accept either.
            contentOrNull?.toLongOrNull() != null -> content.toLong()
            doubleOrNull != null -> double
            isString -> content
            else -> contentOrNull
        }
    is JsonObject -> entries.associate { (k, v): Map.Entry<String, JsonElement> -> k to v.toAnyOrNull() }
    is JsonArray -> map { it.toAnyOrNull() }
}
