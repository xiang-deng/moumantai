#pragma once

#include "esp_err.h"
#include "lvgl.h"

/**
 * Top-right 10 px dot that tracks DisplayState:
 *   CONNECTED    → hidden
 *   RECONNECTING → amber dot
 *   OFFLINE      → red dot with "X" glyph
 *
 * Subscribes to STATE_EVT_DISPLAY_CHANGED (no poll cost when connected).
 *
 * @param screen  Root screen object (renderer_get_screen())
 */
esp_err_t status_indicator_init(lv_obj_t *screen);
