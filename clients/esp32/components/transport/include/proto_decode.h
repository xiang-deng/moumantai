#pragma once

/*
 * proto_decode.h — inbound ServerMessage dispatcher.
 *
 * Decodes a single binary protobuf frame (the entire WebSocket text
 * payload) into a typed `moumantai_v1_ServerMessage`, switches on
 * `which_payload`, and posts the appropriate transport event with the
 * typed sub-message attached.
 *
 * Heap ownership:
 *   - Variants whose typed message is a fixed-size struct (chat, voice,
 *     navigate, ack, error, hello-ok, app_list, face_list, chat_update,
 *     reset_notice) are dispatched as stack copies; the receiver consumes
 *     and the dispatcher cleans up before return.
 *   - `face_update` and `chat_window` allocate heap (the components/entries
 *     arrays + face data cJSON); the receiver MUST free the typed message
 *     plus the array carried via `pb_callback_t.arg` slots and (for
 *     face_update) the cJSON face data attached at `data.fields.arg`.
 *
 * No cJSON in the component-tree code path — only the face data model
 * payload (`google.protobuf.Struct`) is converted into a cJSON tree, and
 * that tree is owned by the face_state cache (the renderer borrows).
 */

#include <stdint.h>
#include <stddef.h>
#include "moumantai/v1/components.pb.h"

/**
 * Decode a single protobuf frame and dispatch transport events.
 *
 * Bytes are consumed entirely (no streaming reassembly here — that lives
 * in transport.c's WS event handler).
 *
 * Errors are logged; this function never returns a status code because the
 * downstream handlers post events and clean up internally.
 */
void proto_decode_dispatch(const uint8_t *bytes, size_t len);
