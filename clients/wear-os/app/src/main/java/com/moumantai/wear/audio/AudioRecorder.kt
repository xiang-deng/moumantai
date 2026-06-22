package com.moumantai.wear.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Simple audio recording utility that captures PCM16 mono audio at 16kHz.
 *
 * Streams audio chunks (640 bytes = 20ms of 16kHz 16-bit mono) to a callback
 * as they are captured. Designed for real-time voice streaming over the transport.
 *
 * Usage:
 * ```
 * val recorder = AudioRecorder(context)
 * recorder.start { chunk -> transport.sendAudioInput(data = chunk, scope = key) }
 * // ... later ...
 * val finalChunk = recorder.stop()
 * transport.sendAudioInput(data = finalChunk, scope = key, final = true)
 * ```
 */
class AudioRecorder(private val context: Context) {

    private val recording = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null

    /**
     * Start recording audio and stream chunks via [onChunk] (called on a background thread).
     *
     * Returns false if recording could not start (missing permission or hardware error).
     * Each callback invocation receives [AudioConfig.CHUNK_SIZE] bytes of PCM16, except
     * possibly the last.
     */
    fun start(onChunk: (ByteArray) -> Unit): Boolean {
        if (recording.get()) return false

        // Check RECORD_AUDIO permission
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }

        val sampleRate = AudioConfig.SAMPLE_RATE
        val channelConfig = AudioFormat.CHANNEL_IN_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val chunkSize = AudioConfig.CHUNK_SIZE

        val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, encoding)
        val bufferSize = maxOf(minBufferSize, chunkSize * 4)

        val record = try {
            @Suppress("MissingPermission") // Checked above
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                channelConfig,
                encoding,
                bufferSize,
            )
        } catch (_: Exception) {
            return false
        }

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return false
        }

        audioRecord = record
        recording.set(true)

        record.startRecording()

        recordingThread = Thread({
            val buffer = ByteArray(chunkSize)
            while (recording.get()) {
                val bytesRead = record.read(buffer, 0, chunkSize)
                if (bytesRead > 0 && recording.get()) {
                    val chunk = if (bytesRead == chunkSize) {
                        buffer.copyOf()
                    } else {
                        buffer.copyOf(bytesRead)
                    }
                    onChunk(chunk)
                }
            }
        }, "audio-recorder").also { it.start() }

        return true
    }

    /**
     * Stop recording and return the final audio chunk (empty if none).
     * After this call, [isRecording] returns false and the recorder can be restarted.
     */
    fun stop(): ByteArray {
        if (!recording.getAndSet(false)) return ByteArray(0)

        try {
            recordingThread?.join(500)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        recordingThread = null

        val record = audioRecord
        audioRecord = null

        if (record == null) return ByteArray(0)

        val chunkSize = AudioConfig.CHUNK_SIZE
        val remaining = ByteArray(chunkSize)
        val bytesRead = try {
            record.read(remaining, 0, chunkSize)
        } catch (_: Exception) {
            0
        }

        try {
            record.stop()
        } catch (_: Exception) {
            // May already be stopped
        }
        record.release()

        return if (bytesRead > 0) remaining.copyOf(bytesRead) else ByteArray(0)
    }

    /**
     * Whether the recorder is currently capturing audio.
     */
    fun isRecording(): Boolean = recording.get()
}
