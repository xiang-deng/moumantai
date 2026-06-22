package com.moumantai.client.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.moumantai.client.transport.MoumantaiTransport

/** True for a plaintext ws:// URL to a non-loopback host (deviceId in cleartext). */
private fun isInsecureWs(url: String): Boolean {
    val u = url.trim().lowercase()
    if (!u.startsWith("ws://")) return false
    val host = u.removePrefix("ws://").substringBefore("/").substringBefore(":")
    return host !in setOf("localhost", "127.0.0.1", "10.0.2.2", "::1", "[::1]")
}

/**
 * Settings screen displayed as the first page (index 0) in the horizontal pager.
 *
 * Shows the server URL (editable), current connection state, and a reconnect
 * button.
 */
@Composable
fun ConfigScreen(
    serverUrl: String,
    connectionState: MoumantaiTransport.ConnectionState,
    pairingCode: String?,
    onServerUrlChanged: (String) -> Unit,
    onReconnect: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(horizontal = 16.dp, vertical = 16.dp),
    ) {
        Text(
            text = "Settings",
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Server URL field — local state so edits don't trigger reconnect per keystroke.
        // The URL is persisted and applied when the user taps "Reconnect".
        var editedUrl by remember(serverUrl) { mutableStateOf(serverUrl) }

        OutlinedTextField(
            value = editedUrl,
            onValueChange = { editedUrl = it },
            label = { Text("Server URL") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        if (isInsecureWs(editedUrl)) {
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "⚠ Plaintext ws:// — your device ID is sent unencrypted. " +
                    "Prefer wss:// unless this is a trusted local network.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        val statusText = when (connectionState) {
            MoumantaiTransport.ConnectionState.CONNECTED -> "Connected"
            MoumantaiTransport.ConnectionState.CONNECTING -> "Connecting..."
            MoumantaiTransport.ConnectionState.DISCONNECTED -> "Disconnected"
        }
        val statusColor = when (connectionState) {
            MoumantaiTransport.ConnectionState.CONNECTED -> MaterialTheme.colorScheme.primary
            MoumantaiTransport.ConnectionState.CONNECTING -> MaterialTheme.colorScheme.tertiary
            MoumantaiTransport.ConnectionState.DISCONNECTED -> MaterialTheme.colorScheme.error
        }
        Text(
            text = statusText,
            style = MaterialTheme.typography.bodyMedium,
            color = statusColor,
        )

        // Pairing: this device isn't approved on the server yet. Show the code
        // and the exact command to approve it. The transport keeps retrying.
        if (pairingCode != null) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = "Pairing required — code $pairingCode",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.tertiary,
            )
            Text(
                text = "On the server run: task server:cli -- device approve $pairingCode",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        Button(onClick = {
            onServerUrlChanged(editedUrl) // persist to DataStore
            onReconnect()
        }) {
            Text("Reconnect")
        }
    }
}
