#include "binary_frame.h"

#include <string.h>
#include <stdlib.h>
#include <pb_encode.h>
#include <pb_decode.h>
#include "moumantai/v1/chat.pb.h"
#include "esp_log.h"

static const char *TAG = "binary_frame";

/* --------------------------------------------------------------------------
 * Decode: [type:1] [header_len LE16] [AudioChunkHeader proto bytes] [PCM]
 * ----------------------------------------------------------------------- */

int binary_frame_decode(const uint8_t *frame, size_t frame_len, binary_frame_t *out) {
    if (!frame || !out || frame_len < 3)
        return -1;

    memset(out, 0, sizeof(*out));
    out->type = frame[0];

    /* Header length is little-endian — cross-language byte-equality test
     * pins this; do NOT switch to ntohs(). */
    uint16_t header_len = (uint16_t)frame[1] | ((uint16_t)frame[2] << 8);
    if ((size_t)3 + header_len > frame_len) {
        ESP_LOGW(TAG, "binary frame header_len %u exceeds frame_len %u", (unsigned)header_len, (unsigned)frame_len);
        return -1;
    }

    if (out->type == BINARY_FRAME_AUDIO) {
        pb_istream_t stream = pb_istream_from_buffer(&frame[3], header_len);
        if (!pb_decode(&stream, moumantai_v1_AudioChunkHeader_fields, &out->header)) {
            ESP_LOGW(TAG, "AudioChunkHeader decode failed: %s", PB_GET_ERROR(&stream));
            return -1;
        }
    }

    out->payload = &frame[3 + header_len];
    out->payload_len = frame_len - 3 - header_len;
    return 0;
}

/* --------------------------------------------------------------------------
 * Encode: build typed AudioChunkHeader, framed with type byte + LE16 length.
 * ----------------------------------------------------------------------- */

int binary_frame_encode_audio(const char *scope, const uint8_t *pcm_data, size_t pcm_len, bool final,
                              uint8_t **out_frame, size_t *out_len) {
    if (!out_frame || !out_len)
        return -1;

    moumantai_v1_AudioChunkHeader hdr = moumantai_v1_AudioChunkHeader_init_zero;
    if (scope) {
        strncpy(hdr.scope, scope, sizeof(hdr.scope) - 1);
    }
    hdr.format = moumantai_v1_AudioFormat_AUDIO_FORMAT_PCM16;
    hdr.sample_rate = 16000;
    hdr.final = final;

    /* Two-pass: size, then encode. moumantai_v1_AudioChunkHeader_size = 145, but
     * we still want the actual encoded size so the wire envelope's length
     * prefix matches. */
    uint8_t hdr_buf[moumantai_v1_AudioChunkHeader_size];
    pb_ostream_t hdr_stream = pb_ostream_from_buffer(hdr_buf, sizeof(hdr_buf));
    if (!pb_encode(&hdr_stream, moumantai_v1_AudioChunkHeader_fields, &hdr)) {
        ESP_LOGE(TAG, "AudioChunkHeader encode failed: %s", PB_GET_ERROR(&hdr_stream));
        return -1;
    }
    size_t hdr_len = hdr_stream.bytes_written;
    if (hdr_len > 0xFFFF)
        return -1;

    size_t frame_len = 1 + 2 + hdr_len + pcm_len;
    uint8_t *frame = malloc(frame_len);
    if (!frame)
        return -1;

    frame[0] = BINARY_FRAME_AUDIO;
    frame[1] = (uint8_t)(hdr_len & 0xFF);
    frame[2] = (uint8_t)((hdr_len >> 8) & 0xFF);
    memcpy(&frame[3], hdr_buf, hdr_len);
    if (pcm_data && pcm_len > 0) {
        memcpy(&frame[3 + hdr_len], pcm_data, pcm_len);
    }

    *out_frame = frame;
    *out_len = frame_len;
    return 0;
}
