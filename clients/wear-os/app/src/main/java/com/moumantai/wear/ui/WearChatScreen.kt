package com.moumantai.wear.ui

import android.app.Activity
import android.app.RemoteInput
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.SwipeToDismissValue
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.foundation.rememberSwipeToDismissBoxState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.FilledIconButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.IconButtonDefaults
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.SwipeToDismissBox
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.input.RemoteInputIntentHelper
import com.moumantai.protocol.v1.ChatMessage
import com.moumantai.protocol.v1.ChatRole
import com.moumantai.protocol.v1.TurnStatus
import com.moumantai.protocol.v1.VoiceState
import com.moumantai.protocol.v1.VoiceStateValue
import com.moumantai.wear.renderer.lookupMaterialIcon
import kotlinx.coroutines.launch

/**
 * Voice-first chat screen for Wear OS.
 *
 * Shows a large mic button when empty, one-message-per-glance when active,
 * and voice state indicators at the bottom.
 */
@Composable
fun WearChatScreen(
    messages: List<ChatMessage>,
    voiceState: VoiceState,
    onSendMessage: (String) -> Unit,
    onVoiceToggle: () -> Unit,
    scope: String,
    onRetry: (String) -> Unit = {},
    resetNoticeVisible: Boolean = false,
    loadOlderState: com.moumantai.wear.state.AppViewModel.LoadOlder? = null,
    onLoadOlder: (() -> Unit)? = null,
) {
    val state: VoiceStateValue = voiceState.state ?: VoiceStateValue.VOICE_STATE_VALUE_IDLE

    val remoteInputLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val text = RemoteInput.getResultsFromIntent(result.data)
                ?.getCharSequence(REMOTE_INPUT_KEY)
                ?.toString()
                ?.trim()
            if (!text.isNullOrEmpty()) {
                onSendMessage(text)
            }
        }
    }

    val onKeyboardTap = remember(remoteInputLauncher) {
        {
            val remoteInput = RemoteInput.Builder(REMOTE_INPUT_KEY)
                .setLabel("Message")
                .build()
            val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
            RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(remoteInput))
            remoteInputLauncher.launch(intent)
        }
    }

    var detailMessage by remember { mutableStateOf<ChatMessage?>(null) }

    Box(modifier = Modifier.fillMaxSize()) {
        if (messages.isEmpty()) {
            EmptyChatState(
                voiceState = state,
                onVoiceToggle = onVoiceToggle,
                onKeyboardTap = onKeyboardTap,
            )
        } else {
            ActiveChatState(
                messages = messages,
                voiceState = state,
                onVoiceToggle = onVoiceToggle,
                onKeyboardTap = onKeyboardTap,
                onRetry = onRetry,
                onMessageTap = { detailMessage = it },
                loadOlderState = loadOlderState,
                onLoadOlder = onLoadOlder,
            )
        }
        if (resetNoticeVisible) {
            ResetNoticeBanner(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 4.dp),
            )
        }
        detailMessage?.let { msg ->
            WearMessageDetail(message = msg, onDismiss = { detailMessage = null })
        }
    }
}

@Composable
private fun ResetNoticeBanner(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .padding(horizontal = 8.dp)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.secondary)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text(
            text = "Reset from another device",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

private const val REMOTE_INPUT_KEY = "chat_message"

@Composable
private fun EmptyChatState(
    voiceState: VoiceStateValue,
    onVoiceToggle: () -> Unit,
    onKeyboardTap: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "How can I help?",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(12.dp))

        VoiceButton(
            voiceState = voiceState,
            onToggle = onVoiceToggle,
            size = 64,
        )

        Spacer(modifier = Modifier.height(8.dp))

        if (voiceState == VoiceStateValue.VOICE_STATE_VALUE_IDLE) {
            KeyboardButton(size = 36, onClick = onKeyboardTap)
        } else {
            VoiceStateLabel(voiceState)
        }
    }
}

@Composable
private fun ActiveChatState(
    messages: List<ChatMessage>,
    voiceState: VoiceStateValue,
    onVoiceToggle: () -> Unit,
    onKeyboardTap: () -> Unit,
    onRetry: (String) -> Unit,
    onMessageTap: (ChatMessage) -> Unit,
    loadOlderState: com.moumantai.wear.state.AppViewModel.LoadOlder? = null,
    onLoadOlder: (() -> Unit)? = null,
) {
    val listState = rememberScalingLazyListState()

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (loadOlderState != null && onLoadOlder != null) {
                when (loadOlderState.state) {
                    com.moumantai.wear.state.AppViewModel.LoadOlderState.IDLE -> {
                        if (loadOlderState.hasMore) {
                            item {
                                Button(
                                    onClick = onLoadOlder,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 4.dp, vertical = 2.dp),
                                    colors = ButtonDefaults.filledTonalButtonColors(),
                                    label = {
                                        Text(
                                            text = "Load earlier",
                                            style = MaterialTheme.typography.labelSmall,
                                        )
                                    },
                                )
                            }
                        }
                    }
                    com.moumantai.wear.state.AppViewModel.LoadOlderState.LOADING -> {
                        item {
                            Text(
                                text = "Loading…",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                                textAlign = TextAlign.Center,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                            )
                        }
                    }
                    com.moumantai.wear.state.AppViewModel.LoadOlderState.EXHAUSTED -> {
                        // Nothing shown — no more history to load.
                    }
                }
            }
            itemsIndexed(messages) { _, msg ->
                MessageBubble(
                    message = msg,
                    onRetry = {
                        val cmid = msg.client_msg_id
                        if (msg.status == TurnStatus.TURN_STATUS_UNSPECIFIED && cmid != null) {
                            onRetry(cmid)
                        }
                    },
                    onTap = { onMessageTap(msg) },
                )
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 4.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (voiceState == VoiceStateValue.VOICE_STATE_VALUE_IDLE) {
                KeyboardButton(size = 32, onClick = onKeyboardTap)
                Spacer(modifier = Modifier.width(12.dp))
            }
            VoiceButton(
                voiceState = voiceState,
                onToggle = onVoiceToggle,
                size = 40,
            )
        }
    }
}

@Composable
private fun MessageBubble(
    message: ChatMessage,
    onRetry: () -> Unit = {},
    onTap: () -> Unit = {},
) {
    val isUser = message.role == ChatRole.CHAT_ROLE_USER
    val bgColor = if (isUser) {
        MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
    } else {
        MaterialTheme.colorScheme.surfaceContainer
    }

    val isUnsent = message.status == TurnStatus.TURN_STATUS_UNSPECIFIED && message.client_msg_id != null && isUser

    var hasOverflow by remember { mutableStateOf(false) }

    val clickAction: (() -> Unit)? = when {
        isUnsent -> onRetry
        hasOverflow -> onTap
        else -> null
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
            .background(bgColor)
            .let { if (clickAction != null) it.clickable(onClick = clickAction) else it }
            .padding(8.dp),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        Text(
            text = when (message.role) {
                ChatRole.CHAT_ROLE_USER -> "You"
                ChatRole.CHAT_ROLE_SYSTEM -> "System"
                else -> "Assistant"
            },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )
        Text(
            text = message.text,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            onTextLayout = { hasOverflow = it.hasVisualOverflow },
        )
        if (isUnsent) {
            Text(
                text = "Not sent — tap to retry",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun WearMessageDetail(message: ChatMessage, onDismiss: () -> Unit) {
    val isUser = message.role == ChatRole.CHAT_ROLE_USER
    val bgColor = if (isUser) {
        MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
    } else {
        MaterialTheme.colorScheme.surfaceContainer
    }

    val roleLabel = when (message.role) {
        ChatRole.CHAT_ROLE_USER -> "You"
        ChatRole.CHAT_ROLE_SYSTEM -> "System"
        else -> "Assistant"
    }

    val swipeState = rememberSwipeToDismissBoxState()
    val scrollState = rememberScrollState()
    val coroutineScope = rememberCoroutineScope()
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    LaunchedEffect(swipeState.currentValue) {
        if (swipeState.currentValue == SwipeToDismissValue.Dismissed) onDismiss()
    }

    SwipeToDismissBox(
        state = swipeState,
    ) { isBackground ->
        if (isBackground) {
            Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
        } else {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(bgColor),
            ) {
                TimeText()
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 12.dp)
                        .padding(top = 28.dp, bottom = 12.dp)
                        .onRotaryScrollEvent { event ->
                            coroutineScope.launch {
                                scrollState.scrollBy(event.verticalScrollPixels)
                            }
                            true
                        }
                        .focusRequester(focusRequester)
                        .focusable()
                        .verticalScroll(scrollState),
                ) {
                    Text(
                        text = roleLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = message.text,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

@Composable
private fun VoiceButton(
    voiceState: VoiceStateValue,
    onToggle: () -> Unit,
    size: Int,
) {
    val buttonColor = when (voiceState) {
        VoiceStateValue.VOICE_STATE_VALUE_LISTENING -> MaterialTheme.colorScheme.error
        VoiceStateValue.VOICE_STATE_VALUE_THINKING -> MaterialTheme.colorScheme.secondary
        VoiceStateValue.VOICE_STATE_VALUE_SPEAKING -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.primary
    }

    val iconName = when (voiceState) {
        VoiceStateValue.VOICE_STATE_VALUE_LISTENING -> "stop"
        VoiceStateValue.VOICE_STATE_VALUE_THINKING -> "more_horiz"
        VoiceStateValue.VOICE_STATE_VALUE_SPEAKING -> "volume_up"
        else -> "mic"
    }
    val iconSize = if (size >= 64) 32 else 20

    FilledIconButton(
        onClick = {
            when (voiceState) {
                VoiceStateValue.VOICE_STATE_VALUE_IDLE -> onToggle()
                VoiceStateValue.VOICE_STATE_VALUE_LISTENING -> onToggle()
                VoiceStateValue.VOICE_STATE_VALUE_SPEAKING -> onToggle()
                else -> {} // thinking / unspecified — no action
            }
        },
        modifier = Modifier.size(size.dp),
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = buttonColor,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ),
    ) {
        Icon(
            imageVector = lookupMaterialIcon(iconName),
            contentDescription = iconName,
            modifier = Modifier.size(iconSize.dp),
        )
    }
}

@Composable
private fun KeyboardButton(size: Int, onClick: () -> Unit) {
    val iconSize = if (size >= 36) 20 else 16
    FilledIconButton(
        onClick = onClick,
        modifier = Modifier.size(size.dp),
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
            contentColor = MaterialTheme.colorScheme.onSurface,
        ),
    ) {
        Icon(
            imageVector = lookupMaterialIcon("keyboard"),
            contentDescription = "Keyboard",
            modifier = Modifier.size(iconSize.dp),
        )
    }
}

@Composable
private fun VoiceStateLabel(voiceState: VoiceStateValue) {
    val label = when (voiceState) {
        VoiceStateValue.VOICE_STATE_VALUE_LISTENING -> "Listening..."
        VoiceStateValue.VOICE_STATE_VALUE_THINKING -> "Thinking..."
        VoiceStateValue.VOICE_STATE_VALUE_SPEAKING -> "Speaking..."
        else -> ""
    }

    if (label.isNotEmpty()) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
    }
}
