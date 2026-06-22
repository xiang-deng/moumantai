idf_component_register(
    SRCS "board_init.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES esp_lcd esp_lcd_touch driver esp_lvgl_port
)
