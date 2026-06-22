/*
 * status_indicator.c — R1 lifecycle on-screen DisplayState indicator.
 *
 * A 10-px dot in the top-right corner of the screen, visible only when the
 * connection has been non-CONNECTED long enough to merit attention. Input
 * remains unblocked; the dot is just a passive hint.
 *
 *   CONNECTED    → hidden
 *   RECONNECTING → amber dot
 *   OFFLINE      → red dot with "X" label
 */

#include "status_indicator.h"
#include "display_state.h"
#include "state.h"
#include "style_helpers.h"

#include "lvgl.h"

#include "esp_event.h"
#include "esp_lvgl_port.h"
#include "esp_log.h"

static const char *TAG = "status_ind";

static lv_obj_t *s_dot = NULL;
static lv_obj_t *s_dot_label = NULL; /* centered "X" when offline */

static void apply_state_locked(display_state_t d) {
    if (!s_dot)
        return;

    switch (d) {
    case DISPLAY_CONNECTED:
        lv_obj_add_flag(s_dot, LV_OBJ_FLAG_HIDDEN);
        return;
    case DISPLAY_RECONNECTING:
        lv_obj_set_style_bg_color(s_dot, lv_color_hex(0xF9A825), 0); /* amber 800 */
        if (s_dot_label)
            lv_obj_add_flag(s_dot_label, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_dot, LV_OBJ_FLAG_HIDDEN);
        return;
    case DISPLAY_OFFLINE:
    default:
        lv_obj_set_style_bg_color(s_dot, THEME_ERROR, 0);
        if (s_dot_label)
            lv_obj_remove_flag(s_dot_label, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_dot, LV_OBJ_FLAG_HIDDEN);
        return;
    }
}

static void deferred_refresh(void *user_data) {
    display_state_t d = (display_state_t)(intptr_t)user_data;
    if (!lvgl_port_lock(200))
        return;
    apply_state_locked(d);
    lvgl_port_unlock();
}

static void on_display_changed(void *arg, esp_event_base_t base, int32_t id, void *data) {
    display_state_t d = data ? *(display_state_t *)data : display_state_get();
    /* Bounce to LVGL task — handler runs on the default event loop task. */
    lv_async_call(deferred_refresh, (void *)(intptr_t)d);
}

esp_err_t status_indicator_init(lv_obj_t *screen) {
    if (!screen)
        return ESP_ERR_INVALID_ARG;
    if (s_dot)
        return ESP_OK; /* idempotent */

    if (!lvgl_port_lock(0))
        return ESP_FAIL;

    /* 10 px dot in the top-right corner — clear of pager dots (bottom)
     * and chat FAB (bottom-right). */
    s_dot = lv_obj_create(screen);
    lv_obj_set_size(s_dot, 10, 10);
    lv_obj_set_style_radius(s_dot, 5, 0);
    lv_obj_set_style_bg_opa(s_dot, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_dot, 0, 0);
    lv_obj_align(s_dot, LV_ALIGN_TOP_RIGHT, -8, 8);
    lv_obj_remove_flag(s_dot, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(s_dot, LV_OBJ_FLAG_CLICKABLE);

    /* Centered "X" glyph for OFFLINE (labelSmall, 14 px). Hidden in RECONNECTING. */
    s_dot_label = lv_label_create(s_dot);
    lv_label_set_text(s_dot_label, "x");
    lv_obj_set_style_text_color(s_dot_label, lv_color_white(), 0);
    lv_obj_set_style_text_font(s_dot_label, resolve_font("labelSmall"), 0);
    lv_obj_center(s_dot_label);
    lv_obj_add_flag(s_dot_label, LV_OBJ_FLAG_HIDDEN);

    apply_state_locked(display_state_get());

    lvgl_port_unlock();

    esp_event_handler_register(STATE_EVENTS, STATE_EVT_DISPLAY_CHANGED, on_display_changed, NULL);

    ESP_LOGI(TAG, "Status indicator initialized");
    return ESP_OK;
}
