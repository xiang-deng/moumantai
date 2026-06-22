package com.moumantai.wear.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.foundation.pager.VerticalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.HorizontalPageIndicator
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.VoiceState
import com.moumantai.wear.renderer.LocalFormSetter
import com.moumantai.wear.renderer.RenderNode
import com.moumantai.wear.state.AppState
import com.moumantai.wear.state.AppViewModel
import com.moumantai.wear.state.DisplayState
import com.moumantai.wear.theme.WearColorStatusError
import com.moumantai.wear.theme.WearColorStatusWarning
import com.moumantai.wear.transport.Transport
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

// Pulse animation duration for the Reconnecting status dot (700ms is
// intentionally slower than MOTION_DURATION_MEDIUM so the pulse is perceptible
// without being distracting on a small watch face).
private const val WEAR_CONN_PULSE_DURATION_MS = 700

// Visual diameter of the connection-status indicator dot.
private const val CONNECTION_DOT_SIZE_DP = 6

/**
 * Horizontal pager for apps, with vertical pager for faces within each app.
 * Home app renders [WearChatScreen]; mini apps render face component trees.
 *
 * Outer chrome is owned by M3 `AppScaffold`: it curves [TimeText] along the
 * top arc and gives each `ScreenScaffold`-wrapped face the room to draw its
 * own per-screen chrome (ScrollIndicator on the right bezel, EdgeButton along
 * the bottom). M3 drops M2's `Vignette` — the chin clearance is folded into
 * AppScaffold + ScreenScaffold's content padding.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WearAppPager(
    apps: List<AppState>,
    activeAppIndex: Int,
    onAppChanged: (Int) -> Unit,
    onFaceChanged: (String, Int) -> Unit,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    /**
     * Per-face form-state writer. Inputs without `action` invoke this on
     * change; the caller routes to the active face's `form` map. Defaults
     * to a no-op so unit tests don't need to provide one.
     */
    setFormValue: (key: String, value: Any?) -> Unit = { _, _ -> },
    chatMessagesByApp: Map<String, List<ChatMessage>>,
    voiceState: VoiceState,
    onSendChatMessage: (String) -> Unit,
    onRetryChatMessage: (String, String) -> Unit = { _, _ -> },
    onVoiceToggle: () -> Unit,
    serverUrl: String,
    connectionState: Transport.ConnectionState,
    pairingCode: String? = null,
    onReconnect: () -> Unit,
    onServerUrlChanged: (String) -> Unit = {},
    displayState: DisplayState = DisplayState.Connected,
    resetNoticeScopes: Set<String> = emptySet(),
    transientNotice: String? = null,
    onNoticeShown: () -> Unit = {},
    openChatFlow: Flow<String> = emptyFlow(),
    loadOlderByScope: Map<String, AppViewModel.LoadOlder> = emptyMap(),
    onLoadOlder: (String) -> Unit = {},
) {
    // Page 0 = config screen, pages 1..N = apps
    val totalPages = apps.size + 1

    val pagerState = rememberPagerState(
        initialPage = if (apps.isEmpty()) 0 else activeAppIndex + 1,
        pageCount = { totalPages },
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

    // M3 AppScaffold owns top-arc TimeText. Per-face ScreenScaffold (inside
    // RenderNode → ScaffoldRenderer) owns the right-bezel ScrollIndicator
    // + chin-aware body padding.
    AppScaffold(
        modifier = Modifier.fillMaxSize(),
        timeText = { TimeText() },
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
                if (page == 0) {
                    WearConfigScreen(
                        serverUrl = serverUrl,
                        connectionState = connectionState,
                        pairingCode = pairingCode,
                        onReconnect = onReconnect,
                        onServerUrlChanged = onServerUrlChanged,
                    )
                } else {
                    val appIndex = page - 1
                    if (appIndex >= apps.size) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("...", style = MaterialTheme.typography.bodyMedium)
                        }
                    } else {
                        val app = apps[appIndex]

                        if (app.appId == "home") {
                            WearChatScreen(
                                messages = chatMessagesByApp["home"].orEmpty(),
                                voiceState = voiceState,
                                onSendMessage = onSendChatMessage,
                                onVoiceToggle = onVoiceToggle,
                                scope = "home",
                                onRetry = { cmid -> onRetryChatMessage("home", cmid) },
                                resetNoticeVisible = "home" in resetNoticeScopes,
                                loadOlderState = loadOlderByScope["home"],
                                onLoadOlder = { onLoadOlder("home") },
                            )
                        } else if (app.faces.isEmpty()) {
                            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text("Loading...", style = MaterialTheme.typography.bodyMedium)
                            }
                        } else {
                            WearFacePager(
                                app = app,
                                dispatch = dispatch,
                                setFormValue = setFormValue,
                                onFaceChanged = onFaceChanged,
                                chatMessages = chatMessagesByApp[app.appId].orEmpty(),
                                voiceState = voiceState,
                                onSendChatMessage = onSendChatMessage,
                                onRetryChatMessage = onRetryChatMessage,
                                onVoiceToggle = onVoiceToggle,
                                resetNoticeScopes = resetNoticeScopes,
                                openChatFlow = openChatFlow,
                                loadOlderByScope = loadOlderByScope,
                                onLoadOlder = onLoadOlder,
                            )
                        }
                    }
                }
            }

            // M3 HorizontalPageIndicator binds directly to the PagerState.
            if (totalPages > 1) {
                HorizontalPageIndicator(
                    pagerState = pagerState,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 4.dp),
                )
            }

            if (displayState == DisplayState.Offline) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.3f)),
                )
            }

            ConnectionIndicatorDot(
                displayState = displayState,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 6.dp, end = 10.dp),
            )

            TransientNoticeBanner(
                notice = transientNotice,
                onShown = onNoticeShown,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 28.dp, start = 12.dp, end = 12.dp),
            )
        }
    }
}

@Composable
private fun TransientNoticeBanner(
    notice: String?,
    onShown: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (notice == null) return
    LaunchedEffect(notice) {
        kotlinx.coroutines.delay(4_000)
        onShown()
    }
    androidx.wear.compose.material3.Card(
        onClick = onShown,
        modifier = modifier,
    ) {
        Text(
            text = notice,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onError,
            modifier = Modifier.padding(8.dp),
        )
    }
}

/**
 * Small connection-status dot rendered on top of the face content.
 *  - Connected → not drawn
 *  - Reconnecting → pulsing amber (40%→100% alpha, 700ms reverse tween)
 *  - Offline → solid red at full alpha (scrim behind conveys the outage)
 *
 * Sized at 6dp to minimise visual footprint on the small watch screen.
 */
@Composable
private fun ConnectionIndicatorDot(
    displayState: DisplayState,
    modifier: Modifier = Modifier,
) {
    if (displayState == DisplayState.Connected) return

    val transition = rememberInfiniteTransition(label = "wear-conn-pulse")
    val pulseAlpha by transition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = WEAR_CONN_PULSE_DURATION_MS, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "wear-conn-pulse-alpha",
    )

    val color = when (displayState) {
        DisplayState.Reconnecting -> WearColorStatusWarning
        DisplayState.Offline -> WearColorStatusError
        DisplayState.Connected -> Color.Transparent
    }
    val alpha = if (displayState == DisplayState.Reconnecting) pulseAlpha else 1f

    Box(
        modifier = modifier
            .size(CONNECTION_DOT_SIZE_DP.dp)
            .clip(CircleShape)
            .background(color)
            .alpha(alpha),
    )
}

/**
 * Vertical pager for a mini-app. Page 0 is the app's Chat (special); pages
 * 1..N are the real faces from `app.faces`. Default opens on page 1 (first
 * real face); swiping up reveals Chat.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WearFacePager(
    app: AppState,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    setFormValue: (key: String, value: Any?) -> Unit,
    onFaceChanged: (String, Int) -> Unit,
    chatMessages: List<ChatMessage>,
    voiceState: VoiceState,
    onSendChatMessage: (String) -> Unit,
    onRetryChatMessage: (String, String) -> Unit = { _, _ -> },
    onVoiceToggle: () -> Unit,
    resetNoticeScopes: Set<String> = emptySet(),
    openChatFlow: Flow<String> = emptyFlow(),
    loadOlderByScope: Map<String, AppViewModel.LoadOlder> = emptyMap(),
    onLoadOlder: (String) -> Unit = {},
) {
    val totalPages = app.faces.size + 1
    fun facePageForActive() = (app.activeFaceIndex + 1).coerceIn(1, totalPages - 1)

    val facePagerState = rememberPagerState(
        initialPage = facePageForActive(),
        pageCount = { totalPages },
    )

    LaunchedEffect(app.appId) {
        if (facePagerState.currentPage == 0) facePagerState.scrollToPage(facePageForActive())
    }

    LaunchedEffect(facePagerState) {
        snapshotFlow { facePagerState.currentPage }.collect { page ->
            if (page > 0) onFaceChanged(app.appId, page - 1)
        }
    }

    LaunchedEffect(openChatFlow) {
        openChatFlow.collect { facePagerState.animateScrollToPage(0) }
    }

    VerticalPager(state = facePagerState, modifier = Modifier.fillMaxSize()) { page ->
        if (page == 0) {
            val appScope = "app:${app.appId}"
            WearChatScreen(
                messages = chatMessages,
                voiceState = voiceState,
                onSendMessage = onSendChatMessage,
                onVoiceToggle = onVoiceToggle,
                scope = appScope,
                onRetry = { cmid -> onRetryChatMessage(appScope, cmid) },
                resetNoticeVisible = appScope in resetNoticeScopes,
                loadOlderState = loadOlderByScope[appScope],
                onLoadOlder = { onLoadOlder(appScope) },
            )
        } else {
            val face = app.faces[page - 1]
            // Merge form state under `$form` so inputs resolve `/$form/<id>` pointers.
            val viewData = if (face.form.isEmpty()) face.data else face.data + ("\$form" to face.form)
            CompositionLocalProvider(LocalFormSetter provides setFormValue) {
                RenderNode(
                    componentId = "root",
                    components = face.components,
                    data = viewData,
                    surfaceId = "${app.appId}:${face.faceId}",
                    dispatch = dispatch,
                )
            }
        }
    }
}
