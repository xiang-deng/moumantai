#pragma once

/*
 * transport.h — public API of the WebSocket transport.
 *
 * Wire: binary protobuf via subprotocol `moumantai.v1.proto`. Every message
 * is a typed `moumantai_v1_*` struct; the renderer/state consume them
 * directly (cJSON only inside the face data payload via
 * google.protobuf.Struct).
 *
 * Events posted on `TRANSPORT_EVENTS` carry typed pointers — see the
 * comments next to each event ID.
 */

#include <stdbool.h>
#include "esp_err.h"
#include "esp_event.h"
#include "cJSON.h"
#include "binary_frame.h"
#include "transport_limits.h"
#include "moumantai/v1/lifecycle.pb.h"
#include "moumantai/v1/chat.pb.h"
#include "moumantai/v1/apps.pb.h"

/* --------------------------------------------------------------------------
 * Event base + IDs.
 * ----------------------------------------------------------------------- */

ESP_EVENT_DECLARE_BASE(TRANSPORT_EVENTS);

enum {
    TRANSPORT_EVT_CONNECTED = 0, /* data: NULL */
    TRANSPORT_EVT_DISCONNECTED,  /* data: NULL */
    TRANSPORT_EVT_HELLO_OK,      /* data: moumantai_v1_ServerHello* (stack copy) */
    TRANSPORT_EVT_APP_LIST,      /* data: moumantai_v1_AppListMsg** — receiver frees */
    TRANSPORT_EVT_FACE_LIST,     /* data: moumantai_v1_FaceListMsg** — receiver frees */
    TRANSPORT_EVT_FACE_UPDATE, /* data: moumantai_v1_FaceUpdateMsg** — receiver frees msg + components arg + data arg */
    TRANSPORT_EVT_CHAT,        /* data: moumantai_v1_ChatMessage** — receiver frees */
    TRANSPORT_EVT_VOICE_STATE, /* data: moumantai_v1_VoiceState* (stack copy) */
    TRANSPORT_EVT_NAVIGATE,    /* data: moumantai_v1_NavigateMsg* (stack copy) */
    TRANSPORT_EVT_AUDIO_CHUNK, /* data: binary_frame_t** — heap-owned (PSRAM); receiver heap_caps_free()s the single
                                  co-allocation */
    TRANSPORT_EVT_CHAT_WINDOW, /* data: moumantai_v1_ChatWindowMsg** — receiver frees msg + entries arg */
    TRANSPORT_EVT_CHAT_UPDATE, /* data: moumantai_v1_ChatUpdateMsg** — receiver frees */
    TRANSPORT_EVT_RESET_NOTICE,        /* data: moumantai_v1_ResetNoticeMsg* (stack copy) */
    TRANSPORT_EVT_ERROR,               /* data: moumantai_v1_ErrorMessage* (stack copy) */
    TRANSPORT_EVT_UI_ACTION_ESCALATED, /* data: ui_escalated_evt_t* (stack copy) — disposable, not replayed */
    TRANSPORT_EVT_CHAT_HISTORY,        /* data: moumantai_v1_ChatHistoryMsg** — receiver frees msg + entries arg */
    TRANSPORT_EVT_PAIRING_REQUIRED,    /* data: NULL — server rejected this device (close 4008); not yet approved */
};

/* Event payload for TRANSPORT_EVT_UI_ACTION_ESCALATED. proto_decode.c posts
 * a stack copy; receivers strcmp `scope` against their active scope and
 * no-op on mismatch. The buffer matches nanopb's max_size:64 from
 * shared/protocol/proto/moumantai/v1/nanopb.options. */
typedef struct {
    char scope[64];
} ui_escalated_evt_t;

/* --------------------------------------------------------------------------
 * Navigation intent (R1 of lifecycle redesign).
 * ----------------------------------------------------------------------- */

typedef struct {
    char current_app_id[MOUMANTAI_MAX_ID_LEN];
    char current_face_id[MOUMANTAI_MAX_ID_LEN];
} nav_intent_t;

typedef void (*nav_intent_provider_fn)(nav_intent_t *out);

void transport_set_nav_intent_provider(nav_intent_provider_fn fn);

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

esp_err_t transport_init(void);
esp_err_t transport_connect(const char *uri);
void transport_disconnect(void);
bool transport_is_connected(void);

/* --------------------------------------------------------------------------
 * Client → Server senders. All wrap nanopb encoders into a single WS
 * binary frame.
 * ----------------------------------------------------------------------- */

esp_err_t transport_send_chat_input(const char *scope, const char *text, const char *client_msg_id);

/** Notify server which scope the UI is showing. Deduped against the last sent. */
esp_err_t transport_send_viewing(const char *scope);

/** Request a non-destructive reset of the given scope's conversation. */
esp_err_t transport_send_reset_conversation(const char *scope);

/** Send a binary audio input frame. */
esp_err_t transport_send_audio_input(const uint8_t *pcm_data, size_t len, const char *scope, bool final);

/**
 * Invoke a tool from a face's UI action. Routes through the same server
 * code path the LLM uses (executeTool → face refresh → [ui_action] transcript).
 * `client_request_id` should be a fresh UUID per dispatch — the server's
 * persistent invoke_dedup table dedupes retries on (conversation_id,
 * client_request_id). `args` is the decoded Action.args cJSON tree (from
 * state_get_action_args); NULL emits an empty Struct on the wire.
 */
esp_err_t transport_send_invoke_tool(const char *tool_name, const char *source_face_id, const char *client_request_id,
                                     const cJSON *args);

/* --------------------------------------------------------------------------
 * Test-only / internal helpers (kept stable for unit tests).
 * ----------------------------------------------------------------------- */

bool offline_queue_enqueue(const char *scope, const char *text, const char *client_msg_id);
size_t offline_queue_size(void);
bool offline_queue_peek(size_t idx, const char **out_scope, const char **out_text, const char **out_client_msg_id);
void offline_queue_clear(void);
void offline_queue_flush_on_connect(void);

uint32_t compute_reconnect_delay_ms(int attempt, uint32_t jitter_rand);
