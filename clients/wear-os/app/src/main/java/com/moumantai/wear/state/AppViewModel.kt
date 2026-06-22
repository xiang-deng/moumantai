package com.moumantai.wear.state

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.moumantai.audio.AudioPlayer
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.AppListMsg
import com.moumantai.protocol.v1.ChatHistoryMsg
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.ChatRole
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
import com.moumantai.wear.audio.AudioConfig
import com.moumantai.wear.audio.AudioRecorder
import com.moumantai.wear.transport.MoumantaiTransport
import com.moumantai.wear.transport.NavIntent
import com.moumantai.wear.transport.OfflineQueue
import com.moumantai.wear.transport.Transport
import com.moumantai.wear.util.safeLog
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

/**
 * Central state holder for the Moumantai Wear OS client.
 *
 * Owns a [MoumantaiTransport], wires its callbacks to [StateFlow]s, and
 * processes incoming messages (appList, faceList, faceUpdate, navigate, chat)
 * to maintain [AppState] objects observed by the Compose UI.
 */
class AppViewModel : ViewModel() {

    // -- Transport (created on connect) ---------------------------------------

    private var transport: Transport? = null
    private var offlineQueue: OfflineQueue? = null

    // -- Connection state -----------------------------------------------------

    private val _connectionState = MutableStateFlow(Transport.ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<Transport.ConnectionState> = _connectionState.asStateFlow()

    /** Debounced/escalated UI-facing view of [connectionState]. See [deriveDisplayState]. */
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

    // -- Apps -----------------------------------------------------------------

    private val _apps = MutableStateFlow<List<AppState>>(emptyList())
    val apps: StateFlow<List<AppState>> = _apps.asStateFlow()

    private val _activeAppIndex = MutableStateFlow(0)
    val activeAppIndex: StateFlow<Int> = _activeAppIndex.asStateFlow()

    // -- Chat (for home / active app) -----------------------------------------

    private val _chatMessagesByApp = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val chatMessagesByApp: StateFlow<Map<String, List<ChatMessage>>> = _chatMessagesByApp.asStateFlow()

    private val _voiceState = MutableStateFlow(idleVoiceState())
    val voiceState: StateFlow<VoiceState> = _voiceState.asStateFlow()

    /**
     * Per-scope "thinking" flag. Driven entirely by server-side turn status
     * (chatUpdate frames + chatWindow snapshots): a scope is thinking iff its
     * last user row is pending/running. Multi-client: device A sending →
     * server broadcasts chatUpdate → device B lights the indicator too.
     */
    private val _thinkingScopes = MutableStateFlow<Set<String>>(emptySet())
    val thinkingScopes: StateFlow<Set<String>> = _thinkingScopes.asStateFlow()

    /** Safety timers for escalation thinking-indicator; cancelled when the chat-log
     *  derivation takes over or a follow-up tap supersedes. */
    private val thinkingScopeTimers = mutableMapOf<String, kotlinx.coroutines.Job>()

    /**
     * One-shot user-facing notice (e.g. "Voice reset, try again"). UI
     * observes, displays briefly, then clears via [clearTransientNotice].
     * Null when there's nothing to show.
     */
    private val _transientNotice = MutableStateFlow<String?>(null)
    val transientNotice: StateFlow<String?> = _transientNotice.asStateFlow()

    /**
     * Disposable event: server requested the chat surface for [scope]. Emitted
     * when [handleUiActionEscalated] fires for the active app's scope. UI
     * navigates to chat page 0. Not replayed on reconnect.
     */
    private val _openChatForScope = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 1)
    val openChatForScope: SharedFlow<String> = _openChatForScope.asSharedFlow()

    /**
     * Per-scope flash marker shown when another device issued `/reset`.
     * Cleared after [RESET_NOTICE_FLASH_MS]. Self-originated notices are suppressed.
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

    /** Minimum seq seen per appId; used as the `before_seq` cursor for [sendFetchOlder]. */
    private val minSeqByApp = mutableMapOf<String, Long>()

    /** 15s TTL timers per clientMsgId. Cancelled on server echo; on expiry the bubble
     *  flips to status="unsent" for retry. */
    private val optimisticTtlJobs = mutableMapOf<String, Job>()

    /** `chatUpdate` frames for row ids not yet in the log. Drained when the row
     *  arrives; TTL-evicted after [PENDING_UPDATE_TTL_MS]. */
    private val pendingUpdates = mutableMapOf<String, PendingUpdate>()
    private val pendingEvictionJobs = mutableMapOf<String, Job>()

    data class PendingUpdate(val msg: ChatUpdateMsg, val deadlineMs: Long)

    // -- Voice capture & playback ---------------------------------------------

    private var audioRecorder: AudioRecorder? = null
    private val audioPlayer = AudioPlayer(usage = AudioAttributes.USAGE_ASSISTANT)
    private var currentVoiceScope: String? = null

    /**
     * Active conversationId per scope (from the last [ChatWindowMsg]). Kept
     * so later chat reconciliations know which conversation the scope is on
     * without hunting through messages.
     */
    private val _conversationIdByScope = MutableStateFlow<Map<String, String>>(emptyMap())
    val conversationIdByScope: StateFlow<Map<String, String>> = _conversationIdByScope.asStateFlow()

    /**
     * Last scope the client reported via `viewing`. Used to suppress duplicate
     * emissions when switchApp is called for the same scope, and so face-only
     * changes (which don't change scope) don't emit at all.
     */
    private var lastSubscribedScope: String? = null

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
        val currentConvId = _conversationIdByScope.value[scope] ?: ""
        _loadOlder.value = _loadOlder.value + (
            scope to current.copy(
                state = LoadOlderState.LOADING,
                inflightConvId = currentConvId,
            )
            )
        transport?.sendFetchOlder(scope, beforeSeq, 50)
    }

    /**
     * Connect to the server via WebSocket at [serverUrl]. [context] is optional
     * (needed for OfflineQueue + AudioManager); unit tests may pass null.
     */
    fun connect(
        serverUrl: String,
        context: Context? = null,
        deviceId: String,
    ) {
        transport?.disconnect()

        if (context != null) {
            if (offlineQueue == null) offlineQueue = OfflineQueue(context)
            audioPlayer.bindAudioManager(context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)
        }

        val t = MoumantaiTransport(serverUrl)
        transport = t
        wireTransportCallbacks(t)
        t.connect(deviceId = deviceId)
    }

    /**
     * Disconnect from the server and clean up.
     */
    fun disconnect() {
        transport?.disconnect()
        transport = null
        _connectionState.value = Transport.ConnectionState.DISCONNECTED
        // Clear so the first post-reconnect switchApp (or the hello-ok
        // handler itself) re-announces scope to the server.
        lastSubscribedScope = null
    }

    /** App foreground state — gates pairing-poll battery use (see transport). */
    fun setForeground(fg: Boolean) {
        transport?.setForeground(fg)
    }

    /**
     * Switch the active app by pager index. Announces scope to the server
     * (no-op if scope unchanged). Evicts face content beyond the proximity
     * window to bound per-app memory on the watch's tight RAM budget.
     */
    fun switchApp(index: Int) {
        val appList = _apps.value
        if (index < 0 || index >= appList.size) return
        _activeAppIndex.value = index
        evictInactiveApps(index, NEIGHBOR_WINDOW)
        val newScope = appIdToScope(appList[index].appId)
        if (newScope != lastSubscribedScope) {
            lastSubscribedScope = newScope
            transport?.sendViewing(newScope)
        }
    }

    /**
     * Switch the active face within the current app by index. Face-only
     * changes do NOT change scope (the scope stays `app:<appId>`), so no
     * `viewing` is emitted here.
     */
    fun switchFace(appId: String, faceIndex: Int) {
        val appList = _apps.value
        val app = appList.firstOrNull { it.appId == appId } ?: return
        if (faceIndex < 0 || faceIndex >= app.faces.size) return
        val leaving = app.faces.getOrNull(app.activeFaceIndex)
        updateApp(appId) { current ->
            // Clear the leaving face's $form on navigation — drafts don't survive nav.
            val faces = current.faces.mapIndexed { i, f ->
                if (leaving != null &&
                    i == current.activeFaceIndex &&
                    i != faceIndex &&
                    f.faceId == leaving.faceId &&
                    f.form.isNotEmpty()
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

    /** Write `key = value` to the active face's `$form` (called by `LocalFormSetter`). */
    fun setFormValueOnActiveFace(key: String, value: Any?) {
        val appList = _apps.value
        val app = appList.getOrNull(_activeAppIndex.value) ?: return
        val face = app.faces.getOrNull(app.activeFaceIndex) ?: return
        setFormValue(app.appId, face.faceId, key, value)
    }

    /**
     * Dispatch a UI action by invoking the named tool through the server.
     * Resolves `{path: "..."}` placeholders inside `args` against face data
     * + itemScope + per-face `/$form/...` before sending.
     */
    fun sendAction(action: Action?, itemScope: Map<String, Any?>? = null) {
        if (action == null || action.tool.isEmpty()) return
        val appList = _apps.value
        val app = appList.getOrNull(_activeAppIndex.value) ?: return
        val face = app.faces.getOrNull(app.activeFaceIndex) ?: return
        val resolved = resolveActionArgs(action.args, face.data, face.form, itemScope)
        val clientRequestId = UUID.randomUUID().toString()

        // Online: send through the socket. Offline: persist; same client_request_id
        // lets the server's invoke_dedup table dedupe on replay.
        if (_connectionState.value == Transport.ConnectionState.CONNECTED) {
            transport?.sendInvokeTool(
                toolName = action.tool,
                args = resolved,
                sourceFaceId = face.faceId,
                clientRequestId = clientRequestId,
            )
        } else {
            val q = offlineQueue
            if (q != null) {
                viewModelScope.launch {
                    runCatching {
                        q.enqueueInvokeTool(
                            scope = appIdToScope(app.appId),
                            toolName = action.tool,
                            args = resolved,
                            sourceFaceId = face.faceId,
                            clientRequestId = clientRequestId,
                            originConversationId = _conversationIdByScope.value[appIdToScope(app.appId)]?.takeIf { it.isNotEmpty() },
                        )
                    }
                }
            }
        }
    }

    // `internal` so FormSemanticsConformanceTest can drive it directly without reflection.
    internal fun resolveActionArgs(
        args: Map<String, *>?,
        faceData: Map<String, Any?>,
        form: Map<String, Any?>,
        itemScope: Map<String, Any?>?,
    ): Map<String, Any?>? {
        if (args == null) return null
        return args.mapValues { (_, v) -> resolveActionValue(v, faceData, form, itemScope) }
    }

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
     * Send a text chat message to the server on the given scope.
     *
     * Special case: `/reset` (trimmed + lowercased) is intercepted — when
     * connected it sends a [Transport.sendResetConversation] and does NOT
     * push an optimistic bubble; when disconnected it emits a transient
     * notice and drops (we don't queue /reset offline because the reset
     * meaning is tied to a live server turn).
     *
     * For normal text: the message is optimistically appended with a fresh
     * [clientMsgId] for server-echo reconciliation. When the transport
     * isn't CONNECTED, the message is persisted to the [OfflineQueue]; it
     * will be drained on the next successful hello via [flushOfflineQueue].
     */
    fun sendChatInput(scope: String, text: String) {
        // /reset intercept — trimmed + lowercased match.
        if (text.trim().lowercase() == "/reset") {
            if (_connectionState.value == Transport.ConnectionState.CONNECTED) {
                transport?.sendResetConversation(scope)
            } else {
                _transientNotice.value = "Can't reset while offline"
            }
            return
        }

        val appId = scopeToAppId(scope)
        val clientMsgId = UUID.randomUUID().toString()
        val connected = _connectionState.value == Transport.ConnectionState.CONNECTED
        val userMsg = ChatMessage(
            id = "local-${System.currentTimeMillis()}",
            scope = scope,
            conversation_id = _conversationIdByScope.value[scope] ?: "",
            role = ChatRole.CHAT_ROLE_USER,
            text = text,
            timestamp = java.time.Instant.now().toString(),
            client_msg_id = clientMsgId,
            // Optimistic pending status when actually sending so the thinking
            // derivation lights up immediately. Null when offline-queued
            // (no turn in flight).
            status = if (connected) TurnStatus.TURN_STATUS_PENDING else null,
        )
        appendChatMessage(appId, userMsg)
        refreshThinkingForScope(scope)

        if (connected) {
            // Show thinking state while we wait on the server.
            _voiceState.value = thinkingVoiceState()
            transport?.sendChatInput(scope, text, clientMsgId)
            scheduleOptimisticTtl(appId, scope, clientMsgId)
        } else {
            // Persist for replay. Don't hang on "thinking" — the server can't
            // respond until we reconnect. Snapshot the conversationId so the
            // server can reject stale drains with `stale_conversation` rather
            // than appending to a new conversation.
            val q = offlineQueue
            if (q != null) {
                val originConv = _conversationIdByScope.value[scope]?.takeIf { it.isNotEmpty() }
                viewModelScope.launch {
                    q.enqueueText(
                        scope,
                        text,
                        clientMsgId,
                        originConversationId = originConv,
                    )
                }
            }
            _voiceState.value = idleVoiceState()
        }
    }

    /**
     * Retry a locally-unsent user bubble. Reuses the same [clientMsgId]
     * so the server dedups if the original did eventually land.
     */
    fun retryChatMessage(scope: String, clientMsgId: String) {
        if (_connectionState.value != Transport.ConnectionState.CONNECTED) return
        val appId = scopeToAppId(scope)
        val current = _chatMessagesByApp.value[appId].orEmpty()
        val idx = current.indexOfFirst {
            it.role == ChatRole.CHAT_ROLE_USER && it.client_msg_id == clientMsgId
        }
        if (idx < 0) return
        val msg = current[idx]
        if (msg.status != UNSENT_STATUS) return

        val reborn = msg.copy(status = TurnStatus.TURN_STATUS_PENDING)
        val rebuilt = current.toMutableList().also { it[idx] = reborn }
        _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to rebuilt)
        refreshThinkingForScope(scope)

        transport?.sendChatInput(scope, msg.text, clientMsgId)
        scheduleOptimisticTtl(appId, scope, clientMsgId)
    }

    private fun scheduleOptimisticTtl(appId: String, scope: String, clientMsgId: String) {
        optimisticTtlJobs.remove(clientMsgId)?.cancel()
        optimisticTtlJobs[clientMsgId] = viewModelScope.launch {
            delay(OPTIMISTIC_TTL_MS)
            val current = _chatMessagesByApp.value[appId].orEmpty()
            val idx = current.indexOfFirst { it.client_msg_id == clientMsgId && it.role == ChatRole.CHAT_ROLE_USER }
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
     * UI calls this once the transient notice has been shown to the user.
     */
    fun clearTransientNotice() {
        _transientNotice.value = null
    }

    /**
     * Start capturing audio from the microphone and streaming it to the server.
     */
    fun startVoiceCapture(scope: String, recorder: AudioRecorder) {
        if (_voiceState.value.state != VoiceStateValue.VOICE_STATE_VALUE_IDLE) return

        val t = transport ?: return
        audioRecorder = recorder
        currentVoiceScope = scope

        val started = recorder.start { chunk ->
            t.sendAudioInput(
                data = chunk,
                format = AudioConfig.FORMAT,
                sampleRate = AudioConfig.SAMPLE_RATE,
                final = false,
                scope = scope,
            )
        }

        if (started) {
            _voiceState.value = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_LISTENING)
        } else {
            audioRecorder = null
            currentVoiceScope = null
        }
    }

    /**
     * Stop recording and send the final audio chunk.
     */
    fun stopVoiceCapture() {
        val recorder = audioRecorder ?: return
        val scope = currentVoiceScope ?: return
        val t = transport

        val finalChunk = recorder.stop()
        audioRecorder = null

        if (_voiceState.value.state == VoiceStateValue.VOICE_STATE_VALUE_LISTENING && t != null) {
            t.sendAudioInput(
                data = finalChunk,
                format = AudioConfig.FORMAT,
                sampleRate = AudioConfig.SAMPLE_RATE,
                final = true,
                scope = scope,
            )
            _voiceState.value = thinkingVoiceState()
        }

        currentVoiceScope = null
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
        _voiceState.value = idleVoiceState()
    }

    override fun onCleared() {
        super.onCleared()
        resetVoiceState()
        disconnect()
    }

    // -- Transport callback wiring --------------------------------------------

    private fun wireTransportCallbacks(t: Transport) {
        // Read through StateFlow.value (not captured) so reconnects carry the
        // app/face the user is on now.
        t.navIntentProvider = {
            val list = _apps.value
            val idx = _activeAppIndex.value
            val app = list.getOrNull(idx)
            val appId = app?.appId
            val faceId = app?.faces?.getOrNull(app.activeFaceIndex)?.faceId
            NavIntent(
                currentAppId = appId,
                currentFaceId = faceId,
            )
        }

        t.onConnectionState = { state ->
            _connectionState.value = state
            if (state == Transport.ConnectionState.CONNECTED) _pairingCode.value = null
            // Reset thinking state if connection drops while waiting for response
            if (state == Transport.ConnectionState.DISCONNECTED &&
                _voiceState.value.state == VoiceStateValue.VOICE_STATE_VALUE_THINKING
            ) {
                _voiceState.value = idleVoiceState()
            }
        }

        t.onPairingRequired = { code ->
            _pairingCode.value = code
        }

        t.onServerHello = { hello ->
            _sessionId.value = hello.session_id
            // Apps/faces arrive via appList/faceList/faceUpdate, not hello.
            // Drain offline queue on hello-ok (not onConnectionState=CONNECTED,
            // which fires optimistically before the server confirms the session).
            flushOfflineQueue()
            // Re-announce scope post-reconnect; transport dedup resets per hello-ok.
            val scope = currentScope()
            lastSubscribedScope = scope
            t.sendViewing(scope)
        }

        t.onError = { err -> handleTransportError(err) }
        t.onUiActionEscalated = { msg -> handleUiActionEscalated(msg) }

        t.onAppList = { msg -> handleAppList(msg) }
        t.onFaceList = { msg -> handleFaceList(msg) }
        t.onFaceUpdate = { msg -> handleFaceUpdate(msg) }
        t.onNavigate = { msg -> handleNavigate(msg) }

        t.onChatMessage = { msg -> handleIncomingChatMessage(msg) }

        t.onChatWindow = { msg -> handleChatWindow(msg) }
        t.onChatHistory = { msg -> handleChatHistory(msg) }
        t.onChatUpdate = { msg -> handleChatUpdate(msg) }
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

    internal fun handleAppList(msg: AppListMsg) {
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

        // Clamp active index
        if (_activeAppIndex.value >= newApps.size && newApps.isNotEmpty()) {
            _activeAppIndex.value = newApps.size - 1
        }
    }

    internal fun handleFaceList(msg: FaceListMsg) {
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

    internal fun handleFaceUpdate(msg: FaceUpdateMsg) {
        try {
            val newComponents = msg.components.associateBy { it.id }

            // STRUCT_MAP decodes into Map<String, *> — pass through unchanged.
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
     * Replace the chat log for a scope with the server's authoritative
     * window. REPLACE semantics except: optimistic entries (rows carrying a
     * non-null [ChatMessage.client_msg_id] whose value is NOT present as an
     * `id` in the incoming entries) are preserved so the user's
     * just-typed message doesn't disappear between send + server echo.
     *
     * Also records the conversationId for the scope so the next outbound
     * chatInput can stamp it on the optimistic bubble.
     */
    private fun handleChatWindow(msg: ChatWindowMsg) {
        val appId = scopeToAppId(msg.scope)
        val incomingIds = msg.entries.asSequence().map { it.id }.toHashSet()
        val incomingClientMsgIds = msg.entries.asSequence()
            .mapNotNull { it.client_msg_id }.toHashSet()
        val rebuilt = msg.entries.map { e ->
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
        val previous = _chatMessagesByApp.value[appId].orEmpty()
        // Match optimistic preservation by EITHER id or clientMsgId so a
        // reconnect rehydrate doesn't render the same message twice.
        val preserved = previous.filter { prev ->
            val cmi = prev.client_msg_id
            cmi != null &&
                prev.conversation_id == msg.conversation_id &&
                prev.id !in incomingIds &&
                cmi !in incomingClientMsgIds
        }
        val merged = (rebuilt + preserved).takeLast(CHAT_LOG_CAP)
        _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to merged)
        _conversationIdByScope.value =
            _conversationIdByScope.value + (msg.scope to msg.conversation_id)

        // Track the minimum seq observed so loadOlderChat has an accurate cursor.
        if (msg.entries.isNotEmpty()) {
            val minSeq = msg.entries.minOf { it.seq }
            val current = minSeqByApp[appId]
            if (current == null || minSeq < current) minSeqByApp[appId] = minSeq
        }
        // A chatWindow always signals a fresh conversation — reset load-older state.
        _loadOlder.value = _loadOlder.value - msg.scope

        // Authoritative chat window = canonical signal for "this is the
        // current conv id for this scope". Any queued offline item whose
        // originConversationId disagrees is from a prior era (server-side
        // /reset, DB wipe, etc.) and must not be replayed into the new
        // conversation as a non-sequitur.
        pruneOfflineQueueForScope(msg.scope, msg.conversation_id)

        refreshThinkingForScope(msg.scope)
        // Fresh rows may have just materialised — try to apply any queued
        // chatUpdate whose id we didn't recognise before.
        drainPendingUpdates()
    }

    /**
     * Handle a paged history response for a [loadOlderChat] request.
     *
     * Prepends [ChatHistoryMsg.entries] to the in-memory log for the scope,
     * skipping any entry whose id is already present (in-memory copy may have a
     * more recent status from a [ChatUpdateMsg]). Updates the [LoadOlderState]
     * state machine for the scope and the [minSeqByApp] cursor.
     *
     * Discards stale responses: if [ChatHistoryMsg.conversation_id] differs from
     * the current conversation for the scope (i.e., a reset happened mid-flight),
     * the response is ignored and [LoadOlderState] is reset to [LoadOlderState.IDLE].
     */
    private fun handleChatHistory(msg: ChatHistoryMsg) {
        val appId = scopeToAppId(msg.scope)
        val currentConvId = _conversationIdByScope.value[msg.scope] ?: ""

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

    private fun pruneOfflineQueueForScope(scope: String, conversationId: String) {
        val q = offlineQueue ?: return
        if (conversationId.isEmpty()) return
        viewModelScope.launch {
            try {
                val dropped = q.pruneStale(scope, conversationId)
                if (dropped > 0) {
                    safeLog("AppViewModel", "Pruned $dropped stale offline-queue item(s) for $scope (new conv $conversationId)")
                }
            } catch (e: Throwable) {
                safeLog("AppViewModel", "Offline-queue prune failed for $scope", e)
            }
        }
    }

    /**
     * Handle a server → client chat frame: reconcile optimistic bubbles by
     * clientMsgId (replace in place) or append, cancel the unsent-TTL, and
     * re-derive thinking.
     */
    private fun handleIncomingChatMessage(msg: ChatMessage) {
        val appId = scopeToAppId(msg.scope)
        if (msg.conversation_id.isNotEmpty()) {
            _conversationIdByScope.value =
                _conversationIdByScope.value + (msg.scope to msg.conversation_id)
        }
        val existing = _chatMessagesByApp.value[appId].orEmpty()
        val echoedCmi = msg.client_msg_id
        val matchIdx = if (echoedCmi != null) {
            existing.indexOfFirst { it.client_msg_id == echoedCmi }
        } else {
            -1
        }
        if (matchIdx != -1) {
            val merged = existing.toMutableList().apply { set(matchIdx, msg) }
            _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to merged)
        } else {
            appendChatMessage(appId, msg)
        }
        cancelOptimisticTtl(echoedCmi)
        refreshThinkingForScope(msg.scope)
        if (msg.role == ChatRole.CHAT_ROLE_ASSISTANT &&
            _voiceState.value.state == VoiceStateValue.VOICE_STATE_VALUE_THINKING
        ) {
            _voiceState.value = idleVoiceState()
        }
        // A row just materialised — try to apply any chatUpdate we queued
        // for a then-unknown id.
        drainPendingUpdates()
    }

    /**
     * Apply an incremental turn status update. If the target row isn't in
     * the log yet (race: chatUpdate landed before the matching `chat` /
     * `chatWindow` frame) the update is enqueued for up to
     * [PENDING_UPDATE_TTL_MS] and re-tried on the next log mutation.
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

    /**
     * Apply the patch from a [ChatUpdateMsg] to a known-present row.
     */
    private fun applyChatUpdate(msg: ChatUpdateMsg, log: List<ChatMessage>, idx: Int) {
        val appId = scopeToAppId(msg.scope)
        val patched = log[idx].copy(
            status = msg.status,
            failure_reason = msg.failure_reason,
            // Prefer the existing value (stable across updates), fall back to
            // the frame's value if the local row somehow lacks it.
            origin_device_id = log[idx].origin_device_id ?: msg.origin_device_id,
        )
        val rebuilt = log.toMutableList().also { it[idx] = patched }
        _chatMessagesByApp.value = _chatMessagesByApp.value + (appId to rebuilt)

        // Anything past 'pending' means the server is driving the turn —
        // the local TTL is no longer meaningful.
        if (msg.status != TurnStatus.TURN_STATUS_PENDING) cancelOptimisticTtl(patched.client_msg_id)
        refreshThinkingForScope(msg.scope)
    }

    /**
     * Another-device `/reset` landed on this scope. Flash a banner for
     * [RESET_NOTICE_FLASH_MS] then clear. Self-originated notices (the
     * reset came from this session) are suppressed so only *other* devices
     * see the UI indication.
     *
     * The authoritative empty [ChatWindowMsg] follows this frame and
     * clears the log; this handler only drives the banner overlay.
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

    /**
     * Stash an orphan [ChatUpdateMsg] (id isn't in the local log yet) with a
     * TTL. A fresh enqueue for the same id replaces the prior entry and
     * cancels its eviction timer.
     */
    private fun enqueuePendingUpdate(msg: ChatUpdateMsg) {
        pendingEvictionJobs.remove(msg.id)?.cancel()
        pendingUpdates[msg.id] = PendingUpdate(
            msg = msg,
            deadlineMs = System.currentTimeMillis() + PENDING_UPDATE_TTL_MS,
        )
        // The scheduled delay is what guarantees eviction in both wall-clock
        // and virtual-time tests. Drains triggered by log mutations also
        // sweep deadline-expired entries, but this ensures bounded lifetime
        // even if no mutation ever arrives.
        pendingEvictionJobs[msg.id] = viewModelScope.launch {
            delay(PENDING_UPDATE_TTL_MS)
            pendingUpdates.remove(msg.id)
            pendingEvictionJobs.remove(msg.id)
        }
    }

    /**
     * Try to apply any queued chatUpdate whose row now exists, and TTL-sweep
     * any whose deadline has passed. Called at the end of every log
     * mutation (incoming `chat`, `chatWindow`).
     */
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

    /**
     * Single source of truth for the per-scope "thinking" flag. A scope is
     * thinking iff its last user row has status pending/running AND no
     * assistant row follows it. Called after any log mutation so the flag
     * stays derived.
     */
    private fun refreshThinkingForScope(scope: String) {
        val appId = scopeToAppId(scope)
        val log = _chatMessagesByApp.value[appId].orEmpty()
        val lastUserIdx = log.indexOfLast { it.role == ChatRole.CHAT_ROLE_USER }
        val liveTurn = lastUserIdx >= 0 &&
            (
                log[lastUserIdx].status == TurnStatus.TURN_STATUS_PENDING ||
                    log[lastUserIdx].status == TurnStatus.TURN_STATUS_RUNNING
                ) &&
            log.drop(lastUserIdx + 1).none { it.role == ChatRole.CHAT_ROLE_ASSISTANT }
        _thinkingScopes.update {
            if (liveTurn) it + scope else it - scope
        }
        // The chat-log derivation is the canonical owner of this scope's
        // thinking state. Cancel any outstanding escalation safety timer so
        // it doesn't fire later and clobber a future typed-chat indicator.
        thinkingScopeTimers.remove(scope)?.cancel()
    }

    private fun handleUiActionEscalated(msg: UiActionEscalated) {
        val appList = _apps.value
        val activeApp = appList.getOrNull(_activeAppIndex.value) ?: return
        val activeScope = if (activeApp.appId == "home") "home" else "app:${activeApp.appId}"
        if (msg.scope != activeScope) return
        viewModelScope.launch {
            _openChatForScope.emit(msg.scope)
        }
        // Light up the existing thinking indicator for the escalation lag.
        // The chat-log derivation removes the scope when the assistant
        // question lands; we add a 30s safety fallback for the case where
        // no chat frame ever arrives (server failure mid-flight).
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
     * Handle a structured error frame from the transport.
     *
     * `stale_conversation` arrives when an offline-queued drain's `originConversationId`
     * no longer matches the server's active conversation (another device advanced or
     * reset during the outage). Surfaced as a transient notice; the queue item is
     * already consumed — the server's rejection is retroactive.
     */
    private fun handleTransportError(err: ErrorMessage) {
        // Always surface the error. Stale-conversation gets a friendlier message;
        // everything else echoes the server's text.
        _transientNotice.value =
            if (err.code == ProtocolErrorCode.PROTOCOL_ERROR_CODE_STALE_CONVERSATION) {
                "Queued message dropped — conversation advanced while offline."
            } else {
                err.message?.takeIf { it.isNotBlank() } ?: "Server error"
            }
    }

    /** Drain offline messages through [transport] in order; stop on first failure. */
    private fun flushOfflineQueue() {
        val q = offlineQueue ?: return
        val t = transport ?: return
        viewModelScope.launch {
            try {
                q.flushOnConnect(t)
            } catch (e: Throwable) {
                safeLog("AppViewModel", "Offline queue flush failed", e)
            }
        }
    }

    /** Map scope → app ID; "home" and unrecognised scopes return "home". */
    private fun scopeToAppId(scope: String): String {
        if (scope.startsWith("app:")) return scope.removePrefix("app:")
        return "home"
    }

    /** Map app ID → scope string (`"home"` or `"app:<appId>"`). */
    private fun appIdToScope(appId: String): String = if (appId == "home") "home" else "app:$appId"

    /** Scope the UI is currently showing; falls back to "home" when no apps are loaded. */
    private fun currentScope(): String {
        val list = _apps.value
        val idx = _activeAppIndex.value
        val app = list.getOrNull(idx) ?: return "home"
        return appIdToScope(app.appId)
    }

    /** Update a specific app in the immutable list by appId. */
    private inline fun updateApp(appId: String, transform: (AppState) -> AppState) {
        val current = _apps.value
        val index = current.indexOfFirst { it.appId == appId }
        if (index == -1) return
        val updated = current.toMutableList()
        updated[index] = transform(current[index])
        _apps.value = updated
    }

    /** Append a chat message; drop oldest beyond [CHAT_LOG_CAP] to bound memory. */
    private fun appendChatMessage(appId: String, msg: ChatMessage) {
        val current = _chatMessagesByApp.value
        val merged = (current[appId].orEmpty() + msg).takeLast(CHAT_LOG_CAP)
        _chatMessagesByApp.value = current + (appId to merged)
    }

    /**
     * Drop face components/data for apps outside the proximity window.
     * Metadata is kept so the pager still renders; content is re-fetched on revisit.
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
        /** Proximity cache radius: content is kept for apps within this many carousel slots of active. */
        private const val NEIGHBOR_WINDOW = 1

        /** Max chat messages retained per-app. */
        private const val CHAT_LOG_CAP = 100

        /**
         * Flip an optimistic bubble to `unsent` after this many ms without a server echo.
         * Server-side 90s timeout writes the backstop `(timed out)` row.
         */
        internal const val OPTIMISTIC_TTL_MS = 15_000L

        /** Duration the "reset from another device" banner stays on screen. */
        internal const val RESET_NOTICE_FLASH_MS = 4_000L

        /**
         * How long to hold a `chatUpdate` for an unrecognised row id before giving up.
         * 2s absorbs the race between `chatUpdate{running}` and the `chat`/`chatWindow`
         * that introduces the row.
         */
        internal const val PENDING_UPDATE_TTL_MS = 2_000L

        /**
         * Local-only "gave up waiting" status — never sent on the wire.
         * Uses `UNSPECIFIED` so it's distinct from every server-emitted value.
         */
        @JvmField
        internal val UNSENT_STATUS: TurnStatus = TurnStatus.TURN_STATUS_UNSPECIFIED

        private fun idleVoiceState(): VoiceState = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_IDLE)

        private fun thinkingVoiceState(): VoiceState = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_THINKING)
    }
}

/**
 * Flash marker surfaced by [AppViewModel.resetNoticeByScope] when a sibling device
 * issued `/reset`. UI shows a transient banner explaining why the chat log cleared.
 */
data class ResetNoticeFlash(
    val conversationId: String,
    val timestamp: String,
)
