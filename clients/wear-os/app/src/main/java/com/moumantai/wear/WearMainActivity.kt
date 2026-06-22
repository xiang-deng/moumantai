package com.moumantai.wear

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.viewmodel.compose.viewModel
import com.moumantai.protocol.v1.VoiceStateValue
import com.moumantai.wear.audio.AudioRecorder
import com.moumantai.wear.state.AppViewModel
import com.moumantai.wear.state.DEFAULT_SERVER_URL
import com.moumantai.wear.state.SettingsRepository
import com.moumantai.wear.theme.WearAppTheme
import com.moumantai.wear.ui.WearAppPager
import kotlinx.coroutines.launch

class WearMainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            WearAppTheme {
                WearAppScreen()
            }
        }
    }
}

@Composable
fun WearAppScreen(viewModel: AppViewModel = viewModel()) {
    val context = LocalContext.current.applicationContext
    val settings = remember { SettingsRepository(context) }
    val scope = rememberCoroutineScope()

    val connectionState by viewModel.connectionState.collectAsState()
    val pairingCode by viewModel.pairingCode.collectAsState()
    val displayState by viewModel.displayState.collectAsState()
    val apps by viewModel.apps.collectAsState()
    val activeAppIndex by viewModel.activeAppIndex.collectAsState()
    val chatMessagesByApp by viewModel.chatMessagesByApp.collectAsState()
    val voiceState by viewModel.voiceState.collectAsState()
    val resetNoticeByScope by viewModel.resetNoticeByScope.collectAsState()
    val transientNotice by viewModel.transientNotice.collectAsState()
    val loadOlderByScope by viewModel.loadOlder.collectAsState()
    val serverUrl by settings.serverUrl.collectAsState(initial = DEFAULT_SERVER_URL)

    // Connect using the persisted server URL.
    LaunchedEffect(serverUrl) {
        val deviceId = settings.getOrCreateDeviceId()
        viewModel.connect(
            serverUrl = serverUrl,
            context = context,
            deviceId = deviceId,
        )
    }

    DisposableEffect(Unit) {
        onDispose { viewModel.disconnect() }
    }

    // Foreground/background → transport, so the pairing poll pauses off-screen
    // (battery) and resumes a burst on return. Especially important on watch.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> viewModel.setForeground(true)
                Lifecycle.Event.ON_STOP -> viewModel.setForeground(false)
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // Voice capture: one recorder, permission launcher, scope deferred until grant.
    val audioRecorder = remember { AudioRecorder(context) }
    var pendingVoiceScope by remember { mutableStateOf<String?>(null) }
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val key = pendingVoiceScope
        pendingVoiceScope = null
        if (granted && key != null) {
            viewModel.startVoiceCapture(key, audioRecorder)
        }
    }

    fun scopeForActiveApp(): String {
        val activeApp = apps.getOrNull(activeAppIndex) ?: return "home"
        return if (activeApp.appId == "home") "home" else "app:${activeApp.appId}"
    }

    // Always show the pager — config screen at page 0 is accessible in any state
    WearAppPager(
        apps = apps,
        activeAppIndex = activeAppIndex,
        onAppChanged = { viewModel.switchApp(it) },
        onFaceChanged = { appId, faceIndex -> viewModel.switchFace(appId, faceIndex) },
        dispatch = { action, itemScope -> viewModel.sendAction(action, itemScope) },
        setFormValue = { key, value -> viewModel.setFormValueOnActiveFace(key, value) },
        chatMessagesByApp = chatMessagesByApp,
        voiceState = voiceState,
        onSendChatMessage = { text ->
            viewModel.sendChatInput(scopeForActiveApp(), text)
        },
        onRetryChatMessage = { scope, cmid ->
            viewModel.retryChatMessage(scope, cmid)
        },
        onVoiceToggle = {
            when (voiceState.state) {
                VoiceStateValue.VOICE_STATE_VALUE_LISTENING -> viewModel.stopVoiceCapture()
                VoiceStateValue.VOICE_STATE_VALUE_SPEAKING -> viewModel.interruptPlayback()
                VoiceStateValue.VOICE_STATE_VALUE_IDLE -> {
                    val key = scopeForActiveApp()
                    val granted = ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.RECORD_AUDIO,
                    ) == PackageManager.PERMISSION_GRANTED
                    if (granted) {
                        viewModel.startVoiceCapture(key, audioRecorder)
                    } else {
                        pendingVoiceScope = key
                        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }
                // THINKING / UNSPECIFIED: ignore — awaiting server response.
                else -> Unit
            }
        },
        serverUrl = serverUrl,
        connectionState = connectionState,
        pairingCode = pairingCode,
        onServerUrlChanged = { url ->
            scope.launch {
                settings.setServerUrl(url)
            }
        },
        onReconnect = {
            // connect() already calls disconnect() internally
            scope.launch {
                val deviceId = settings.getOrCreateDeviceId()
                viewModel.connect(
                    serverUrl = serverUrl,
                    context = context,
                    deviceId = deviceId,
                )
            }
        },
        displayState = displayState,
        resetNoticeScopes = resetNoticeByScope.keys,
        transientNotice = transientNotice,
        onNoticeShown = { viewModel.clearTransientNotice() },
        openChatFlow = viewModel.openChatForScope,
        loadOlderByScope = loadOlderByScope,
        onLoadOlder = { scopeStr -> viewModel.loadOlderChat(scopeStr) },
    )
}
