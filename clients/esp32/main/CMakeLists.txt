idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES board transport state renderer navigation chat config_store wifi_mgr
                  esp_event nvs_flash esp_netif json
)
