package com.moumantai.client.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Records microphone audio and streams PCM16 mono chunks at [AudioConfig.SAMPLE_RATE]
 * to a callback. Chunks carry ~[AudioConfig.CHUNK_DURATION_MS] of audio each.
 *
 * Capture-rate negotiation:
 * - Rates in [AudioConfig.CAPTURE_RATE_CANDIDATES] are tried in order.
 * - The first rate the device accepts is used; audio is resampled to
 *   [AudioConfig.SAMPLE_RATE] via [AudioResampler] before being emitted.
 * - This matches modern devices' native input rate (usually 48kHz, picks the
 *   FastMixer path) and avoids the Android emulator's tone-source fallback at 16kHz.
 *
 * Audio source: [MediaRecorder.AudioSource.VOICE_RECOGNITION] — tuned for ASR,
 * skips noise-suppression filters that can degrade transcription accuracy.
 */
class AudioRecorder(
    private val context: Context,
) {
    private val recording = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null

    /** Sample rate we ended up capturing at. Zero when idle. Useful for logs/tests. */
    var captureSampleRate: Int = 0
        private set

    /**
     * Start recording audio and stream chunks via the callback.
     *
     * Returns false if recording could not start (missing permission, no compatible
     * capture rate, or hardware error). Each chunk is PCM16 mono at
     * [AudioConfig.SAMPLE_RATE], ~[AudioConfig.CHUNK_DURATION_MS] of audio.
     *
     * @param onChunk Called on a background thread with each audio buffer.
     * @return true if recording started successfully.
     */
    fun start(onChunk: (ByteArray) -> Unit): Boolean {
        if (recording.get()) return false

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }

        val (record, rate) = openMic() ?: return false
        audioRecord = record
        captureSampleRate = rate
        recording.set(true)
        record.startRecording()

        val captureChunkBytes = chunkBytesFor(rate)

        recordingThread =
            Thread({
                val buffer = ByteArray(captureChunkBytes)
                while (recording.get()) {
                    val bytesRead = record.read(buffer, 0, captureChunkBytes)
                    if (bytesRead <= 0 || !recording.get()) continue
                    val captured = if (bytesRead == captureChunkBytes) buffer else buffer.copyOf(bytesRead)
                    onChunk(AudioResampler.resample(captured, rate, AudioConfig.SAMPLE_RATE))
                }
            }, "audio-recorder").also { it.start() }

        return true
    }

    /**
     * Stop recording and return the final resampled audio chunk (may be empty).
     */
    fun stop(): ByteArray {
        if (!recording.getAndSet(false)) return ByteArray(0)

        try {
            recordingThread?.join(500)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        recordingThread = null

        val record = audioRecord ?: return ByteArray(0)
        val rate = captureSampleRate
        audioRecord = null
        captureSampleRate = 0

        val captureChunkBytes = chunkBytesFor(rate)
        val remaining = ByteArray(captureChunkBytes)
        val bytesRead =
            try {
                record.read(remaining, 0, captureChunkBytes)
            } catch (_: Exception) {
                0
            }

        try {
            record.stop()
        } catch (_: Exception) {
            // may already be stopped
        }
        record.release()

        if (bytesRead <= 0) return ByteArray(0)
        return AudioResampler.resample(remaining.copyOf(bytesRead), rate, AudioConfig.SAMPLE_RATE)
    }

    /** Whether the recorder is currently capturing audio. */
    fun isRecording(): Boolean = recording.get()

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /**
     * Try each candidate rate in order until one yields an initialized AudioRecord.
     * Returns the record + the rate used, or null if none worked.
     */
    private fun openMic(): Pair<AudioRecord, Int>? {
        val channelConfig = AudioFormat.CHANNEL_IN_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT

        for (rate in AudioConfig.CAPTURE_RATE_CANDIDATES) {
            val minBuffer = AudioRecord.getMinBufferSize(rate, channelConfig, encoding)
            if (minBuffer <= 0) continue // ERROR or ERROR_BAD_VALUE

            val captureChunkBytes = chunkBytesFor(rate)
            val bufferSize = maxOf(minBuffer, captureChunkBytes * 4)

            val record =
                try {
                    @Suppress("MissingPermission") // Checked by caller
                    AudioRecord(
                        MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        rate,
                        channelConfig,
                        encoding,
                        bufferSize,
                    )
                } catch (_: Exception) {
                    continue
                }

            if (record.state == AudioRecord.STATE_INITIALIZED) {
                return record to rate
            }
            record.release()
        }
        return null
    }

    /** PCM16 bytes needed to hold one chunk at [rate]. */
    private fun chunkBytesFor(rate: Int): Int = (rate * AudioConfig.BYTES_PER_SAMPLE * AudioConfig.CHUNK_DURATION_MS) / 1000
}
