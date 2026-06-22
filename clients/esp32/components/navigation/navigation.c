/*
 * navigation.c — nested-tileview pager.
 *
 * Outer tileview (horizontal): col 0 = ConfigScreen, cols 1..N = apps.
 * Each app tile hosts an inner vertical tileview with one row per face.
 * Nested tileviews avoid the ragged-grid problem: row count is a per-app
 * property so swiping horizontally off an app with 3 faces onto one with
 * 1 face never lands on a non-existent tile.
 * Horizontal swipes chain inner → outer via LV_OBJ_FLAG_SCROLL_CHAIN_HOR.
 * Mirrors the Android/Wear HorizontalPager{VerticalPager} nesting.
 */

#include "navigation.h"
#include "config_screen.h"
#include "pager_indicator.h"
#include "renderer.h"
#include "state.h"
#include "style_helpers.h"

#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "esp_event.h"
#include "esp_lvgl_port.h"
#include "esp_log.h"

static const char *TAG = "nav";

/* --------------------------------------------------------------------------
 * Module state
 * ----------------------------------------------------------------------- */

#define COL_CONFIG 0
#define FIRST_APP_COL 1

typedef struct {
    lv_obj_t *body; /* face body inside an inner tileview tile */
} face_cell_t;

typedef struct {
    char app_id[MOUMANTAI_MAX_ID_LEN];
    lv_obj_t *outer_tile;     /* position in the outer horizontal tileview */
    lv_obj_t *inner_tileview; /* vertical tileview hosted in outer_tile */
    int num_faces;
    face_cell_t *faces; /* length = max(num_faces, 1) */
} app_column_t;

static lv_obj_t *s_outer_tv = NULL;
static lv_obj_t *s_config_tile = NULL;
static app_column_t *s_cols = NULL;
static int s_num_cols = 0;
static pager_indicator_t *s_app_pi = NULL;    /* horizontal dots at bottom    */
static pager_indicator_t *s_face_pi = NULL;   /* vertical dots on right edge */
static bool s_suppress_value_changed = false; /* programmatic scroll */

/* --------------------------------------------------------------------------
 * Forward
 * ----------------------------------------------------------------------- */
static void rebuild_tiles(void);
static void on_outer_value_changed(lv_event_t *e);
static void on_inner_value_changed(lv_event_t *e);
static void render_current_face(void);
static void update_indicators(void);
static void scroll_to_active(bool animate);

/* --------------------------------------------------------------------------
 * Tile/body construction helpers
 * ----------------------------------------------------------------------- */

static lv_obj_t *make_tile_body(lv_obj_t *tile) {
    /* Full-bleed body. Bottom pad (24 px) leaves room for the pager dots. */
    lv_obj_t *body = lv_obj_create(tile);
    lv_obj_set_size(body, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_opa(body, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(body, 0, 0);
    lv_obj_set_style_radius(body, 0, 0);
    lv_obj_set_style_pad_all(body, 0, 0);
    lv_obj_set_style_pad_bottom(body, 24, 0);
    lv_obj_remove_flag(body, LV_OBJ_FLAG_SCROLLABLE);
    return body;
}

static void free_cols(void) {
    if (!s_cols)
        return;
    for (int i = 0; i < s_num_cols; i++) {
        free(s_cols[i].faces);
    }
    free(s_cols);
    s_cols = NULL;
    s_num_cols = 0;
}

/* --------------------------------------------------------------------------
 * Tile rebuild — called whenever app list or face count changes.
 * LVGL lock must be held.
 * ----------------------------------------------------------------------- */

static void build_inner_tileview(app_column_t *col, int num_faces) {
    /* Vertical-only tileview inside the outer tile. Inherits
     * LV_OBJ_FLAG_SCROLL_CHAIN_HOR so horizontal swipes reach the outer. */
    lv_obj_t *inner = lv_tileview_create(col->outer_tile);
    lv_obj_set_size(inner, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_opa(inner, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(inner, 0, 0);
    lv_obj_set_style_pad_all(inner, 0, 0);
    lv_obj_set_scrollbar_mode(inner, LV_SCROLLBAR_MODE_OFF);
    lv_obj_add_event_cb(inner, on_inner_value_changed, LV_EVENT_VALUE_CHANGED, col);

    col->inner_tileview = inner;

    int rows = num_faces > 0 ? num_faces : 1;
    col->num_faces = num_faces;
    col->faces = calloc(rows, sizeof(face_cell_t));

    for (int f = 0; f < rows; f++) {
        lv_dir_t dir = 0;
        if (f > 0)
            dir |= LV_DIR_TOP;
        if (f + 1 < rows)
            dir |= LV_DIR_BOTTOM;

        lv_obj_t *tile = lv_tileview_add_tile(inner, 0, f, dir);
        lv_obj_set_style_bg_color(tile, THEME_SURFACE, 0);
        lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
        col->faces[f].body = make_tile_body(tile);
    }
}

static void rebuild_tiles(void) {
    const client_state_t *st = state_get();
    int num_apps = st ? st->num_apps : 0;

    /* Recreate all tiles — simpler than diffing. */
    lv_obj_clean(s_outer_tv);
    free_cols();

    /* Outer tile (col 0) = ConfigScreen */
    s_config_tile = lv_tileview_add_tile(s_outer_tv, COL_CONFIG, 0, num_apps > 0 ? LV_DIR_RIGHT : 0);
    lv_obj_set_style_bg_color(s_config_tile, THEME_SURFACE, 0);
    lv_obj_set_style_bg_opa(s_config_tile, LV_OPA_COVER, 0);
    config_screen_build(s_config_tile);

    /* Outer tiles (col 1..N) = one per app; each hosts an inner vertical tileview */
    s_num_cols = num_apps;
    if (num_apps > 0) {
        s_cols = calloc(num_apps, sizeof(app_column_t));
        for (int a = 0; a < num_apps; a++) {
            const app_state_t *app = &st->apps[a];
            strncpy(s_cols[a].app_id, app->app_id, MOUMANTAI_MAX_ID_LEN - 1);

            lv_dir_t dir = LV_DIR_LEFT; /* config or previous app always exists */
            if (a + 1 < num_apps)
                dir |= LV_DIR_RIGHT;

            lv_obj_t *outer_tile = lv_tileview_add_tile(s_outer_tv, a + FIRST_APP_COL, 0, dir);
            lv_obj_set_style_bg_color(outer_tile, THEME_SURFACE, 0);
            lv_obj_set_style_bg_opa(outer_tile, LV_OPA_COVER, 0);
            lv_obj_set_style_pad_all(outer_tile, 0, 0);
            lv_obj_remove_flag(outer_tile, LV_OBJ_FLAG_SCROLLABLE);

            s_cols[a].outer_tile = outer_tile;
            build_inner_tileview(&s_cols[a], app->num_faces);
        }
    }

    /* Scroll to active, render active face, update indicators. */
    scroll_to_active(false);
    render_current_face();
    update_indicators();
}

/* --------------------------------------------------------------------------
 * Scroll tileview to the active (app, face) coordinate
 * ----------------------------------------------------------------------- */

/* Scroll only if the tileview isn't already on `target` — avoids a
 * redundant animation when the user's swipe already landed there. */
static void scroll_tile_if_needed(lv_obj_t *tv, int col, int row, lv_obj_t *target, lv_anim_enable_t anim) {
    if (!target)
        return;
    if (lv_tileview_get_tile_active(tv) == target)
        return;
    lv_tileview_set_tile_by_index(tv, col, row, anim);
}

static void scroll_to_active(bool animate) {
    const client_state_t *st = state_get();
    if (!st)
        return;

    lv_anim_enable_t anim = animate ? LV_ANIM_ON : LV_ANIM_OFF;
    bool on_config = (st->num_apps == 0 || st->active_app_idx < 0);
    int outer_col = on_config ? COL_CONFIG : FIRST_APP_COL + st->active_app_idx;

    s_suppress_value_changed = true;

    lv_obj_t *outer_target =
        on_config ? s_config_tile : (st->active_app_idx < s_num_cols ? s_cols[st->active_app_idx].outer_tile : NULL);
    scroll_tile_if_needed(s_outer_tv, outer_col, 0, outer_target, anim);

    /* Scroll inner tileview only when parked on a real app. */
    if (!on_config && st->active_app_idx < s_num_cols) {
        const app_state_t *app = &st->apps[st->active_app_idx];
        app_column_t *col = &s_cols[st->active_app_idx];
        if (col->inner_tileview && col->faces) {
            int rows = col->num_faces > 0 ? col->num_faces : 1;
            int row = (app->num_faces > 0) ? app->active_face_idx : 0;
            if (row < 0 || row >= rows)
                row = 0;
            scroll_tile_if_needed(col->inner_tileview, 0, row, lv_obj_get_parent(col->faces[row].body), anim);
        }
    }
    s_suppress_value_changed = false;
}

/* --------------------------------------------------------------------------
 * Render the face of the active app into its tile body.
 * LVGL lock must be held.
 * ----------------------------------------------------------------------- */

static void render_current_face(void) {
    const client_state_t *st = state_get();
    if (!st || st->num_apps == 0 || st->active_app_idx < 0)
        return;
    int a = st->active_app_idx;
    if (a >= s_num_cols)
        return;
    const app_state_t *app = &st->apps[a];
    int rows = app->num_faces > 0 ? app->num_faces : 1;
    int f = (app->num_faces > 0) ? app->active_face_idx : 0;
    if (f < 0 || f >= rows)
        return;

    const face_state_t *face = (app->num_faces > 0) ? &app->faces[f] : NULL;
    renderer_render_face(s_cols[a].faces[f].body, app, face);
}

/* --------------------------------------------------------------------------
 * Page-indicator updates
 * ----------------------------------------------------------------------- */

static void update_indicators(void) {
    const client_state_t *st = state_get();
    if (!st)
        return;

    /* Horizontal (apps): total = apps + 1 (includes config tile). */
    int total_h = st->num_apps + 1;
    int active_h = (st->num_apps > 0 && st->active_app_idx >= 0) ? st->active_app_idx + 1 : 0;
    pager_indicator_set(s_app_pi, total_h, active_h);

    /* Vertical (faces): only visible when the active app has >1 face. */
    if (st->num_apps == 0 || st->active_app_idx < 0) {
        pager_indicator_set(s_face_pi, 0, 0);
        return;
    }
    const app_state_t *app = &st->apps[st->active_app_idx];
    pager_indicator_set(s_face_pi, app->num_faces, app->active_face_idx);
}

/* --------------------------------------------------------------------------
 * Swipe event — user changed tile
 * ----------------------------------------------------------------------- */

static void on_outer_value_changed(lv_event_t *e) {
    (void)e;
    if (s_suppress_value_changed)
        return;

    lv_obj_t *active = lv_tileview_get_tile_active(s_outer_tv);
    if (!active || active == s_config_tile) {
        update_indicators(); /* config tile is stateless w.r.t. app index */
        return;
    }

    /* Outer tiles added in order (config, app[0], …); child-index − offset = app index. */
    int a = (int)lv_obj_get_index(active) - FIRST_APP_COL;
    if (a < 0 || a >= s_num_cols)
        return;

    const client_state_t *st = state_get();
    if (st && st->active_app_idx != a) {
        ESP_LOGI(TAG, "swipe → app %d (%s)", a, s_cols[a].app_id);
        state_switch_app(a); /* posts ACTIVE_APP_CHANGED → coalescing dispatcher */
    }
}

static void on_inner_value_changed(lv_event_t *e) {
    if (s_suppress_value_changed)
        return;

    app_column_t *col = (app_column_t *)lv_event_get_user_data(e);
    if (!col || !col->inner_tileview || col->num_faces <= 0)
        return;

    lv_obj_t *active = lv_tileview_get_tile_active(col->inner_tileview);
    if (!active)
        return;

    /* Inner tiles added one per row; child-index == row. */
    int row = (int)lv_obj_get_index(active);
    if (row < 0 || row >= col->num_faces)
        return;

    /* s_cols[i] mirrors state.apps[i] by construction. */
    int app_idx = (int)(col - s_cols);
    const client_state_t *st = state_get();
    if (!st || app_idx < 0 || app_idx >= st->num_apps)
        return;

    if (st->apps[app_idx].active_face_idx != row) {
        ESP_LOGI(TAG, "swipe → face %d of %s", row, col->app_id);
        state_switch_face(col->app_id, row);
    }
}

/* --------------------------------------------------------------------------
 * State event handlers — bounce from the esp_event task to LVGL.
 *
 * Events within one tick (e.g. appList + faceList + faceUpdate) are
 * coalesced: each sets bits in `s_dirty`; only the first queues flush_dirty.
 * flush_dirty reads+clears flags atomically and runs the coarsest needed
 * action (rebuild > scroll > render).
 * ----------------------------------------------------------------------- */

/* Proximity cache window: active ± 1 = 3 apps cached. Matches server prefetch. */
#define NEIGHBOR_WINDOW 1

#define DIRTY_REBUILD (1u << 0) /* apps or face-count changed        */
#define DIRTY_SCROLL (1u << 1)  /* active app/face changed           */
#define DIRTY_RENDER (1u << 2)  /* active face content changed       */
#define DIRTY_IND (1u << 3)     /* only indicators need repainting   */

static portMUX_TYPE s_dirty_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_dirty = 0;
static bool s_async_pending = false;

static void flush_dirty(void *ud) {
    (void)ud;

    portENTER_CRITICAL(&s_dirty_lock);
    uint32_t d = s_dirty;
    s_dirty = 0;
    s_async_pending = false;
    portEXIT_CRITICAL(&s_dirty_lock);

    /* REBUILD is the coarsest — it already scrolls + renders + updates
     * indicators, so early-return avoids double work. */
    if (d & DIRTY_REBUILD) {
        rebuild_tiles();
        return;
    }
    if (d & DIRTY_SCROLL) {
        scroll_to_active(true);
        render_current_face();
        update_indicators();
        return;
    }
    if (d & DIRTY_RENDER) {
        render_current_face();
    }
    if (d & DIRTY_IND) {
        update_indicators();
    }
}

static void mark_dirty(uint32_t flags) {
    bool schedule = false;
    portENTER_CRITICAL(&s_dirty_lock);
    s_dirty |= flags;
    if (!s_async_pending) {
        s_async_pending = true;
        schedule = true;
    }
    portEXIT_CRITICAL(&s_dirty_lock);
    if (schedule)
        lv_async_call(flush_dirty, NULL);
}

static void on_apps_changed(void *a, esp_event_base_t b, int32_t i, void *d) {
    mark_dirty(DIRTY_REBUILD);
}
static void on_active_app_changed(void *a, esp_event_base_t b, int32_t i, void *d) {
    /* Evict face data beyond the proximity window before LVGL repaints.
     * Active face is untouched; server prefetches neighbours on revisit. */
    const client_state_t *st = state_get();
    if (st && st->num_apps > 0) {
        state_evict_inactive_apps(st->active_app_idx, NEIGHBOR_WINDOW);
    }
    mark_dirty(DIRTY_SCROLL);
}
static void on_active_face_changed(void *a, esp_event_base_t b, int32_t i, void *d) {
    mark_dirty(DIRTY_SCROLL);
}
static void on_face_updated(void *a, esp_event_base_t b, int32_t i, void *d) {
    /* Gate on active face — neighbor-prefetch updates for non-active faces
     * should not force a render. The user picks up new data via
     * DIRTY_SCROLL → render_current_face on their next swipe. */
    const face_updated_evt_t *evt = (const face_updated_evt_t *)d;
    if (!evt)
        return;
    const app_state_t *app = state_get_active_app();
    const face_state_t *face = state_get_active_face();
    if (!app || !face)
        return;
    if (strcmp(app->app_id, evt->app_id) != 0)
        return;
    if (strcmp(face->face_id, evt->face_id) != 0)
        return;
    mark_dirty(DIRTY_RENDER | DIRTY_IND);
}

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

esp_err_t navigation_init(lv_obj_t *screen) {
    if (!lvgl_port_lock(0))
        return ESP_FAIL;

    /* Outer horizontal tileview. Per-app inner tileviews are built in rebuild_tiles. */
    s_outer_tv = lv_tileview_create(screen);
    lv_obj_set_size(s_outer_tv, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s_outer_tv, THEME_SURFACE, 0);
    lv_obj_set_style_bg_opa(s_outer_tv, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(s_outer_tv, 0, 0);
    lv_obj_set_style_border_width(s_outer_tv, 0, 0);
    lv_obj_set_scrollbar_mode(s_outer_tv, LV_SCROLLBAR_MODE_OFF);
    lv_obj_add_event_cb(s_outer_tv, on_outer_value_changed, LV_EVENT_VALUE_CHANGED, NULL);

    /* Indicators parent on screen so they overlay the tileview. */
    s_app_pi = pager_indicator_create(screen, PAGER_INDICATOR_HORIZONTAL);
    lv_obj_t *app_pi_obj = pager_indicator_obj(s_app_pi);
    lv_obj_set_size(app_pi_obj, LV_PCT(60), 20);
    lv_obj_align(app_pi_obj, LV_ALIGN_BOTTOM_MID, 0, -4);

    s_face_pi = pager_indicator_create(screen, PAGER_INDICATOR_VERTICAL);
    lv_obj_t *face_pi_obj = pager_indicator_obj(s_face_pi);
    lv_obj_set_size(face_pi_obj, 20, LV_PCT(40));
    lv_obj_align(face_pi_obj, LV_ALIGN_RIGHT_MID, -4, 0);

    rebuild_tiles(); /* build initial (empty) config tile */

    lvgl_port_unlock();

    /* Subscribe to state events. */
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_APPS_CHANGED, on_apps_changed, NULL);
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_ACTIVE_APP_CHANGED, on_active_app_changed, NULL);
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_ACTIVE_FACE_CHANGED, on_active_face_changed, NULL);
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_FACE_UPDATED, on_face_updated, NULL);

    ESP_LOGI(TAG, "Navigation initialized (tileview pager)");
    return ESP_OK;
}
