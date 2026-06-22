package com.moumantai.wear.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SettingsRepositoryTest {
    @Test
    fun normalizeServerUrlAcceptsWebSocketUrls() {
        assertEquals("ws://10.0.2.2:3000", normalizeServerUrl("ws://10.0.2.2:3000"))
        assertEquals("wss://example.com/socket", normalizeServerUrl("wss://example.com/socket"))
    }

    @Test
    fun normalizeServerUrlAddsDefaultWebSocketScheme() {
        assertEquals("ws://192.168.1.10:3000", normalizeServerUrl("192.168.1.10:3000"))
    }

    @Test
    fun normalizeServerUrlRejectsInvalidUrls() {
        assertNull(normalizeServerUrl(""))
        assertNull(normalizeServerUrl("not a url"))
        assertNull(normalizeServerUrl("http://10.0.2.2:3000"))
        assertNull(normalizeServerUrl("ws://"))
    }
}
