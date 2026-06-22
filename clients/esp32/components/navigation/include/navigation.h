#pragma once

#include "esp_err.h"
#include "lvgl.h"

/**
 * Initialize the 2D pager:
 *   col 0           → ConfigScreen (server URL, connection state, reconnect)
 *   col 1..N, row M → face M of app N
 *
 * Horizontal swipe switches apps, vertical swipe switches faces within the
 * current app. Matches the Android/Wear pager pattern.
 *
 * Must be called after state_init(); subscribes to state events to rebuild
 * tiles.
 *
 * @param screen  Root screen object
 * @return ESP_OK on success
 */
esp_err_t navigation_init(lv_obj_t *screen);
