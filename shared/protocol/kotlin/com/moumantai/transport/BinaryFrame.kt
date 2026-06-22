package com.moumantai.transport

import com.moumantai.protocol.v1.AudioChunkHeader
import com.moumantai.protocol.v1.AudioFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Shared binary-frame envelope helpers for Android + Wear OS.
 *
 * Wire layout: `[1 byte type][2 bytes LE header_len][header bytes][payload]`.
 * The header bytes are proto-encoded `AudioChunkHeader` (chat.proto). Both
 * clients consume + produce the exact same shape.
 *
 * `Type.IMAGE` is retained as a defensive no-op route on the inbound side of
 * each client — no current code path emits IMAGE frames (image input travels
 * inline on `ChatInput.image_data`), but the constant guards the binary-frame
 * router against accidental mis-decode.
 *
 * The proto enum [com.moumantai.protocol.v1.BinaryFrameType] is `Int`-valued
 * via `WireEnum`; for the leading-byte channel tag we expose the same
 * values as [Byte] under [Type].
 */
object BinaryFrame {

    object Type {
        val AUDIO: Byte = com.moumantai.protocol.v1.BinaryFrameType.BINARY_FRAME_TYPE_AUDIO.value.toByte()
        val IMAGE: Byte = com.moumantai.protocol.v1.BinaryFrameType.BINARY_FRAME_TYPE_IMAGE.value.toByte()
    }

    /** Decoded view of a binary frame; [headerBytes] is proto-encoded. */
    data class Parsed(val type: Byte, val headerBytes: ByteArray, val payload: ByteArray)

    /** Parse the outer envelope. Returns null on undersized or oversized frames. */
    fun parse(frame: ByteArray): Parsed? {
        if (frame.size < 3) return null
        val headerLen = ByteBuffer.wrap(frame, 1, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF
        if (frame.size < 3 + headerLen) return null
        return Parsed(
            type = frame[0],
            headerBytes = frame.copyOfRange(3, 3 + headerLen),
            payload = frame.copyOfRange(3 + headerLen, frame.size),
        )
    }

    /** Build a frame from a typed-enum tag, raw header bytes, and payload. */
    fun encode(type: Byte, headerBytes: ByteArray, payload: ByteArray): ByteArray {
        require(headerBytes.size <= 0xFFFF) { "Binary frame header exceeds uint16 max" }
        val frame = ByteBuffer.allocate(1 + 2 + headerBytes.size + payload.size).order(ByteOrder.LITTLE_ENDIAN)
        frame.put(type)
        frame.putShort(headerBytes.size.toShort())
        frame.put(headerBytes)
        frame.put(payload)
        return frame.array()
    }

    // ---- Type-safe convenience helpers ----

    fun encodeAudio(
        scope: String,
        audioData: ByteArray,
        format: String,
        sampleRate: Int,
        isFinal: Boolean,
        clientMsgId: String?,
    ): ByteArray {
        val header = AudioChunkHeader(
            scope = scope,
            format = audioFormatProto(format),
            sample_rate = sampleRate,
            final_ = isFinal,
            client_msg_id = clientMsgId,
        )
        return encode(Type.AUDIO, AudioChunkHeader.ADAPTER.encode(header), audioData)
    }

    /** Decode the audio-frame proto header; throws on malformed bytes. */
    fun decodeAudio(headerBytes: ByteArray): AudioChunkHeader = AudioChunkHeader.ADAPTER.decode(headerBytes)

    // ---- Format <-> string helpers ----
    //
    // Only PCM16 is currently produced or consumed; the AudioFormat enum
    // carries no other codecs.

    fun audioFormatProto(label: String): AudioFormat = when (label) {
        "pcm16" -> AudioFormat.AUDIO_FORMAT_PCM16
        else    -> AudioFormat.AUDIO_FORMAT_UNSPECIFIED
    }

    fun audioFormatLabel(value: AudioFormat): String? = when (value) {
        AudioFormat.AUDIO_FORMAT_PCM16 -> "pcm16"
        AudioFormat.AUDIO_FORMAT_UNSPECIFIED -> null
    }
}
