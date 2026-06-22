package com.moumantai.client.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import com.moumantai.client.renderer.LocalFormSetter
import com.moumantai.client.renderer.LocalServerHttpBase
import com.moumantai.client.renderer.RenderNode
import com.moumantai.client.state.AppState
import com.moumantai.client.state.DisplayState
import com.moumantai.client.transport.MoumantaiTransport
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.VoiceState
import com.moumantai.protocol.v1.VoiceStateValue
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

/**
 * Top-level Scaffold owning system insets, the chat FAB, and the pager-dot
 * indicator. Each page inside the horizontal pager is either the config screen
 * (index 0) or an app face. Per-face Scaffolds pass `WindowInsets(0)` so they
 * don't double-apply status-bar padding.
 *
 * Horizontal = apps. Vertical = faces within an app.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AppPager(
    apps: List<AppState>,
    activeAppIndex: Int,
    onAppChanged: (Int) -> Unit,
    onFaceChanged: (String, Int) -> Unit = { _, _ -> },
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    /** Per-face form-state writer; invoked by inputs without `action`. No-op default for tests. */
    setFormValue: (key: String, value: Any?) -> Unit = { _, _ -> },
    chatMessagesByApp: Map<String, List<ChatMessage>> = emptyMap(),
    voiceState: VoiceState = VoiceState(state = VoiceStateValue.VOICE_STATE_VALUE_IDLE),
    thinkingScopes: Set<String> = emptySet(),
    micAmplitude: Float = 0f,
    onSendChatMessage: (text: String, imageBytes: ByteArray?) -> Unit = { _, _ -> },
    onRetryChatMessage: (String, String) -> Unit = { _, _ -> },
    onVoiceToggle: () -> Unit = {},
    serverUrl: String = "",
    connectionState: MoumantaiTransport.ConnectionState = MoumantaiTransport.ConnectionState.DISCONNECTED,
    pairingCode: String? = null,
    onServerUrlChanged: (String) -> Unit = {},
    onReconnect: () -> Unit = {},
    displayState: DisplayState = DisplayState.Connected,
    /** Scopes flashing a "reset from another device" banner. */
    resetNoticeScopes: Set<String> = emptySet(),
    /** Snackbar host for transient notices from [AppViewModel.transientNotice]. */
    snackbarHostState: SnackbarHostState = remember { SnackbarHostState() },
    /** Emits a scope when a UiActionEscalated frame opens the chat overlay. Empty-flow default for tests. */
    openChatFlow: Flow<String> = emptyFlow(),
) {
    val pagerState = rememberPagerState(
        initialPage = if (apps.isEmpty()) 0 else activeAppIndex + 1,
        pageCount = { apps.size + 1 },
    )

    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.currentPage }.collect { page ->
            if (page > 0) onAppChanged(page - 1)
        }
    }

    LaunchedEffect(activeAppIndex) {
        val targetPage = activeAppIndex + 1
        if (pagerState.currentPage > 0 && pagerState.currentPage != targetPage) {
            pagerState.animateScrollToPage(targetPage)
        }
    }

    var chatOpen by remember { mutableStateOf(false) }

    LaunchedEffect(openChatFlow) {
        openChatFlow.collect { chatOpen = true }
    }
    val currentApp = if (pagerState.currentPage > 0) apps.getOrNull(pagerState.currentPage - 1) else null
    val onConfigPage = pagerState.currentPage == 0
    val onHomePage = currentApp != null && isHomeApp(currentApp)
    // Chat overlay is offered as a FAB on mini-app pages only. Home has its own chat UI;
    // the config page is neutral.
    val showChatFab = !onConfigPage && !onHomePage && currentApp != null && !chatOpen
    val showPagerDots = apps.isNotEmpty() && isWideEnoughForPagerDots()

    Scaffold(
        containerColor = MaterialTheme.colorScheme.surface,
        contentWindowInsets = WindowInsets.statusBars.union(WindowInsets.navigationBars),
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            if (showChatFab) {
                ExtendedFloatingActionButton(
                    onClick = { chatOpen = true },
                    icon = {
                        Icon(
                            imageVector = Icons.AutoMirrored.Rounded.Chat,
                            contentDescription = null,
                        )
                    },
                    text = { Text("Chat") },
                )
            }
        },
        bottomBar = {
            if (showPagerDots) {
                Surface(color = MaterialTheme.colorScheme.surface) {
                    PageIndicator(
                        pageCount = apps.size + 1,
                        currentPage = pagerState.currentPage,
                        modifier = Modifier
                            .fillMaxWidth()
                            .windowInsetsPadding(WindowInsets.navigationBars)
                            .padding(vertical = 8.dp),
                    )
                }
            }
        },
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .consumeWindowInsets(inner),
        ) {
            // Offline banner appears above the pager; Reconnecting pill floats
            // over the content so it doesn't reflow the face.
            AnimatedVisibility(
                visible = displayState == DisplayState.Offline,
                enter = expandVertically(),
                exit = shrinkVertically(),
            ) {
                OfflineBanner()
            }

            Box(modifier = Modifier.fillMaxSize()) {
                HorizontalPager(
                    state = pagerState,
                    modifier = Modifier.fillMaxSize(),
                ) { page ->
                    if (page == 0) {
                        ConfigScreen(
                            serverUrl = serverUrl,
                            connectionState = connectionState,
                            pairingCode = pairingCode,
                            onServerUrlChanged = onServerUrlChanged,
                            onReconnect = onReconnect,
                        )
                        return@HorizontalPager
                    }

                    val app = apps[page - 1]

                    if (isHomeApp(app)) {
                        ChatScreen(
                            messages = chatMessagesByApp["home"].orEmpty(),
                            voiceState = voiceState,
                            micAmplitude = micAmplitude,
                            isThinking = "home" in thinkingScopes,
                            onSendMessage = onSendChatMessage,
                            onRetry = { cmid -> onRetryChatMessage("home", cmid) },
                            onVoiceToggle = onVoiceToggle,
                            resetNoticeVisible = "home" in resetNoticeScopes,
                        )
                    } else if (chatOpen) {
                        ChatScreen(
                            messages = chatMessagesByApp[app.appId].orEmpty(),
                            voiceState = voiceState,
                            micAmplitude = micAmplitude,
                            isThinking = "app:${app.appId}" in thinkingScopes,
                            onSendMessage = onSendChatMessage,
                            onRetry = { cmid -> onRetryChatMessage("app:${app.appId}", cmid) },
                            onVoiceToggle = onVoiceToggle,
                            onDismiss = { chatOpen = false },
                            resetNoticeVisible = "app:${app.appId}" in resetNoticeScopes,
                        )
                    } else {
                        MiniAppFacePager(
                            app = app,
                            onFaceChanged = onFaceChanged,
                            dispatch = dispatch,
                            setFormValue = setFormValue,
                            serverHttpBase = toHttpBase(serverUrl),
                        )
                    }
                }
                // Reconnecting dot: top-right, hidden once Offline banner takes over.
                if (displayState == DisplayState.Reconnecting) {
                    ReconnectingPulseDot(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(top = 8.dp, end = 12.dp),
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MiniAppFacePager(
    app: AppState,
    onFaceChanged: (String, Int) -> Unit,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    setFormValue: (key: String, value: Any?) -> Unit,
    serverHttpBase: String,
) {
    if (app.faces.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                "Loading…",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    val facePagerState = rememberPagerState(
        initialPage = app.activeFaceIndex.coerceIn(0, (app.faces.size - 1).coerceAtLeast(0)),
        pageCount = { app.faces.size },
    )

    LaunchedEffect(facePagerState) {
        snapshotFlow { facePagerState.currentPage }.collect { faceIndex ->
            onFaceChanged(app.appId, faceIndex)
        }
    }

    LaunchedEffect(app.activeFaceIndex) {
        if (facePagerState.currentPage != app.activeFaceIndex) {
            facePagerState.animateScrollToPage(app.activeFaceIndex)
        }
    }

    VerticalPager(
        state = facePagerState,
        modifier = Modifier.fillMaxSize(),
    ) { faceIndex ->
        val face = app.faces[faceIndex]
        if (face.components.containsKey("root")) {
            // Inject `$form` so inputs resolve `/$form/<id>` without bespoke renderer wiring.
            val viewData = if (face.form.isEmpty()) face.data else face.data + ("\$form" to face.form)
            CompositionLocalProvider(
                LocalFormSetter provides setFormValue,
                LocalServerHttpBase provides serverHttpBase,
            ) {
                RenderNode(
                    componentId = "root",
                    components = face.components,
                    data = viewData,
                    surfaceId = "${app.appId}:${face.faceId}",
                    dispatch = dispatch,
                )
            }
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    face.faceId,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

fun isHomeApp(app: AppState): Boolean = app.appId == "home"

@Composable
private fun isWideEnoughForPagerDots(): Boolean {
    // >240dp = expanded (phone); ≤240dp = compact (watch) — same breakpoint as isCompactWidth().
    return LocalConfiguration.current.screenWidthDp > 240
}

@Composable
private fun PageIndicator(
    pageCount: Int,
    currentPage: Int,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(pageCount) { index ->
            val color = if (index == currentPage) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f)
            }
            Box(
                modifier = Modifier
                    .padding(horizontal = 4.dp)
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(color),
            )
        }
    }
}

/**
 * Amber 8dp dot that pulses between 40% and 100% opacity while the transport
 * is mid-reconnect. Non-blocking — purely visual. Reuses `tertiary` from the
 * theme so it reads as "warning, not error".
 */
@Composable
private fun ReconnectingPulseDot(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "reconnecting-pulse")
    val alpha by transition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 700, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "reconnecting-pulse-alpha",
    )
    Box(
        modifier = modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.tertiary)
            .alpha(alpha),
    )
}

/**
 * Derive the HTTP base URL from the WebSocket URL by swapping the scheme.
 * Returns "" for blank input so relative asset URLs pass through unchanged.
 */
private fun toHttpBase(serverUrl: String): String {
    if (serverUrl.isBlank()) return ""
    val trimmed = serverUrl.trimEnd('/')
    return when {
        trimmed.startsWith("wss://") -> "https://" + trimmed.removePrefix("wss://")
        trimmed.startsWith("ws://") -> "http://" + trimmed.removePrefix("ws://")
        trimmed.startsWith("https://") || trimmed.startsWith("http://") -> trimmed
        else -> "http://$trimmed"
    }
}

@Composable
private fun OfflineBanner(modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
    ) {
        Text(
            "Offline — messages will send when connected",
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
