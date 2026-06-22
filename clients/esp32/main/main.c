#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "lvgl.h"
#include "esp_lvgl_port.h"
#include "cJSON.h"

#include "board_init.h"
#include "wifi.h"
#include "transport.h"
#include "state.h"
#include "display_state.h"
#include "renderer.h"
#include "navigation.h"
#include "status_indicator.h"
#include "chat.h"
#include "config_store.h"

static const char *TAG = "main";

/* --------------------------------------------------------------------------
 * Nav-intent provider — called before every ClientHello so the server can
 * restore the active app/face on reconnect.
 * ----------------------------------------------------------------------- */

static void fill_nav_intent(nav_intent_t *out) {
    if (!out)
        return;
    const app_state_t *app = state_get_active_app();
    if (app) {
        strncpy(out->current_app_id, app->app_id, sizeof(out->current_app_id) - 1);
        const face_state_t *face = state_get_active_face();
        if (face) {
            strncpy(out->current_face_id, face->face_id, sizeof(out->current_face_id) - 1);
        }
    }
}

/* --------------------------------------------------------------------------
 * Heap diagnostics — `largest_free_block(MALLOC_CAP_INTERNAL)` declining
 * while total stays flat signals fragmentation. Logs one CSV row per 60 s;
 * grep "heap_diag," on a captured monitor log to extract the time-series. */
static void heap_diag_cb(void *arg) {
    (void)arg;
    size_t int_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t int_lfb = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    size_t psram_lfb = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
    ESP_LOGI(TAG, "heap_diag,%lld,int_free=%u,int_lfb=%u,psram_free=%u,psram_lfb=%u", esp_timer_get_time() / 1000,
             (unsigned)int_free, (unsigned)int_lfb, (unsigned)psram_free, (unsigned)psram_lfb);
}

/* --------------------------------------------------------------------------
 * cJSON allocator routing — face data trees are many small nodes and the
 * worst case for internal-RAM fragmentation. Route all cJSON allocations to
 * PSRAM. Must be installed before transport_init (which spawns the WS receive
 * task that calls cJSON_Create* first).
 * ----------------------------------------------------------------------- */
static void *cjson_psram_malloc(size_t sz) {
    return heap_caps_malloc(sz, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
static void cjson_psram_free(void *p) {
    heap_caps_free(p);
}

static void heap_diag_start(void) {
    static esp_timer_handle_t s_diag_timer = NULL;
    if (s_diag_timer)
        return;
    const esp_timer_create_args_t args = {
        .callback = heap_diag_cb,
        .name = "heap_diag",
    };
    if (esp_timer_create(&args, &s_diag_timer) != ESP_OK)
        return;
    /* One tick at boot for a baseline, then every 60 s. */
    heap_diag_cb(NULL);
    esp_timer_start_periodic(s_diag_timer, 60ULL * 1000 * 1000);
}

void app_main(void) {
    ESP_LOGI(TAG, "Moumantai ESP32 Client starting");

    /* ── 1. Board: display + touch + LVGL ── */
    lv_display_t *disp = NULL;
    ESP_ERROR_CHECK(board_init(&disp));

    /* ── 2. NVS + event loop (needed before state_init / config_store) ── */
    {
        esp_err_t ret = nvs_flash_init();
        if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
            ESP_ERROR_CHECK(nvs_flash_erase());
            ret = nvs_flash_init();
        }
        ESP_ERROR_CHECK(ret);
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    /* NVS-backed config: ssid / password / server URI. */
    ESP_ERROR_CHECK(config_store_init());

    /* Route cJSON to PSRAM before transport_init spawns the WS receive task. */
    cJSON_InitHooks(&(cJSON_Hooks){
        .malloc_fn = cjson_psram_malloc,
        .free_fn = cjson_psram_free,
    });

    /* ── 3. Transport + State + Renderer + Navigation + Chat ── */
    ESP_ERROR_CHECK(transport_init());
    ESP_ERROR_CHECK(state_init());
    ESP_ERROR_CHECK(renderer_init(disp));
    ESP_ERROR_CHECK(navigation_init(renderer_get_screen())); /* 2D tileview pager */
    ESP_ERROR_CHECK(chat_init(renderer_get_screen()));       /* chat FAB overlay */

    /* Register after state+chat are up — transport reads this inline at hello
     * time, so reconnects carry the current app/face, not a stale snapshot. */
    transport_set_nav_intent_provider(fill_nav_intent);

    /* Display-state tick: 2 s flap debounce, 15 s offline escalation. */
    display_state_init();
    ESP_ERROR_CHECK(status_indicator_init(renderer_get_screen()));

    /* Soak diagnostics — see heap_diag_cb. */
    heap_diag_start();

    /* ── 4. Load saved credentials (empty on first boot). ── */
    char ssid[CFG_MAX_SSID];
    char password[CFG_MAX_PASSWORD];
    char server_uri[CFG_MAX_URI];
    config_store_get_ssid(ssid, sizeof(ssid));
    config_store_get_password(password, sizeof(password));
    config_store_get_server_uri(server_uri, sizeof(server_uri));

    /* ── 5. Best-effort WiFi + WebSocket. Skip if no credentials yet —
     *      the ConfigScreen handles first-time setup. ── */
    if (ssid[0] == '\0') {
        ESP_LOGI(TAG, "No WiFi credentials configured — open the ConfigScreen "
                      "to enter SSID / password / server URI.");
    } else {
        esp_err_t wifi_ret = wifi_init_sta(ssid, password);
        if (wifi_ret != ESP_OK) {
            ESP_LOGW(TAG, "WiFi initial connect failed — edit credentials in "
                          "the ConfigScreen and hit Save & Reconnect.");
        } else if (server_uri[0] == '\0') {
            ESP_LOGW(TAG, "WiFi up but no server URI configured — open the "
                          "ConfigScreen to set it.");
        } else {
            esp_err_t ws_ret = transport_connect(server_uri);
            if (ws_ret != ESP_OK) {
                ESP_LOGW(TAG, "WebSocket connect failed — edit URI in the "
                              "ConfigScreen and hit Save & Reconnect.");
            } else {
                ESP_LOGI(TAG, "Init complete. Server-driven UI will render "
                              "on faceUpdate.");
            }
        }
    }

    /* app_main returns; LVGL, event loop, WiFi, and WebSocket tasks keep
     * running. ConfigScreen's Save & Reconnect repeats this sequence. */
}
