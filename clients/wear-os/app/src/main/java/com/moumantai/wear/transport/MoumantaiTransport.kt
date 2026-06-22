package com.moumantai.wear.transport

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
import com.moumantai.wear.util.safeLog
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
 * WebSocket transport for Wear OS.
 *
 * Wire format: binary protobuf (subprotocol `moumantai.v1.proto`), encoded via
 * Square Wire's `ProtoAdapter` directly. Binary frames (audio/image) use the
 * shared envelope: `[1 byte type] [2 byte LE header_len] [proto header] [payload]`.
 * The server disambiguates by the leading byte.
 */
class MoumantaiTransport(private val serverUrl: String = "ws://10.0.2.2:3000") : Transport {

    companion object {
        private const val TAG = "MoumantaiTransport"
        private const val MAX_RECONNECT_DELAY_MS = 30_000L
        private const val INITIAL_RECONNECT_DELAY_MS = 1_000L

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

    private var ws: WebSocket? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0

    @Volatile
    private var shouldReconnect = false
    private var lastConnectParams: ConnectParams? = null

    // True between a PAIRING_REQUIRED close and the next successful hello — drives
    // the short fixed retry cadence so approval is picked up quickly.
    private var pairingPending = false

    // Wallclock ms after which the active pairing-poll burst stops (then explicit
    // Reconnect, or foregrounding resumes it). 0 = no burst running.
    private var pairingBurstDeadlineMs = 0L

    // App foreground state; while pending we only poll when foregrounded (battery).
    private var foreground = true

    @Volatile private var currentSessionId: String? = null

    /**
     * Last scope we successfully emitted a viewing message for. Reset to null
     * on every hello-ok so reconnects re-announce the scope even if it hasn't
     * changed on the client side.
     */
    @Volatile private var lastSentScope: String? = null

    private data class ConnectParams(
        val deviceClass: DeviceClass,
        val width: Int,
        val height: Int,
        /** Stable per-device UUIDv4; sent in every ClientHello. */
        val deviceId: String,
    )

    private val client = OkHttpClient.Builder()
        .readTimeout(35, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    // -- Callbacks -----------------------------------------------------------

    override var onChatMessage: ((ChatMessage) -> Unit)? = null
    override var onChatWindow: ((ChatWindowMsg) -> Unit)? = null
    override var onChatHistory: ((ChatHistoryMsg) -> Unit)? = null
    override var onChatUpdate: ((ChatUpdateMsg) -> Unit)? = null
    override var onResetNotice: ((ResetNoticeMsg) -> Unit)? = null
    override var onVoiceState: ((VoiceState) -> Unit)? = null
    override var onAppList: ((AppListMsg) -> Unit)? = null
    override var onFaceList: ((FaceListMsg) -> Unit)? = null
    override var onFaceUpdate: ((FaceUpdateMsg) -> Unit)? = null
    override var onNavigate: ((NavigateMsg) -> Unit)? = null
    override var onAudioChunk: ((data: ByteArray, isFinal: Boolean, format: String, sampleRate: Int) -> Unit)? = null
    override var onConnectionState: ((Transport.ConnectionState) -> Unit)? = null
    override var onPairingRequired: ((code: String) -> Unit)? = null
    override var onServerHello: ((ServerHello) -> Unit)? = null
    override var onError: ((ErrorMessage) -> Unit)? = null
    override var onUiActionEscalated: ((UiActionEscalated) -> Unit)? = null
    override var navIntentProvider: (() -> NavIntent)? = null

    // -- Public API ----------------------------------------------------------

    override val sessionId: String?
        get() = currentSessionId

    override fun connect(
        deviceClass: String,
        width: Int,
        height: Int,
        deviceId: String,
    ) {
        lastConnectParams = ConnectParams(
            deviceClass = deviceClassFromString(deviceClass),
            width = width,
            height = height,
            deviceId = deviceId,
        )
        shouldReconnect = true
        reconnectAttempt = 0
        // Fresh user-initiated connect → reset any pairing burst (also the
        // "explicit retry" path from the Config screen's Reconnect button).
        pairingPending = false
        pairingBurstDeadlineMs = 0L
        reconnectJob?.cancel()
        reconnectJob = null
        ws?.close(1000, null)
        openInternal()
    }

    override fun setForeground(fg: Boolean) {
        foreground = fg
        if (fg && pairingPending && shouldReconnect) {
            pairingBurstDeadlineMs = System.currentTimeMillis() + PAIRING_BURST_MS
            reconnectJob?.cancel()
            reconnectJob = null
            ws?.close(1000, null)
            openInternal()
        }
    }

    override fun disconnect() {
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

    override fun sendInvokeTool(
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

    override fun sendChatInput(
        scope: String,
        text: String,
        clientMsgId: String?,
        originConversationId: String?,
    ) {
        sendEnvelope(
            ClientMessage(
                chat_input = ChatInput(
                    scope = scope,
                    text = text,
                    client_msg_id = clientMsgId ?: UUID.randomUUID().toString(),
                    origin_conversation_id = originConversationId,
                ),
            ),
        )
    }

    override fun sendFetchOlder(scope: String, beforeSeq: Long, limit: Int) {
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

    override fun sendViewing(scope: String) {
        if (scope == lastSentScope) return
        sendEnvelope(ClientMessage(viewing = ViewingMsg(scope = scope)))
        lastSentScope = scope
    }

    override fun sendResetConversation(scope: String) {
        sendEnvelope(ClientMessage(reset_conversation = ResetConversationMsg(scope = scope)))
    }

    override fun sendAudioInput(
        data: ByteArray,
        format: String,
        sampleRate: Int,
        final: Boolean,
        scope: String,
        clientMsgId: String?,
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

    // -- Internal: connection loop ------------------------------------------

    private fun openInternal() {
        val params = lastConnectParams ?: return
        onConnectionState?.invoke(Transport.ConnectionState.CONNECTING)

        val request = Request.Builder()
            .url(serverUrl)
            .header("Sec-WebSocket-Protocol", PROTO_SUBPROTOCOL)
            .build()
        ws = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    reconnectAttempt = 0
                    val nav = navIntentProvider?.invoke()
                    val helloEnvelope = ClientMessage(
                        hello = ClientHello(
                            device_class = params.deviceClass,
                            device_profile = DeviceProfile(
                                width = params.width,
                                height = params.height,
                                shape = DeviceShape.DEVICE_SHAPE_ROUND,
                            ),
                            current_app_id = nav?.currentAppId,
                            current_face_id = nav?.currentFaceId,
                            device_id = params.deviceId,
                        ),
                    )
                    webSocket.send(ClientMessage.ADAPTER.encode(helloEnvelope).toByteString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    // Proto subprotocol: every envelope is on the binary channel.
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    handleBinaryMessage(bytes.toByteArray())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    onConnectionState?.invoke(Transport.ConnectionState.DISCONNECTED)
                    // PAIRING_REQUIRED (4008) is not a fault — the device just
                    // isn't approved yet. Surface the code and retry on a short
                    // interval so approval is picked up quickly.
                    val wasPairing = pairingPending
                    pairingPending = code == CLOSE_PAIRING_REQUIRED
                    if (pairingPending && !wasPairing) {
                        pairingBurstDeadlineMs = System.currentTimeMillis() + PAIRING_BURST_MS
                    }
                    if (pairingPending) {
                        lastConnectParams?.deviceId?.let { onPairingRequired?.invoke(pairingCode(it)) }
                    }
                    // deviceId is the stable identity; no resume creds.
                    currentSessionId = null
                    lastSentScope = null
                    scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    onConnectionState?.invoke(Transport.ConnectionState.DISCONNECTED)
                    lastSentScope = null
                    scheduleReconnect()
                }
            },
        )
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        reconnectJob?.cancel()
        // While pending approval: fixed interval (no backoff growth), foreground-only,
        // bounded burst — connects promptly once approved without draining battery.
        val delayMs = if (pairingPending) {
            if (!foreground) return // paused; setForeground resumes
            if (System.currentTimeMillis() > pairingBurstDeadlineMs) return // exhausted; tap Reconnect
            PAIRING_RETRY_MS
        } else {
            val attempt = reconnectAttempt++
            val base = (INITIAL_RECONNECT_DELAY_MS shl minOf(attempt, 5)).coerceAtMost(MAX_RECONNECT_DELAY_MS)
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

    // -- Internal: inbound dispatch -----------------------------------------

    /**
     * Disambiguate incoming binary frames: 0x01 → audio, 0x02 → image,
     * anything else → proto `ServerMessage` envelope.
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
            safeLog(TAG, "Failed to decode ServerMessage envelope", e)
            return
        }

        envelope.hello_ok?.let { msg ->
            onHello(msg)
            onServerHello?.invoke(msg)
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
        safeLog(TAG, "Unknown ServerMessage payload variant (all known oneof fields null)")
    }

    private fun handleAudioFrame(data: ByteArray) {
        val parsed = BinaryFrame.parse(data) ?: return
        val header = try {
            BinaryFrame.decodeAudio(parsed.headerBytes)
        } catch (e: Exception) {
            safeLog(TAG, "Malformed AudioChunkHeader", e)
            return
        }
        val format = BinaryFrame.audioFormatLabel(header.format) ?: return
        onAudioChunk?.invoke(parsed.payload, header.final_, format, header.sample_rate)
    }

    // -- Transport interface plumbing ---------------------------------------

    override fun onHello(hello: ServerHello) {
        currentSessionId = hello.session_id
        lastSentScope = null
        pairingPending = false
        pairingBurstDeadlineMs = 0L
        onConnectionState?.invoke(Transport.ConnectionState.CONNECTED)
    }
}
