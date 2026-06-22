package com.moumantai.wear.transport

import com.moumantai.protocol.v1.AppListMsg
import com.moumantai.protocol.v1.ChatHistoryMsg
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.ChatUpdateMsg
import com.moumantai.protocol.v1.ChatWindowMsg
import com.moumantai.protocol.v1.ErrorMessage
import com.moumantai.protocol.v1.FaceListMsg
import com.moumantai.protocol.v1.FaceUpdateMsg
import com.moumantai.protocol.v1.NavigateMsg
import com.moumantai.protocol.v1.ResetNoticeMsg
import com.moumantai.protocol.v1.ServerHello
import com.moumantai.protocol.v1.UiActionEscalated
import com.moumantai.protocol.v1.VoiceState

/**
 * Common transport interface for the Moumantai wire protocol.
 *
 * Implemented by [MoumantaiTransport] (direct WebSocket). Kept as a single-impl
 * seam so the [AppViewModel][com.moumantai.wear.state.AppViewModel] can swap
 * in test fakes without depending on the concrete transport.
 *
 * All payloads are Wire-typed `com.moumantai.protocol.v1.*` messages — the
 * transport encodes/decodes via Wire's `ProtoAdapter` directly; no
 * intermediate translation layer.
 */
interface Transport {

    // -- Callbacks (set by ViewModel before connect) --------------------------

    var onChatMessage: ((ChatMessage) -> Unit)?

    /**
     * Authoritative chat window for a scope. Client REPLACES its local chat
     * log for `scope` with `entries` (except optimistic entries whose
     * `client_msg_id` is not in `entries[].id`, which are preserved).
     */
    var onChatWindow: ((ChatWindowMsg) -> Unit)?

    /** Older-history page from [sendFetchOlder]; client prepends to cache. */
    var onChatHistory: ((ChatHistoryMsg) -> Unit)?

    /**
     * Incremental turn status update for an existing chat row (pending →
     * running; running → terminal). Assistant-row appends still arrive via
     * [onChatMessage].
     */
    var onChatUpdate: ((ChatUpdateMsg) -> Unit)?

    /**
     * Disposable notice that a scope's conversation is being reset. Arrives
     * just before the authoritative empty [ChatWindowMsg]. The ViewModel
     * filters out self-originated notices (requesterSessionId == sessionId)
     * so only *other* devices surface a transient banner.
     */
    var onResetNotice: ((ResetNoticeMsg) -> Unit)?
    var onVoiceState: ((VoiceState) -> Unit)?
    var onAppList: ((AppListMsg) -> Unit)?
    var onFaceList: ((FaceListMsg) -> Unit)?
    var onFaceUpdate: ((FaceUpdateMsg) -> Unit)?
    var onNavigate: ((NavigateMsg) -> Unit)?

    /**
     * Audio chunk callback: payload + final flag + format / sampleRate
     * threaded from the binary frame's typed header.
     */
    var onAudioChunk: ((data: ByteArray, isFinal: Boolean, format: String, sampleRate: Int) -> Unit)?
    var onConnectionState: ((ConnectionState) -> Unit)?

    /**
     * Fired when the server rejects this device with PAIRING_REQUIRED (4008).
     * The argument is the short pairing code to display. The transport keeps
     * retrying; a later CONNECTED means approval landed. Kept separate from
     * [ConnectionState] so that enum stays 3-valued.
     */
    var onPairingRequired: ((code: String) -> Unit)?
    var onServerHello: ((ServerHello) -> Unit)?

    /** Structured error (rate_limited, session_busy, audio_overflow, etc). */
    var onError: ((ErrorMessage) -> Unit)?

    /**
     * Disposable hint that a UI tap escalated to chat because of missing args.
     * Not replayed on reconnect — no seq.
     */
    var onUiActionEscalated: ((UiActionEscalated) -> Unit)?

    /**
     * Invoked just before sending ClientHello so the caller can attach the
     * current UI nav state (active app/face). Read fresh at every (re)connect
     * so reconnects pick up the app/face the user is on now.
     */
    var navIntentProvider: (() -> NavIntent)?

    /**
     * Currently-bound session id, read by the ViewModel to suppress self-
     * originated broadcasts (e.g. the `resetNotice` frame: siblings flash
     * a banner; the originator does not). Null whenever no session is
     * active.
     */
    val sessionId: String?

    // -- Lifecycle ------------------------------------------------------------

    fun connect(
        deviceClass: String = "watch",
        width: Int = 192,
        height: Int = 192,
        deviceId: String,
    )

    fun disconnect()

    /** App foreground state — gates the pairing-poll battery use (see impl). */
    fun setForeground(fg: Boolean)

    // -- Outbound messages ----------------------------------------------------

    /**
     * Invoke a tool from a face's UI action. Mirrors the agent loop's tool
     * dispatch — same code path on the server, just initiated by user tap.
     *
     * `args` is the resolved Struct payload — the dispatcher must substitute
     * any `{path: "..."}` placeholders against face data + itemScope +
     * `/$form/...` before reaching here. `clientRequestId` enables persistent
     * dedup if the message is replayed via the offline queue.
     */
    fun sendInvokeTool(
        toolName: String,
        args: Map<String, Any?>?,
        sourceFaceId: String,
        clientRequestId: String,
    )

    /**
     * Send a user text turn. If [clientMsgId] is null a fresh UUID is
     * generated so server-side idempotency dedup works across reconnects.
     */
    fun sendChatInput(
        scope: String,
        text: String,
        clientMsgId: String? = null,
        originConversationId: String? = null,
    )

    /**
     * Request older chat history below `beforeSeq` for `scope`. Server
     * replies via [onChatHistory]. `beforeSeq <= 0` returns the newest page.
     */
    fun sendFetchOlder(scope: String, beforeSeq: Long, limit: Int = 50)

    /**
     * Announce the scope the UI is currently showing. Transports suppress
     * duplicate sends — emitting only when `scope` differs from the last
     * sent value (reset to null on each hello-ok).
     */
    fun sendViewing(scope: String)

    /**
     * Request server-side conversation reset for [scope].
     */
    fun sendResetConversation(scope: String)

    /**
     * Stream an audio chunk to the server. [format] + [sampleRate] are
     * required (no defaults inside the transport — callers thread the
     * device's actual capture parameters).
     */
    fun sendAudioInput(
        data: ByteArray,
        format: String,
        sampleRate: Int,
        final: Boolean,
        scope: String,
        clientMsgId: String? = null,
    )

    // -- Internal hello handling --------------------------------------------

    /**
     * Record the sessionId from the server hello before [onServerHello] fires.
     */
    fun onHello(hello: ServerHello)

    // -- Connection state -----------------------------------------------------

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
