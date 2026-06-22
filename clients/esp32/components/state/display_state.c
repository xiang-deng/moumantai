/*
 * display_state.c — time-aware UI indicator layer over connection_state_t.
 *
 * derive_display_state() is pure (unit-testable). display_state_init() runs
 * a 500 ms timer that maintains the "last non-connected" timestamp and posts
 * STATE_EVT_DISPLAY_CHANGED on transitions.
 */

#include "display_state.h"
#include "state.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "disp_state";

/* --------------------------------------------------------------------------
 * Pure derivation
 * ----------------------------------------------------------------------- */

display_state_t derive_display_state(connection_state_t cur, uint64_t now_us, uint64_t last_non_connected_us) {
    if (cur == CONN_SESSION_ACTIVE) {
        return DISPLAY_CONNECTED;
    }
    /* Cold boot (no transition recorded yet) — treat as just dropped. */
    if (last_non_connected_us == 0 || now_us < last_non_connected_us) {
        return DISPLAY_CONNECTED;
    }
    uint64_t elapsed_ms = (now_us - last_non_connected_us) / 1000ULL;
    if (elapsed_ms < (uint64_t)MOUMANTAI_RECONNECT_INDICATOR_DELAY_MS) {
        return DISPLAY_CONNECTED;
    }
    if (elapsed_ms < (uint64_t)MOUMANTAI_OFFLINE_THRESHOLD_MS) {
        return DISPLAY_RECONNECTING;
    }
    return DISPLAY_OFFLINE;
}

/* --------------------------------------------------------------------------
 * Stateful wrapper
 * ----------------------------------------------------------------------- */

static uint64_t s_last_non_connected_us = 0;
static display_state_t s_display = DISPLAY_CONNECTED;
static esp_timer_handle_t s_tick = NULL;

#define TICK_INTERVAL_US (500 * 1000) /* 500 ms — fits within 2 s / 15 s thresholds */

static void tick_cb(void *arg) {
    (void)arg;
    connection_state_t cur = state_get_connection();
    uint64_t now = esp_timer_get_time();

    /* Reset timestamp to 0 while SESSION_ACTIVE. On first non-active tick,
     * stamp it once — preserves the original drop time across flaps so the
     * 15 s threshold is absolute, not reset by CONNECTING ↔ DISCONNECTED churn. */
    if (cur == CONN_SESSION_ACTIVE) {
        s_last_non_connected_us = 0;
    } else if (s_last_non_connected_us == 0) {
        s_last_non_connected_us = now;
    }

    display_state_t next = derive_display_state(cur, now, s_last_non_connected_us);
    if (next != s_display) {
        s_display = next;
        ESP_LOGI(TAG, "DisplayState → %s",
                 next == DISPLAY_CONNECTED      ? "Connected"
                 : next == DISPLAY_RECONNECTING ? "Reconnecting"
                                                : "Offline");
        display_state_t copy = next;
        esp_event_post(STATE_EVENTS, STATE_EVT_DISPLAY_CHANGED, &copy, sizeof(copy), 0);
    }
}

void display_state_init(void) {
    if (s_tick)
        return; /* idempotent */

    const esp_timer_create_args_t args = {
        .callback = tick_cb,
        .name = "display_state_tick",
    };
    esp_err_t err = esp_timer_create(&args, &s_tick);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_create failed: %d", err);
        return;
    }
    err = esp_timer_start_periodic(s_tick, TICK_INTERVAL_US);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_start_periodic failed: %d", err);
        esp_timer_delete(s_tick);
        s_tick = NULL;
        return;
    }
    ESP_LOGI(TAG, "Initialized (tick %d ms)", TICK_INTERVAL_US / 1000);
}

display_state_t display_state_get(void) {
    return s_display;
}
