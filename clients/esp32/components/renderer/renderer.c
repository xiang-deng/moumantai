#include "renderer.h"
#include "render_node.h"
#include "style_helpers.h"
#include "state.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "esp_lvgl_port.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_event.h"

static const char *TAG = "renderer";

static lv_obj_t *s_screen = NULL;
static lv_display_t *s_display = NULL;

/* --------------------------------------------------------------------------
 * Batched-session driver
 *
 * renderer_render_face captures a snapshot, renders the root widget, then
 * yields via a 1 ms timer between batches so swipe animations and touch
 * input keep running. A monotonic generation counter detects superseded
 * sessions; a stale continuation destroys itself without draining the
 * deferred-free queue (the newer session owns that drain).
 * ----------------------------------------------------------------------- */

#define RENDER_BATCH_BUDGET_US                                                                                         \
    25000 /* ~25 ms per batch — keeps animation                                                                      \
              timers (5 ms period) running with                                                                        \
              ~5 ticks of slack between batches. */

typedef struct {
    /* Pinned ctx state (heap-owned; outlives renderer_render_face's frame). */
    const moumantai_v1_ComponentDef *components;
    int num_components;
    const cJSON *data;
    const cJSON *action_args; /* component_id -> cJSON args */
    char surface_id[128];

    lv_obj_t *body;            /* the tile body we own widgets under */
    render_session_t *session; /* BFS queue + bookkeeping */
    uint32_t generation;       /* must match s_generation to run */
} render_state_t;

static uint32_t s_generation = 0;       /* bumped per renderer_render_face   */
static render_state_t *s_active = NULL; /* the only state allowed to finalize */

/* Same-body refresh during an in-flight session: don't cancel-restart
 * (lv_obj_clean + rapid server prefetches leave the screen blank). Set this
 * flag instead; finalize_session re-triggers via STATE_EVT_FACE_UPDATED once
 * the current session drains cleanly. */
static bool s_redraw_pending = false;

/* Previous face body — cleaned on navigation to return widgets to the LVGL
 * pool; without this, visited faces exhaust the pool (StoreProhibited crash).
 * lv_obj_is_valid guards against rebuild_tiles having already cleaned it. */
static lv_obj_t *s_last_body = NULL;

static render_ctx_t state_to_ctx(const render_state_t *st) {
    render_ctx_t ctx = {
        .components = st->components,
        .num_components = st->num_components,
        .data = st->data,
        .surface_id = st->surface_id,
        .item_scope_path = NULL,
        .item_scope_data = NULL,
        .session = st->session,
        .action_args = st->action_args,
    };
    return ctx;
}

static void state_free(render_state_t *st) {
    if (!st)
        return;
    render_session_destroy(st->session);
    free(st);
}

static void session_continue(void *ud);
static void finalize_session(render_state_t *st);

static void session_continue_timer_cb(lv_timer_t *t) {
    /* lv_timer wrapper: auto_delete=true, repeat_count=1 → self-deletes. */
    session_continue(lv_timer_get_user_data(t));
}

static void schedule_batch(render_state_t *st) {
    /* 1 ms one-shot, not lv_async_call: a 0-period timer fires immediately
     * inside the same lv_timer_handler pass (LVGL do-while restart), keeping
     * the port task captive for the full render. 1 ms causes the handler to
     * skip it, the task unlocks + vTaskDelay(1), and the next iteration fires. */
    lv_timer_t *t = lv_timer_create(session_continue_timer_cb, 1, st);
    if (t) {
        lv_timer_set_repeat_count(t, 1);
        return;
    }
    /* Timer pool exhausted — drain synchronously. Loses yield-between-batches
     * for this face; acceptable as graceful degradation. */
    while (render_session_has_work(st->session)) {
        render_ctx_t ctx = state_to_ctx(st);
        render_session_drain_batch(st->session, &ctx, RENDER_BATCH_BUDGET_US);
    }
    finalize_session(st);
}

static void finalize_session(render_state_t *st) {
    /* Drain deferred-free entries — done reading components/data. Any refresh
     * that arrived during the session was pushed onto the queue; drain it now. */
    state_drain_face_free();

    bool need_redraw = s_redraw_pending;
    s_redraw_pending = false;

    if (s_active == st)
        s_active = NULL;
    state_free(st);

    /* If a same-body refresh arrived during the session, post
     * STATE_EVT_FACE_UPDATED to re-enter via the normal navigation path. */
    if (need_redraw) {
        const app_state_t *app = state_get_active_app();
        const face_state_t *face = state_get_active_face();
        if (app && face) {
            face_updated_evt_t evt = {0};
            strncpy(evt.app_id, app->app_id, sizeof(evt.app_id) - 1);
            strncpy(evt.face_id, face->face_id, sizeof(evt.face_id) - 1);
            esp_event_post(STATE_EVENTS, STATE_EVT_FACE_UPDATED, &evt, sizeof(evt), 0);
        }
    }
}

static void session_continue(void *ud) {
    render_state_t *st = (render_state_t *)ud;
    if (!st)
        return;

    /* Stale session — superseded by a newer render. Free without draining
     * face_free; the newer session owns that drain. */
    if (st->generation != s_generation) {
        state_free(st);
        return;
    }

    /* Per-widget self-invalidation only — explicit lv_obj_invalidate(body)
     * at batch boundaries forces a full-frame paint (~150 ms on ILI9488/SPI). */

    render_ctx_t ctx = state_to_ctx(st);
    render_session_drain_batch(st->session, &ctx, RENDER_BATCH_BUDGET_US);

    if (render_session_has_work(st->session)) {
        schedule_batch(st);
    } else {
        finalize_session(st);
    }
}

/* --------------------------------------------------------------------------
 * Face render — entry point. Always returns quickly; large faces run via
 * scheduled continuations.
 * ----------------------------------------------------------------------- */

void renderer_render_face(lv_obj_t *body, const app_state_t *app, const face_state_t *face) {
    if (!body)
        return;

    /* Same-body refresh mid-session: don't cancel-restart (lv_obj_clean +
     * rapid server prefetches leave the body blank). Set redraw-pending;
     * finalize will post STATE_EVT_FACE_UPDATED with fresh data. */
    if (s_active && s_active->body == body) {
        s_redraw_pending = true;
        return;
    }

    /* Different body (user swiped) — cancel-restart: bump generation so the
     * in-flight session bails, clean the new body, and start fresh. */
    uint32_t my_gen = ++s_generation;

    /* Release the previous face's widgets to the LVGL pool; without this,
     * every visited body retains its tree until pool exhaustion → crash.
     * lv_obj_is_valid guards against navigation having already cleaned the tile. */
    if (s_last_body && s_last_body != body && lv_obj_is_valid(s_last_body)) {
        lv_obj_clean(s_last_body);
    }
    s_last_body = body;

    lv_obj_clean(body);

    /* Snapshot components/data without holding the lock; on_face_update
     * defers frees to a queue drained at finalization, keeping captured
     * pointers valid for the full session. */
    face_render_snapshot_t snap = {0};
    if (!state_snapshot_face(face, &snap)) {
        lv_obj_t *label = lv_label_create(body);
        lv_label_set_text(label, "Loading\xe2\x80\xa6");
        apply_typo(label, "bodyLarge");
        lv_obj_set_style_text_color(label, THEME_ON_SURFACE_VARIANT, 0);
        lv_obj_center(label);
        state_drain_face_free();
        return;
    }

    /* Convention: root is id="root"; fall back to first component if missing. */
    const char *root_id = NULL;
    const moumantai_v1_ComponentDef *root = find_component(snap.components, snap.num_components, "root");
    if (root) {
        root_id = "root";
    } else {
        root_id = snap.components[0].id;
    }

    ESP_LOGI(TAG, "Render face %s:%s (%d components, root=%s)", app ? app->app_id : "?", face->face_id,
             snap.num_components, root_id);

    /* Heap-allocate the session state — outlives this stack frame. */
    render_state_t *st = calloc(1, sizeof(*st));
    if (!st) {
        ESP_LOGE(TAG, "render_state alloc failed; falling back to drain");
        state_drain_face_free();
        return;
    }
    st->components = snap.components;
    st->num_components = snap.num_components;
    st->data = snap.data;
    st->action_args = snap.action_args;
    snprintf(st->surface_id, sizeof(st->surface_id), "%s:%s", app ? app->app_id : "", face->face_id);
    st->body = body;
    st->session = render_session_create();
    st->generation = my_gen;

    if (!st->session) {
        ESP_LOGE(TAG, "session alloc failed; falling back to drain");
        state_free(st);
        state_drain_face_free();
        return;
    }

    s_active = st;

    /* First batch: render the root widget synchronously; its grandchildren
     * are queued. LVGL coalesces dirty regions across batches. */
    render_ctx_t ctx = state_to_ctx(st);
    int64_t start = esp_timer_get_time();
    lv_obj_t *rendered = render_node(body, root_id, &ctx, DS_RENDER_PARENT_ROOT);
    if (!rendered) {
        lv_obj_t *err = lv_label_create(body);
        lv_label_set_text(err, "Render failed");
        lv_obj_set_style_text_color(err, THEME_ERROR, 0);
        lv_obj_center(err);
    }

    /* Drain remaining first-batch budget (grandchildren already queued). */
    int64_t remaining = RENDER_BATCH_BUDGET_US - (esp_timer_get_time() - start);
    if (remaining > 0) {
        render_session_drain_batch(st->session, &ctx, remaining);
    }

    if (render_session_has_work(st->session)) {
        schedule_batch(st);
    } else {
        finalize_session(st);
    }
}

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

esp_err_t renderer_init(lv_display_t *disp) {
    s_display = disp;

    if (!lvgl_port_lock(0))
        return ESP_FAIL;

    /* Initialize shared typography styles once, inside LVGL lock. */
    style_helpers_init_styles();

    s_screen = lv_display_get_screen_active(disp);

    lv_obj_set_style_bg_color(s_screen, THEME_SURFACE, 0);
    lv_obj_set_style_bg_opa(s_screen, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(s_screen, 0, 0);
    /* Pin the unified font on all three LVGL layer roots (screen, top, sys).
     * Widgets on lv_layer_top() / lv_layer_sys() don't descend from the
     * screen, so a font set only on s_screen never reaches them. */
    const lv_font_t *body_font = resolve_font("bodyMedium");
    lv_obj_set_style_text_font(s_screen, body_font, 0);
    lv_obj_set_style_text_font(lv_layer_top(), body_font, 0);
    lv_obj_set_style_text_font(lv_layer_sys(), body_font, 0);

    lvgl_port_unlock();

    ESP_LOGI(TAG, "Renderer initialized");
    return ESP_OK;
}

lv_obj_t *renderer_get_screen(void) {
    return s_screen;
}
