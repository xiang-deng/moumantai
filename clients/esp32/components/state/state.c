#include "state.h"
#include "data_model.h"
#include "transport.h"
#include "proto_decode.h"
#include "moumantai/v1/actions.pb.h"

#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"

static const char *TAG = "state";

ESP_EVENT_DEFINE_BASE(STATE_EVENTS);

/* Decoder context stashed in pb_callback_t.arg by proto_decode.c. */
typedef struct {
    moumantai_v1_ComponentDef *components;
    int count;
    int capacity;
    cJSON *args_by_id; /* component_id -> cJSON args, owned */
} components_decode_ctx_t;

/* --------------------------------------------------------------------------
 * Internal state
 * ----------------------------------------------------------------------- */

static client_state_t s_state = {0};
static SemaphoreHandle_t s_mutex = NULL;

#define STATE_LOCK() xSemaphoreTake(s_mutex, portMAX_DELAY)
#define STATE_UNLOCK() xSemaphoreGive(s_mutex)

static char s_last_viewing_scope[MOUMANTAI_MAX_ID_LEN] = {0};

/* Deferred-free queue: on_face_update pushes old face pointers here when
 * swapping in new data; the renderer drains it after each render. Decouples
 * free from update so the LVGL task can snapshot face->components safely. */
typedef struct face_free_node {
    moumantai_v1_ComponentDef *components;
    int num_components;
    cJSON *data;
    cJSON *action_args; /* component_id -> cJSON args sidecar */
    struct face_free_node *next;
} face_free_node_t;

static face_free_node_t *s_face_free_head = NULL; /* protected by STATE_LOCK */

/* --------------------------------------------------------------------------
 * Free helpers
 * ----------------------------------------------------------------------- */

/* Free heap payloads owned by a face tuple (action_args may be NULL). */
static void free_face_components_inner(moumantai_v1_ComponentDef *components, int num_components, cJSON *data,
                                       cJSON *action_args) {
    if (components) {
        free(components);
    }
    if (data)
        cJSON_Delete(data);
    if (action_args)
        cJSON_Delete(action_args);
}

static void free_face_state(face_state_t *face) {
    if (!face)
        return;
    free_face_components_inner(face->components, face->num_components, face->data, face->action_args);
    face->components = NULL;
    face->num_components = 0;
    face->data = NULL;
    face->action_args = NULL;
}

/* Push old face contents onto the deferred-free queue (caller holds STATE_LOCK).
 * On malloc failure, fall back to immediate free — the race window reopens but
 * a failed enqueue is far rarer than leaving stale pointers indefinitely. */
static void enqueue_face_free_locked(moumantai_v1_ComponentDef *components, int num_components, cJSON *data,
                                     cJSON *action_args) {
    if (!components && !data && !action_args)
        return;
    face_free_node_t *node = malloc(sizeof(*node));
    if (!node) {
        free_face_components_inner(components, num_components, data, action_args);
        return;
    }
    node->components = components;
    node->num_components = num_components;
    node->data = data;
    node->action_args = action_args;
    node->next = s_face_free_head;
    s_face_free_head = node;
}

static void free_app_state(app_state_t *app) {
    if (!app)
        return;
    if (app->faces) {
        for (int i = 0; i < app->num_faces; i++)
            free_face_state(&app->faces[i]);
        free(app->faces);
        app->faces = NULL;
    }
    app->num_faces = 0;
}

static void clear_all_state(void) {
    if (s_state.apps) {
        for (int i = 0; i < s_state.num_apps; i++)
            free_app_state(&s_state.apps[i]);
        free(s_state.apps);
        s_state.apps = NULL;
    }
    s_state.num_apps = 0;
    s_state.active_app_idx = 0;
}

/* --------------------------------------------------------------------------
 * Find helpers
 * ----------------------------------------------------------------------- */

static app_state_t *find_app(const char *app_id) {
    for (int i = 0; i < s_state.num_apps; i++) {
        if (strcmp(s_state.apps[i].app_id, app_id) == 0)
            return &s_state.apps[i];
    }
    return NULL;
}

static face_state_t *find_face(app_state_t *app, const char *face_id) {
    if (!app)
        return NULL;
    for (int i = 0; i < app->num_faces; i++) {
        if (strcmp(app->faces[i].face_id, face_id) == 0)
            return &app->faces[i];
    }
    return NULL;
}

/* --------------------------------------------------------------------------
 * Transport event handlers
 * ----------------------------------------------------------------------- */

static void on_connected(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    (void)data;
    STATE_LOCK();
    s_state.conn_state = CONN_CONNECTED;
    STATE_UNLOCK();
    esp_event_post(STATE_EVENTS, STATE_EVT_CONN_CHANGED, &s_state.conn_state, sizeof(connection_state_t), 0);
}

static void on_disconnected(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    (void)data;
    STATE_LOCK();
    s_state.conn_state = CONN_DISCONNECTED;
    s_last_viewing_scope[0] = '\0';
    STATE_UNLOCK();
    esp_event_post(STATE_EVENTS, STATE_EVT_CONN_CHANGED, &s_state.conn_state, sizeof(connection_state_t), 0);
}

static void on_hello_ok(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ServerHello *hello = (moumantai_v1_ServerHello *)data;
    STATE_LOCK();
    strncpy(s_state.session_id, hello->session_id, sizeof(s_state.session_id) - 1);
    s_state.conn_state = CONN_SESSION_ACTIVE;
    clear_all_state();
    STATE_UNLOCK();
    ESP_LOGI(TAG, "Session active: %s", s_state.session_id);
    esp_event_post(STATE_EVENTS, STATE_EVT_CONN_CHANGED, &s_state.conn_state, sizeof(connection_state_t), 0);
}

static void on_app_list(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_AppListMsg *msg = *(moumantai_v1_AppListMsg **)data;

    STATE_LOCK();
    clear_all_state();

    s_state.num_apps = msg->apps_count > MOUMANTAI_MAX_APPS ? MOUMANTAI_MAX_APPS : (int)msg->apps_count;
    if (s_state.num_apps > 0) {
        s_state.apps = calloc(s_state.num_apps, sizeof(app_state_t));
        for (int i = 0; i < s_state.num_apps; i++) {
            const moumantai_v1_AppInfo *info = &msg->apps[i];
            strncpy(s_state.apps[i].app_id, info->app_id, MOUMANTAI_MAX_ID_LEN - 1);
            strncpy(s_state.apps[i].label, info->label, MOUMANTAI_MAX_LABEL_LEN - 1);
            strncpy(s_state.apps[i].icon, info->icon, sizeof(s_state.apps[i].icon) - 1);
            s_state.apps[i].position = info->position;
        }
    }
    s_state.active_app_idx = 0;
    STATE_UNLOCK();

    free(msg);

    ESP_LOGI(TAG, "State: %d apps loaded", s_state.num_apps);
    esp_event_post(STATE_EVENTS, STATE_EVT_APPS_CHANGED, NULL, 0, 0);
}

/* Merge the incoming face list. Matched face_ids keep their components+data;
 * fallen-out faces go on the deferred-free queue; new face_ids start NULL
 * until a faceUpdate arrives. APPS_CHANGED is posted only on structural
 * change — identical id sequence is a silent no-op (no "Loading…" flash). */
static void on_face_list(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_FaceListMsg *msg = *(moumantai_v1_FaceListMsg **)data;

    STATE_LOCK();
    app_state_t *app = find_app(msg->app_id);
    if (!app) {
        STATE_UNLOCK();
        ESP_LOGW(TAG, "faceList for unknown app: %s", msg->app_id);
        free(msg);
        return;
    }

    face_state_t *old_faces = app->faces;
    int old_count = app->num_faces;
    int old_active = app->active_face_idx;

    /* Snapshot the active face_id so we can find its new index post-merge.
     * Empty if there was no prior active. */
    char old_active_face_id[MOUMANTAI_MAX_ID_LEN] = {0};
    if (old_faces && old_active >= 0 && old_active < old_count) {
        strncpy(old_active_face_id, old_faces[old_active].face_id, MOUMANTAI_MAX_ID_LEN - 1);
    }

    int new_count = msg->faces_count > MOUMANTAI_MAX_FACES ? MOUMANTAI_MAX_FACES : (int)msg->faces_count;

    /* Fast path: identical id sequence (common — server sends the same
     * faceList on every viewing + neighbor prefetch). Update labels/positions
     * in place; no realloc, no swap, no dangling pointer risk. */
    bool same_structure = (new_count == old_count);
    if (same_structure) {
        for (int i = 0; i < new_count; i++) {
            if (strcmp(old_faces[i].face_id, msg->faces[i].face_id) != 0) {
                same_structure = false;
                break;
            }
        }
    }
    if (same_structure) {
        for (int i = 0; i < new_count; i++) {
            const moumantai_v1_FaceInfo *info = &msg->faces[i];
            strncpy(app->faces[i].label, info->label, MOUMANTAI_MAX_LABEL_LEN - 1);
            app->faces[i].label[MOUMANTAI_MAX_LABEL_LEN - 1] = '\0';
            app->faces[i].position = info->position;
        }
        ESP_LOGI(TAG, "State: app '%s' faceList unchanged (%d faces)", app->app_id, new_count);
        STATE_UNLOCK();
        free(msg);
        return;
    }

    /* Slow path: structure changed. Build a fresh array, moving surviving
     * data and deferring the rest. APPS_CHANGED is unconditional here. */
    face_state_t *new_faces = NULL;
    if (new_count > 0) {
        new_faces = calloc(new_count, sizeof(face_state_t));
        if (!new_faces) {
            STATE_UNLOCK();
            ESP_LOGE(TAG, "faceList: calloc(%d) failed; keeping old state", new_count);
            free(msg);
            return;
        }
    }

    /* Track which old slots were moved (so the fallout-free loop skips them). */
    bool *old_moved = NULL;
    if (old_count > 0) {
        old_moved = calloc(old_count, sizeof(bool));
        /* OOM: bail to avoid double-free. */
        if (!old_moved) {
            free(new_faces);
            STATE_UNLOCK();
            ESP_LOGE(TAG, "faceList: calloc(old_moved=%d) failed; keeping old state", old_count);
            free(msg);
            return;
        }
    }

    for (int i = 0; i < new_count; i++) {
        const moumantai_v1_FaceInfo *info = &msg->faces[i];
        face_state_t *dst = &new_faces[i];
        strncpy(dst->face_id, info->face_id, MOUMANTAI_MAX_ID_LEN - 1);
        strncpy(dst->label, info->label, MOUMANTAI_MAX_LABEL_LEN - 1);
        dst->position = info->position;

        /* Move matching face_id's data into dst. */
        for (int j = 0; j < old_count; j++) {
            if (old_moved[j])
                continue;
            if (strcmp(old_faces[j].face_id, dst->face_id) == 0) {
                dst->components = old_faces[j].components;
                dst->num_components = old_faces[j].num_components;
                dst->data = old_faces[j].data;
                dst->action_args = old_faces[j].action_args;
                old_faces[j].components = NULL;
                old_faces[j].num_components = 0;
                old_faces[j].data = NULL;
                old_faces[j].action_args = NULL;
                old_moved[j] = true;
                break;
            }
        }
    }

    /* Defer free of fallen-out faces — renderer may hold a snapshot pointer. */
    for (int j = 0; j < old_count; j++) {
        if (old_moved[j])
            continue;
        if (old_faces[j].components || old_faces[j].data || old_faces[j].action_args) {
            enqueue_face_free_locked(old_faces[j].components, old_faces[j].num_components, old_faces[j].data,
                                     old_faces[j].action_args);
            old_faces[j].components = NULL;
            old_faces[j].num_components = 0;
            old_faces[j].data = NULL;
            old_faces[j].action_args = NULL;
        }
    }

    free(old_moved);
    free(old_faces);

    app->faces = new_faces;
    app->num_faces = new_count;

    /* Preserve active face id if it survived; otherwise fall back to 0. */
    int new_active = 0;
    if (old_active_face_id[0]) {
        for (int i = 0; i < new_count; i++) {
            if (strcmp(new_faces[i].face_id, old_active_face_id) == 0) {
                new_active = i;
                break;
            }
        }
    }
    app->active_face_idx = new_active;

    ESP_LOGI(TAG, "State: app '%s' faceList rebuilt (%d faces, active=%d)", app->app_id, app->num_faces, new_active);

    STATE_UNLOCK();

    free(msg);

    /* Structural change — always post. Fast path above suppresses on no-change. */
    esp_event_post(STATE_EVENTS, STATE_EVT_APPS_CHANGED, NULL, 0, 0);
}

static void on_face_update(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_FaceUpdateMsg *msg = *(moumantai_v1_FaceUpdateMsg **)data;

    /* Decoder packed msg->components.arg → components_decode_ctx_t*,
     * msg->data.fields.arg → cJSON* face data Struct. */
    components_decode_ctx_t *cctx = (components_decode_ctx_t *)msg->components.arg;
    cJSON *face_data = (cJSON *)msg->data.fields.arg;

    STATE_LOCK();
    app_state_t *app = find_app(msg->app_id);
    face_state_t *face = app ? find_face(app, msg->face_id) : NULL;

    if (face) {
        /* Defer old free — LVGL task may be mid-snapshot without STATE_LOCK. */
        enqueue_face_free_locked(face->components, face->num_components, face->data, face->action_args);
        face->components = cctx ? cctx->components : NULL;
        face->num_components = cctx ? cctx->count : 0;
        face->data = face_data;
        face->action_args = cctx ? cctx->args_by_id : NULL;
        ESP_LOGI(TAG, "State: face '%s:%s' updated (%d components)", msg->app_id, msg->face_id, face->num_components);
    } else {
        ESP_LOGW(TAG, "faceUpdate for unknown face: %s:%s", msg->app_id, msg->face_id);
        if (cctx)
            free_face_components_inner(cctx->components, cctx->count, NULL, cctx->args_by_id);
        if (face_data)
            cJSON_Delete(face_data);
    }
    STATE_UNLOCK();

    /* Capture ids before freeing msg — receiver gates re-render on
     * active-face match to suppress spurious renders for non-active faces. */
    face_updated_evt_t evt = {0};
    if (face) {
        strncpy(evt.app_id, msg->app_id, sizeof(evt.app_id) - 1);
        strncpy(evt.face_id, msg->face_id, sizeof(evt.face_id) - 1);
    }

    free(cctx);
    free(msg);

    if (face)
        esp_event_post(STATE_EVENTS, STATE_EVT_FACE_UPDATED, &evt, sizeof(evt), 0);
}

static void on_chat(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    /* Pass pointer to chat consumer, which frees. */
    moumantai_v1_ChatMessage *msg = *(moumantai_v1_ChatMessage **)data;
    esp_event_post(STATE_EVENTS, STATE_EVT_CHAT_MESSAGE, &msg, sizeof(msg), 0);
}

static void on_chat_window(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ChatWindowMsg *msg = *(moumantai_v1_ChatWindowMsg **)data;
    esp_event_post(STATE_EVENTS, STATE_EVT_CHAT_WINDOW, &msg, sizeof(msg), 0);
}

static void on_chat_update(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ChatUpdateMsg *msg = *(moumantai_v1_ChatUpdateMsg **)data;
    esp_event_post(STATE_EVENTS, STATE_EVT_CHAT_UPDATE, &msg, sizeof(msg), 0);
}

static void on_voice_state(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_VoiceState *vs = (moumantai_v1_VoiceState *)data;
    voice_state_t v = vs->state;
    STATE_LOCK();
    s_state.voice = v;
    STATE_UNLOCK();
    esp_event_post(STATE_EVENTS, STATE_EVT_VOICE_CHANGED, &v, sizeof(v), 0);
}

static void on_navigate(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_NavigateMsg *nav = (moumantai_v1_NavigateMsg *)data;

    int app_idx = -1;
    int face_idx = -1;
    bool face_changed = false;

    STATE_LOCK();
    for (int i = 0; i < s_state.num_apps; i++) {
        if (strcmp(s_state.apps[i].app_id, nav->app_id) == 0) {
            s_state.active_app_idx = i;
            app_idx = i;
            if (nav->has_face_id && nav->face_id[0] != '\0') {
                for (int j = 0; j < s_state.apps[i].num_faces; j++) {
                    if (strcmp(s_state.apps[i].faces[j].face_id, nav->face_id) == 0) {
                        s_state.apps[i].active_face_idx = j;
                        face_idx = j;
                        face_changed = true;
                        break;
                    }
                }
            }
            break;
        }
    }
    STATE_UNLOCK();

    if (app_idx >= 0) {
        esp_event_post(STATE_EVENTS, STATE_EVT_ACTIVE_APP_CHANGED, &app_idx, sizeof(app_idx), 0);
    }
    if (face_changed) {
        esp_event_post(STATE_EVENTS, STATE_EVT_ACTIVE_FACE_CHANGED, &face_idx, sizeof(face_idx), 0);
    }
}

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

esp_err_t state_init(void) {
    if (s_mutex)
        return ESP_OK;
    s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex)
        return ESP_ERR_NO_MEM;

    memset(&s_state, 0, sizeof(s_state));
    s_state.voice = VOICE_IDLE;

    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_CONNECTED, on_connected, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_DISCONNECTED, on_disconnected, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_HELLO_OK, on_hello_ok, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_APP_LIST, on_app_list, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_FACE_LIST, on_face_list, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_FACE_UPDATE, on_face_update, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_CHAT, on_chat, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_CHAT_WINDOW, on_chat_window, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_CHAT_UPDATE, on_chat_update, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_VOICE_STATE, on_voice_state, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_NAVIGATE, on_navigate, NULL);

    ESP_LOGI(TAG, "State manager initialized");
    return ESP_OK;
}

/* --------------------------------------------------------------------------
 * Read-only accessors
 * ----------------------------------------------------------------------- */

const client_state_t *state_get(void) {
    return &s_state;
}

const app_state_t *state_get_active_app(void) {
    if (s_state.num_apps == 0 || s_state.active_app_idx >= s_state.num_apps)
        return NULL;
    return &s_state.apps[s_state.active_app_idx];
}

const face_state_t *state_get_active_face(void) {
    const app_state_t *app = state_get_active_app();
    if (!app || app->num_faces == 0 || app->active_face_idx >= app->num_faces)
        return NULL;
    return &app->faces[app->active_face_idx];
}

connection_state_t state_get_connection(void) {
    return s_state.conn_state;
}
voice_state_t state_get_voice(void) {
    return s_state.voice;
}

bool state_snapshot_face(const face_state_t *face, face_render_snapshot_t *out) {
    if (!out)
        return false;
    out->components = NULL;
    out->num_components = 0;
    out->data = NULL;
    out->action_args = NULL;
    if (!face)
        return false;
    STATE_LOCK();
    out->components = face->components;
    out->num_components = face->num_components;
    out->data = face->data;
    out->action_args = face->action_args;
    STATE_UNLOCK();
    return out->components && out->num_components > 0;
}

const cJSON *state_get_action_args(const face_state_t *face, const char *component_id) {
    if (!face || !component_id || !component_id[0])
        return NULL;
    /* action_args lifetime is pinned by the deferred-free queue (same as
     * components/data) — no STATE_LOCK needed for the lookup. */
    const cJSON *map = face->action_args;
    if (!map)
        return NULL;
    return cJSON_GetObjectItemCaseSensitive((cJSON *)map, component_id);
}

void state_drain_face_free(void) {
    STATE_LOCK();
    face_free_node_t *head = s_face_free_head;
    s_face_free_head = NULL;
    STATE_UNLOCK();
    while (head) {
        face_free_node_t *next = head->next;
        free_face_components_inner(head->components, head->num_components, head->data, head->action_args);
        free(head);
        head = next;
    }
}

/* --------------------------------------------------------------------------
 * Navigation
 * ----------------------------------------------------------------------- */

void state_switch_app(int index) {
    char new_scope[MOUMANTAI_MAX_ID_LEN] = {0};
    bool scope_changed = false;
    STATE_LOCK();
    if (index >= 0 && index < s_state.num_apps) {
        s_state.active_app_idx = index;
        const char *app_id = s_state.apps[index].app_id;
        if (strcmp(app_id, "home") == 0) {
            snprintf(new_scope, sizeof(new_scope), "home");
        } else {
            snprintf(new_scope, sizeof(new_scope), "app:%.*s", (int)(sizeof(new_scope) - 5), app_id);
        }
        /* Compare-and-swap inside the lock to avoid racing with
         * on_disconnected (which clears s_last_viewing_scope).
         * Send outside the lock — transport_send_viewing can block. */
        if (strcmp(s_last_viewing_scope, new_scope) != 0) {
            strncpy(s_last_viewing_scope, new_scope, sizeof(s_last_viewing_scope) - 1);
            s_last_viewing_scope[sizeof(s_last_viewing_scope) - 1] = '\0';
            scope_changed = true;
        }
        STATE_UNLOCK();

        if (scope_changed)
            transport_send_viewing(new_scope);
        esp_event_post(STATE_EVENTS, STATE_EVT_ACTIVE_APP_CHANGED, &index, sizeof(index), 0);
    } else {
        STATE_UNLOCK();
    }
}

void state_evict_inactive_apps(int active_idx, int window) {
    if (window < 0)
        window = 0;
    STATE_LOCK();
    for (int i = 0; i < s_state.num_apps; i++) {
        if (i == active_idx)
            continue;
        int dist = i > active_idx ? (i - active_idx) : (active_idx - i);
        if (dist <= window)
            continue;
        app_state_t *app = &s_state.apps[i];
        for (int j = 0; j < app->num_faces; j++) {
            face_state_t *f = &app->faces[j];
            /* Defer free — LVGL task may hold a snapshot pointer (UAF hazard). */
            if (f->components || f->data || f->action_args) {
                enqueue_face_free_locked(f->components, f->num_components, f->data, f->action_args);
                f->components = NULL;
                f->num_components = 0;
                f->data = NULL;
                f->action_args = NULL;
            }
        }
    }
    STATE_UNLOCK();
}

void state_switch_face(const char *app_id, int face_index) {
    STATE_LOCK();
    app_state_t *app = find_app(app_id);
    if (app && face_index >= 0 && face_index < app->num_faces) {
        app->active_face_idx = face_index;
        int idx = face_index;
        STATE_UNLOCK();
        /* ACTIVE_FACE_CHANGED drives DIRTY_SCROLL → scroll + render.
         * No need to also post FACE_UPDATED — data unchanged, only active index. */
        esp_event_post(STATE_EVENTS, STATE_EVT_ACTIVE_FACE_CHANGED, &idx, sizeof(idx), 0);
    } else {
        STATE_UNLOCK();
    }
}
