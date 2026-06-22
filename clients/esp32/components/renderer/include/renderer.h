#pragma once

#include "esp_err.h"
#include "lvgl.h"
#include "state.h"

/**
 * Prepare the screen: background color, theme, LVGL display retained.
 * Must be called after board_init() and state_init(), before
 * navigation_init(). Does NOT create a content area — the navigation
 * component owns the tileview that subdivides the screen.
 */
esp_err_t renderer_init(lv_display_t *disp);

/**
 * Render the given face into the provided tile body. Clears existing
 * children of `body` first. If face is NULL or has no components,
 * renders a "Loading…" placeholder. Must be called with the LVGL lock held.
 */
void renderer_render_face(lv_obj_t *body, const app_state_t *app, const face_state_t *face);

/** Get the root screen LVGL object. */
lv_obj_t *renderer_get_screen(void);
