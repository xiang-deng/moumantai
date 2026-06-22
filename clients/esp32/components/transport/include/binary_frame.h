#pragma once

/*
 * binary_frame.h — typed audio binary-frame envelope.
 *
 * Wire shape: [1 byte type][2 bytes header_len LE][AudioChunkHeader proto bytes][PCM payload]
 *
 * The 2-byte header-length prefix is little-endian and matches TS / Kotlin
 * implementations byte-for-byte (cross-language test enforces).
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "moumantai/v1/chat.pb.h"

/* --------------------------------------------------------------------------
 * Frame types — match `moumantai.v1.BinaryFrameType` enum on the wire.
 * ----------------------------------------------------------------------- */

#define BINARY_FRAME_AUDIO 0x01
#define BINARY_FRAME_IMAGE 0x02

/**
 * Decoded binary frame. `header` carries the typed AudioChunkHeader; `payload`
 * points into the original frame buffer (NOT owned by this struct — valid
 * only during the dispatch event).
 */
typedef struct {
    uint8_t type;                         /* BINARY_FRAME_AUDIO etc */
    moumantai_v1_AudioChunkHeader header; /* Typed protobuf header */
    const uint8_t *payload;               /* Borrowed slice */
    size_t payload_len;
} binary_frame_t;

/**
 * Decode a binary WebSocket frame.
 *
 * @return 0 on success, -1 on parse error.
 */
int binary_frame_decode(const uint8_t *frame, size_t frame_len, binary_frame_t *out);

/**
 * Encode an outbound audio binary frame. Caller frees `*out_frame` with free().
 *
 * @param scope    Scope string ('home' or 'app:<appId>')
 * @param pcm_data PCM16 audio payload
 * @param pcm_len  Length of PCM data
 * @param final    True if this is the last chunk
 * @return 0 on success, -1 on error
 */
int binary_frame_encode_audio(const char *scope, const uint8_t *pcm_data, size_t pcm_len, bool final,
                              uint8_t **out_frame, size_t *out_len);
