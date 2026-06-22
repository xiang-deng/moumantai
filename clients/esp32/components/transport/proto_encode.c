/*
 * proto_encode.c — encode outbound ClientMessage variants via nanopb.
 *
 * Helpers produce a complete ClientMessage envelope ready for the WebSocket
 * text frame. Variants emitted today: hello, chat_input, viewing,
 * reset_conversation, ack. Audio bytes ride a separate binary frame whose
 * header is a typed `AudioChunkHeader` (see binary_frame.c).
 *
 * Helpers return ESP_OK + the encoded byte length on success; the caller
 * owns the encode buffer. Errors set out_len to 0 and return ESP_FAIL.
 */

#include "proto_encode.h"
#include <pb_encode.h>
#include "moumantai/v1/envelope.pb.h"
#include "moumantai/v1/lifecycle.pb.h"
#include "moumantai/v1/chat.pb.h"
#include "moumantai/v1/apps.pb.h"
#include "moumantai/v1/actions.pb.h"
#include "moumantai/v1/enums.pb.h"
#include "google/protobuf/struct.pb.h"
#include "esp_log.h"

#include <string.h>

static const char *TAG = "proto_encode";

/* ----------------------------------------------------------------------------
 * encode helpers
 * -------------------------------------------------------------------------- */

static esp_err_t encode_into(pb_ostream_t *stream, const pb_msgdesc_t *fields, const void *src, size_t *out_len) {
    if (!pb_encode(stream, fields, src)) {
        ESP_LOGE(TAG, "pb_encode failed: %s", PB_GET_ERROR(stream));
        if (out_len)
            *out_len = 0;
        return ESP_FAIL;
    }
    if (out_len)
        *out_len = stream->bytes_written;
    return ESP_OK;
}

/* ----------------------------------------------------------------------------
 * Public encoders — each builds a ClientMessage envelope around the variant
 * -------------------------------------------------------------------------- */

esp_err_t proto_encode_hello(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *current_app_id,
                             const char *current_face_id, const char *device_id) {
    moumantai_v1_ClientMessage msg = moumantai_v1_ClientMessage_init_zero;
    msg.which_payload = moumantai_v1_ClientMessage_hello_tag;

    moumantai_v1_ClientHello *hello = &msg.payload.hello;
    /* device_class and shape are ints; DeviceClass enum value for hmi-panel
     * matches the proto enum. We rely on the proto's first non-default
     * tagging by name. */
    hello->device_class = moumantai_v1_DeviceClass_DEVICE_CLASS_HMI_PANEL;
    hello->has_device_profile = true;
    hello->device_profile.width = 320;
    hello->device_profile.height = 480;
    hello->device_profile.shape = moumantai_v1_DeviceShape_DEVICE_SHAPE_RECT;

    if (current_app_id && current_app_id[0] && strcmp(current_app_id, "home") != 0) {
        hello->has_current_app_id = true;
        strncpy(hello->current_app_id, current_app_id, sizeof(hello->current_app_id) - 1);
        if (current_face_id && current_face_id[0]) {
            hello->has_current_face_id = true;
            strncpy(hello->current_face_id, current_face_id, sizeof(hello->current_face_id) - 1);
        }
    }
    if (device_id && device_id[0]) {
        hello->has_device_id = true;
        strncpy(hello->device_id, device_id, sizeof(hello->device_id) - 1);
    }

    pb_ostream_t stream = pb_ostream_from_buffer(buf, buf_cap);
    return encode_into(&stream, moumantai_v1_ClientMessage_fields, &msg, out_len);
}

esp_err_t proto_encode_chat_input(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *scope, const char *text,
                                  const char *client_msg_id) {
    moumantai_v1_ClientMessage msg = moumantai_v1_ClientMessage_init_zero;
    msg.which_payload = moumantai_v1_ClientMessage_chat_input_tag;
    moumantai_v1_ChatInput *ci = &msg.payload.chat_input;
    if (scope)
        strncpy(ci->scope, scope, sizeof(ci->scope) - 1);
    if (text)
        strncpy(ci->text, text, sizeof(ci->text) - 1);
    if (client_msg_id && client_msg_id[0]) {
        ci->has_client_msg_id = true;
        strncpy(ci->client_msg_id, client_msg_id, sizeof(ci->client_msg_id) - 1);
    }
    pb_ostream_t stream = pb_ostream_from_buffer(buf, buf_cap);
    return encode_into(&stream, moumantai_v1_ClientMessage_fields, &msg, out_len);
}

esp_err_t proto_encode_viewing(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *scope) {
    moumantai_v1_ClientMessage msg = moumantai_v1_ClientMessage_init_zero;
    msg.which_payload = moumantai_v1_ClientMessage_viewing_tag;
    if (scope)
        strncpy(msg.payload.viewing.scope, scope, sizeof(msg.payload.viewing.scope) - 1);
    pb_ostream_t stream = pb_ostream_from_buffer(buf, buf_cap);
    return encode_into(&stream, moumantai_v1_ClientMessage_fields, &msg, out_len);
}

esp_err_t proto_encode_reset_conversation(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *scope) {
    moumantai_v1_ClientMessage msg = moumantai_v1_ClientMessage_init_zero;
    msg.which_payload = moumantai_v1_ClientMessage_reset_conversation_tag;
    if (scope)
        strncpy(msg.payload.reset_conversation.scope, scope, sizeof(msg.payload.reset_conversation.scope) - 1);
    pb_ostream_t stream = pb_ostream_from_buffer(buf, buf_cap);
    return encode_into(&stream, moumantai_v1_ClientMessage_fields, &msg, out_len);
}

/* ----------------------------------------------------------------------------
 * cJSON → google.protobuf.Struct encoder.
 *
 * Symmetric with the decode-side struct_fields_cb in proto_decode.c. Used
 * to round-trip Action.args back to the server when the user activates a
 * component whose Action carries args (e.g. filter chips:
 * `invokeTool('view_scoreboard', {day: 'today'})`).
 *
 * Today supports null, bool, number, string, and nested object args. cJSON
 * arrays at the args level are silently skipped — emit them only when an
 * ESP32-bound face actually needs them (no current case in the codebase).
 *
 * Single-task contract: encoders only run on the WS write path, so a plain
 * static depth counter guards nested objects.
 * ----------------------------------------------------------------------- */

#define STRUCT_ENCODE_MAX_DEPTH 32
static int s_struct_encode_depth = 0;

/* nanopb's encode hook for Struct.fields — emits one FieldsEntry per cJSON
 * object key. Recurses via the same callback for nested object values. */
static bool struct_fields_encode_cb(pb_ostream_t *stream, const pb_field_t *field, void *const *arg) {
    const cJSON *obj = (const cJSON *)*arg;
    if (!obj)
        return true;
    if (s_struct_encode_depth >= STRUCT_ENCODE_MAX_DEPTH)
        return false;

    const cJSON *child = NULL;
    cJSON_ArrayForEach(child, obj) {
        google_protobuf_Struct_FieldsEntry entry = google_protobuf_Struct_FieldsEntry_init_zero;
        if (child->string) {
            strncpy(entry.key, child->string, sizeof(entry.key) - 1);
        }
        entry.has_value = true;

        if (cJSON_IsNull(child)) {
            entry.value.which_kind = google_protobuf_Value_null_value_tag;
            entry.value.kind.null_value = google_protobuf_NullValue_NULL_VALUE;
        } else if (cJSON_IsBool(child)) {
            entry.value.which_kind = google_protobuf_Value_bool_value_tag;
            entry.value.kind.bool_value = cJSON_IsTrue(child);
        } else if (cJSON_IsNumber(child)) {
            entry.value.which_kind = google_protobuf_Value_number_value_tag;
            entry.value.kind.number_value = child->valuedouble;
        } else if (cJSON_IsString(child)) {
            entry.value.which_kind = google_protobuf_Value_string_value_tag;
            const char *s = child->valuestring ? child->valuestring : "";
            strncpy(entry.value.kind.string_value, s, sizeof(entry.value.kind.string_value) - 1);
        } else if (cJSON_IsObject(child)) {
            entry.value.which_kind = google_protobuf_Value_struct_value_tag;
            entry.value.kind.struct_value.fields.funcs.encode = struct_fields_encode_cb;
            entry.value.kind.struct_value.fields.arg = (void *)child;
        } else {
            /* Array (or untyped) — skip. ESP32 faces don't emit array args
             * today; extend here when one does. */
            continue;
        }

        if (!pb_encode_tag_for_field(stream, field))
            return false;
        s_struct_encode_depth++;
        bool ok = pb_encode_submessage(stream, google_protobuf_Struct_FieldsEntry_fields, &entry);
        s_struct_encode_depth--;
        if (!ok)
            return false;
    }
    return true;
}

/* ----------------------------------------------------------------------------
 * Invoke-tool envelope.
 *
 * Encodes the InvokeToolMsg with `args` populated from the cJSON tree (when
 * non-NULL). The Struct fields encode callback (struct_fields_encode_cb) is
 * installed on it->args.fields before pb_encode runs; nanopb invokes it
 * during the body encode of the args submsg, walking the cJSON object and
 * emitting one FieldsEntry per key/value pair.
 * ----------------------------------------------------------------------- */

esp_err_t proto_encode_invoke_tool(uint8_t *buf, size_t buf_cap, size_t *out_len, const char *tool_name,
                                   const char *source_face_id, const char *client_request_id, const cJSON *args) {
    if (!tool_name || !tool_name[0]) {
        if (out_len)
            *out_len = 0;
        return ESP_ERR_INVALID_ARG;
    }

    moumantai_v1_ClientMessage msg = moumantai_v1_ClientMessage_init_zero;
    msg.which_payload = moumantai_v1_ClientMessage_invoke_tool_tag;
    moumantai_v1_InvokeToolMsg *it = &msg.payload.invoke_tool;

    strncpy(it->tool_name, tool_name, sizeof(it->tool_name) - 1);
    if (source_face_id && source_face_id[0]) {
        strncpy(it->source_face_id, source_face_id, sizeof(it->source_face_id) - 1);
    }
    if (client_request_id && client_request_id[0]) {
        strncpy(it->client_request_id, client_request_id, sizeof(it->client_request_id) - 1);
    }
    if (args && cJSON_IsObject(args)) {
        it->has_args = true;
        it->args.fields.funcs.encode = struct_fields_encode_cb;
        it->args.fields.arg = (void *)args;
    }

    pb_ostream_t stream = pb_ostream_from_buffer(buf, buf_cap);
    return encode_into(&stream, moumantai_v1_ClientMessage_fields, &msg, out_len);
}
