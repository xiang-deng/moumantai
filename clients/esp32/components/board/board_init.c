#include "board_config.h"
#include "board_init.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_ili9488.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_lvgl_port.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_heap_caps.h"

static const char *TAG = "board";

static esp_err_t backlight_init(void) {
    const gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << BSP_LCD_BACKLIGHT),
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&cfg), TAG, "Backlight GPIO config failed");
    ESP_RETURN_ON_ERROR(gpio_set_level(BSP_LCD_BACKLIGHT, 1), TAG, "Backlight on");
    return ESP_OK;
}

static esp_err_t lcd_init(esp_lcd_panel_io_handle_t *out_io, esp_lcd_panel_handle_t *out_panel) {
    /* SPI bus */
    const spi_bus_config_t bus_cfg = {
        .sclk_io_num = BSP_LCD_SCLK,
        .mosi_io_num = BSP_LCD_MOSI,
        .miso_io_num = GPIO_NUM_NC,
        .quadwp_io_num = GPIO_NUM_NC,
        .quadhd_io_num = GPIO_NUM_NC,
        .max_transfer_sz = BSP_LCD_H_RES * BSP_LCD_DRAW_BUF_LINES * sizeof(uint16_t),
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(BSP_LCD_SPI_HOST, &bus_cfg, SPI_DMA_CH_AUTO), TAG, "SPI bus init failed");

    /* SPI panel IO */
    const esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = BSP_LCD_DC,
        .cs_gpio_num = BSP_LCD_CS,
        .pclk_hz = BSP_LCD_PIXEL_CLK_HZ,
        .lcd_cmd_bits = BSP_LCD_CMD_BITS,
        .lcd_param_bits = BSP_LCD_PARAM_BITS,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi(BSP_LCD_SPI_HOST, &io_cfg, out_io), TAG, "Panel IO init failed");

    /* ILI9488 panel */
    const esp_lcd_panel_dev_config_t panel_cfg = {
        .reset_gpio_num = BSP_LCD_RST,
        .color_space = ESP_LCD_COLOR_SPACE_BGR,
        .bits_per_pixel = 18, /* ILI9488 uses 18-bit color (RGB666) over SPI */
    };
    size_t conv_buf_size = BSP_LCD_H_RES * BSP_LCD_DRAW_BUF_LINES * 3; /* 3 B/px for RGB666 */
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_ili9488(*out_io, &panel_cfg, conv_buf_size, out_panel), TAG,
                        "ILI9488 init failed");

    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(*out_panel), TAG, "Panel reset failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(*out_panel), TAG, "Panel init failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_invert_color(*out_panel, BSP_LCD_COLOR_INVERT), TAG, "Color invert failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_swap_xy(*out_panel, BSP_LCD_SWAP_XY), TAG, "Swap XY failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_mirror(*out_panel, BSP_LCD_MIRROR_X, BSP_LCD_MIRROR_Y), TAG, "Mirror failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(*out_panel, true), TAG, "Display on failed");

    ESP_LOGI(TAG, "LCD initialized: %dx%d ILI9488 SPI", BSP_LCD_H_RES, BSP_LCD_V_RES);
    return ESP_OK;
}

static esp_err_t touch_init(esp_lcd_touch_handle_t *out_touch) {
    /* I2C master bus */
    const i2c_master_bus_config_t i2c_cfg = {
        .i2c_port = BSP_I2C_NUM,
        .sda_io_num = BSP_I2C_SDA,
        .scl_io_num = BSP_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c_bus = NULL;
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&i2c_cfg, &i2c_bus), TAG, "I2C bus init failed");

    /* GT911 touch panel IO */
    esp_lcd_panel_io_i2c_config_t tp_io_cfg = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
    tp_io_cfg.dev_addr = BSP_TOUCH_I2C_ADDR;
    esp_lcd_panel_io_handle_t tp_io = NULL;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_i2c(i2c_bus, &tp_io_cfg, &tp_io), TAG, "Touch IO init failed");

    /* GT911 touch controller */
    const esp_lcd_touch_config_t tp_cfg = {
        .x_max = BSP_TOUCH_H_RES,
        .y_max = BSP_TOUCH_V_RES,
        .rst_gpio_num = BSP_TOUCH_RST,
        .int_gpio_num = BSP_TOUCH_INT,
        .levels =
            {
                .reset = 0,
                .interrupt = 0,
            },
        .flags =
            {
                .swap_xy = BSP_LCD_SWAP_XY,
                .mirror_x = BSP_LCD_MIRROR_X,
                .mirror_y = BSP_LCD_MIRROR_Y,
            },
    };
    ESP_RETURN_ON_ERROR(esp_lcd_touch_new_i2c_gt911(tp_io, &tp_cfg, out_touch), TAG, "GT911 init failed");

    ESP_LOGI(TAG, "Touch initialized: GT911 I2C (addr=0x%02X)", BSP_TOUCH_I2C_ADDR);
    return ESP_OK;
}

esp_err_t board_init(lv_display_t **out_disp) {
    ESP_LOGI(TAG, "Board init starting");

    /* Backlight on */
    ESP_RETURN_ON_ERROR(backlight_init(), TAG, "Backlight init failed");

    /* LCD display */
    esp_lcd_panel_io_handle_t lcd_io = NULL;
    esp_lcd_panel_handle_t lcd_panel = NULL;
    ESP_RETURN_ON_ERROR(lcd_init(&lcd_io, &lcd_panel), TAG, "LCD init failed");

    /* Touch (non-fatal — display works without it) */
    esp_lcd_touch_handle_t touch = NULL;
    esp_err_t touch_ret = touch_init(&touch);
    if (touch_ret != ESP_OK) {
        ESP_LOGW(TAG, "Touch unavailable: %s (continuing without touch)", esp_err_to_name(touch_ret));
        touch = NULL;
    }

    /* LVGL task stack: 16 KB — recursive widget trees (Scaffold → Column →
     * List → ListItem → Icon/Text) are deep and lv_obj_create eats stack. */
    lvgl_port_cfg_t lvgl_cfg = ESP_LVGL_PORT_INIT_CONFIG();
    lvgl_cfg.task_stack = 16 * 1024;
    ESP_RETURN_ON_ERROR(lvgl_port_init(&lvgl_cfg), TAG, "LVGL port init failed");

    /* Add display to LVGL */
    const lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = lcd_io,
        .panel_handle = lcd_panel,
        .buffer_size = BSP_LCD_H_RES * BSP_LCD_DRAW_BUF_LINES,
        .double_buffer = true,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        .color_format = LV_COLOR_FORMAT_RGB565,
        .rotation =
            {
                .swap_xy = false,
                .mirror_x = false,
                .mirror_y = false,
            },
        .flags =
            {
                /* Draw buffer in PSRAM (CONFIG_SOC_PSRAM_DMA_CAPABLE=y on Octal
                 * PSRAM ESP32-S3) — frees ~25-77 KB of internal DMA-RAM for
                 * WiFi/SPI esf_buf allocations. The SPI driver bounces
                 * internally when needed. */
                .buff_dma = false,
                .buff_spiram = true,
                .swap_bytes = false, /* ILI9488 does RGB565→RGB666 in software; needs native byte order */
            },
    };
    lv_display_t *disp = lvgl_port_add_disp(&disp_cfg);
    if (!disp) {
        ESP_LOGE(TAG, "Failed to add display to LVGL port");
        return ESP_FAIL;
    }

    /* Add touch to LVGL (skip if touch init failed) */
    if (touch) {
        const lvgl_port_touch_cfg_t touch_cfg = {
            .disp = disp,
            .handle = touch,
        };
        lv_indev_t *indev = lvgl_port_add_touch(&touch_cfg);
        if (!indev) {
            ESP_LOGW(TAG, "Failed to add touch to LVGL port (non-fatal)");
        }
    } else {
        ESP_LOGW(TAG, "Touch not available, skipping LVGL touch setup");
    }

    if (out_disp) {
        *out_disp = disp;
    }

    ESP_LOGI(TAG, "Board initialized successfully");
    return ESP_OK;
}
