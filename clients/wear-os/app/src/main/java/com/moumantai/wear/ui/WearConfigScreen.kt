package com.moumantai.wear.ui

import android.app.Activity
import android.app.RemoteInput
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.input.RemoteInputIntentHelper
import androidx.wear.input.WearableRemoteInputExtender
import com.moumantai.wear.transport.Transport

private const val SERVER_URL_REMOTE_INPUT_KEY = "server_url"
private const val WEAR_INPUT_ACTION_DONE = 2

/**
 * Settings / config page that lives at pager index 0 (before apps).
 *
 * Shows the server URL (tap to edit), current connection state, and a
 * reconnect button. Wrapped in an M3 `ScreenScaffold` so it gets the same
 * right-bezel ScrollIndicator + chin-aware padding as any other face.
 */
/** True for a plaintext ws:// URL to a non-loopback host (deviceId in cleartext). */
private fun isInsecureWs(url: String): Boolean {
    val u = url.trim().lowercase()
    if (!u.startsWith("ws://")) return false
    val host = u.removePrefix("ws://").substringBefore("/").substringBefore(":")
    return host !in setOf("localhost", "127.0.0.1", "10.0.2.2", "::1", "[::1]")
}

@Composable
fun WearConfigScreen(
    serverUrl: String,
    connectionState: Transport.ConnectionState,
    pairingCode: String? = null,
    onReconnect: () -> Unit,
    onServerUrlChanged: (String) -> Unit = {},
) {
    val listState = rememberLazyListState()

    val urlInputLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val entered = RemoteInput.getResultsFromIntent(result.data)
                ?.getCharSequence(SERVER_URL_REMOTE_INPUT_KEY)
                ?.toString()
                ?.trim()
            if (!entered.isNullOrEmpty()) {
                onServerUrlChanged(entered)
            }
        }
    }
    val onUrlChipTap = remember(urlInputLauncher, serverUrl) {
        {
            val remoteInput = RemoteInput.Builder(SERVER_URL_REMOTE_INPUT_KEY)
                .setLabel("Server URL")
                .setAllowFreeFormInput(true)
                .also { builder ->
                    WearableRemoteInputExtender(builder)
                        .setEmojisAllowed(false)
                        .setInputActionType(WEAR_INPUT_ACTION_DONE)
                }
                .build()
            val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
            RemoteInputIntentHelper.putTitleExtra(intent, "Server URL")
            RemoteInputIntentHelper.putConfirmLabelExtra(intent, "Save")
            RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(remoteInput))
            urlInputLauncher.launch(intent)
        }
    }

    ScreenScaffold(
        scrollState = listState,
        modifier = Modifier.fillMaxSize(),
    ) { contentPadding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = 10.dp,
                top = contentPadding.calculateTopPadding() + 8.dp,
                end = 10.dp,
                bottom = contentPadding.calculateBottomPadding() + 8.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item {
                Text(
                    text = "Connection",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.primary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 4.dp),
                )
            }

            item {
                FilledTonalButton(
                    onClick = onUrlChipTap,
                    modifier = Modifier.fillMaxWidth(),
                    label = {
                        Text(
                            text = serverUrl,
                            maxLines = 2,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    },
                    secondaryLabel = { Text("Tap to edit") },
                )
            }

            item {
                val statusText = when (connectionState) {
                    Transport.ConnectionState.CONNECTED -> "Connected"
                    Transport.ConnectionState.CONNECTING -> "Connecting..."
                    Transport.ConnectionState.DISCONNECTED -> "Disconnected"
                }
                val statusColor = when (connectionState) {
                    Transport.ConnectionState.CONNECTED -> MaterialTheme.colorScheme.primary
                    Transport.ConnectionState.CONNECTING -> MaterialTheme.colorScheme.secondary
                    Transport.ConnectionState.DISCONNECTED -> MaterialTheme.colorScheme.error
                }
                Text(
                    text = statusText,
                    style = MaterialTheme.typography.bodySmall,
                    color = statusColor,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                )
            }

            if (isInsecureWs(serverUrl)) {
                item {
                    Text(
                        text = "⚠ Plaintext ws:// — device ID sent unencrypted. Prefer wss://.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    )
                }
            }

            // Pairing: this device isn't approved yet. Show the code + how to
            // approve it on the server. The transport keeps retrying.
            if (pairingCode != null) {
                item {
                    Text(
                        text = "Pairing required\ncode $pairingCode\nrun: task server:cli -- device approve $pairingCode",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                    )
                }
            }

            item {
                Button(
                    onClick = onReconnect,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Reconnect") },
                )
            }
        }
    }
}
