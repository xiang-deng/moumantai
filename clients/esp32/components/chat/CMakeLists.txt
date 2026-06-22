idf_component_register(
    SRCS "chat_ui.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_lvgl_port state transport renderer
    PRIV_REQUIRES esp_event log json esp_hw_support
)
