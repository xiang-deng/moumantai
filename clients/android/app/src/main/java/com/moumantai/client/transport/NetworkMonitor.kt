package com.moumantai.client.transport

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Thin wrapper around [ConnectivityManager.NetworkCallback] that:
 *   1. Exposes a [StateFlow] of network availability for the UI.
 *   2. Fires [onAvailable] whenever a usable network returns so callers
 *      (typically [MoumantaiTransport.reconnectNow]) can stop waiting on the
 *      exponential-backoff timer and try immediately.
 *
 * Requires the `ACCESS_NETWORK_STATE` permission in AndroidManifest.xml.
 */
class NetworkMonitor(
    context: Context,
) {
    private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _isOnline = MutableStateFlow(currentOnline())

    /** Observable flag reflecting whether any network can reach the internet. */
    val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()

    /** Called on every network that becomes available (may fire multiple times). */
    var onAvailable: (() -> Unit)? = null

    /** Called when all networks drop. */
    var onLost: (() -> Unit)? = null

    @Volatile private var registered = false

    private val callback =
        object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Don't fire until validation also completes — onCapabilitiesChanged
                // will upgrade the online flag once NET_CAPABILITY_VALIDATED flips.
                if (hasValidatedCaps(network)) {
                    _isOnline.value = true
                    onAvailable?.invoke()
                }
            }

            override fun onLost(network: Network) {
                val stillOnline = currentOnline()
                _isOnline.value = stillOnline
                if (!stillOnline) onLost?.invoke()
            }

            override fun onCapabilitiesChanged(
                network: Network,
                caps: NetworkCapabilities,
            ) {
                val online =
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                val wasOnline = _isOnline.value
                _isOnline.value = online
                // Captive-portal recovery: when VALIDATED flips on after initial
                // onAvailable, treat it as the effective "available" moment.
                if (online && !wasOnline) onAvailable?.invoke()
            }
        }

    /**
     * Register the callback. No-op if already registered — ConnectivityManager
     * does NOT dedup, so double-registering would fire every event twice.
     */
    fun start() {
        if (registered) return
        val request =
            NetworkRequest
                .Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
        cm.registerNetworkCallback(request, callback)
        registered = true
    }

    /** Unregister the callback. Call from the owning scope's teardown. */
    fun stop() {
        if (!registered) return
        try {
            cm.unregisterNetworkCallback(callback)
        } catch (_: IllegalArgumentException) {
            // Already unregistered; ignore.
        }
        registered = false
    }

    private fun currentOnline(): Boolean {
        val active = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(active) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun hasValidatedCaps(network: Network): Boolean {
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
