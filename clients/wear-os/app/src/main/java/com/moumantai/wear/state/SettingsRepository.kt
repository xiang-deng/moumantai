package com.moumantai.wear.state

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.UUID

const val DEFAULT_SERVER_URL = "ws://10.0.2.2:3000"

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/**
 * DataStore-backed settings for the Wear OS client.
 *
 * Exposes [serverUrl] as an observable [Flow] with a suspend setter, plus a
 * lazy device-id getter that persists for the install lifetime.
 */
class SettingsRepository(private val context: Context) {

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
    }

    /** WebSocket server URL (default: emulator localhost). */
    val serverUrl: Flow<String> = context.dataStore.data.map { prefs ->
        normalizeServerUrl(prefs[Keys.SERVER_URL]) ?: DEFAULT_SERVER_URL
    }

    /** Persist a new server URL. */
    suspend fun setServerUrl(url: String) {
        val normalized = normalizeServerUrl(url) ?: return
        context.dataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = normalized
        }
    }

    /**
     * Stable per-device UUIDv4. Generated lazily, persisted for the install
     * lifetime.
     */
    suspend fun getOrCreateDeviceId(): String {
        var result = ""
        context.dataStore.edit { prefs ->
            val existing = prefs[Keys.DEVICE_ID]
            if (existing != null) {
                result = existing
            } else {
                val fresh = UUID.randomUUID().toString()
                prefs[Keys.DEVICE_ID] = fresh
                result = fresh
            }
        }
        return result
    }
}

fun normalizeServerUrl(rawUrl: String?): String? {
    val trimmed = rawUrl?.trim().orEmpty()
    if (trimmed.isEmpty()) return null

    val withScheme = if (trimmed.contains("://")) trimmed else "ws://$trimmed"
    val scheme = withScheme.substringBefore("://", missingDelimiterValue = "")
    if (scheme != "ws" && scheme != "wss") return null

    val httpEquivalent = when (scheme) {
        "ws" -> "http://${withScheme.substringAfter("://")}"
        else -> "https://${withScheme.substringAfter("://")}"
    }
    val parsed = httpEquivalent.toHttpUrlOrNull() ?: return null
    if (parsed.host.isBlank()) return null

    return withScheme
}
