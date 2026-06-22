package com.moumantai.wear.state

import com.moumantai.wear.transport.Transport.ConnectionState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Timing tests for [deriveDisplayState]. Drives a virtual clock via
 * [runTest] + [advanceTimeBy] so each scenario runs in microseconds.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DisplayStateTest {

    /**
     * Wire up the derivation against a test-driven [source] inside the
     * caller's [TestScope]. Returns a (source, display, job) triple; the test
     * must cancel [job] before returning so runTest doesn't complain about a
     * leftover collect coroutine.
     */
    private fun TestScope.setup(
        initial: ConnectionState = ConnectionState.CONNECTED,
    ): Triple<MutableStateFlow<ConnectionState>, MutableStateFlow<DisplayState>, Job> {
        val source = MutableStateFlow(initial)
        val out = MutableStateFlow(DisplayState.Connected)
        val job = startDisplayStateDerivation(this, source, out)
        runCurrent()
        return Triple(source, out, job)
    }

    /** Sanity: a CONNECTED source stays Connected. */
    @Test
    fun `connected source stays Connected`() = runTest {
        val (_, display, job) = setup()
        assertEquals(DisplayState.Connected, display.value)
        job.cancel()
    }

    /**
     * A brief flap (< 2s) must NOT surface a Reconnecting indicator.
     * Tests the debounce rule.
     */
    @Test
    fun `brief flap under 2s never reaches Reconnecting`() = runTest {
        val (source, display, job) = setup()

        source.value = ConnectionState.CONNECTING
        advanceTimeBy(1_000L) // 1s into the outage
        assertEquals(
            "under 2s must still read Connected",
            DisplayState.Connected,
            display.value,
        )

        source.value = ConnectionState.CONNECTED
        runCurrent()
        assertEquals(DisplayState.Connected, display.value)

        // Let any mistakenly-scheduled timer fire; must stay Connected.
        advanceTimeBy(OFFLINE_THRESHOLD_MS + 5_000L)
        assertEquals(DisplayState.Connected, display.value)
        job.cancel()
    }

    /**
     * 2.5s outage → Reconnecting appears at the 2s mark, still Reconnecting
     * (not Offline) at 2.5s. This is the skepticism anchor: if the 2s
     * constant is wrong the assertion at t=2001ms fails.
     */
    @Test
    fun `2_5s outage emits Reconnecting at 2s mark`() = runTest {
        val (source, display, job) = setup()

        source.value = ConnectionState.DISCONNECTED
        // t = 1999ms: not yet Reconnecting.
        advanceTimeBy(1_999L)
        assertEquals(
            "at 1999ms must still be Connected",
            DisplayState.Connected,
            display.value,
        )
        // t = 2001ms: the 2s timer has fired.
        advanceTimeBy(2L)
        assertEquals(
            "at 2001ms must be Reconnecting",
            DisplayState.Reconnecting,
            display.value,
        )
        // t = 2500ms: still Reconnecting (Offline at 15s).
        advanceTimeBy(499L)
        assertEquals(DisplayState.Reconnecting, display.value)
        job.cancel()
    }

    /**
     * 16s outage → Reconnecting at 2s, Offline at 15s, still Offline at 16s.
     */
    @Test
    fun `16s outage escalates Reconnecting then Offline`() = runTest {
        val (source, display, job) = setup()

        source.value = ConnectionState.DISCONNECTED
        advanceTimeBy(2_001L)
        assertEquals(DisplayState.Reconnecting, display.value)

        // t = 14_999ms: still Reconnecting, not yet Offline.
        advanceTimeBy(12_998L)
        assertEquals(
            "at 14999ms must still be Reconnecting",
            DisplayState.Reconnecting,
            display.value,
        )

        // t = 15_001ms: Offline.
        advanceTimeBy(2L)
        assertEquals(DisplayState.Offline, display.value)

        // t = 16_000ms: still Offline.
        advanceTimeBy(999L)
        assertEquals(DisplayState.Offline, display.value)
        job.cancel()
    }

    /**
     * From Offline, a reconnect flips immediately to Connected (no lag).
     */
    @Test
    fun `reconnect from Offline returns to Connected immediately`() = runTest {
        val (source, display, job) = setup()

        source.value = ConnectionState.DISCONNECTED
        advanceTimeBy(20_000L)
        assertEquals(DisplayState.Offline, display.value)

        source.value = ConnectionState.CONNECTED
        runCurrent()
        assertEquals(DisplayState.Connected, display.value)
        job.cancel()
    }

    /**
     * Reconnect from Reconnecting (mid-outage) also flips straight to
     * Connected — the Offline timer is cancelled and never fires.
     */
    @Test
    fun `reconnect from Reconnecting cancels pending Offline`() = runTest {
        val (source, display, job) = setup()

        source.value = ConnectionState.DISCONNECTED
        advanceTimeBy(5_000L)
        assertEquals(DisplayState.Reconnecting, display.value)

        source.value = ConnectionState.CONNECTED
        runCurrent()
        assertEquals(DisplayState.Connected, display.value)

        // Well past the original 15s mark; must stay Connected.
        advanceTimeBy(30_000L)
        assertEquals(DisplayState.Connected, display.value)
        job.cancel()
    }
}
