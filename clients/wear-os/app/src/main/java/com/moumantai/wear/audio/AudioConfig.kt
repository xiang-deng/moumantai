package com.moumantai.wear.audio

/**
 * Audio configuration constants for recording and playback.
 *
 * Separated from AudioRecorder/AudioPlayer so constants can be referenced
 * in JVM unit tests without loading Android SDK classes.
 */
object AudioConfig {
    /** Sample rate in Hz. 16kHz is standard for speech recognition. */
    const val SAMPLE_RATE = 16000

    /** Audio format string for the wire protocol. */
    const val FORMAT = "pcm16"

    /**
     * Chunk size in bytes: 20ms of audio at 16kHz, 16-bit mono.
     * 16000 samples/sec * 2 bytes/sample * 0.020 sec = 640 bytes.
     */
    const val CHUNK_SIZE = 640

    /** Bytes per sample (PCM16). */
    const val BYTES_PER_SAMPLE = 2

    /** Mono. */
    const val CHANNELS = 1
}
