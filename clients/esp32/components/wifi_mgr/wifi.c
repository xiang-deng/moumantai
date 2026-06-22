#include "wifi.h"

#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "nvs_flash.h"

static const char *TAG = "wifi";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT BIT1

/* Mask SSID/password in log output (first 3 chars + length: "ATT…(9)").
 * Keeps serial captures safe to share. Caller passes char[N], N >= 24. */
static const char *mask_cred(const char *s, char *buf, size_t buf_sz) {
    if (!s || !s[0])
        return "(empty)";
    size_t len = strlen(s);
    snprintf(buf, buf_sz, "%.3s\xE2\x80\xA6(%u)", s, (unsigned)len);
    return buf;
}

static EventGroupHandle_t s_wifi_event_group;
static int s_retry_count = 0;
static bool s_connected = false;
static bool s_initialized = false;
static esp_timer_handle_t s_reconnect_timer = NULL;
/* Guards against stacking concurrent reconnect timer arms. */
static bool s_reconnect_pending = false;

/* Exponential backoff: 1000, 2000, 4000, 8000, 16000, 30000 ms (clamped).
 * ±20% jitter avoids thundering-herd on campus-wide AP restarts. */
static int wifi_backoff_delay_ms(int attempt) {
    const int base_ms = 1000;
    const int max_ms = 30000;
    int shift = attempt < 5 ? attempt : 5;
    int delay = base_ms << shift;
    if (delay > max_ms)
        delay = max_ms;
    /* ±20% jitter via esp_random() (hardware RNG, no entropy cost). */
    int jitter = ((int)(esp_random() & 0xFFFF) - 0x7FFF) * delay / (5 * 0x7FFF);
    int out = delay + jitter;
    return out < base_ms / 2 ? base_ms / 2 : out;
}

static void reconnect_timer_cb(void *arg) {
    (void)arg;
    s_reconnect_pending = false;
    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_connect failed: %s", esp_err_to_name(err));
    }
}

static void ensure_reconnect_timer(void) {
    if (s_reconnect_timer)
        return;
    const esp_timer_create_args_t args = {
        .callback = reconnect_timer_cb,
        .name = "wifi_reconnect",
    };
    if (esp_timer_create(&args, &s_reconnect_timer) != ESP_OK) {
        s_reconnect_timer = NULL;
    }
}

static void event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        if (s_retry_count < WIFI_MAX_RETRY) {
            int delay_ms = wifi_backoff_delay_ms(s_retry_count);
            s_retry_count++;
            ESP_LOGI(TAG, "Retry %d/%d in %d ms", s_retry_count, WIFI_MAX_RETRY, delay_ms);
            /* Use esp_timer, not vTaskDelay — this handler runs on the default
             * event loop task (shared with IP_EVENT, TRANSPORT_EVENTS, etc.).
             * Blocking it for 30 s would stall all other event subscribers. */
            ensure_reconnect_timer();
            if (s_reconnect_timer && !s_reconnect_pending) {
                s_reconnect_pending = true;
                if (esp_timer_start_once(s_reconnect_timer, (uint64_t)delay_ms * 1000ULL) != ESP_OK) {
                    s_reconnect_pending = false;
                    /* Fallback: try immediately rather than stalling forever. */
                    esp_wifi_connect();
                }
            }
        } else {
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
            ESP_LOGE(TAG, "Connection failed after %d retries", WIFI_MAX_RETRY);
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected, IP: " IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_count = 0;
        s_connected = true;
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static void apply_sta_config(const char *ssid, const char *password) {
    wifi_config_t wifi_config = {0};
    /* esp_wifi uses fixed-size byte arrays — truncate to avoid overwriting
     * struct fields (e.g. trailing whitespace from copy-paste). */
    strncpy((char *)wifi_config.sta.ssid, ssid ? ssid : "", sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, password ? password : "", sizeof(wifi_config.sta.password) - 1);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
}

esp_err_t wifi_init_sta(const char *ssid, const char *password) {
    if (s_initialized) {
        ESP_LOGW(TAG, "wifi_init_sta called twice — use wifi_reconnect instead");
        return wifi_reconnect(ssid, password);
    }

    /* NVS (may already be initialized by main) */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    if (ret != ESP_OK && ret != ESP_ERR_NVS_NO_FREE_PAGES) {
        ESP_ERROR_CHECK(ret);
    }

    s_wifi_event_group = xEventGroupCreate();

    /* May already be initialized by main — ignore INVALID_STATE. */
    ret = esp_netif_init();
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE)
        ESP_ERROR_CHECK(ret);
    ret = esp_event_loop_create_default();
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE)
        ESP_ERROR_CHECK(ret);
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL, NULL));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    apply_sta_config(ssid, password);
    ESP_ERROR_CHECK(esp_wifi_start());

    s_initialized = true;
    char mbuf[24];
    ESP_LOGI(TAG, "Connecting to '%s'...", mask_cred(ssid, mbuf, sizeof(mbuf)));

    /* 60 s timeout covers slow auth + DHCP and guards against captive portals
     * that return GOT_IP but drop real traffic. Caller falls through to ConfigScreen. */
    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(60 * 1000));

    if (bits & WIFI_CONNECTED_BIT)
        return ESP_OK;
    if (!(bits & WIFI_FAIL_BIT)) {
        ESP_LOGW(TAG, "wifi_init_sta: 60s timeout — neither CONNECTED nor FAIL bit set");
    }
    return ESP_FAIL;
}

esp_err_t wifi_reconnect(const char *ssid, const char *password) {
    if (!s_initialized) {
        /* First-time call path. Block until connected / failed. */
        return wifi_init_sta(ssid, password);
    }
    char mbuf[24];
    ESP_LOGI(TAG, "Reconnecting to '%s'...", mask_cred(ssid, mbuf, sizeof(mbuf)));

    /* Reset retry counter and cancel any pending timer before installing new
     * credentials — a stale timer would call esp_wifi_connect with old creds. */
    if (s_reconnect_timer && s_reconnect_pending) {
        esp_timer_stop(s_reconnect_timer);
        s_reconnect_pending = false;
    }
    s_retry_count = 0;
    s_connected = false;
    xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

    /* Disconnect triggers WIFI_EVENT_STA_DISCONNECTED → auto-reconnect
     * with the freshly-set config. */
    apply_sta_config(ssid, password);
    esp_err_t ret = esp_wifi_disconnect();
    if (ret == ESP_ERR_WIFI_NOT_STARTED) {
        ret = esp_wifi_start(); /* previous attempt never reached start */
    } else if (ret == ESP_OK) {
        /* Some IDF versions don't auto-reconnect after explicit disconnect. */
        esp_wifi_connect();
    }
    return ret;
}

bool wifi_is_connected(void) {
    return s_connected;
}
