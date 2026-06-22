#pragma once

#include "esp_err.h"
#include "lvgl.h"

/**
 * Initialize all board hardware and LVGL integration.
 *
 * Sets up SPI display (ILI9488), I2C touch (GT911), backlight,
 * and registers both with esp_lvgl_port. After return, LVGL runs
 * on its own FreeRTOS task. Use lvgl_port_lock/unlock before
 * calling LVGL APIs from other tasks.
 *
 * @param[out] out_disp  LVGL display handle (may be NULL if not needed)
 * @return ESP_OK on success
 */
esp_err_t board_init(lv_display_t **out_disp);
