idf_component_register(
    SRCS "state.c" "data_model.c" "action_dispatch.c" "display_state.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_event transport esp_timer
    PRIV_REQUIRES json log freertos
)
