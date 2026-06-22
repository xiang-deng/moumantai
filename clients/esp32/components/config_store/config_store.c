#include "config_store.h"

#include <stdio.h>
#include <string.h>
#include "nvs.h"
#include "nvs_flash.h"
#include "esp_log.h"
#include "esp_random.h"

static const char *TAG = "config_store";
static const char *NS = "moumantai_cfg";

static nvs_handle_t s_handle = 0;
static bool s_ready = false;

esp_err_t config_store_init(void) {
    esp_err_t ret = nvs_open(NS, NVS_READWRITE, &s_handle);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "nvs_open failed: %s", esp_err_to_name(ret));
        s_ready = false;
        return ret;
    }
    s_ready = true;
    ESP_LOGI(TAG, "NVS namespace '%s' ready", NS);
    return ESP_OK;
}

/* Copy `src` into `out[out_len]`, NUL-terminating. */
static void copy_str(char *out, size_t out_len, const char *src) {
    if (!out || out_len == 0)
        return;
    if (!src) {
        out[0] = '\0';
        return;
    }
    size_t n = strlen(src);
    if (n >= out_len)
        n = out_len - 1;
    memcpy(out, src, n);
    out[n] = '\0';
}

/* Fetch a string from NVS. Falls back to default_val if absent/empty/unready.
 * Always populates the caller's buffer. */
static void get_string(const char *key, char *out, size_t out_len, const char *default_val) {
    if (!s_ready) {
        copy_str(out, out_len, default_val);
        return;
    }

    size_t required = 0;
    esp_err_t ret = nvs_get_str(s_handle, key, NULL, &required);
    if (ret != ESP_OK || required == 0 || required > out_len) {
        copy_str(out, out_len, default_val);
        return;
    }
    ret = nvs_get_str(s_handle, key, out, &required);
    if (ret != ESP_OK || out[0] == '\0') {
        copy_str(out, out_len, default_val);
    }
}

static esp_err_t set_string(const char *key, const char *val) {
    if (!s_ready)
        return ESP_ERR_INVALID_STATE;
    esp_err_t ret;
    if (!val || val[0] == '\0') {
        /* Empty string → erase the key so next read returns the default. */
        ret = nvs_erase_key(s_handle, key);
        if (ret == ESP_ERR_NVS_NOT_FOUND)
            ret = ESP_OK;
    } else {
        ret = nvs_set_str(s_handle, key, val);
    }
    if (ret != ESP_OK)
        return ret;
    return nvs_commit(s_handle);
}

/* Credentials live in NVS only — never compiled in. Empty on first boot. */
void config_store_get_ssid(char *out, size_t out_len) {
    get_string("ssid", out, out_len, "");
}

void config_store_get_password(char *out, size_t out_len) {
    get_string("password", out, out_len, "");
}

void config_store_get_server_uri(char *out, size_t out_len) {
    get_string("server_uri", out, out_len, "");
}

esp_err_t config_store_set_ssid(const char *v) {
    return set_string("ssid", v);
}
esp_err_t config_store_set_password(const char *v) {
    return set_string("password", v);
}
esp_err_t config_store_set_server_uri(const char *v) {
    return set_string("server_uri", v);
}

/* Write a UUIDv4 string (8-4-4-4-12) into `out` using 16 random bytes. */
static void format_uuid_v4(char *out) {
    uint8_t b[16];
    esp_fill_random(b, sizeof(b));
    /* RFC 4122 v4: high nibble of byte 6 = 0100, byte 8 = 10xx. */
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    snprintf(out, CFG_MAX_DEVICE_ID, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1],
             b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
}

/* In-process cache — avoids NVS reads on every ClientHello (every reconnect).
 * Populated on first call; NVS is the durable store across reboots. */
static char s_device_id_cache[CFG_MAX_DEVICE_ID] = {0};

void config_store_get_device_id(char *out, size_t out_len) {
    if (!out || out_len == 0)
        return;
    if (out_len < CFG_MAX_DEVICE_ID) {
        /* Buffer too small — NUL-terminate rather than leave it garbage. */
        out[0] = '\0';
        return;
    }
    /* Return cached value if available. */
    if (s_device_id_cache[0] != '\0') {
        strncpy(out, s_device_id_cache, out_len - 1);
        out[out_len - 1] = '\0';
        return;
    }
    if (s_ready) { /* try NVS */
        size_t required = 0;
        if (nvs_get_str(s_handle, "device_id", NULL, &required) == ESP_OK && required > 0 && required <= out_len) {
            esp_err_t r = nvs_get_str(s_handle, "device_id", out, &required);
            if (r == ESP_OK && out[0] != '\0') {
                strncpy(s_device_id_cache, out, sizeof(s_device_id_cache) - 1);
                s_device_id_cache[sizeof(s_device_id_cache) - 1] = '\0';
                return;
            }
        }
    }
    /* Generate a new UUID. Persist best-effort — even if NVS is unwritable
     * the in-process cache keeps the value stable within this boot. */
    format_uuid_v4(out);
    strncpy(s_device_id_cache, out, sizeof(s_device_id_cache) - 1);
    s_device_id_cache[sizeof(s_device_id_cache) - 1] = '\0';
    if (s_ready) {
        if (nvs_set_str(s_handle, "device_id", out) == ESP_OK) {
            nvs_commit(s_handle);
        } else {
            ESP_LOGW(TAG, "device_id persist failed; will regenerate next boot");
        }
    }
}
