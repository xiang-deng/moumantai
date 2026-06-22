package com.moumantai.client

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.viewmodel.compose.viewModel
import com.moumantai.client.audio.AudioRecorder
import com.moumantai.client.state.AppViewModel
import com.moumantai.client.state.SettingsRepository
import com.moumantai.client.theme.MoumantaiTheme
import com.moumantai.client.ui.AppPager
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MoumantaiTheme {
                MoumantaiScreen()
            }
        }
    }
}

/**
 * Root composable that owns the [AppViewModel] and renders the [AppPager].
 *
 * The pager is always shown regardless of connection state — the config
 * screen at page 0 lets the user change the server URL and reconnect.
 */
@Composable
private fun MoumantaiScreen(viewModel: AppViewModel = viewModel()) {
    val connectionState by viewModel.connectionState.collectAsState()
    val pairingCode by viewModel.pairingCode.collectAsState()
    val displayState by viewModel.displayState.collectAsState()
    val apps by viewModel.apps.collectAsState()
    val activeAppIndex by viewModel.activeAppIndex.collectAsState()
    val chatMessagesByApp by viewModel.chatMessagesByApp.collectAsState()
    val voiceState by viewModel.voiceState.collectAsState()
    val thinkingScopes by viewModel.thinkingScopes.collectAsState()
    val resetNoticeByScope by viewModel.resetNoticeByScope.collectAsState()
    val micAmplitude by viewModel.micAmplitude.collectAsState()

    val context = LocalContext.current
    val settingsRepo = remember { SettingsRepository(context.applicationContext) }
    val serverUrl by settingsRepo.serverUrl.collectAsState(initial = SettingsRepository.DEFAULT_SERVER_URL)
    val scope = rememberCoroutineScope()

    // Report dimensions + device class so the server picks the right face variant.
    // Uses smallestScreenWidthDp so rotation doesn't flip the class.
    val configuration = LocalConfiguration.current
    val widthDp = configuration.screenWidthDp
    val heightDp = configuration.screenHeightDp
    val deviceClass = if (configuration.smallestScreenWidthDp < 300) "iot-small" else "phone"

    // Voice capture: one recorder, permission launcher, session-scoped start
    val audioRecorder = remember { AudioRecorder(context.applicationContext) }
    var pendingVoiceScope by remember { mutableStateOf<String?>(null) }
    val playStartCue = rememberStartCue(context)

    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val key = pendingVoiceScope
        pendingVoiceScope = null
        if (granted && key != null) {
            playStartCue()
            viewModel.startVoiceCapture(key, audioRecorder)
        }
    }

    fun scopeForActiveApp(): String {
        val activeApp = apps.getOrNull(activeAppIndex) ?: return "home"
        return if (activeApp.appId == "home") "home" else "app:${activeApp.appId}"
    }

    // Surface server errors as snackbars via the host mounted inside AppPager.
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(viewModel) {
        viewModel.transientNotice.collect { notice ->
            snackbarHostState.showSnackbar(notice)
        }
    }

    // Connect on enter / when server URL or dimensions change.
    // appContext lets the ViewModel wire ConnectivityManager + offline queue.
    LaunchedEffect(serverUrl, widthDp, heightDp, deviceClass) {
        val deviceId = settingsRepo.getOrCreateDeviceId()
        viewModel.connect(
            serverUrl = serverUrl,
            deviceClass = deviceClass,
            widthDp = widthDp,
            heightDp = heightDp,
            appContext = context.applicationContext,
            deviceId = deviceId,
        )
    }

    // Disconnect when the composable leaves the composition
    DisposableEffect(Unit) {
        onDispose {
            viewModel.disconnect()
        }
    }

    // Notify the transport of foreground/background to gate the pairing poll.
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

    // AppPager always rendered — config page (index 0) is accessible in all states.
    AppPager(
        apps = apps,
        activeAppIndex = activeAppIndex,
        onAppChanged = { index -> viewModel.switchApp(index) },
        onFaceChanged = { appId, faceIndex -> viewModel.switchFace(appId, faceIndex) },
        dispatch = { action, itemScope -> viewModel.sendAction(action, itemScope) },
        setFormValue = { key, value -> viewModel.setFormValueOnActiveFace(key, value) },
        chatMessagesByApp = chatMessagesByApp,
        voiceState = voiceState,
        thinkingScopes = thinkingScopes,
        micAmplitude = micAmplitude,
        onSendChatMessage = { text, imageBytes ->
            viewModel.sendChatInput(scopeForActiveApp(), text, imageBytes)
        },
        onRetryChatMessage = { scope, cmid ->
            viewModel.retryChatMessage(scope, cmid)
        },
        onVoiceToggle = {
            when (voiceState.state) {
                com.moumantai.protocol.v1.VoiceStateValue.VOICE_STATE_VALUE_LISTENING ->
                    viewModel.stopVoiceCapture()
                com.moumantai.protocol.v1.VoiceStateValue.VOICE_STATE_VALUE_SPEAKING ->
                    viewModel.interruptPlayback()
                com.moumantai.protocol.v1.VoiceStateValue.VOICE_STATE_VALUE_IDLE -> {
                    val key = scopeForActiveApp()
                    val granted = ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.RECORD_AUDIO,
                    ) == PackageManager.PERMISSION_GRANTED
                    if (granted) {
                        playStartCue()
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
            scope.launch { settingsRepo.updateServerUrl(url) }
        },
        onReconnect = {
            // connect() already calls disconnect() internally
            scope.launch {
                val deviceId = settingsRepo.getOrCreateDeviceId()
                viewModel.connect(
                    serverUrl = serverUrl,
                    deviceClass = deviceClass,
                    widthDp = widthDp,
                    heightDp = heightDp,
                    appContext = context.applicationContext,
                    deviceId = deviceId,
                )
            }
        },
        displayState = displayState,
        resetNoticeScopes = resetNoticeByScope.keys,
        snackbarHostState = snackbarHostState,
        openChatFlow = viewModel.openChatForScope,
    )
}

/**
 * Returns a callback that plays a short ACK tone + haptic tick when the mic
 * opens. Releases the [ToneGenerator] on disposal.
 */
@Composable
private fun rememberStartCue(context: Context): () -> Unit {
    val toneGen = remember {
        try {
            ToneGenerator(AudioManager.STREAM_SYSTEM, 60)
        } catch (_: RuntimeException) {
            null
        }
    }
    DisposableEffect(toneGen) {
        onDispose { toneGen?.release() }
    }
    val vibrator: Vibrator? = remember(context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }?.takeIf { it.hasVibrator() }
    }
    val tickEffect = remember {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
        } else {
            VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE)
        }
    }
    return remember(toneGen, vibrator, tickEffect) {
        {
            toneGen?.startTone(ToneGenerator.TONE_PROP_ACK, 120)
            vibrator?.vibrate(tickEffect)
        }
    }
}
