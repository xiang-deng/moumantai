package com.moumantai.client.audio

/**
 * Audio configuration constants for recording and playback.
 *
 * Separated from AudioRecorder/AudioPlayer so constants can be referenced
 * in JVM unit tests without loading Android SDK classes.
 */
object AudioConfig {
    /** Sample rate in Hz sent over the wire. 16kHz is standard for speech recognition. */
    const val SAMPLE_RATE = 16000

    /** Audio format string for the wire protocol. */
    const val FORMAT = "pcm16"

    /** Bytes per sample for PCM16 encoding. */
    const val BYTES_PER_SAMPLE = 2

    /** Number of audio channels (mono). */
    const val CHANNELS = 1

    /** Chunk duration: 20ms per chunk gives responsive streaming without excessive overhead. */
    const val CHUNK_DURATION_MS = 20

    /**
     * Candidate capture rates, in preference order. The first rate the device
     * accepts is used; audio is resampled down to [SAMPLE_RATE] before leaving
     * the recorder.
     *
     * 48kHz is the native input rate on virtually all modern Android hardware
     * (picks the FastMixer path and avoids internal OS resampling). 44.1kHz is
     * the historical "universal" rate. 16kHz is last-resort — the Android
     * emulator HAL silently falls back to a tone source at this rate.
     */
    val CAPTURE_RATE_CANDIDATES = intArrayOf(48_000, 44_100, 16_000)

    /**
     * VAD (voice activity detection) parameters for auto-stop on silence.
     * Thresholds are against normalized RMS (0..1) of a PCM16 chunk.
     */
    /** RMS above this is considered speech. ~-40 dBFS. */
    const val VAD_VOICE_THRESHOLD = 0.01f

    /** After user has started speaking, stop recording after this much silence. */
    const val VAD_SILENCE_TIMEOUT_MS = 1500L

    /** Hard cap on a single utterance — prevents runaway captures. */
    const val MAX_UTTERANCE_MS = 30_000L
}
