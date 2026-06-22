package com.moumantai.client.state

import android.content.Context
import android.media.AudioManager
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.moumantai.audio.AudioPlayer
import com.moumantai.client.audio.AudioConfig
import com.moumantai.client.audio.AudioRecorder
import com.moumantai.client.transport.MoumantaiTransport
import com.moumantai.client.transport.NavIntent
import com.moumantai.client.transport.NetworkMonitor
import com.moumantai.client.transport.OfflineQueue
import com.moumantai.client.util.safeLog
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.AppListMsg
import com.moumantai.protocol.v1.ChatHistoryMsg
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.ChatUpdateMsg
import com.moumantai.protocol.v1.ChatWindowMsg
import com.moumantai.protocol.v1.ErrorMessage
import com.moumantai.protocol.v1.FaceListMsg
import com.moumantai.protocol.v1.FaceUpdateMsg
import com.moumantai.protocol.v1.NavigateMsg
import com.moumantai.protocol.v1.ProtocolErrorCode
import com.moumantai.protocol.v1.ResetNoticeMsg
import com.moumantai.protocol.v1.TurnStatus
import com.moumantai.protocol.v1.UiActionEscalated
import com.moumantai.protocol.v1.VoiceState
import com.moumantai.protocol.v1.VoiceStateValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.sqrt

/**
 * Central state holder for the Moumantai Android client.
 *
 * Owns the [MoumantaiTransport] instance, wires its callbacks to [StateFlow]s,
 * and processes incoming app/face messages (appList, faceList, faceUpdate, navigate)
 * to maintain [AppState] objects that the Compose UI layer observes.
 *
 * All wire types are Wire-typed `com.moumantai.protocol.v1.*` — the ViewModel
 * stores them directly, with light keying / lookups for chat-message log
 * mutations.
 */
class AppViewModel : ViewModel() {

    // -- Transport (created on connect) ---------------------------------------

    private var transport: MoumantaiTransport? = null
    private var networkMonitor: NetworkMonitor? = null
    private var offlineQueue: OfflineQueue? = null

    // -- Connection state -----------------------------------------------------

    private val _connectionState = MutableStateFlow(MoumantaiTransport.ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<MoumantaiTransport.ConnectionState> = _connectionState.asStateFlow()

    /**
     * UI-facing connection indicator derived from [connectionState] with debounce
     * and offline-escalation timing. See [deriveDisplayState].
     */
    val displayState: StateFlow<DisplayState> =
        deriveDisplayState(viewModelScope, _connectionState)

    /**
     * Short pairing code while the server is rejecting this device with
     * PAIRING_REQUIRED; null once connected. Surfaced on the Config screen.
     */
    private val _pairingCode = MutableStateFlow<String?>(null)
    val pairingCode: StateFlow<String?> = _pairingCode.asStateFlow()

    private val _sessionId = MutableStateFlow<String?>(null)
    val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

    private val _lastError = MutableStateFlow<ErrorMessage?>(null)

    /** Last structured error received from the server (rate_limited, session_busy, etc). */
    val lastError: StateFlow<ErrorMessage?> = _lastError.asStateFlow()

    /** True when the OS reports no reachable internet. */
    private val _isOffline = MutableStateFlow(false)
    val isOffline: StateFlow<Boolean> = _isOffline.asStateFlow()

    // -- Apps -----------------------------------------------------------------

    private val _apps = MutableStateFlow<List<AppState>>(emptyList())
    val apps: StateFlow<List<AppState>> = _apps.asStateFlow()

    private val _activeAppIndex = MutableStateFlow(0)
    val activeAppIndex: StateFlow<Int> = _activeAppIndex.asStateFlow()

    // -- Chat (for home / active app) -----------------------------------------

    private val _chatMessagesByApp = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val chatMessagesByApp: StateFlow<Map<String, List<ChatMessage>>> = _chatMessagesByApp.asStateFlow()

    /**
     * Latest `conversationId` per appId, learned from `chatWindow` / `chat` frames.
     * Stamped onto optimistic user bubbles so the UI shows a consistent value
     * until the server echo arrives with its authoritative id.
     */
    private val _conversationIdByApp = MutableStateFlow<Map<String, String>>(emptyMap())

    private val _voiceState = MutableStateFlow(idleVoiceState())
    val voiceState: StateFlow<VoiceState> = _voiceState.asStateFlow()

    /**
     * Per-scope "thinking" flag. Derived entirely from server-side turn
     * status (chatUpdate + chatWindow + the assistant row's arrival):
     * a scope is thinking iff its last user row is pending/running.
     */
    private val _thinkingScopes = MutableStateFlow<Set<String>>(emptySet())
    val thinkingScopes: StateFlow<Set<String>> = _thinkingScopes.asStateFlow()

    /** Per-scope safety-timer handles for the escalation thinking-indicator.
     *  Cancelled when the chat-log derivation runs (typed-chat lifecycle takes
     *  over) or when a follow-up tap supersedes the timer. */
    private val thinkingScopeTimers = mutableMapOf<String, kotlinx.coroutines.Job>()

    /** Transient user-visible notices. */
    private val _transientNotice = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 4)
    val transientNotice: SharedFlow<String> = _transientNotice.asSharedFlow()

    /**
     * Disposable event: server asked the chat surface to open for a given scope.
     * Emitted when [handleUiActionEscalated] receives a [UiActionEscalated] whose
     * scope matches the currently-active app. The UI collects this and sets its
     * local `chatOpen` flag; the frame is not replayed on reconnect.
     */
    private val _openChatForScope = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 1)
    val openChatForScope: SharedFlow<String> = _openChatForScope.asSharedFlow()

    /**
     * Per-scope flash marker emitted when another device issued `/reset`.
     * The UI renders a small banner ("Conversation reset from another
     * device") while the value is non-null; [RESET_NOTICE_FLASH_MS] later
     * the key is cleared.
     *
     * Self-originated notices (requesterSessionId == our session id) are
     * suppressed — the user already knows they reset it.
     */
    private val _resetNoticeByScope = MutableStateFlow<Map<String, ResetNoticeFlash>>(emptyMap())
    val resetNoticeByScope: StateFlow<Map<String, ResetNoticeFlash>> =
        _resetNoticeByScope.asStateFlow()

    /** Timers that clear each scope's banner after [RESET_NOTICE_FLASH_MS]. */
    private val resetNoticeClearJobs = mutableMapOf<String, Job>()

    // -- Fetch-older pagination state -----------------------------------------

    enum class LoadOlderState { IDLE, LOADING, EXHAUSTED }

    data class LoadOlder(
        val state: LoadOlderState = LoadOlderState.IDLE,
        val inflightConvId: String? = null,
        val hasMore: Boolean = true,
    )

    private val _loadOlder = MutableStateFlow<Map<String, LoadOlder>>(emptyMap())
    val loadOlder: StateFlow<Map<String, LoadOlder>> = _loadOlder.asStateFlow()

    /**
     * Tracks the minimum seq seen for each appId. Updated whenever a
     * [ChatWindowMsg] or [ChatHistoryMsg] delivers entries with seq values.
     * Used as the `before_seq` cursor for [sendFetchOlder].
     */
    private val minSeqByApp = mutableMapOf<String, Long>()

    // -- Voice capture & playback ---------------------------------------------

    private var audioRecorder: AudioRecorder? = null
    private val audioPlayer = AudioPlayer()
    private var currentVoiceScope: String? = null

    /**
     * Last scope we handed to [MoumantaiTransport.sendViewing] from the ViewModel
     * layer. Used to deduplicate calls triggered by repeated pager events.
     * Reset to null on disconnect so the next reconnect re-announces.
     */
    private var lastSubscribedScope: String? = null

    /** Normalized RMS of the most recent audio chunk (0..1). Drives the mic-button pulse. */
    private val _micAmplitude = MutableStateFlow(0f)
    val micAmplitude: StateFlow<Float> = _micAmplitude.asStateFlow()

    /**
     * Outstanding 15s TTL timers, keyed by clientMsgId. Started on send and
     * cancelled when the server's user-echo `chat` frame or a `chatUpdate`
     * moves the bubble past `pending`. If the timer fires first, the bubble
     * flips to local status="unsent" so the UI can offer a retry.
     */
    private val optimisticTtlJobs = mutableMapOf<String, Job>()

    /**
     * Pending image bytes keyed by `clientMsgId`. Held until the server-echoed
     * row arrives (non-pending status), so [retryChatMessage] can re-attach them.
     * In-memory only — on process restart an UNSENT bubble loses its bytes and
     * retry degrades to text-only.
     */
    private data class PendingImage(val originalText: String, val bytes: ByteArray, val mimeType: String)
    private val pendingImageByMsgId = mutableMapOf<String, PendingImage>()

    /**
     * `chatUpdate` frames for ids we don't yet have in the log. Keyed by
     * the server-assigned row id. A subsequent `chat` or `chatWindow` that
     * introduces the row triggers a drain; unmatched entries TTL-evict after
     * [PENDING_UPDATE_TTL_MS].
     */
    private val pendingUpdates = mutableMapOf<String, PendingUpdate>()
    private val pendingEvictionJobs = mutableMapOf<String, Job>()

    data class PendingUpdate(val msg: ChatUpdateMsg, val deadlineMs: Long)

    // VAD state — tracked per capture session
    private var captureStartMs = 0L
    private var lastVoiceMs = 0L
    private var hasDetectedVoice = false

    // -- Public API -----------------------------------------------------------

    /**
     * Trigger a "load older messages" page fetch for [scope]. No-op while
     * a request is already in-flight ([LoadOlderState.LOADING]) or the server
     * confirmed there are no more older entries ([LoadOlderState.EXHAUSTED]).
     *
     * Uses [minSeqByApp] as the `before_seq` cursor; 0 when no seq has been
     * observed yet (server treats 0 as "from newest" — same as chatWindow).
     */
    fun loadOlderChat(scope: String) {
        val current = _loadOlder.value[scope] ?: LoadOlder()
        if (current.state != LoadOlderState.IDLE) return

        val appId = scopeToAppId(scope)
        val beforeSeq = minSeqByApp[appId] ?: 0L
        val currentConvId = _conversationIdByApp.value[appId] ?: ""
        _loadOlder.value = _loadOlder.value + (
            scope to current.copy(
                state = LoadOlderState.LOADING,
                inflightConvId = currentConvId,
            )
            )
        transport?.sendFetchOlder(scope, beforeSeq, 50)
    }

    /**
     * Connect to the Moumantai server at the given WebSocket URL.
     *
     * @param deviceClass "phone" / "watch" / "iot-small" / "hmi-panel" — drives
     *   component filtering server-side. If null, transport default applies.
     * @param widthDp / heightDp — screen dimensions in dp.
     */
    fun connect(
        serverUrl: String,
        deviceClass: String? = null,
        widthDp: Int? = null,
        heightDp: Int? = null,
        appContext: Context? = null,
        deviceId: String,
    ) {
        transport?.disconnect()
        if (appContext != null) {
            if (offlineQueue == null) offlineQueue = OfflineQueue(appContext)
            audioPlayer.bindAudioManager(appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)
            if (networkMonitor == null) {
                val nm = NetworkMonitor(appContext)
                networkMonitor = nm
                nm.onAvailable = { transport?.reconnectNow() }
                nm.start()
                viewModelScope.launch {
                    nm.isOnline.collect { _isOffline.value = !it }
                }
            }
        }

        val t = MoumantaiTransport(serverUrl)
        transport = t
        wireTransportCallbacks(t)
        if (deviceClass != null && widthDp != null && heightDp != null) {
            t.connect(deviceClass = deviceClass, width = widthDp, height = heightDp, deviceId = deviceId)
        } else {
            t.connect(deviceId = deviceId)
        }
    }

    /**
     * Disconnect from the server and clean up.
     */
    fun disconnect() {
        networkMonitor?.stop()
        networkMonitor = null
        transport?.disconnect()
        transport = null
        _connectionState.value = MoumantaiTransport.ConnectionState.DISCONNECTED
    }

    /** App foreground state — gates pairing-poll battery use (see transport). */
    fun setForeground(fg: Boolean) {
        transport?.setForeground(fg)
    }

    /**
     * Switch the active app by pager index.
     */
    fun switchApp(index: Int) {
        val appList = _apps.value
        if (index < 0 || index >= appList.size) return
        _activeAppIndex.value = index
        evictInactiveApps(index, NEIGHBOR_WINDOW)
        val newScope = appIdToScope(appList[index].appId)
        if (newScope != lastSubscribedScope) {
            transport?.sendViewing(newScope)
            lastSubscribedScope = newScope
        }
    }

    /**
     * Switch the active face within the current app by index. Clears the
     * `$form` scope of the face we're leaving — drafts don't survive nav.
     */
    fun switchFace(appId: String, faceIndex: Int) {
        val appList = _apps.value
        val app = appList.firstOrNull { it.appId == appId } ?: return
        if (faceIndex < 0 || faceIndex >= app.faces.size) return
        val leaving = app.faces.getOrNull(app.activeFaceIndex)
        updateApp(appId) { current ->
            val faces = current.faces.mapIndexed { i, f ->
                if (leaving != null && i == current.activeFaceIndex && i != faceIndex &&
                    f.faceId == leaving.faceId && f.form.isNotEmpty()
                ) {
                    f.copy(form = emptyMap())
                } else {
                    f
                }
            }
            current.copy(activeFaceIndex = faceIndex, faces = faces)
        }
    }

    /**
     * Write a value to a specific face's per-face `$form` scope. Preserved
     * across face refreshes; cleared on navigation.
     */
    fun setFormValue(appId: String, faceId: String, key: String, value: Any?) {
        updateApp(appId) { app ->
            app.copy(
                faces = app.faces.map { f ->
                    if (f.faceId == faceId) f.copy(form = f.form + (key to value)) else f
                },
            )
        }
    }

    /**
     * Convenience: write `key = value` to the *active* face's `$form` scope.
     * Used by the renderer's `LocalFormSetter` Compose hook — no need for
     * the renderer to know which app/face is active.
     */
    fun setFormValueOnActiveFace(key: String, value: Any?) {
        val appList = _apps.value
        val app = appList.getOrNull(_activeAppIndex.value) ?: return
        val face = app.faces.getOrNull(app.activeFaceIndex) ?: return
        setFormValue(app.appId, face.faceId, key, value)
    }

    /**
     * Dispatch a UI action by invoking the named tool through the server.
     * Resolves any `{path: "..."}` placeholders inside `args` against face
     * data + itemScope + per-face `/$form/...` before sending. Generates a
     * fresh `clientRequestId` (UUID) per dispatch.
     */
    fun sendAction(action: Action?, itemScope: Map<String, Any?>? = null) {
        if (action == null || action.tool.isEmpty()) return
        val appList = _apps.value
        val app = appList.getOrNull(_activeAppIndex.value) ?: return
        val face = app.faces.getOrNull(app.activeFaceIndex) ?: return
        val resolved = resolveActionArgs(action.args, face.data, face.form, itemScope)
        val clientRequestId = UUID.randomUUID().toString()

        // Online: send through the live socket. Offline: persist to the
        // OfflineQueue so the tap survives the outage; the same client_request_id
        // makes the server's invoke_dedup table dedupe on replay.
        if (_connectionState.value == MoumantaiTransport.ConnectionState.CONNECTED) {
            transport?.sendInvokeTool(
                toolName = action.tool,
                args = resolved,
                sourceFaceId = face.faceId,
                clientRequestId = clientRequestId,
            )
        } else {
            offlineQueue?.enqueueInvokeTool(
                scope = appIdToScope(app.appId),
                toolName = action.tool,
                args = resolved,
                sourceFaceId = face.faceId,
                clientRequestId = clientRequestId,
                originConversationId = _conversationIdByApp.value[app.appId],
            )
        }
    }

    private fun resolveActionArgs(
        args: Map<String, *>?,
        faceData: Map<String, Any?>,
        form: Map<String, Any?>,
        itemScope: Map<String, Any?>?,
    ): Map<String, Any?>? {
        if (args == null) return null
        return args.mapValues { (_, v) -> resolveActionValue(v, faceData, form, itemScope) }
    }

    /**
     * Walk a Struct value and substitute `{path: "..."}` placeholders.
     *   - `/$form/<key>`            → form scope
     *   - `$.<field>` or `<field>`  → itemScope (list row)
     *   - `/...`                    → JSON-Pointer into face data
     */
    private fun resolveActionValue(
        value: Any?,
        faceData: Map<String, Any?>,
        form: Map<String, Any?>,
        itemScope: Map<String, Any?>?,
    ): Any? {
        if (value == null) return null
        if (value is Map<*, *>) {
            val maybePath = value["path"]
            if (maybePath is String && value.size == 1) {
                return resolvePath(maybePath, faceData, form, itemScope)
            }
            @Suppress("UNCHECKED_CAST")
            return (value as Map<String, Any?>).mapValues { (_, v) ->
                resolveActionValue(v, faceData, form, itemScope)
            }
        }
        if (value is List<*>) {
            return value.map { resolveActionValue(it, faceData, form, itemScope) }
        }
        return value
    }

    private fun resolvePath(
        path: String,
        faceData: Map<String, Any?>,
        form: Map<String, Any?>,
        itemScope: Map<String, Any?>?,
    ): Any? {
        if (path.startsWith("/\$form/")) {
            return form[path.removePrefix("/\$form/")]
        }
        if (path.startsWith("/")) {
            return resolveJsonPointer(faceData, path)
        }
        if (itemScope != null) {
            val key = if (path.startsWith("$.")) path.removePrefix("$.") else path
            return itemScope[key]
        }
        return faceData[path]
    }

    private fun resolveJsonPointer(root: Map<String, Any?>, pointer: String): Any? {
        if (pointer.isEmpty() || pointer == "/") return root
        var cur: Any? = root
        for (raw in pointer.removePrefix("/").split("/")) {
            val key = raw.replace("~1", "/").replace("~0", "~")
            cur = when (cur) {
                is Map<*, *> -> cur[key]
                is List<*> -> cur.getOrNull(key.toIntOrNull() ?: return null)
                else -> return null
            }
        }
        return cur
    }

    /**
     * Send a text (and optional image) chat message. Intercepts `/reset`.
     * For normal turns, stamps a fresh `clientMsgId` onto an optimistic bubble.
     *
     * @param imageBytes JPEG-encoded image from [com.moumantai.client.camera.CameraCapture].
     *   Optimistic bubble shows `"[image]"` when text is empty, matching the server broadcast.
     * @param mimeType MIME type for [imageBytes] (default `"image/jpeg"`).
     */
    fun sendChatInput(
        scope: String,
        text: String,
        imageBytes: ByteArray? = null,
        mimeType: String = "image/jpeg",
    ) {
        val trimmed = text.trim()
        if (trimmed.equals("/reset", ignoreCase = true)) {
            val connected = _connectionState.value == MoumantaiTransport.ConnectionState.CONNECTED
            if (connected) {
                transport?.sendResetConversation(scope)
            } else {
                _transientNotice.tryEmit("Reset works only while connected.")
            }
            return
        }

        if (text.isEmpty() && imageBytes == null) return

        val appId = scopeToAppId(scope)
        val clientMsgId = java.util.UUID.randomUUID().toString()
        val connected = _connectionState.value == MoumantaiTransport.ConnectionState.CONNECTED
        // Same rule as server's runUserTurn — keeps the optimistic bubble
        // text identical to what the server will broadcast back.
        val displayText = text.ifEmpty { if (imageBytes != null) "[image]" else "" }
        val userMsg = ChatMessage(
            id = "local-$clientMsgId",
            scope = scope,
            conversation_id = _conversationIdByApp.value[appId] ?: "",
            role = com.moumantai.protocol.v1.ChatRole.CHAT_ROLE_USER,
            text = displayText,
            timestamp = java.time.Instant.now().toString(),
            client_msg_id = clientMsgId,
            // Optimistic pending status when we're actually sending so the
            // thinking indicator derivation lights up immediately.
            status = if (connected) TurnStatus.TURN_STATUS_PENDING else null,
        )
        appendChatMessage(appId, userMsg)
        refreshThinkingForScope(scope)

        // Hold image bytes for the retry window; released on server-echo reconciliation.
        if (imageBytes != null) {
            pendingImageByMsgId[clientMsgId] = PendingImage(text, imageBytes, mimeType)
        }

        val originConv = _conversationIdByApp.value[appId]?.takeIf { it.isNotEmpty() }
        if (connected) {
            transport?.sendChatInput(scope, text, clientMsgId, imageBytes, mimeType)
            scheduleOptimisticTtl(appId, scope, clientMsgId)
        } else {
            offlineQueue?.enqueueChatInput(
                scope = scope,
                text = text,
                clientMsgId = clientMsgId,
                originConversationId = originConv,
                imageBytes = imageBytes,
                imageMimeType = if (imageBytes != null) mimeType else null,
            )
        }
    }

    /**
     * Start capturing audio from the microphone and streaming it to the server.
     */
    fun startVoiceCapture(scope: String, recorder: AudioRecorder) {
        if (_voiceState.value.state != VoiceStateValue.VOICE_STATE_VALUE_IDLE) return
        if (_connectionState.value != MoumantaiTransport.ConnectionState.CONNECTED) return

        val t = transport ?: return
        audioRecorder = recorder
        currentVoiceScope = scope

        captureStartMs = System.currentTimeMillis()
        lastVoiceMs = captureStartMs
        hasDetectedVoice = false
        _micAmplitude.value = 0f

        val started = recorder.start { chunk ->
            val rms = computeRms(chunk)
            _micAmplitude.value = rms

            t.sendAudioInput(
                data = chunk,
                format = AudioConfig.FORMAT,
                sampleRate = AudioConfig.SAMPLE_RATE,
                final = false,
                scope = scope,
            )

            val now = System.currentTimeMillis()
            if (rms >= AudioConfig.VAD_VOICE_THRESHOLD) {
                hasDetectedVoice = true
                lastVoiceMs = now
            }
            val silenceTooLong = hasDetectedVoice &&
                (now - lastVoiceMs) >= AudioConfig.VAD_SILENCE_TIMEOUT_MS
            val overMaxDuration = (now - captureStartMs) >= AudioConfig.MAX_UTTERANCE_MS
            if (silenceTooLong || overMaxDuration) {
                viewModelScope.launch(Dispatchers.Main) { stopVoiceCapture() }
            }
        }

        if (started) {
            _voiceState.value = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_LISTENING)
        } else {
            audioRecorder = null
            currentVoiceScope = null
            _micAmplitude.value = 0f
        }
    }

    /**
     * RMS of a PCM16 little-endian mono chunk, normalized to 0..1.
     */
    private fun computeRms(pcm: ByteArray): Float {
        if (pcm.size < 2) return 0f
        var sum = 0.0
        var count = 0
        var i = 0
        while (i + 1 < pcm.size) {
            val lo = pcm[i].toInt() and 0xff
            val hi = pcm[i + 1].toInt()
            val sample = (hi shl 8) or lo
            sum += (sample * sample).toDouble()
            count++
            i += 2
        }
        if (count == 0) return 0f
        val rms = sqrt(sum / count)
        return (rms / 32768.0).toFloat().coerceIn(0f, 1f)
    }

    /**
     * Stop recording and send the final audio chunk.
     */
    fun stopVoiceCapture() {
        val recorder = audioRecorder ?: return
        val scope = currentVoiceScope ?: return

        val finalChunk = recorder.stop()
        audioRecorder = null
        _micAmplitude.value = 0f
        currentVoiceScope = null

        if (_voiceState.value.state != VoiceStateValue.VOICE_STATE_VALUE_LISTENING) return

        val t = transport
        val connected = _connectionState.value == MoumantaiTransport.ConnectionState.CONNECTED
        if (t != null && connected) {
            t.sendAudioInput(
                data = finalChunk,
                format = AudioConfig.FORMAT,
                sampleRate = AudioConfig.SAMPLE_RATE,
                final = true,
                scope = scope,
            )
            _voiceState.value = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_THINKING)
        } else {
            _voiceState.value = idleVoiceState()
        }
    }

    /**
     * Interrupt current voice playback and return to idle.
     */
    fun interruptPlayback() {
        audioPlayer.stop()
        _voiceState.value = idleVoiceState()
    }

    /**
     * Reset voice state to idle. Used for error recovery or cleanup.
     */
    fun resetVoiceState() {
        audioRecorder?.stop()
        audioRecorder = null
        audioPlayer.stop()
        currentVoiceScope = null
        _micAmplitude.value = 0f
        _voiceState.value = idleVoiceState()
    }

    override fun onCleared() {
        super.onCleared()
        resetVoiceState()
        disconnect()
    }

    // -- Transport callback wiring --------------------------------------------

    private fun wireTransportCallbacks(t: MoumantaiTransport) {
        t.navIntentProvider = {
            val list = _apps.value
            val idx = _activeAppIndex.value
            val app = list.getOrNull(idx)
            val appId = app?.appId
            val faceId = app?.faces?.getOrNull(app.activeFaceIndex)?.faceId
            NavIntent(currentAppId = appId, currentFaceId = faceId)
        }

        t.onConnectionState = { state ->
            _connectionState.value = state
            if (state == MoumantaiTransport.ConnectionState.DISCONNECTED) {
                if (_voiceState.value.state != VoiceStateValue.VOICE_STATE_VALUE_IDLE) resetVoiceState()
                lastSubscribedScope = null
            }
            if (state == MoumantaiTransport.ConnectionState.CONNECTED) {
                _pairingCode.value = null
                flushOfflineQueue()
            }
        }

        t.onPairingRequired = { code ->
            _pairingCode.value = code
        }

        t.onServerHello = { hello ->
            _sessionId.value = hello.session_id
        }

        t.onError = { err -> handleTransportError(err) }
        t.onUiActionEscalated = { msg -> handleUiActionEscalated(msg) }

        t.onAppList = { msg -> handleAppList(msg) }
        t.onFaceList = { msg -> handleFaceList(msg) }
        t.onFaceUpdate = { msg -> handleFaceUpdate(msg) }
        t.onNavigate = { msg -> handleNavigate(msg) }

        t.onChatMessage = { msg -> handleIncomingChatMessage(msg) }
        t.onChatUpdate = { msg -> handleChatUpdate(msg) }

        t.onChatWindow = { msg -> handleChatWindow(msg) }
        t.onChatHistory = { msg -> handleChatHistory(msg) }
        t.onResetNotice = { msg -> handleResetNotice(msg) }

        t.onVoiceState = { state ->
            _voiceState.value = state
        }

        t.onAudioChunk = { data, isFinal, format, sampleRate ->
            if (_voiceState.value.state == VoiceStateValue.VOICE_STATE_VALUE_THINKING) {
                _voiceState.value = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_SPEAKING)
            }
            audioPlayer.play(data, format, sampleRate)
            if (isFinal && !audioPlayer.isPlaying()) {
                _voiceState.value = idleVoiceState()
            }
        }
    }

    // -- Message handlers -----------------------------------------------------

    private fun handleAppList(msg: AppListMsg) {
        val current = _apps.value
        val newApps = msg.apps.sortedBy { it.position }.map { info ->
            val existing = current.find { it.appId == info.app_id }
            AppState(
                appId = info.app_id,
                label = info.label,
                icon = info.icon,
                position = info.position,
                faces = existing?.faces ?: emptyList(),
                activeFaceIndex = existing?.activeFaceIndex ?: 0,
            )
        }
        _apps.value = newApps

        if (_activeAppIndex.value >= newApps.size && newApps.isNotEmpty()) {
            _activeAppIndex.value = newApps.size - 1
        }
    }

    private fun handleFaceList(msg: FaceListMsg) {
        updateApp(msg.app_id) { app ->
            val newFaces = msg.faces.sortedBy { it.position }.map { info ->
                val existing = app.faces.find { it.faceId == info.face_id }
                FaceState(
                    faceId = info.face_id,
                    label = info.label,
                    position = info.position,
                    components = existing?.components ?: emptyMap(),
                    data = existing?.data ?: emptyMap(),
                    form = existing?.form ?: emptyMap(),
                )
            }
            app.copy(
                faces = newFaces,
                activeFaceIndex = if (app.activeFaceIndex >= newFaces.size) 0 else app.activeFaceIndex,
            )
        }
    }

    private fun handleFaceUpdate(msg: FaceUpdateMsg) {
        try {
            val newComponents = msg.components.associateBy { it.id }

            // STRUCT_MAP decodes into Map<String, *> — pass through to the
            // renderer's data model unchanged (the resolver navigates through
            // nested maps and lists).
            @Suppress("UNCHECKED_CAST")
            val newData = (msg.data_ ?: emptyMap<String, Any?>()) as Map<String, Any?>

            updateApp(msg.app_id) { app ->
                val faceIndex = app.faces.indexOfFirst { it.faceId == msg.face_id }
                if (faceIndex == -1) {
                    app.copy(
                        faces = app.faces + FaceState(
                            faceId = msg.face_id,
                            components = newComponents,
                            data = newData,
                        ),
                    )
                } else {
                    val updatedFaces = app.faces.toMutableList()
                    updatedFaces[faceIndex] = app.faces[faceIndex].copy(
                        components = newComponents,
                        data = newData,
                    )
                    app.copy(faces = updatedFaces)
                }
            }
        } catch (e: Exception) {
            safeLog("AppViewModel", "Failed to handle faceUpdate", e)
        }
    }

    /**
     * Reconcile a server → client chat frame against any optimistic bubble
     * with the matching `clientMsgId`.
     */
    private fun handleIncomingChatMessage(msg: ChatMessage) {
        val appId = scopeToAppId(msg.scope)
        if (msg.conversation_id.isNotEmpty()) {
            _conversationIdByApp.value = _conversationIdByApp.value + (appId to msg.conversation_id)
        }
        val existing = _chatMessagesByApp.value[appId].orEmpty()
        if (msg.client_msg_id != null) {
            val idx = existing.indexOfFirst { it.client_msg_id == msg.client_msg_id }
            if (idx >= 0) {
                val rebuilt = existing.toMutableList().also { it[idx] = msg }
                _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to rebuilt)
            } else {
                appendChatMessage(appId, msg)
            }
            cancelOptimisticTtl(msg.client_msg_id)
            // Server has authoritatively received the message — release any
            // image bytes we were holding for retry.
            pendingImageByMsgId.remove(msg.client_msg_id)
        } else {
            appendChatMessage(appId, msg)
        }
        refreshThinkingForScope(msg.scope)
        if (msg.role == com.moumantai.protocol.v1.ChatRole.CHAT_ROLE_ASSISTANT &&
            _voiceState.value.state == VoiceStateValue.VOICE_STATE_VALUE_THINKING
        ) {
            _voiceState.value = idleVoiceState()
        }
        drainPendingUpdates()
    }

    /**
     * Replace the chat log for a single scope with the server's authoritative
     * snapshot. Optimistic bubbles (those carrying a local `clientMsgId` that
     * isn't echoed back) are preserved.
     */
    private fun handleChatWindow(msg: ChatWindowMsg) {
        val appId = scopeToAppId(msg.scope)
        _conversationIdByApp.value = _conversationIdByApp.value + (appId to msg.conversation_id)

        // Map ChatWindowEntry → ChatMessage so the existing log shape stays
        // homogeneous (server sends `chat` frames AND `chatWindow` snapshots
        // through the same on-screen list).
        val serverEntries = msg.entries.map { e ->
            ChatMessage(
                id = e.id,
                scope = msg.scope,
                conversation_id = msg.conversation_id,
                role = e.role,
                text = e.text,
                timestamp = e.created_at,
                client_msg_id = e.client_msg_id,
                status = e.status,
                failure_reason = e.failure_reason,
                origin_device_id = e.origin_device_id,
            )
        }
        val serverIds = msg.entries.mapTo(HashSet(msg.entries.size)) { it.id }
        val serverClientMsgIds = msg.entries.mapNotNullTo(HashSet<String>()) { it.client_msg_id }
        val oldList = _chatMessagesByApp.value[appId].orEmpty()
        val preservedOptimistic = oldList.filter {
            it.client_msg_id != null &&
                it.conversation_id == msg.conversation_id &&
                it.id !in serverIds &&
                it.client_msg_id !in serverClientMsgIds
        }

        val rebuilt = (serverEntries + preservedOptimistic).takeLast(CHAT_LOG_CAP)
        _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to rebuilt)

        // Track the minimum seq observed so loadOlderChat has an accurate cursor.
        if (msg.entries.isNotEmpty()) {
            val minSeq = msg.entries.minOf { it.seq }
            val current = minSeqByApp[appId]
            if (current == null || minSeq < current) minSeqByApp[appId] = minSeq
        }
        // A chatWindow always signals a fresh conversation — reset load-older state.
        _loadOlder.value = _loadOlder.value - msg.scope

        refreshThinkingForScope(msg.scope)
        drainPendingUpdates()
    }

    /**
     * Handle a paged history response for a [loadOlderChat] request. Prepends
     * new entries (existing ids skipped — in-memory status may be newer).
     * Discards stale responses whose conversation_id no longer matches.
     */
    private fun handleChatHistory(msg: ChatHistoryMsg) {
        val appId = scopeToAppId(msg.scope)
        val currentConvId = _conversationIdByApp.value[appId] ?: ""
        val lo = _loadOlder.value[msg.scope]

        // Discard post-reset stale response.
        if (msg.conversation_id != currentConvId) {
            _loadOlder.value = _loadOlder.value + (msg.scope to LoadOlder())
            return
        }

        // Prepend entries, deduping by id. Existing entries take precedence
        // (they may have a more-recent status from a ChatUpdateMsg).
        val existing = _chatMessagesByApp.value[appId].orEmpty()
        val existingIds = existing.mapTo(HashSet(existing.size)) { it.id }
        val newEntries = msg.entries
            .filter { it.id !in existingIds }
            .map { e ->
                ChatMessage(
                    id = e.id,
                    scope = msg.scope,
                    conversation_id = msg.conversation_id,
                    role = e.role,
                    text = e.text,
                    timestamp = e.created_at,
                    client_msg_id = e.client_msg_id,
                    status = e.status,
                    failure_reason = e.failure_reason,
                    origin_device_id = e.origin_device_id,
                )
            }
        if (newEntries.isNotEmpty()) {
            val merged = (newEntries + existing).takeLast(CHAT_LOG_CAP)
            _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to merged)

            // Update the oldest-seq cursor.
            val minSeq = msg.entries.minOf { it.seq }
            val current = minSeqByApp[appId]
            if (current == null || minSeq < current) minSeqByApp[appId] = minSeq
        }

        // Advance state machine.
        val newState = if (msg.has_more) LoadOlderState.IDLE else LoadOlderState.EXHAUSTED
        _loadOlder.value = _loadOlder.value + (
            msg.scope to LoadOlder(
                state = newState,
                inflightConvId = null,
                hasMore = msg.has_more,
            )
            )
    }

    /**
     * Apply an incremental turn status update.
     */
    private fun handleChatUpdate(msg: ChatUpdateMsg) {
        val appId = scopeToAppId(msg.scope)
        val existing = _chatMessagesByApp.value[appId]
        val idx = existing?.indexOfFirst { it.id == msg.id } ?: -1
        if (existing == null || idx < 0) {
            enqueuePendingUpdate(msg)
            return
        }
        applyChatUpdate(msg, existing, idx)
    }

    private fun applyChatUpdate(msg: ChatUpdateMsg, log: List<ChatMessage>, idx: Int) {
        val appId = scopeToAppId(msg.scope)
        val patched = log[idx].copy(
            status = msg.status,
            failure_reason = msg.failure_reason,
            origin_device_id = log[idx].origin_device_id ?: msg.origin_device_id,
        )
        val rebuilt = log.toMutableList().also { it[idx] = patched }
        _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to rebuilt)

        if (msg.status != TurnStatus.TURN_STATUS_PENDING) cancelOptimisticTtl(patched.client_msg_id)
        refreshThinkingForScope(msg.scope)
    }

    /**
     * Another-device `/reset` landed on this scope. Flash a banner.
     */
    internal fun handleResetNotice(msg: ResetNoticeMsg) {
        val mySessionId = transport?.sessionId
        if (mySessionId != null && msg.requester_session_id == mySessionId) {
            return
        }
        // Reset load-older state for the scope: the conversation is fresh after
        // a reset, so any in-flight or exhausted pagination state is stale.
        _loadOlder.value = _loadOlder.value + (msg.scope to LoadOlder())
        minSeqByApp.remove(scopeToAppId(msg.scope))

        val flash = ResetNoticeFlash(
            conversationId = msg.conversation_id,
            timestamp = msg.timestamp,
        )
        _resetNoticeByScope.value = _resetNoticeByScope.value + (msg.scope to flash)
        resetNoticeClearJobs.remove(msg.scope)?.cancel()
        resetNoticeClearJobs[msg.scope] = viewModelScope.launch {
            delay(RESET_NOTICE_FLASH_MS)
            _resetNoticeByScope.value = _resetNoticeByScope.value - msg.scope
            resetNoticeClearJobs.remove(msg.scope)
        }
    }

    private fun enqueuePendingUpdate(msg: ChatUpdateMsg) {
        pendingEvictionJobs.remove(msg.id)?.cancel()
        pendingUpdates[msg.id] = PendingUpdate(
            msg = msg,
            deadlineMs = System.currentTimeMillis() + PENDING_UPDATE_TTL_MS,
        )
        pendingEvictionJobs[msg.id] = viewModelScope.launch {
            delay(PENDING_UPDATE_TTL_MS)
            pendingUpdates.remove(msg.id)
            pendingEvictionJobs.remove(msg.id)
        }
    }

    private fun drainPendingUpdates() {
        if (pendingUpdates.isEmpty()) return
        val now = System.currentTimeMillis()
        val iter = pendingUpdates.entries.iterator()
        while (iter.hasNext()) {
            val (id, pu) = iter.next()
            if (pu.deadlineMs <= now) {
                pendingEvictionJobs.remove(id)?.cancel()
                iter.remove()
                continue
            }
            val appId = scopeToAppId(pu.msg.scope)
            val log = _chatMessagesByApp.value[appId] ?: continue
            val rowIdx = log.indexOfFirst { it.id == pu.msg.id }
            if (rowIdx >= 0) {
                applyChatUpdate(pu.msg, log, rowIdx)
                pendingEvictionJobs.remove(id)?.cancel()
                iter.remove()
            }
        }
    }

    private fun handleUiActionEscalated(msg: UiActionEscalated) {
        val appList = _apps.value
        val activeApp = appList.getOrNull(_activeAppIndex.value) ?: return
        val activeScope = if (activeApp.appId == "home") "home" else "app:${activeApp.appId}"
        if (msg.scope != activeScope) return
        viewModelScope.launch {
            _openChatForScope.emit(msg.scope)
        }
        // Show thinking indicator immediately; chat-log derivation clears it on assistant arrival.
        // 30s safety fallback in case no chat frame arrives (server error mid-flight).
        _thinkingScopes.update { it + msg.scope }
        thinkingScopeTimers[msg.scope]?.cancel()
        thinkingScopeTimers[msg.scope] = viewModelScope.launch {
            delay(30_000)
            _thinkingScopes.update { it - msg.scope }
            thinkingScopeTimers.remove(msg.scope)
        }
    }

    private fun handleNavigate(msg: NavigateMsg) {
        val appList = _apps.value
        val appIndex = appList.indexOfFirst { it.appId == msg.app_id }
        if (appIndex == -1) return

        _activeAppIndex.value = appIndex
        evictInactiveApps(appIndex, NEIGHBOR_WINDOW)

        if (msg.face_id != null) {
            updateApp(msg.app_id) { app ->
                val faceIndex = app.faces.indexOfFirst { it.faceId == msg.face_id }
                if (faceIndex != -1) app.copy(activeFaceIndex = faceIndex) else app
            }
        }
    }

    /**
     * Handle an incoming structured error frame from the transport.
     *
     * Always surfaces the message to the user via [_transientNotice] (collected
     * by MainActivity into a SnackbarHost) — silent failure is a contract
     * violation per shared/protocol/FORM_SCOPE.md. Specific error codes also
     * reset transient UI state (voice mid-flight, queued offline replay).
     */
    private fun handleTransportError(err: ErrorMessage) {
        _lastError.value = err
        if (err.code == ProtocolErrorCode.PROTOCOL_ERROR_CODE_RATE_LIMITED ||
            err.code == ProtocolErrorCode.PROTOCOL_ERROR_CODE_SESSION_BUSY ||
            err.code == ProtocolErrorCode.PROTOCOL_ERROR_CODE_AUDIO_OVERFLOW
        ) {
            val voice = _voiceState.value.state
            if (voice == VoiceStateValue.VOICE_STATE_VALUE_THINKING ||
                voice == VoiceStateValue.VOICE_STATE_VALUE_LISTENING
            ) {
                _voiceState.value = idleVoiceState()
            }
        }
        val notice = if (err.code == ProtocolErrorCode.PROTOCOL_ERROR_CODE_STALE_CONVERSATION) {
            "Queued message dropped — conversation advanced while offline."
        } else {
            err.message?.takeIf { it.isNotBlank() } ?: "Server error"
        }
        _transientNotice.tryEmit(notice)
    }

    /**
     * Replay queued offline user messages FIFO. Called on reconnect.
     */
    private fun flushOfflineQueue() {
        val q = offlineQueue ?: return
        val t = transport ?: return
        q.drain { item ->
            try {
                when (item.kind) {
                    "text" -> {
                        val text = item.text ?: return@drain true
                        // Re-attach staged image if the blob still exists; degrades to text-only if missing.
                        val imageBytes = item.imageBlobPath?.let { q.readImageBlob(item) }
                        t.sendChatInput(
                            scope = item.scope,
                            text = text,
                            clientMsgId = item.clientMsgId,
                            imageBytes = imageBytes,
                            imageMimeType = if (imageBytes != null) item.imageMimeType else null,
                            originConversationId = item.originConversationId,
                        )
                    }
                    "voice" -> {
                        val pcm = q.readVoiceBlob(item) ?: return@drain true
                        t.sendAudioInput(
                            data = pcm,
                            format = item.format,
                            sampleRate = item.sampleRate,
                            final = true,
                            scope = item.scope,
                            clientMsgId = item.clientMsgId,
                        )
                    }
                    "invoke_tool" -> {
                        // Same client_request_id so server's invoke_dedup short-circuits on duplicate.
                        val toolName = item.toolName ?: return@drain true
                        val faceId = item.sourceFaceId ?: ""
                        val args = q.readInvokeToolArgs(item)
                        t.sendInvokeTool(
                            toolName = toolName,
                            args = args,
                            sourceFaceId = faceId,
                            clientRequestId = item.clientMsgId,
                        )
                    }
                    else -> return@drain true
                }
                true
            } catch (_: Throwable) {
                false
            }
        }
    }

    /**
     * Map a wire scope (e.g. "app:weather", "home") to its app ID.
     */
    private fun scopeToAppId(scope: String): String {
        if (scope.startsWith("app:")) return scope.removePrefix("app:")
        return "home"
    }

    /** Inverse of [scopeToAppId]. */
    private fun appIdToScope(appId: String): String = if (appId == "home") "home" else "app:$appId"

    /**
     * Helper to update a specific app in the immutable list by appId.
     */
    private inline fun updateApp(appId: String, transform: (AppState) -> AppState) {
        val current = _apps.value
        val index = current.indexOfFirst { it.appId == appId }
        if (index == -1) return
        val updated = current.toMutableList()
        updated[index] = transform(current[index])
        _apps.value = updated
    }

    /**
     * Append a chat message and enforce the per-app log cap.
     */
    private fun appendChatMessage(appId: String, msg: ChatMessage) {
        val current = _chatMessagesByApp.value
        val merged = (current[appId].orEmpty() + msg).takeLast(CHAT_LOG_CAP)
        _chatMessagesByApp.value = current + (appId to merged)
    }

    /**
     * Retry a locally-unsent user bubble.
     */
    fun retryChatMessage(scope: String, clientMsgId: String) {
        if (_connectionState.value != MoumantaiTransport.ConnectionState.CONNECTED) return
        val appId = scopeToAppId(scope)
        val current = _chatMessagesByApp.value[appId].orEmpty()
        val idx = current.indexOfFirst {
            it.role == com.moumantai.protocol.v1.ChatRole.CHAT_ROLE_USER && it.client_msg_id == clientMsgId
        }
        if (idx < 0) return
        val msg = current[idx]
        if (msg.status != UNSENT_STATUS) return

        val reborn = msg.copy(status = TurnStatus.TURN_STATUS_PENDING)
        val rebuilt = current.toMutableList().also { it[idx] = reborn }
        _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to rebuilt)
        refreshThinkingForScope(scope)

        // Re-attach image bytes if still in RAM; use originalText (the pending entry
        // holds the real caption, not the "[image]" placeholder).
        val pending = pendingImageByMsgId[clientMsgId]
        val retryText = pending?.originalText ?: msg.text
        transport?.sendChatInput(
            scope,
            retryText,
            clientMsgId,
            pending?.bytes,
            pending?.mimeType ?: "image/jpeg",
        )
        scheduleOptimisticTtl(appId, scope, clientMsgId)
    }

    /**
     * Start a 15s TTL timer; flips the bubble to [UNSENT_STATUS] if the server
     * never echoes or transitions it past `pending`.
     */
    private fun scheduleOptimisticTtl(appId: String, scope: String, clientMsgId: String) {
        optimisticTtlJobs.remove(clientMsgId)?.cancel()
        optimisticTtlJobs[clientMsgId] = viewModelScope.launch {
            delay(OPTIMISTIC_TTL_MS)
            val current = _chatMessagesByApp.value[appId].orEmpty()
            val idx = current.indexOfFirst {
                it.client_msg_id == clientMsgId && it.role == com.moumantai.protocol.v1.ChatRole.CHAT_ROLE_USER
            }
            if (idx < 0) return@launch
            val msg = current[idx]
            if (msg.status != TurnStatus.TURN_STATUS_PENDING) return@launch

            val patched = msg.copy(status = UNSENT_STATUS)
            val rebuilt = current.toMutableList().also { it[idx] = patched }
            _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to rebuilt)
            refreshThinkingForScope(scope)
            optimisticTtlJobs.remove(clientMsgId)
        }
    }

    private fun cancelOptimisticTtl(clientMsgId: String?) {
        if (clientMsgId == null) return
        optimisticTtlJobs.remove(clientMsgId)?.cancel()
    }

    /**
     * Single source of truth for the per-scope "thinking" flag.
     */
    private fun refreshThinkingForScope(scope: String) {
        val appId = scopeToAppId(scope)
        val log = _chatMessagesByApp.value[appId].orEmpty()
        val lastUserIdx = log.indexOfLast { it.role == com.moumantai.protocol.v1.ChatRole.CHAT_ROLE_USER }
        val liveTurn = lastUserIdx >= 0 &&
            (
                log[lastUserIdx].status == TurnStatus.TURN_STATUS_PENDING ||
                    log[lastUserIdx].status == TurnStatus.TURN_STATUS_RUNNING
                ) &&
            log.drop(lastUserIdx + 1).none {
                it.role == com.moumantai.protocol.v1.ChatRole.CHAT_ROLE_ASSISTANT
            }
        _thinkingScopes.update {
            if (liveTurn) it + scope else it - scope
        }
        // Cancel any escalation safety timer — chat-log derivation is now the authority.
        thinkingScopeTimers.remove(scope)?.cancel()
    }

    /**
     * Drop face components/data for apps outside the proximity window.
     */
    private fun evictInactiveApps(activeIndex: Int, window: Int) {
        val current = _apps.value
        if (current.isEmpty()) return
        var changed = false
        val rebuilt = current.mapIndexed { i, app ->
            val distance = kotlin.math.abs(i - activeIndex)
            if (distance <= window || app.faces.isEmpty()) {
                app
            } else {
                val hadContent = app.faces.any { it.components.isNotEmpty() || it.data.isNotEmpty() }
                if (!hadContent) {
                    app
                } else {
                    changed = true
                    app.copy(
                        faces = app.faces.map { f ->
                            f.copy(components = emptyMap(), data = emptyMap())
                        },
                    )
                }
            }
        }
        if (changed) _apps.value = rebuilt
    }

    companion object {
        /** Proximity cache radius: keep face content for apps within this many slots of active. */
        private const val NEIGHBOR_WINDOW = 1

        /** Max chat messages retained per-app. */
        private const val CHAT_LOG_CAP = 100

        /** How long to wait for a server echo before flipping an optimistic bubble to `unsent`. */
        internal const val OPTIMISTIC_TTL_MS = 15_000L

        /** How long a "reset from another device" banner stays on screen. */
        internal const val RESET_NOTICE_FLASH_MS = 4_000L

        /** Pending-update queue TTL (race window for chatUpdate vs chat). */
        internal const val PENDING_UPDATE_TTL_MS = 2_000L

        /**
         * Client-only "gave up waiting" sentinel. Uses `UNSPECIFIED` so it's
         * never confused with any server-emitted status.
         */
        @JvmField
        internal val UNSENT_STATUS: TurnStatus = TurnStatus.TURN_STATUS_UNSPECIFIED

        private fun idleVoiceState(): VoiceState = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_IDLE)
    }
}

/**
 * One-shot flash marker surfaced by [AppViewModel.resetNoticeByScope] when a
 * sibling device issued `/reset`.
 */
data class ResetNoticeFlash(
    val conversationId: String,
    val timestamp: String,
)
