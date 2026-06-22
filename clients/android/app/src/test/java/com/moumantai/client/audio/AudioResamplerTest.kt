package com.moumantai.client.audio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * JVM unit tests for [AudioResampler]. Exercises the mathematical properties
 * of the resampler without needing Android or real audio hardware.
 */
class AudioResamplerTest {
    @Test
    fun `pass-through when src rate equals dst rate`() {
        val pcm = pcm16FromSamples(shortArrayOf(100, -200, 3000, -4000))
        val out = AudioResampler.resample(pcm, 16_000, 16_000)
        // Pass-through is identity and returns the same array instance.
        assertArrayEquals(pcm, out)
    }

    @Test
    fun `3 to 1 downsample gives exactly 1 third the sample count`() {
        val input = shortArrayOf(1000, 1000, 1000, 2000, 2000, 2000, 3000, 3000, 3000)
        val out = AudioResampler.resample(pcm16FromSamples(input), 48_000, 16_000)
        assertEquals(3, out.size / 2)
    }

    @Test
    fun `silence in stays silence out`() {
        val silence = ByteArray(1920) // 20ms at 48kHz mono PCM16
        val out = AudioResampler.resample(silence, 48_000, 16_000)
        assertEquals(640, out.size)
        assertTrue("output should be all zeros", out.all { it == 0.toByte() })
    }

    @Test
    fun `constant signal in stays approximately the same amplitude out`() {
        // DC-offset constant sample of 5000 across 48000 samples (1 second at 48kHz)
        val constantValue: Short = 5000
        val input = ShortArray(48_000) { constantValue }
        val out = AudioResampler.resample(pcm16FromSamples(input), 48_000, 16_000)

        assertEquals(16_000, out.size / 2)
        // Every output sample should be very close to the constant value.
        val samples = pcm16ToSamples(out)
        for (s in samples) {
            assertTrue("expected ~$constantValue, got $s", abs(s - constantValue) <= 1)
        }
    }

    @Test
    fun `non-integer ratio 44100 to 16000 produces expected sample count`() {
        val srcSamples = 4410 // 100ms at 44.1kHz
        val input = ShortArray(srcSamples) { (it % 1000).toShort() }
        val out = AudioResampler.resample(pcm16FromSamples(input), 44_100, 16_000)
        // 4410 * 16000 / 44100 = 1600
        assertEquals(1_600, out.size / 2)
    }

    @Test
    fun `empty or tiny input returns empty`() {
        assertEquals(0, AudioResampler.resample(ByteArray(0), 48_000, 16_000).size)
        assertEquals(0, AudioResampler.resample(ByteArray(2), 48_000, 16_000).size) // 1 sample
    }

    // ---- helpers ----

    private fun pcm16FromSamples(samples: ShortArray): ByteArray {
        val out = ByteArray(samples.size * 2)
        for (i in samples.indices) {
            val s = samples[i].toInt()
            out[i * 2] = (s and 0xff).toByte()
            out[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        return out
    }

    private fun pcm16ToSamples(pcm: ByteArray): ShortArray {
        val out = ShortArray(pcm.size / 2)
        for (i in out.indices) {
            val lo = pcm[i * 2].toInt() and 0xff
            val hi = pcm[i * 2 + 1].toInt() // signed extension
            out[i] = ((hi shl 8) or lo).toShort()
        }
        return out
    }
}
