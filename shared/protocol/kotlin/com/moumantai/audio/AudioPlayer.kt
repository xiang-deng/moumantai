package com.moumantai.audio

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Streaming PCM16 audio playback for the Moumantai clients.
 *
 * Accepts PCM16 chunks from the binary-frame audio path, queues them, and
 * writes through an [AudioTrack] in MODE_STREAM. Shared between Android and
 * Wear OS — both clients pull this file via the shared sourceSet srcDir
 * (build.gradle.kts) so the only difference per platform is the
 * [usage] [AudioAttributes] constructor parameter.
 *
 * Audio focus: if [bindAudioManager] is called with a real
 * [AudioManager], every playback request takes
 * `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` and abandons it on stop. No
 * transient-pause/resume listener — the OS dips concurrent media; on full
 * loss we just keep playing under the duck.
 */
class AudioPlayer(private val usage: Int = AudioAttributes.USAGE_MEDIA) {

    private val playing = AtomicBoolean(false)
    private val queue = ConcurrentLinkedQueue<ByteArray>()
    private var audioTrack: AudioTrack? = null
    private var playbackThread: Thread? = null

    @Volatile
    private var currentSampleRate: Int = 0

    @Volatile
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null

    private val attributes: AudioAttributes by lazy {
        AudioAttributes.Builder()
            .setUsage(usage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
    }

    /**
     * Plumb in the system [AudioManager] so playback acquires audio focus.
     * Optional — if never called, the player still works but doesn't
     * cooperate with notifications / other apps.
     */
    fun bindAudioManager(am: AudioManager?) {
        audioManager = am
    }

    /**
     * Queue audio data for playback. Only PCM16 is supported; chunks with
     * any other format are silently dropped. Format and sample rate flow
     * through from the typed `AudioChunkHeader`.
     */
    fun play(data: ByteArray, format: String, sampleRate: Int) {
        if (format != "pcm16" || data.isEmpty()) return

        if (playing.get() && sampleRate != currentSampleRate) {
            stop()
        }

        queue.add(data)

        if (playing.compareAndSet(false, true)) {
            currentSampleRate = sampleRate
            requestFocus()
            startPlayback(sampleRate)
        }
    }

    /** Stop playback, drop the queue, and release the AudioTrack. */
    fun stop() {
        playing.set(false)
        queue.clear()

        try {
            playbackThread?.join(500)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        playbackThread = null

        releaseTrack()
        abandonFocus()
    }

    fun isPlaying(): Boolean = playing.get()

    // ---- Internal ----

    private fun startPlayback(sampleRate: Int) {
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )

        val track = AudioTrack.Builder()
            .setAudioAttributes(attributes)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuf, 4096))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        audioTrack = track
        track.play()

        playbackThread = Thread({
            while (playing.get()) {
                val chunk = queue.poll()
                if (chunk != null) {
                    track.write(chunk, 0, chunk.size)
                } else {
                    Thread.sleep(10)
                    if (queue.isEmpty()) playing.set(false)
                }
            }
            releaseTrack()
            abandonFocus()
        }, "audio-player").also { it.start() }
    }

    private fun requestFocus() {
        val am = audioManager ?: return
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener { /* duck/loss handled by the OS */ }
            .build()
        focusRequest = req
        am.requestAudioFocus(req)
    }

    private fun abandonFocus() {
        val am = audioManager ?: return
        val req = focusRequest ?: return
        am.abandonAudioFocusRequest(req)
        focusRequest = null
    }

    private fun releaseTrack() {
        val track = audioTrack ?: return
        audioTrack = null
        try { track.stop() } catch (_: Exception) { /* may already be stopped */ }
        track.release()
    }
}
