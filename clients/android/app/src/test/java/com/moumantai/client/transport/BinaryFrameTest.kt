package com.moumantai.client.transport

import com.moumantai.protocol.v1.AudioChunkHeader
import com.moumantai.protocol.v1.AudioFormat
import com.moumantai.transport.BinaryFrame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Tests for the shared binary-frame encoder used by the phone client.
 *
 * Wire format:
 *   [1 byte type prefix]
 *   [2 bytes header length, little-endian]
 *   [proto-encoded AudioChunkHeader bytes]
 *   [raw payload bytes]
 *
 * Image frames are no longer originated by any client (image input travels
 * inline on `ChatInput.image_data`); only the AUDIO frame type has a typed
 * encode helper. `Type.IMAGE` is retained as a defensive no-op route in
 * MoumantaiTransport.handleBinaryMessage but is not exercised here.
 */
class BinaryFrameTest {
    @Test
    fun `audio frame has correct type byte`() {
        val audioFrame = encodeAudio(scope = "s")
        assertEquals(BinaryFrame.Type.AUDIO, audioFrame[0])
    }

    @Test
    fun `frame total length equals 1 + 2 + headerLen + payloadLen`() {
        val payload = byteArrayOf(1, 2, 3, 4, 5)
        val frame = encodeAudio(scope = "t", audioData = payload)
        val headerLen = readHeaderLen(frame)
        assertEquals(1 + 2 + headerLen + payload.size, frame.size)
    }

    @Test
    fun `payload bytes are preserved unchanged`() {
        val payload = ByteArray(640) { (it % 256).toByte() }
        val frame = encodeAudio(scope = "s", audioData = payload)
        assertArrayEquals(payload, frame.copyOfRange(3 + readHeaderLen(frame), frame.size))
    }

    @Test
    fun `audio header round-trips through proto decode`() {
        val frame =
            encodeAudio(
                scope = "rt",
                audioData = byteArrayOf(0x01, 0x02, 0x03),
                format = "pcm16",
                sampleRate = 16000,
                isFinal = true,
                clientMsgId = "abc-123",
            )
        val header = extractAudioHeader(frame)
        assertEquals("rt", header.scope)
        assertEquals(AudioFormat.AUDIO_FORMAT_PCM16, header.format)
        assertEquals(16000, header.sample_rate)
        assertTrue(header.final_)
        assertEquals("abc-123", header.client_msg_id)
    }

    @Test
    fun `audio frame without clientMsgId leaves the field null`() {
        val frame = encodeAudio(scope = "s", isFinal = true)
        val header = extractAudioHeader(frame)
        assertNull(header.client_msg_id)
    }

    // ---- Helpers ----

    private fun encodeAudio(
        scope: String,
        audioData: ByteArray = ByteArray(0),
        format: String = "pcm16",
        sampleRate: Int = 16000,
        isFinal: Boolean = false,
        clientMsgId: String? = null,
    ): ByteArray = BinaryFrame.encodeAudio(
        scope = scope,
        audioData = audioData,
        format = format,
        sampleRate = sampleRate,
        isFinal = isFinal,
        clientMsgId = clientMsgId,
    )

    private fun readHeaderLen(frame: ByteArray): Int = ByteBuffer
        .wrap(frame, 1, 2)
        .order(ByteOrder.LITTLE_ENDIAN)
        .short
        .toInt() and 0xFFFF

    private fun extractAudioHeader(frame: ByteArray): AudioChunkHeader = AudioChunkHeader.ADAPTER.decode(frame.copyOfRange(3, 3 + readHeaderLen(frame)))
}
