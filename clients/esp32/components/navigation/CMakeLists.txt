idf_component_register(
    SRCS "navigation.c" "config_screen.c" "pager_indicator.c" "status_indicator.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_lvgl_port state renderer transport
    PRIV_REQUIRES esp_event esp_netif log config_store wifi_mgr chat
)
