package com.moumantai.client.transport

import com.moumantai.client.util.safeLog
import com.moumantai.protocol.v1.AppListMsg
import com.moumantai.protocol.v1.ChatHistoryMsg
import com.moumantai.protocol.v1.ChatInput
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.ChatUpdateMsg
import com.moumantai.protocol.v1.ChatWindowMsg
import com.moumantai.protocol.v1.ClientHello
import com.moumantai.protocol.v1.ClientMessage
import com.moumantai.protocol.v1.DeviceClass
import com.moumantai.protocol.v1.DeviceProfile
import com.moumantai.protocol.v1.DeviceShape
import com.moumantai.protocol.v1.ErrorMessage
import com.moumantai.protocol.v1.FaceListMsg
import com.moumantai.protocol.v1.FaceUpdateMsg
import com.moumantai.protocol.v1.FetchOlderMsg
import com.moumantai.protocol.v1.InvokeToolMsg
import com.moumantai.protocol.v1.NavigateMsg
import com.moumantai.protocol.v1.ResetConversationMsg
import com.moumantai.protocol.v1.ResetNoticeMsg
import com.moumantai.protocol.v1.ServerHello
import com.moumantai.protocol.v1.ServerMessage
import com.moumantai.protocol.v1.UiActionEscalated
import com.moumantai.protocol.v1.ViewingMsg
import com.moumantai.protocol.v1.VoiceState
import com.moumantai.transport.BinaryFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * OkHttp WebSocket client for the Moumantai v1 binary protobuf protocol
 * (subprotocol `moumantai.v1.proto`). Exponential-backoff reconnect (1s–30s
 * jittered); reconnect is a fresh handshake with full server snapshot.
 * Audio/image use a `[1-byte type][2-byte LE length][proto header][payload]`
 * binary frame envelope. Attach a [NetworkMonitor] for immediate reconnect on
 * network restore.
 */
class MoumantaiTransport(private val serverUrl: String = "ws://10.0.2.2:3000") {

    private var ws: WebSocket? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var reconnectJob: Job? = null

    /** Monotonic attempt counter; drives exp backoff. Reset on successful open. */
    private var reconnectAttempt = 0

    /** Params captured at connect time; reused on every reconnect. */
    private data class ConnectParams(
        val deviceClass: DeviceClass,
        val width: Int,
        val height: Int,
        /** Stable per-device UUIDv4; sent in every ClientHello. */
        val deviceId: String,
    )
    private var lastParams: ConnectParams? = null

    // True between a PAIRING_REQUIRED close and the next successful hello — drives
    // the short fixed retry cadence so approval is picked up quickly.
    private var pairingPending = false

    // Wallclock ms after which the active pairing-poll burst stops (then the user
    // taps Reconnect, or foregrounding resumes it). 0 = no burst running.
    private var pairingBurstDeadlineMs = 0L

    // App foreground state; while pending we only poll when foregrounded (battery).
    private var foreground = true

    /** Set to false by disconnect() so reconnect loops tear down. */
    @Volatile
    private var shouldReconnect = false

    /**
     * Session id from the most recent ServerHello. Fresh per WS handshake;
     * used for `resetNotice` self-suppression (originator skips the banner).
     */
    @Volatile private var currentSessionId: String? = null
    val sessionId: String?
        get() = currentSessionId

    /** Last scope announced via `viewing`; makes [sendViewing] idempotent. Null on disconnect. */
    @Volatile private var lastSentScope: String? = null

    private val client: OkHttpClient = OkHttpClient.Builder()
        // 35s read timeout catches half-open TCP; pair with the 15s ping below.
        .readTimeout(35, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    // -- Callbacks -----------------------------------------------------------

    var onChatMessage: ((ChatMessage) -> Unit)? = null

    /**
     * Authoritative chat window for a scope. Client REPLACES its per-scope
     * chat log with `entries` (except it preserves optimistic bubbles whose
     * `clientMsgId` is non-null and not in `entries`). Sent in response to
     * `viewing` and after `resetConversation`.
     */
    var onChatWindow: ((ChatWindowMsg) -> Unit)? = null

    /**
     * Older-history page in response to [sendFetchOlder]. Client should
     * prepend entries to its local cache, deduping by id.
     */
    var onChatHistory: ((ChatHistoryMsg) -> Unit)? = null

    /**
     * Incremental turn status update for an existing chat row (pending →
     * running; running → timed_out / failed / aborted). Assistant-row
     * appends still arrive via [onChatMessage].
     */
    var onChatUpdate: ((ChatUpdateMsg) -> Unit)? = null

    /**
     * Disposable notice that a scope's conversation is being reset. Arrives
     * just before the authoritative empty [ChatWindowMsg]. The ViewModel
     * filters out self-originated notices (requesterSessionId == sessionId)
     * so only *other* devices surface a transient banner.
     */
    var onResetNotice: ((ResetNoticeMsg) -> Unit)? = null
    var onVoiceState: ((VoiceState) -> Unit)? = null
    var onAppList: ((AppListMsg) -> Unit)? = null
    var onFaceList: ((FaceListMsg) -> Unit)? = null
    var onFaceUpdate: ((FaceUpdateMsg) -> Unit)? = null
    var onNavigate: ((NavigateMsg) -> Unit)? = null

    /**
     * Audio chunk callback. Receives raw PCM/Opus bytes plus the chunk
     * metadata parsed from the binary frame's JSON header.
     */
    var onAudioChunk: ((data: ByteArray, isFinal: Boolean, format: String, sampleRate: Int) -> Unit)? = null
    var onConnectionState: ((ConnectionState) -> Unit)? = null

    /**
     * Fired when the server rejects this device with PAIRING_REQUIRED (4008).
     * The argument is the short pairing code to show. The transport keeps
     * retrying on a short interval; a later CONNECTED means approval landed.
     * Kept separate from [ConnectionState] so that enum stays 3-valued.
     */
    var onPairingRequired: ((code: String) -> Unit)? = null
    var onServerHello: ((ServerHello) -> Unit)? = null

    /** Structured error (rate_limited, session_busy, audio_overflow, etc). */
    var onError: ((ErrorMessage) -> Unit)? = null

    /**
     * Disposable hint that a UI tap escalated to chat because of missing args.
     * Not replayed on reconnect — no seq.
     */
    var onUiActionEscalated: ((UiActionEscalated) -> Unit)? = null

    /**
     * Invoked just before sending ClientHello so the caller can attach the
     * current UI nav state (active app/face, chat overlay). Survives reconnects —
     * whichever value the provider returns at hello time is what goes on the wire.
     */
    var navIntentProvider: (() -> NavIntent)? = null

    // -- Public API ----------------------------------------------------------

    /**
     * Open a WebSocket connection and send the initial handshake. Sends a
     * fresh ClientHello on every connect (no resume credentials). The server
     * responds with a new sessionId and pushes a full state snapshot. If a
     * prior socket for the same deviceId is still open server-side, the server
     * closes it with code 1000 'superseded' before processing this hello.
     */
    fun connect(
        deviceClass: String = "phone",
        width: Int = 390,
        height: Int = 844,
        deviceId: String,
    ) {
        lastParams = ConnectParams(
            deviceClass = deviceClassFromString(deviceClass),
            width = width,
            height = height,
            deviceId = deviceId,
        )
        shouldReconnect = true
        reconnectAttempt = 0
        // User-initiated connect — reset pairing burst (also the Reconnect button path).
        pairingPending = false
        pairingBurstDeadlineMs = 0L
        // Tear down any in-flight reconnect or prior socket to avoid races.
        reconnectJob?.cancel()
        reconnectJob = null
        ws?.close(1000, null)
        openInternal()
    }

    /**
     * App foreground state. While pairing-pending we only poll when foregrounded
     * (to save battery on watch/phone). Returning to the foreground resumes a
     * fresh polling burst immediately. Call from the Activity lifecycle.
     */
    fun setForeground(fg: Boolean) {
        foreground = fg
        if (fg && pairingPending && shouldReconnect) {
            pairingBurstDeadlineMs = System.currentTimeMillis() + PAIRING_BURST_MS
            reconnectNow()
        }
    }

    /**
     * Fast path: open a connection now, cancelling any pending exp-backoff
     * wait. Call this from a [NetworkMonitor.onAvailable] callback.
     */
    fun reconnectNow() {
        if (!shouldReconnect) return
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempt = 0
        // Close any half-open socket so we don't leave two parallel listeners.
        ws?.close(1000, null)
        openInternal()
    }

    /**
     * Close the WebSocket and stop reconnecting. Does not shut down the shared
     * OkHttp dispatcher — idle connections expire on their own.
     */
    fun disconnect() {
        shouldReconnect = false
        reconnectJob?.cancel()
        reconnectJob = null
        ws?.close(1000, "Client disconnect")
        ws = null
        scope.cancel()
        client.connectionPool.evictAll()
        currentSessionId = null
        lastSentScope = null
    }

    // -- Send helpers --------------------------------------------------------

    /**
     * Invoke a tool from a face UI action. `args` must have `{path}` placeholders
     * already resolved. `clientRequestId` enables server-side dedup on offline replay.
     */
    fun sendInvokeTool(
        toolName: String,
        args: Map<String, Any?>?,
        sourceFaceId: String,
        clientRequestId: String,
    ) {
        sendEnvelope(
            ClientMessage(
                invoke_tool = InvokeToolMsg(
                    tool_name = toolName,
                    args = args,
                    source_face_id = sourceFaceId,
                    client_request_id = clientRequestId,
                ),
            ),
        )
    }

    /**
     * Request older chat entries below `beforeSeq` for `scope`. Server replies
     * via [onChatHistory]. `beforeSeq <= 0` acts like a fresh chatWindow.
     */
    fun sendFetchOlder(scope: String, beforeSeq: Long, limit: Int = 50) {
        sendEnvelope(
            ClientMessage(
                fetch_older = FetchOlderMsg(
                    scope = scope,
                    before_seq = beforeSeq,
                    limit = limit,
                ),
            ),
        )
    }

    /**
     * Send a user text turn. Generates a fresh `clientMsgId` if null.
     * [originConversationId] is set only when replaying offline-queued items;
     * the server rejects with `stale_conversation` if it no longer matches.
     */
    fun sendChatInput(
        scope: String,
        text: String,
        clientMsgId: String? = null,
        imageBytes: ByteArray? = null,
        imageMimeType: String? = null,
        originConversationId: String? = null,
    ) {
        val image = if (imageBytes != null && imageMimeType != null) {
            imageBytes.toByteString()
        } else {
            null
        }
        sendEnvelope(
            ClientMessage(
                chat_input = ChatInput(
                    scope = scope,
                    text = text,
                    client_msg_id = clientMsgId ?: UUID.randomUUID().toString(),
                    origin_conversation_id = originConversationId,
                    image_data = image,
                    image_mime_type = if (image != null) imageMimeType else null,
                ),
            ),
        )
    }

    /**
     * Announce the scope the UI is currently showing. Idempotent: if [scope]
     * equals the last-sent value, this is a no-op. Reset on disconnect so
     * reconnects re-announce.
     */
    fun sendViewing(scope: String) {
        if (scope == lastSentScope) return
        sendEnvelope(ClientMessage(viewing = ViewingMsg(scope = scope)))
        lastSentScope = scope
    }

    /** Ask the server to archive the current conversation for [scope] and open a fresh one. */
    fun sendResetConversation(scope: String) {
        sendEnvelope(ClientMessage(reset_conversation = ResetConversationMsg(scope = scope)))
    }

    /**
     * Stream an audio chunk to the server. Must specify [format] + [sampleRate]
     * so the JSON header in the binary frame matches the device's actual
     * capture parameters — no defaults; callers thread the values from
     * `AudioConfig` (recorder) or the typed `AudioChunkHeader` (playback).
     */
    fun sendAudioInput(
        data: ByteArray,
        format: String,
        sampleRate: Int,
        final: Boolean,
        scope: String,
        clientMsgId: String? = null,
    ) {
        val bytes = BinaryFrame.encodeAudio(
            scope = scope,
            audioData = data,
            format = format,
            sampleRate = sampleRate,
            isFinal = final,
            clientMsgId = if (final) clientMsgId ?: UUID.randomUUID().toString() else null,
        )
        ws?.send(bytes.toByteString())
    }

    // -- Internal: connection loop + handshake -------------------------------

    private fun openInternal() {
        onConnectionState?.invoke(ConnectionState.CONNECTING)

        val request = Request.Builder()
            .url(serverUrl)
            .header("Sec-WebSocket-Protocol", PROTO_SUBPROTOCOL)
            .build()
        ws = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val params = lastParams ?: return
                    // Read the nav intent fresh every time so reconnects pick up
                    // whichever app/face the user is on right now, not the one they
                    // were on when connect() was first called.
                    val nav = navIntentProvider?.invoke()
                    val helloEnvelope = ClientMessage(
                        hello = ClientHello(
                            device_class = params.deviceClass,
                            device_profile = DeviceProfile(
                                width = params.width,
                                height = params.height,
                                shape = DeviceShape.DEVICE_SHAPE_RECT,
                            ),
                            current_app_id = nav?.currentAppId,
                            current_face_id = nav?.currentFaceId,
                            device_id = params.deviceId,
                        ),
                    )
                    webSocket.send(ClientMessage.ADAPTER.encode(helloEnvelope).toByteString())
                    // Stay CONNECTING until ServerHello — prevents a Connected flash for
                    // sockets rejected with 4002/4003 before completing the handshake.
                    reconnectAttempt = 0
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    // Text frames are unexpected on this binary-only subprotocol; ignored.
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    handleBinaryMessage(bytes.toByteArray())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    onConnectionState?.invoke(ConnectionState.DISCONNECTED)
                    // PAIRING_REQUIRED (4008) is not a fault — the device just isn't
                    // approved yet. Surface the pairing code and retry on a short
                    // interval so approval is picked up quickly.
                    val wasPairing = pairingPending
                    pairingPending = code == CLOSE_PAIRING_REQUIRED
                    if (pairingPending && !wasPairing) {
                        pairingBurstDeadlineMs = System.currentTimeMillis() + PAIRING_BURST_MS
                    }
                    if (pairingPending) {
                        lastParams?.deviceId?.let { onPairingRequired?.invoke(pairingCode(it)) }
                    }
                    currentSessionId = null // reset so next reconnect picks up fresh sessionId
                    lastSentScope = null // server has no memory of scope; must re-announce
                    scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    onConnectionState?.invoke(ConnectionState.DISCONNECTED)
                    lastSentScope = null
                    scheduleReconnect()
                }
            },
        )
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        reconnectJob?.cancel()
        // Pairing pending: short fixed interval (no backoff growth), foreground only, bounded burst.
        val delayMs = if (pairingPending) {
            if (!foreground) return // paused; setForeground resumes
            if (System.currentTimeMillis() > pairingBurstDeadlineMs) return // exhausted; tap Reconnect
            PAIRING_RETRY_MS
        } else {
            val attempt = reconnectAttempt++
            // Cap the shift to avoid overflow; max delay 30s.
            val base = (1_000L shl minOf(attempt, 5)).coerceAtMost(30_000L)
            val jitter = (base * 0.2 * (Math.random() - 0.5)).toLong()
            (base + jitter).coerceAtLeast(500L)
        }
        reconnectJob = scope.launch {
            try {
                delay(delayMs)
                if (isActive && shouldReconnect) openInternal()
            } catch (_: Throwable) { /* cancelled */ }
        }
    }

    // -- Internal: outbound envelope helper ----------------------------------

    private fun sendEnvelope(envelope: ClientMessage) {
        ws?.send(ClientMessage.ADAPTER.encode(envelope).toByteString())
    }

    // -- Internal: message dispatch -----------------------------------------

    /**
     * Disambiguate incoming binary frames:
     *   - 0x01 prefix → audio binary frame (proto-encoded AudioChunkHeader + PCM payload).
     *   - 0x02 prefix → image binary frame (proto-encoded header + image payload).
     *   - anything else → proto `ServerMessage` envelope.
     */
    private fun handleBinaryMessage(data: ByteArray) {
        if (data.isEmpty()) return
        when (data[0]) {
            BinaryFrame.Type.AUDIO -> handleAudioFrame(data)
            BinaryFrame.Type.IMAGE -> {
                // Image frames (0x02) are intentionally unconsumed: image
                // attachments ride on ChatInput.image_data, not a binary frame.
            }
            else -> handleEnvelope(data)
        }
    }

    private fun handleEnvelope(data: ByteArray) {
        val envelope = try {
            ServerMessage.ADAPTER.decode(data)
        } catch (e: Exception) {
            safeLog("MoumantaiTransport", "Failed to decode ServerMessage envelope", e)
            return
        }

        envelope.hello_ok?.let { msg ->
            currentSessionId = msg.session_id
            pairingPending = false
            pairingBurstDeadlineMs = 0L
            onConnectionState?.invoke(ConnectionState.CONNECTED)
            onServerHello?.invoke(msg)
            lastSentScope = null
            sendViewing(scopeFromNav(navIntentProvider?.invoke()))
            return
        }
        envelope.chat?.let { msg ->
            onChatMessage?.invoke(msg)
            return
        }
        envelope.chat_window?.let { msg ->
            onChatWindow?.invoke(msg)
            return
        }
        envelope.chat_history?.let { msg ->
            onChatHistory?.invoke(msg)
            return
        }
        envelope.chat_update?.let { msg ->
            onChatUpdate?.invoke(msg)
            return
        }
        envelope.reset_notice?.let { msg ->
            onResetNotice?.invoke(msg)
            return
        }
        envelope.voice_state?.let { msg ->
            onVoiceState?.invoke(msg)
            return
        }
        envelope.app_list?.let { msg ->
            onAppList?.invoke(msg)
            return
        }
        envelope.face_list?.let { msg ->
            onFaceList?.invoke(msg)
            return
        }
        envelope.face_update?.let { msg ->
            onFaceUpdate?.invoke(msg)
            return
        }
        envelope.navigate?.let { msg ->
            onNavigate?.invoke(msg)
            return
        }
        envelope.error?.let { msg ->
            onError?.invoke(msg)
            return
        }
        envelope.ui_action_escalated?.let { msg ->
            onUiActionEscalated?.invoke(msg)
            return
        }
        safeLog("MoumantaiTransport", "Unknown ServerMessage payload variant (all known oneof fields null)")
    }

    /**
     * Audio binary frame: decode the typed `AudioChunkHeader` proto and hand
     * the PCM payload + format/sample-rate to the listener.
     */
    private fun handleAudioFrame(data: ByteArray) {
        val parsed = BinaryFrame.parse(data) ?: return
        val header = try {
            BinaryFrame.decodeAudio(parsed.headerBytes)
        } catch (e: Exception) {
            safeLog("MoumantaiTransport", "Malformed AudioChunkHeader", e)
            return
        }
        val format = BinaryFrame.audioFormatLabel(header.format) ?: return
        onAudioChunk?.invoke(parsed.payload, header.final_, format, header.sample_rate)
    }

    /** Map the current UI nav intent to its wire `scope`. */
    private fun scopeFromNav(nav: NavIntent?): String = if (nav == null || nav.currentAppId == null || nav.currentAppId == "home") {
        "home"
    } else {
        "app:${nav.currentAppId}"
    }

    companion object {
        const val PROTO_SUBPROTOCOL = "moumantai.v1.proto"

        /** WebSocket close codes surfaced by the Moumantai server. */
        const val CLOSE_UNKNOWN_SESSION = 4003
        const val CLOSE_SESSION_IN_USE = 4004
        const val CLOSE_PAIRING_REQUIRED = 4008

        /** Fixed retry cadence while waiting for pairing approval (ms). */
        const val PAIRING_RETRY_MS = 4_000L

        /** Active pairing-poll burst length; then we wait for explicit Reconnect. */
        const val PAIRING_BURST_MS = 120_000L

        /** Short pairing code shown on screen — last 4 hex of the deviceId,
         *  uppercased. Mirrors the server's `deviceCode()` for 1:1 matching. */
        fun pairingCode(deviceId: String): String = deviceId.takeLast(4).uppercase()

        private fun deviceClassFromString(s: String): DeviceClass = when (s) {
            "phone" -> DeviceClass.DEVICE_CLASS_PHONE
            "watch" -> DeviceClass.DEVICE_CLASS_WATCH
            "glass" -> DeviceClass.DEVICE_CLASS_GLASS
            "iot-small" -> DeviceClass.DEVICE_CLASS_IOT_SMALL
            "hmi-panel" -> DeviceClass.DEVICE_CLASS_HMI_PANEL
            else -> DeviceClass.DEVICE_CLASS_UNSPECIFIED
        }
    }

    enum class ConnectionState {
        CONNECTING,
        CONNECTED,
        DISCONNECTED,
    }
}

/**
 * Snapshot of the client's current UI nav state, captured at hello time by the
 * transport so reconnects restore the pre-disconnect face.
 */
data class NavIntent(
    val currentAppId: String? = null,
    val currentFaceId: String? = null,
)
