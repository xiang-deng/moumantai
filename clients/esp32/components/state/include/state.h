#pragma once

#include "esp_err.h"
#include "esp_event.h"
#include "state_types.h"
#include "moumantai/v1/chat.pb.h"
#include "moumantai/v1/actions.pb.h"

/* --------------------------------------------------------------------------
 * State events — posted when state changes.
 * ----------------------------------------------------------------------- */

ESP_EVENT_DECLARE_BASE(STATE_EVENTS);

enum {
    STATE_EVT_CONN_CHANGED = 0,    /* data: connection_state_t* */
    STATE_EVT_APPS_CHANGED,        /* data: NULL */
    STATE_EVT_ACTIVE_APP_CHANGED,  /* data: int* */
    STATE_EVT_ACTIVE_FACE_CHANGED, /* data: int* */
    STATE_EVT_FACE_UPDATED,        /* data: face_updated_evt_t* (stack copy); posted by on_face_update only */
    STATE_EVT_VOICE_CHANGED,       /* data: voice_state_t* */
    STATE_EVT_CHAT_MESSAGE,        /* data: moumantai_v1_ChatMessage** — receiver frees */
    STATE_EVT_CHAT_WINDOW,         /* data: moumantai_v1_ChatWindowMsg** — receiver frees */
    STATE_EVT_CHAT_UPDATE,         /* data: moumantai_v1_ChatUpdateMsg** — receiver frees */
    STATE_EVT_DISPLAY_CHANGED,     /* data: display_state_t* */
};

/* Payload for STATE_EVT_FACE_UPDATED. Receivers gate on the active face —
 * non-active updates must not trigger a re-render. Stack-copy like ui_escalated_evt_t. */
typedef struct {
    char app_id[MOUMANTAI_MAX_ID_LEN];
    char face_id[MOUMANTAI_MAX_ID_LEN];
} face_updated_evt_t;

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

esp_err_t state_init(void);

/* --------------------------------------------------------------------------
 * Read-only accessors (thread-safe via internal mutex).
 * ----------------------------------------------------------------------- */

const client_state_t *state_get(void);
const app_state_t *state_get_active_app(void);
const face_state_t *state_get_active_face(void);
connection_state_t state_get_connection(void);
voice_state_t state_get_voice(void);

/* --------------------------------------------------------------------------
 * Render snapshot — atomically captures face pointers so the renderer can
 * read them without holding STATE_LOCK. Pointers remain valid until the
 * next state_drain_face_free() call.
 * ----------------------------------------------------------------------- */

typedef struct {
    const moumantai_v1_ComponentDef *components;
    int num_components;
    const cJSON *data;
    /* component_id → cJSON args sidecar. NULL when no component had Action.args.
     * Borrowed; same lifetime as components/data (pinned by the free queue). */
    const cJSON *action_args;
} face_render_snapshot_t;

/* Atomically snapshot face->components / num / data / action_args. Returns
 * false if face is NULL or has no components (caller should render the empty
 * state). */
bool state_snapshot_face(const face_state_t *face, face_render_snapshot_t *out);

/* Look up Action.args for a component by id. Returns NULL if absent.
 * Borrowed — lifetime tied to the snapshot (valid until state_drain_face_free). */
const cJSON *state_get_action_args(const face_state_t *face, const char *component_id);

/* Free all face data deferred since the last drain. Call from the renderer
 * task AFTER finishing the current snapshot — deferred entries may include
 * the pointer that snapshot was rendered from. */
void state_drain_face_free(void);

/* --------------------------------------------------------------------------
 * Navigation
 * ----------------------------------------------------------------------- */

void state_switch_app(int index);
void state_switch_face(const char *app_id, int face_index);

/* --------------------------------------------------------------------------
 * Memory policy
 * ----------------------------------------------------------------------- */

void state_evict_inactive_apps(int active_idx, int window);
