package com.moumantai.client.state

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/**
 * DataStore-backed settings repository for persistent configuration.
 *
 * Stores the server URL and the per-device stable identifier, exposed as
 * [Flow]s for reactive observation. The device id is generated lazily on
 * first read (UUIDv4) and persists for the install lifetime — clears only
 * on app uninstall or storage wipe.
 */
class SettingsRepository(
    private val context: Context,
) {
    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_ID = stringPreferencesKey("device_id")
    }

    companion object {
        const val DEFAULT_SERVER_URL = "ws://10.0.2.2:3000"
    }

    /** Observable server URL, emitting the current value on collection. */
    val serverUrl: Flow<String> =
        context.dataStore.data.map { prefs ->
            prefs[Keys.SERVER_URL] ?: DEFAULT_SERVER_URL
        }

    /**
     * Stable per-device UUIDv4. Generated on first read and persisted;
     * sent in every ClientHello.device_id so the server can attribute messages
     * and persist active-view state to the right device row across reconnects,
     * server restarts, and OS process death.
     *
     * Use [getOrCreateDeviceId] for the create-on-first-call entry point;
     * never call inside a hot Flow because the lazy-init runs a transactional
     * edit. The returned value is stable for the install lifetime.
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

    /** Persist a new server URL. */
    suspend fun updateServerUrl(url: String) {
        context.dataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = url
        }
    }
}
