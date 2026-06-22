package com.moumantai.client.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.moumantai.client.theme.LocalDimensions
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.ChatRole
import com.moumantai.protocol.v1.TurnStatus
import com.moumantai.protocol.v1.VoiceState
import com.moumantai.protocol.v1.VoiceStateValue
import kotlinx.coroutines.flow.drop

/**
 * Watch-style chat interface — one message per screen.
 *
 * Design principles:
 * - Glanceable: each message fills the screen, readable at a glance
 * - Voice-first: large mic button as primary action
 * - Focused calm: dark cards with generous padding, no clutter
 * - Progressive disclosure: text input is a full-screen overlay
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(
    messages: List<ChatMessage>,
    voiceState: VoiceState,
    onSendMessage: (text: String, imageBytes: ByteArray?) -> Unit,
    onVoiceToggle: () -> Unit,
    micAmplitude: Float = 0f,
    isThinking: Boolean = false,
    onRetry: (String) -> Unit = {},
    onDismiss: (() -> Unit)? = null,
    /** Show the "Conversation reset from another device" banner (flash window ~4s). */
    resetNoticeVisible: Boolean = false,
    /** Called when the user scrolls to the oldest page; idempotent via ViewModel state machine. */
    onLoadOlder: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    var showCompose by remember { mutableStateOf(false) }
    var showCamera by remember { mutableStateOf(false) }
    var detailMessage by remember { mutableStateOf<ChatMessage?>(null) }
    // Image staged via camera; cleared on × tap, dismiss, or send.
    var stagedImage by remember { mutableStateOf<ByteArray?>(null) }
    val dims = LocalDimensions.current

    // Camera: capture stages the image and returns to compose; dismiss leaves staging intact.
    if (showCamera) {
        com.moumantai.client.camera.CameraCapture(
            onImageCaptured = { jpegBytes ->
                stagedImage = jpegBytes
                showCamera = false
                showCompose = true
            },
            onDismiss = { showCamera = false },
        )
        return
    }

    if (showCompose) {
        // -- Compose mode: replaces all chat content ----------------------
        ComposeView(
            voiceState = voiceState,
            stagedImage = stagedImage,
            onClearImage = { stagedImage = null },
            onSend = { text, image ->
                onSendMessage(text, image)
                stagedImage = null
                showCompose = false
            },
            onDismiss = {
                stagedImage = null
                showCompose = false
            },
            onCameraTap = {
                showCompose = false
                showCamera = true
            },
            onBack = onDismiss,
            modifier = modifier,
        )
    } else if (messages.isEmpty()) {
        // -- Empty state --------------------------------------------------
        Box(modifier = modifier.fillMaxSize()) {
            EmptyState(
                onMicTap = onVoiceToggle,
                onKeyboardTap = { showCompose = true },
                voiceState = voiceState,
                micAmplitude = micAmplitude,
                isThinking = isThinking,
                onBack = onDismiss,
            )
            if (resetNoticeVisible) {
                ResetNoticeBanner(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .windowInsetsPadding(WindowInsets.statusBars),
                )
            }
        }
    } else {
        // -- Message view -------------------------------------------------
        val pagerState = rememberPagerState(
            initialPage = messages.size - 1,
            pageCount = { messages.size },
        )

        // Auto-scroll to latest message
        LaunchedEffect(messages.size) {
            pagerState.animateScrollToPage(messages.size - 1)
        }

        if (onLoadOlder != null) {
            LaunchedEffect(pagerState) {
                snapshotFlow { pagerState.currentPage }
                    .drop(1) // snapshotFlow emits the initial value immediately; drop(1) avoids a spurious load on first composition.
                    .collect { page ->
                        if (page == 0) onLoadOlder()
                    }
            }
        }

        Box(modifier = modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(WindowInsets.statusBars),
            ) {
                // Back button (mini app chat dismiss)
                if (onDismiss != null) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = dims.spacingS, vertical = dims.spacingXs),
                        horizontalArrangement = Arrangement.Start,
                    ) {
                        IconButton(onClick = onDismiss, modifier = Modifier.size(40.dp)) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Back",
                            )
                        }
                    }
                }

                // Message counter
                Text(
                    text = "${pagerState.currentPage + 1} / ${messages.size}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = dims.spacingXs),
                    textAlign = TextAlign.Center,
                )

                // Vertical pager — one message per page
                VerticalPager(
                    state = pagerState,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(horizontal = dims.spacingS),
                ) { page ->
                    val m = messages[page]
                    MessagePage(
                        message = m,
                        onTap = {
                            // UNSPECIFIED = local "unsent" sentinel (AppViewModel.UNSENT_STATUS); retry on tap.
                            if (m.status == TurnStatus.TURN_STATUS_UNSPECIFIED && m.client_msg_id != null) {
                                onRetry(m.client_msg_id)
                            } else {
                                detailMessage = m
                            }
                        },
                    )
                }

                // Action bar
                ActionBar(
                    voiceState = voiceState,
                    micAmplitude = micAmplitude,
                    isThinking = isThinking,
                    onMicTap = onVoiceToggle,
                    onKeyboardTap = { showCompose = true },
                    onCameraTap = { showCamera = true },
                    modifier = Modifier.padding(bottom = dims.spacingS),
                )
            }

            // Detail overlay — full-screen, on top of pager
            detailMessage?.let { msg ->
                MessageDetail(message = msg, onDismiss = { detailMessage = null })
            }

            // Sibling-reset banner — overlaid on top of the log so it
            // doesn't reflow the pager and is immediately visible whether
            // the user is on the empty state or mid-scroll.
            if (resetNoticeVisible) {
                ResetNoticeBanner(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .windowInsetsPadding(WindowInsets.statusBars),
                )
            }
        }
    }
}

/**
 * Small toast-style banner shown at the top of the chat screen when a
 * sibling device triggered `/reset`. Non-interactive; clears itself after
 * [com.moumantai.client.state.AppViewModel.RESET_NOTICE_FLASH_MS].
 */
@Composable
private fun ResetNoticeBanner(modifier: Modifier = Modifier) {
    val dims = LocalDimensions.current
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = dims.spacingM, vertical = dims.spacingXs)
            .clip(RoundedCornerShape(dims.cornerRadius))
            .background(MaterialTheme.colorScheme.secondaryContainer)
            .padding(horizontal = dims.spacingM, vertical = dims.spacingS),
    ) {
        Text(
            text = "Conversation reset from another device",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ---------------------------------------------------------------------------
// Shared: animated 3-dot "thinking" indicator
// ---------------------------------------------------------------------------

@Composable
private fun ThinkingDots() {
    val transition = rememberInfiniteTransition(label = "thinking")
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(3) { i ->
            val alpha by transition.animateFloat(
                initialValue = 0.3f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(600, delayMillis = i * 200), RepeatMode.Reverse),
                label = "dot$i",
            )
            Box(
                Modifier
                    .size(6.dp)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = alpha), CircleShape),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

@Composable
private fun EmptyState(
    onMicTap: () -> Unit,
    onKeyboardTap: () -> Unit,
    voiceState: VoiceState,
    micAmplitude: Float = 0f,
    isThinking: Boolean = false,
    onBack: (() -> Unit)? = null,
) {
    val dims = LocalDimensions.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(dims.spacingL),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (onBack != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Start,
            ) {
                IconButton(onClick = onBack, modifier = Modifier.size(40.dp)) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                    )
                }
            }
        }

        Text(
            text = "How can I help?",
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(dims.spacingL))

        // Large mic button — pulses with mic amplitude while listening
        val isListening = voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_LISTENING
        val pulseTarget = if (isListening) 1f + (micAmplitude.coerceIn(0f, 1f) * 1.5f) else 1f
        val pulseScale by animateFloatAsState(
            targetValue = pulseTarget,
            animationSpec = tween(durationMillis = 80),
            label = "micPulse",
        )

        val showThinking = isThinking || voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_THINKING
        FilledTonalButton(
            onClick = onMicTap,
            modifier = Modifier.size(64.dp).scale(pulseScale),
            shape = CircleShape,
        ) {
            when {
                voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_LISTENING -> Icon(
                    Icons.Filled.Stop,
                    contentDescription = "Stop",
                    modifier = Modifier.size(28.dp),
                )
                showThinking -> ThinkingDots()
                voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_SPEAKING -> Icon(
                    Icons.AutoMirrored.Filled.VolumeUp,
                    contentDescription = "Speaking",
                    modifier = Modifier.size(28.dp),
                )
                else -> Icon(
                    Icons.Filled.Mic,
                    contentDescription = "Voice input",
                    modifier = Modifier.size(28.dp),
                )
            }
        }

        Spacer(modifier = Modifier.height(dims.spacingM))

        TextButton(onClick = onKeyboardTap) {
            Icon(
                Icons.Filled.Keyboard,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
            )
            Text(
                text = "  Type instead",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Message Page — one message fills the screen
// ---------------------------------------------------------------------------

@Composable
private fun MessagePage(message: ChatMessage, onTap: () -> Unit = {}) {
    val dims = LocalDimensions.current
    val isUser = message.role == ChatRole.CHAT_ROLE_USER

    val backgroundColor = if (isUser) {
        MaterialTheme.colorScheme.primaryContainer
    } else {
        MaterialTheme.colorScheme.surfaceVariant
    }

    val textColor = if (isUser) {
        MaterialTheme.colorScheme.onPrimaryContainer
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    val roleLabel = if (isUser) "You" else "Assistant"
    var hasOverflow by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(vertical = dims.spacingXs)
            .clip(MaterialTheme.shapes.medium)
            .background(backgroundColor)
            .clickable(onClick = onTap)
            .padding(dims.spacingL),
    ) {
        // Role label — top start
        Text(
            text = roleLabel,
            style = MaterialTheme.typography.labelSmall,
            color = textColor.copy(alpha = 0.5f),
            modifier = Modifier.align(Alignment.TopStart),
        )

        // Message text — centered
        Text(
            text = message.text,
            style = MaterialTheme.typography.bodyLarge,
            color = textColor,
            textAlign = TextAlign.Start,
            overflow = TextOverflow.Ellipsis,
            onTextLayout = { result -> hasOverflow = result.hasVisualOverflow },
            modifier = Modifier
                .align(Alignment.CenterStart)
                .padding(top = dims.spacingM, bottom = dims.spacingM)
                .fillMaxWidth(),
        )

        // Timestamp + overflow hint — bottom
        Row(
            modifier = Modifier.align(Alignment.BottomEnd),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            when {
                message.status == TurnStatus.TURN_STATUS_UNSPECIFIED -> { // local unsent sentinel
                    Text(
                        text = "Not sent — tap to retry",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                hasOverflow -> {
                    Text(
                        text = "Tap to read",
                        style = MaterialTheme.typography.labelSmall,
                        color = textColor.copy(alpha = 0.5f),
                    )
                }
            }
            Text(
                text = formatChatTimestamp(message.timestamp),
                style = MaterialTheme.typography.labelSmall,
                color = textColor.copy(alpha = 0.4f),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Message Detail — full-screen scrollable view
// ---------------------------------------------------------------------------

@Composable
private fun MessageDetail(message: ChatMessage, onDismiss: () -> Unit) {
    val dims = LocalDimensions.current
    val isUser = message.role == ChatRole.CHAT_ROLE_USER
    val scrollState = rememberScrollState()

    val backgroundColor = if (isUser) {
        MaterialTheme.colorScheme.primaryContainer
    } else {
        MaterialTheme.colorScheme.surfaceVariant
    }

    val textColor = if (isUser) {
        MaterialTheme.colorScheme.onPrimaryContainer
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    val roleLabel = if (isUser) "You" else "Assistant"

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(backgroundColor)
            .windowInsetsPadding(WindowInsets.statusBars),
    ) {
        // Header row: back arrow + role + timestamp
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = dims.spacingXs, vertical = dims.spacingXs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onDismiss, modifier = Modifier.size(48.dp)) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = textColor.copy(alpha = 0.7f),
                )
            }
            Text(
                text = roleLabel,
                style = MaterialTheme.typography.labelMedium,
                color = textColor.copy(alpha = 0.6f),
                modifier = Modifier.weight(1f),
            )
            Text(
                text = formatChatTimestamp(message.timestamp),
                style = MaterialTheme.typography.labelSmall,
                color = textColor.copy(alpha = 0.4f),
                modifier = Modifier.padding(end = dims.spacingS),
            )
        }

        // Scrollable message text
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .padding(horizontal = dims.spacingL)
                .padding(bottom = dims.spacingL),
        ) {
            Text(
                text = message.text,
                style = MaterialTheme.typography.bodyLarge,
                color = textColor,
                textAlign = TextAlign.Start,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Action Bar — mic + keyboard
// ---------------------------------------------------------------------------

@Composable
private fun ActionBar(
    voiceState: VoiceState,
    micAmplitude: Float = 0f,
    isThinking: Boolean = false,
    onMicTap: () -> Unit,
    onKeyboardTap: () -> Unit,
    onCameraTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dims = LocalDimensions.current
    val showThinking = isThinking || voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_THINKING
    val isActive = voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_LISTENING || voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_SPEAKING || showThinking

    if (isActive) {
        // Active — centered status row
        Row(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = dims.spacingM),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_LISTENING -> {
                    val pulseScale by animateFloatAsState(
                        targetValue = 1f + (micAmplitude.coerceIn(0f, 1f) * 1.5f),
                        animationSpec = tween(durationMillis = 80),
                        label = "micPulse",
                    )
                    FilledTonalButton(
                        onClick = onMicTap,
                        modifier = Modifier.size(48.dp).scale(pulseScale),
                        shape = CircleShape,
                    ) {
                        Icon(Icons.Filled.Stop, contentDescription = "Stop", modifier = Modifier.size(24.dp))
                    }
                    Text("  Listening...", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                }
                showThinking -> {
                    ThinkingDots()
                    Spacer(Modifier.width(8.dp))
                    Text("Thinking", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                }
                voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_SPEAKING -> {
                    Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = "Speaking", modifier = Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
                    Text("  Speaking...", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    } else {
        // Idle — [camera] ··· [mic centered] ··· [keyboard]
        Box(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = dims.spacingM),
            contentAlignment = Alignment.Center,
        ) {
            // Camera — left
            IconButton(
                onClick = onCameraTap,
                modifier = Modifier
                    .size(40.dp)
                    .align(Alignment.CenterStart),
            ) {
                Icon(
                    Icons.Filled.CameraAlt,
                    contentDescription = "Camera",
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }

            // Mic — centered
            FilledTonalButton(
                onClick = onMicTap,
                modifier = Modifier.size(48.dp),
                shape = CircleShape,
            ) {
                Icon(Icons.Filled.Mic, contentDescription = "Voice", modifier = Modifier.size(24.dp))
            }

            // Keyboard — right
            IconButton(
                onClick = onKeyboardTap,
                modifier = Modifier
                    .size(40.dp)
                    .align(Alignment.CenterEnd),
            ) {
                Icon(
                    Icons.Filled.Keyboard,
                    contentDescription = "Type",
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Compose View — replaces chat content when typing
// ---------------------------------------------------------------------------

@Composable
private fun ComposeView(
    voiceState: VoiceState,
    stagedImage: ByteArray? = null,
    onClearImage: () -> Unit = {},
    onSend: (text: String, image: ByteArray?) -> Unit,
    onDismiss: () -> Unit,
    onCameraTap: () -> Unit = {},
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val dims = LocalDimensions.current
    var text by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val cameraEnabled = voiceState.state == VoiceStateValue.VOICE_STATE_VALUE_IDLE
    val canSend = text.isNotBlank() || stagedImage != null

    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.ime)
            .padding(dims.spacingM),
        verticalArrangement = Arrangement.Center,
    ) {
        if (onBack != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Start,
            ) {
                IconButton(onClick = onBack, modifier = Modifier.size(40.dp)) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                    )
                }
            }
        }

        // Staged-image thumbnail: tap × to clear before sending.
        if (stagedImage != null) {
            Surface(
                shape = RoundedCornerShape(dims.cornerRadius),
                tonalElevation = 2.dp,
                modifier = Modifier.padding(bottom = dims.spacingS),
            ) {
                Box(modifier = Modifier.size(width = 80.dp, height = 72.dp)) {
                    AsyncImage(
                        model = stagedImage,
                        contentDescription = "Staged image",
                        modifier = Modifier
                            .size(64.dp)
                            .align(Alignment.CenterStart)
                            .padding(start = 4.dp)
                            .clip(RoundedCornerShape(dims.cornerRadius)),
                    )
                    IconButton(
                        onClick = onClearImage,
                        modifier = Modifier
                            .size(24.dp)
                            .align(Alignment.TopEnd),
                    ) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Remove image",
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        // Text input — compact, centered
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = {
                Text(
                    "Type your message...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                )
            },
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focusRequester),
            textStyle = MaterialTheme.typography.bodyMedium,
            singleLine = false,
            maxLines = 4,
            shape = RoundedCornerShape(dims.cornerRadius),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.2f),
                focusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.5f),
                unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f),
                cursorColor = MaterialTheme.colorScheme.primary,
            ),
        )

        Spacer(modifier = Modifier.height(dims.spacingS))

        // Action row — cancel + camera + send
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onDismiss) {
                Text(
                    "Cancel",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }

            // Disabled during voice — a sibling-initiated session could arrive mid-compose.
            IconButton(
                onClick = onCameraTap,
                enabled = cameraEnabled,
                modifier = Modifier.size(40.dp),
            ) {
                Icon(
                    Icons.Filled.CameraAlt,
                    contentDescription = "Camera",
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(
                        alpha = if (cameraEnabled) 0.6f else 0.3f,
                    ),
                )
            }

            FilledTonalButton(
                onClick = {
                    val trimmed = text.trim()
                    if (canSend) onSend(trimmed, stagedImage)
                },
                enabled = canSend,
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowForward,
                    contentDescription = "Send",
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    "  Send",
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}
