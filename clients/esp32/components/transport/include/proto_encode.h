#pragma once

/*
 * proto_encode.h — outbound ClientMessage encoders.
 *
 * Each helper writes a complete `ClientMessage` envelope (typed-oneof,
 * binary protobuf) into the caller-provided buffer. On success, *out_len
 * holds the number of bytes written.
 *
 * Encoded payloads are sent over the WebSocket as binary frames.
 *
 * Buffer sizing: ClientHello + resume credentials + nav intent caps at
 * roughly 700 bytes worst-case; ChatInput caps at ~1.2 KB (per the
 * nanopb.options-derived ChatInput_size of 1221). 4 KB is a safe envelope
 * cap for every variant the ESP32 emits.
 */

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t proto_encode_hello(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *current_app_id,
                             const char *current_face_id, const char *device_id);

esp_err_t proto_encode_chat_input(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *scope, const char *text,
                                  const char *client_msg_id);

esp_err_t proto_encode_viewing(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *scope);

esp_err_t proto_encode_reset_conversation(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *scope);

/**
 * Encode an InvokeToolMsg envelope (ClientMessage tag 9). `args` (when
 * non-NULL) is walked as a cJSON tree and emitted as a
 * google.protobuf.Struct via a field-by-field encode callback — symmetric
 * with the decode-side struct_fields_cb. NULL emits an empty Struct.
 * Pass a non-NULL `client_request_id` (UUID) so the server's persistent
 * invoke_dedup table dedupes retries.
 */
esp_err_t proto_encode_invoke_tool(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *tool_name,
                                   const char *source_face_id, const char *client_request_id, const cJSON *args);

#ifdef __cplusplus
}
#endif
