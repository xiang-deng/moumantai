#pragma once

#include <stdbool.h>
#include "esp_err.h"

#define WIFI_MAX_RETRY 5

/**
 * Initialize WiFi STA and connect. Blocks until connected or max retries
 * exhausted. Call only once per boot; use wifi_reconnect() thereafter.
 *
 * @return ESP_OK on connection, ESP_FAIL on failure.
 */
esp_err_t wifi_init_sta(const char *ssid, const char *password);

/**
 * Re-associate with new credentials. Non-blocking — observe connection
 * state via IP_EVENT_STA_GOT_IP. Safe after wifi_init_sta() succeeds or fails.
 */
esp_err_t wifi_reconnect(const char *ssid, const char *password);

/** True when associated with an AP and holding an IP address. */
bool wifi_is_connected(void);
