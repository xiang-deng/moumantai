#pragma once

#include "esp_err.h"
#include "lvgl.h"

/**
 * Initialize chat overlay — creates chat screen with message display,
 * text input, and on-screen keyboard. Initially hidden.
 *
 * @param parent  Root screen object (renderer_get_screen())
 * @return ESP_OK on success
 */
esp_err_t chat_init(lv_obj_t *parent);

/**
 * Show or hide the chat overlay.
 * When shown, it covers the face content area.
 */
void chat_show(bool visible);

/**
 * Show or hide the chat FAB without touching the chat panel. Used by
 * overlays (e.g. ConfigScreen on-screen keyboard) that need full screen
 * real-estate. Idempotent. When the chat panel itself is open, the FAB
 * stays hidden regardless of this setting.
 */
void chat_fab_set_visible(bool visible);
