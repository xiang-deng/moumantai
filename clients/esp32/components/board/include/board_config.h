#pragma once

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/i2c_master.h"

/* ── Display: ILI9488 over SPI ── */
#define BSP_LCD_SPI_HOST SPI2_HOST
#define BSP_LCD_SCLK GPIO_NUM_42
#define BSP_LCD_MOSI GPIO_NUM_39
#define BSP_LCD_DC GPIO_NUM_41
#define BSP_LCD_CS GPIO_NUM_40
#define BSP_LCD_RST GPIO_NUM_2
#define BSP_LCD_BACKLIGHT GPIO_NUM_38

/* Display parameters */
#define BSP_LCD_H_RES 320
#define BSP_LCD_V_RES 480
/* 60 MHz: 2× faster than 40 MHz default; 80 MHz causes signal-integrity
 * issues on stock CrowPanel wiring. Drop to 40e6 if you see tearing. */
#define BSP_LCD_PIXEL_CLK_HZ (60 * 1000 * 1000)
#define BSP_LCD_CMD_BITS 8
#define BSP_LCD_PARAM_BITS 8
#define BSP_LCD_COLOR_INVERT true
#define BSP_LCD_SWAP_XY false
#define BSP_LCD_MIRROR_X false
#define BSP_LCD_MIRROR_Y false

/* ── Touch: GT911 over I2C ── */
#define BSP_I2C_NUM I2C_NUM_0
#define BSP_I2C_SDA GPIO_NUM_15
#define BSP_I2C_SCL GPIO_NUM_16
#define BSP_I2C_CLK_SPEED_HZ (400 * 1000)
#define BSP_TOUCH_INT GPIO_NUM_47
#define BSP_TOUCH_RST GPIO_NUM_48
#define BSP_TOUCH_I2C_ADDR 0x5D /* GT911 default after reset with INT/RST wired */

/* Touch coordinates match display */
#define BSP_TOUCH_H_RES BSP_LCD_H_RES
#define BSP_TOUCH_V_RES BSP_LCD_V_RES

/* ── LVGL draw buffer ──
 * 20 lines × 320 px × 2 B (RGB565) = 12.5 KB per buffer; double-buffered.
 * Kept at 20 because the ILI9488 driver allocates an internal DMA-capable
 * conv_buf (RGB565→RGB666, LINES×320×3 B); growing LINES grows conv_buf and
 * cancels the internal-RAM headroom freed by buff_spiram=true. */
#define BSP_LCD_DRAW_BUF_LINES 20
