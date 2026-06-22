#pragma once

#include "esp_err.h"
#include <stddef.h>

/*
 * NVS-backed runtime configuration (namespace "moumantai_cfg").
 *
 * Stores WiFi SSID/password and server URI set via the ConfigScreen.
 * Factory-fresh binaries have empty credentials and boot into ConfigScreen —
 * no credentials are baked into shared .bin files.
 */

/* WiFi spec: SSID 32 bytes max, PSK 63 bytes max (+ NUL each). */
#define CFG_MAX_SSID 33
#define CFG_MAX_PASSWORD 65
#define CFG_MAX_URI 128
/** UUIDv4 hex with dashes (8-4-4-4-12) is 36 chars + NUL. */
#define CFG_MAX_DEVICE_ID 37

/** Open the NVS namespace. Call once, after nvs_flash_init(). */
esp_err_t config_store_init(void);

/** Read the stored value into `out` (size `out_len`). When nothing is
 *  persisted, writes an empty string. Guaranteed NUL-terminated. */
void config_store_get_ssid(char *out, size_t out_len);
void config_store_get_password(char *out, size_t out_len);
void config_store_get_server_uri(char *out, size_t out_len);

/** Persist a value. Empty string clears the key. Commits immediately. */
esp_err_t config_store_set_ssid(const char *val);
esp_err_t config_store_set_password(const char *val);
esp_err_t config_store_set_server_uri(const char *val);

/**
 * Stable per-device UUIDv4. Generated via esp_random() on first call,
 * persisted to NVS, and cached in-process thereafter. Sent in every
 * ClientHello so the server can attribute messages per device.
 * `out` must be at least CFG_MAX_DEVICE_ID bytes; always NUL-terminated.
 */
void config_store_get_device_id(char *out, size_t out_len);
