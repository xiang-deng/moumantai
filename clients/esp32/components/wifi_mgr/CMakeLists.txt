idf_component_register(
    SRCS "wifi.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_event esp_netif
    PRIV_REQUIRES nvs_flash log esp_timer
)
