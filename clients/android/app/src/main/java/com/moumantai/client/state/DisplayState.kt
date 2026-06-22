package com.moumantai.client.state

import com.moumantai.client.transport.MoumantaiTransport.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** How long a non-CONNECTED state is debounced before the Reconnecting pill appears. */
const val RECONNECT_INDICATOR_DELAY_MS = 2_000L

/** When non-CONNECTED persists this long, escalate to the Offline banner. */
const val OFFLINE_THRESHOLD_MS = 15_000L

/**
 * UI-facing connection indicator. Purely a presentation layer over
 * [ConnectionState] — the transport enum stays 3-valued; this layer adds
 * the time dimension (debounce brief flaps, escalate after a long outage).
 */
enum class DisplayState { Connected, Reconnecting, Offline }

/**
 * Observe a [ConnectionState] flow and derive [DisplayState] with the R1 timing
 * rules:
 *  - CONNECTED → Connected (and any pending timers cancel)
 *  - non-CONNECTED for < 2s → Connected (brief flaps are hidden)
 *  - non-CONNECTED for 2s..15s → Reconnecting
 *  - non-CONNECTED for ≥ 15s → Offline
 *
 * Runs until [scope] cancels. Returns a [StateFlow] so compose / other
 * observers stay subscribed without redoing the derivation.
 *
 * Timing is driven entirely by [kotlinx.coroutines.delay] so TestScope +
 * `advanceTimeBy` drive the virtual clock in unit tests without real sleeps.
 */
fun deriveDisplayState(
    scope: CoroutineScope,
    source: Flow<ConnectionState>,
): StateFlow<DisplayState> {
    val out = MutableStateFlow(DisplayState.Connected)
    startDisplayStateDerivation(scope, source, out)
    return out.asStateFlow()
}

/**
 * Launch the derivation coroutine and return its [Job] so callers (mostly
 * tests) can cancel the long-running collect. Production callers scope to
 * `viewModelScope` which cancels on VM clear — no manual cancel needed.
 */
internal fun startDisplayStateDerivation(
    scope: CoroutineScope,
    source: Flow<ConnectionState>,
    out: MutableStateFlow<DisplayState>,
): Job = scope.launch {
    // When the connection leaves CONNECTED we kick off a timer job that waits
    // 2s, flips to Reconnecting, waits another 13s, and flips to Offline. On
    // bounce back to CONNECTED the job is cancelled.
    var timerJob: Job? = null

    source.distinctUntilChanged().collect { state ->
        if (state == ConnectionState.CONNECTED) {
            timerJob?.cancel()
            timerJob = null
            out.value = DisplayState.Connected
            return@collect
        }

        // Already running a timer? Don't restart — keep the original drop
        // time as the reference so flapping CONNECTING↔DISCONNECTED
        // doesn't reset the offline countdown.
        if (timerJob?.isActive == true) return@collect

        timerJob =
            launch {
                delay(RECONNECT_INDICATOR_DELAY_MS)
                if (!isActive) return@launch
                out.value = DisplayState.Reconnecting
                delay(OFFLINE_THRESHOLD_MS - RECONNECT_INDICATOR_DELAY_MS)
                if (!isActive) return@launch
                out.value = DisplayState.Offline
            }
    }
}
