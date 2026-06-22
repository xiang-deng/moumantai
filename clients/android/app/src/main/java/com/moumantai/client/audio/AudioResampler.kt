package com.moumantai.client.audio

/**
 * Linear-interpolation resampler for PCM16 little-endian mono audio.
 *
 * Pure Kotlin — no Android dependencies, so it can be unit tested on the JVM.
 * Matches the algorithm used server-side in `audio-utils.ts` so audio round-trips
 * predictably between client and server.
 */
object AudioResampler {
    /**
     * Resample PCM16 mono from [srcRate] to [dstRate].
     *
     * Returns [pcm] unchanged if rates are equal. Supports upsampling and
     * downsampling; for speech, the ratio should not exceed ~6:1 to avoid
     * noticeable aliasing.
     */
    fun resample(
        pcm: ByteArray,
        srcRate: Int,
        dstRate: Int,
    ): ByteArray {
        if (srcRate == dstRate) return pcm
        require(srcRate > 0 && dstRate > 0) { "sample rates must be positive" }

        val srcSamples = pcm.size / 2
        if (srcSamples < 2) return ByteArray(0)

        val dstSamples = ((srcSamples.toLong() * dstRate) / srcRate).toInt()
        val out = ByteArray(dstSamples * 2)
        val ratio = srcRate.toDouble() / dstRate

        for (i in 0 until dstSamples) {
            val srcPos = i * ratio
            val i0 = srcPos.toInt()
            val i1 = (i0 + 1).coerceAtMost(srcSamples - 1)
            val t = srcPos - i0
            val s0 = readSampleAt(pcm, i0)
            val s1 = readSampleAt(pcm, i1)
            val interpolated =
                (s0 * (1.0 - t) + s1 * t)
                    .toInt()
                    .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            writeSampleAt(out, i, interpolated)
        }
        return out
    }

    private fun readSampleAt(
        pcm: ByteArray,
        sampleIdx: Int,
    ): Int {
        val byteIdx = sampleIdx * 2
        val lo = pcm[byteIdx].toInt() and 0xff
        val hi = pcm[byteIdx + 1].toInt() // signed extension — preserves sign
        return (hi shl 8) or lo
    }

    private fun writeSampleAt(
        pcm: ByteArray,
        sampleIdx: Int,
        sample: Int,
    ) {
        val byteIdx = sampleIdx * 2
        pcm[byteIdx] = (sample and 0xff).toByte()
        pcm[byteIdx + 1] = ((sample shr 8) and 0xff).toByte()
    }
}
