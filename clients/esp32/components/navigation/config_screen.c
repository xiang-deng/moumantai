/*
 * ConfigScreen — tile (0, 0) of the app pager.
 *
 * Editable fields: Server URI, WiFi SSID, WiFi Password. Values are
 * persisted to NVS via config_store. "Save & Reconnect" tears down the
 * current transport, reconnects WiFi with the new credentials, then
 * reconnects the WebSocket once IP_EVENT_STA_GOT_IP fires.
 * Status row mirrors transport state via STATE_EVT_CONN_CHANGED.
 */

#include "config_screen.h"
#include "style_helpers.h"
#include "icon_map.h"
#include "state.h"
#include "transport.h"
#include "config_store.h"
#include "wifi.h"
#include "chat.h"

#include <string.h>
#include <stdio.h>
#include <ctype.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "esp_netif.h"
#include "esp_wifi.h"

static const char *TAG = "config_scr";

typedef struct {
    lv_obj_t *ssid_ta;
    lv_obj_t *pwd_ta;
    lv_obj_t *pwd_toggle_label; /* "Show" / "Hide" label inside the toggle btn */
    lv_obj_t *uri_ta;
    lv_obj_t *keyboard;
    lv_obj_t *state_label;
    lv_obj_t *state_dot;
    lv_obj_t *session_label;
    lv_obj_t *pairing_label;
    lv_obj_t *save_btn;
} config_screen_t;

static config_screen_t s_cs = {0};

/* Set on PAIRING_REQUIRED (close 4008); cleared on session-active. */
static bool s_pairing = false;

/* Last 4 chars of deviceId, uppercased — mirrors server's deviceCode(). */
static void pairing_code(char *out, size_t out_len) {
    if (out_len == 0)
        return;
    char did[CFG_MAX_DEVICE_ID] = {0};
    config_store_get_device_id(did, sizeof(did));
    size_t n = strlen(did);
    const char *last4 = (n >= 4) ? (did + n - 4) : did;
    size_t i = 0;
    for (; last4[i] != '\0' && i < out_len - 1; i++) {
        out[i] = (char)toupper((unsigned char)last4[i]);
    }
    out[i] = '\0';
}

/* URI cached here so the one-shot IP handler (fired after wifi_reconnect)
 * can start the transport even after the button-callback stack unwinds. */
static char s_pending_uri[CFG_MAX_URI] = {0};
static esp_event_handler_instance_t s_got_ip_handler = NULL;

/* --------------------------------------------------------------------------
 * Connection-state display
 * ----------------------------------------------------------------------- */

static const char *conn_state_text(connection_state_t c) {
    switch (c) {
    case CONN_DISCONNECTED:
        return "Disconnected";
    case CONN_CONNECTING:
        return "Connecting\xe2\x80\xa6";
    case CONN_CONNECTED:
    case CONN_HELLO_SENT:
        return "Handshaking\xe2\x80\xa6";
    case CONN_SESSION_ACTIVE:
        return "Connected";
    default:
        return "Unknown";
    }
}

static lv_color_t conn_state_color(connection_state_t c) {
    switch (c) {
    case CONN_SESSION_ACTIVE:
        return lv_color_hex(0x2E7D32); /* green 800 */
    case CONN_CONNECTING:
    case CONN_CONNECTED:
    case CONN_HELLO_SENT:
        return lv_color_hex(0xF9A825); /* amber 800 */
    case CONN_DISCONNECTED:
    default:
        return THEME_ERROR;
    }
}

static void refresh_state(void) {
    if (!s_cs.state_label)
        return;
    const client_state_t *st = state_get();
    connection_state_t c = st ? st->conn_state : CONN_DISCONNECTED;

    lv_label_set_text(s_cs.state_label, conn_state_text(c));
    lv_obj_set_style_bg_color(s_cs.state_dot, conn_state_color(c), 0);

    if (c == CONN_SESSION_ACTIVE)
        s_pairing = false;

    if (s_cs.session_label) {
        if (c == CONN_SESSION_ACTIVE && st && st->session_id[0]) {
            char buf[80];
            snprintf(buf, sizeof(buf), "Session: %s", st->session_id);
            lv_label_set_text(s_cs.session_label, buf);
            lv_obj_remove_flag(s_cs.session_label, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_cs.session_label, LV_OBJ_FLAG_HIDDEN);
        }
    }

    /* Pairing: device not yet approved — show code and approve command. */
    if (s_cs.pairing_label) {
        if (s_pairing) {
            char code[CFG_MAX_DEVICE_ID];
            pairing_code(code, sizeof(code));
            /* Sized for two full device-id codes + static text (-Wformat-truncation). */
            char buf[160];
            snprintf(buf, sizeof(buf),
                     "Pairing required \xe2\x80\x94 code %s\nrun: task server:cli -- device approve %s", code, code);
            lv_label_set_text(s_cs.pairing_label, buf);
            lv_obj_remove_flag(s_cs.pairing_label, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_cs.pairing_label, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

static void refresh_state_async(void *user_data) {
    (void)user_data;
    /* Hold the port lock: esp_lvgl_port runs LVGL on its own task. */
    if (lvgl_port_lock(500)) {
        refresh_state();
        lvgl_port_unlock();
    }
}

static void on_conn_changed(void *arg, esp_event_base_t base, int32_t id, void *data) {
    /* Runs on the esp_event task — defer LVGL work to avoid a race with
     * the LVGL task mid-render. */
    lv_async_call(refresh_state_async, NULL);
}

static void on_pairing_required(void *arg, esp_event_base_t base, int32_t id, void *data) {
    /* Server rejected this device (close 4008) — show the pairing code. */
    s_pairing = true;
    lv_async_call(refresh_state_async, NULL);
}

/* --------------------------------------------------------------------------
 * Save & Reconnect
 * ----------------------------------------------------------------------- */

static void on_got_ip_after_save(void *arg, esp_event_base_t base, int32_t id, void *data) {
    ESP_LOGI(TAG, "WiFi up after save — connecting transport");
    ESP_LOGD(TAG, "  server_uri=%s", s_pending_uri);
    transport_connect(s_pending_uri);
    /* One-shot: unregister to avoid re-entering on future IP events. */
    if (s_got_ip_handler) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_got_ip_handler);
        s_got_ip_handler = NULL;
    }
}

/* Data passed to the worker task; it frees this on exit. */
typedef struct {
    char ssid[CFG_MAX_SSID];
    char password[CFG_MAX_PASSWORD];
    char uri[CFG_MAX_URI];
} save_job_t;

static void save_worker(void *arg) {
    save_job_t *job = arg;
    /* Log at INFO without the literal SSID/URI to avoid leaking network names
     * in serial captures. Re-enable LOGD for debug builds. */
    ESP_LOGI(TAG, "Save worker: persisting new WiFi + server config");
    ESP_LOGD(TAG, "  ssid='%s' uri='%s'", job->ssid, job->uri);

    config_store_set_ssid(job->ssid);
    config_store_set_password(job->password);
    config_store_set_server_uri(job->uri);

    strncpy(s_pending_uri, job->uri, sizeof(s_pending_uri) - 1);
    s_pending_uri[sizeof(s_pending_uri) - 1] = '\0';

    /* transport_disconnect can block seconds (TCP/WS teardown) — must run
     * off the LVGL task to avoid UI freeze. */
    transport_disconnect();

    /* Arm one-shot IP handler (replace previous if any). */
    if (s_got_ip_handler) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_got_ip_handler);
        s_got_ip_handler = NULL;
    }
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_got_ip_after_save, NULL, &s_got_ip_handler);

    esp_err_t rret = wifi_reconnect(job->ssid, job->password);
    if (rret != ESP_OK) {
        ESP_LOGE(TAG, "wifi_reconnect failed: %s", esp_err_to_name(rret));
    }

    free(job);
    vTaskDelete(NULL);
}

static void on_save_clicked(lv_event_t *e) {
    (void)e;

    save_job_t *job = calloc(1, sizeof(*job));
    if (!job) {
        ESP_LOGE(TAG, "Save: OOM");
        return;
    }

    /* Snapshot field values here (LVGL task) — worker can't touch widgets. */
    const char *ssid = lv_textarea_get_text(s_cs.ssid_ta);
    const char *pwd = lv_textarea_get_text(s_cs.pwd_ta);
    const char *uri = lv_textarea_get_text(s_cs.uri_ta);
    strncpy(job->ssid, ssid ? ssid : "", sizeof(job->ssid) - 1);
    strncpy(job->password, pwd ? pwd : "", sizeof(job->password) - 1);
    strncpy(job->uri, uri ? uri : "", sizeof(job->uri) - 1);

    /* Defocus to dismiss the on-screen keyboard. */
    if (lv_obj_has_state(s_cs.uri_ta, LV_STATE_FOCUSED))
        lv_obj_clear_state(s_cs.uri_ta, LV_STATE_FOCUSED);
    if (s_cs.keyboard)
        lv_obj_add_flag(s_cs.keyboard, LV_OBJ_FLAG_HIDDEN);
    chat_fab_set_visible(true);

    /* 8 KB covers NVS writes + websocket teardown. */
    BaseType_t ok = xTaskCreate(save_worker, "cfg_save", 8192, job, 5, NULL);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "Save: xTaskCreate failed");
        free(job);
    }
}

/* --------------------------------------------------------------------------
 * Keyboard wiring
 * ----------------------------------------------------------------------- */

static void on_ta_focused(lv_event_t *e) {
    lv_obj_t *ta = lv_event_get_target(e);
    if (!s_cs.keyboard)
        return;
    lv_keyboard_set_textarea(s_cs.keyboard, ta);
    lv_obj_remove_flag(s_cs.keyboard, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_cs.keyboard);
    /* Hide the chat FAB so it doesn't occlude keyboard bottom-right keys. */
    chat_fab_set_visible(false);

    /* Scroll only if the field would be occluded by the keyboard (bottom
     * 200 px). Avoids jitter when tapping between fields that are already
     * visible. visible_bottom = scroll_y + tile_h − kb_h. */
    lv_obj_t *tile = lv_obj_get_parent(ta);
    if (!tile)
        return;
    int32_t ta_y = lv_obj_get_y(ta);
    int32_t ta_h = lv_obj_get_height(ta);
    int32_t scroll_y = lv_obj_get_scroll_y(tile);
    int32_t tile_h = lv_obj_get_height(tile);
    int32_t kb_h = lv_obj_get_height(s_cs.keyboard);
    int32_t visible_bottom = scroll_y + tile_h - kb_h;
    if (ta_y + ta_h > visible_bottom) {
        lv_obj_scroll_to_y(tile, ta_y > 12 ? ta_y - 12 : 0, LV_ANIM_ON);
    }
}

static void on_ta_defocused(lv_event_t *e) {
    (void)e;
    if (!s_cs.keyboard)
        return;
    lv_obj_add_flag(s_cs.keyboard, LV_OBJ_FLAG_HIDDEN);
    chat_fab_set_visible(true);
}

static void on_kb_event(lv_event_t *e) {
    lv_event_code_t code = lv_event_get_code(e);
    /* Hide keyboard on OK / Cancel. The default LVGL handler clears the
     * textarea focus; we mirror with an explicit hide. */
    if (code == LV_EVENT_READY || code == LV_EVENT_CANCEL) {
        if (s_cs.keyboard)
            lv_obj_add_flag(s_cs.keyboard, LV_OBJ_FLAG_HIDDEN); /* OK / Cancel hides keyboard */
        chat_fab_set_visible(true);
    }
}

/* --------------------------------------------------------------------------
 * Section builder: label + textarea (matches the design hierarchy)
 * ----------------------------------------------------------------------- */

static void on_pwd_toggle_clicked(lv_event_t *e) {
    (void)e;
    if (!s_cs.pwd_ta)
        return;
    bool was_masked = lv_textarea_get_password_mode(s_cs.pwd_ta);
    lv_textarea_set_password_mode(s_cs.pwd_ta, !was_masked);
    if (s_cs.pwd_toggle_label) {
        lv_label_set_text(s_cs.pwd_toggle_label, was_masked ? "Hide" : "Show");
    }
}

/* Password field row: [textarea | Show toggle]. Show button flips password_mode. */
static lv_obj_t *make_password_field(lv_obj_t *parent, const char *caption, const char *initial) {
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, caption);
    lv_obj_set_style_text_font(label, resolve_font("labelMedium"), 0);
    lv_obj_set_style_text_color(label, THEME_ON_SURFACE_VARIANT, 0);
    apply_text_style(label, "labelMedium");

    lv_obj_t *row = lv_obj_create(parent);
    reset_container_paint(row);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(row, 8, 0);
    lv_obj_remove_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *ta = lv_textarea_create(row);
    apply_textfield_style(ta, "bodyMedium");
    lv_textarea_set_password_mode(ta, true);
    lv_obj_set_flex_grow(ta, 1);
    if (initial && initial[0])
        lv_textarea_set_text(ta, initial);
    lv_obj_add_event_cb(ta, on_ta_focused, LV_EVENT_FOCUSED, NULL);
    lv_obj_add_event_cb(ta, on_ta_defocused, LV_EVENT_DEFOCUSED, NULL);

    lv_obj_t *toggle_btn = lv_button_create(row);
    lv_obj_set_size(toggle_btn, 60, 40);
    lv_obj_set_style_bg_opa(toggle_btn, LV_OPA_TRANSP, 0);
    lv_obj_set_style_shadow_width(toggle_btn, 0, 0);
    lv_obj_set_style_border_color(toggle_btn, THEME_OUTLINE, 0);
    lv_obj_set_style_border_width(toggle_btn, 1, 0);
    lv_obj_set_style_radius(toggle_btn, 8, 0);
    lv_obj_set_style_pad_hor(toggle_btn, 8, 0);
    lv_obj_t *t_label = lv_label_create(toggle_btn);
    lv_label_set_text(t_label, "Show");
    lv_obj_set_style_text_color(t_label, THEME_PRIMARY, 0);
    apply_text_style(t_label, "labelMedium");
    lv_obj_center(t_label);
    s_cs.pwd_toggle_label = t_label;
    lv_obj_add_event_cb(toggle_btn, on_pwd_toggle_clicked, LV_EVENT_CLICKED, NULL);

    return ta;
}

static lv_obj_t *make_field(lv_obj_t *parent, const char *caption, const char *initial, bool password_mode) {
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, caption);
    lv_obj_set_style_text_font(label, resolve_font("labelMedium"), 0);
    lv_obj_set_style_text_color(label, THEME_ON_SURFACE_VARIANT, 0);
    apply_text_style(label, "labelMedium");

    lv_obj_t *ta = lv_textarea_create(parent);
    apply_textfield_style(ta, "bodyMedium");
    lv_textarea_set_password_mode(ta, password_mode);
    if (initial && initial[0])
        lv_textarea_set_text(ta, initial);

    lv_obj_add_event_cb(ta, on_ta_focused, LV_EVENT_FOCUSED, NULL);
    lv_obj_add_event_cb(ta, on_ta_defocused, LV_EVENT_DEFOCUSED, NULL);
    return ta;
}

/* --------------------------------------------------------------------------
 * Build
 * ----------------------------------------------------------------------- */

void config_screen_build(lv_obj_t *tile) {
    /* Scrollable column so the keyboard can occlude the lower half without
     * hiding the focused field. */
    lv_obj_set_flex_flow(tile, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(tile, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START);
    lv_obj_set_style_pad_hor(tile, 16, 0);
    lv_obj_set_style_pad_ver(tile, 18, 0);
    lv_obj_set_style_pad_gap(tile, 10, 0);
    lv_obj_set_style_bg_opa(tile, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(tile, 0, 0);
    lv_obj_add_flag(tile, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scrollbar_mode(tile, LV_SCROLLBAR_MODE_AUTO);

    /* Title */
    lv_obj_t *title = lv_label_create(tile);
    lv_label_set_text(title, "Moumantai");
    lv_obj_set_style_text_font(title, resolve_font("displayMedium"), 0);
    lv_obj_set_style_text_color(title, THEME_ON_SURFACE, 0);
    apply_text_style(title, "displayMedium");

    lv_obj_t *subtitle = lv_label_create(tile);
    lv_label_set_text(subtitle, "Swipe right to start \xe2\x86\x92");
    lv_obj_set_style_text_font(subtitle, resolve_font("bodyMedium"), 0);
    lv_obj_set_style_text_color(subtitle, THEME_ON_SURFACE_VARIANT, 0);
    apply_text_style(subtitle, "bodyMedium");

    /* Load current settings from NVS. */
    char ssid[CFG_MAX_SSID];
    char password[CFG_MAX_PASSWORD];
    char uri[CFG_MAX_URI];
    config_store_get_ssid(ssid, sizeof(ssid));
    config_store_get_password(password, sizeof(password));
    config_store_get_server_uri(uri, sizeof(uri));

    /* Editable fields */
    s_cs.uri_ta = make_field(tile, "Server URI", uri, false);
    s_cs.ssid_ta = make_field(tile, "WiFi SSID", ssid, false);
    s_cs.pwd_ta = make_password_field(tile, "WiFi Password", password);

    /* Status row */
    lv_obj_t *status_label = lv_label_create(tile);
    lv_label_set_text(status_label, "Status");
    lv_obj_set_style_text_font(status_label, resolve_font("labelMedium"), 0);
    lv_obj_set_style_text_color(status_label, THEME_ON_SURFACE_VARIANT, 0);
    apply_text_style(status_label, "labelMedium");

    lv_obj_t *row = lv_obj_create(tile);
    reset_container_paint(row);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(row, 10, 0);
    lv_obj_remove_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    s_cs.state_dot = lv_obj_create(row);
    reset_container_paint(s_cs.state_dot);
    lv_obj_set_size(s_cs.state_dot, 12, 12);
    lv_obj_set_style_radius(s_cs.state_dot, 6, 0);
    lv_obj_set_style_bg_opa(s_cs.state_dot, LV_OPA_COVER, 0);
    lv_obj_remove_flag(s_cs.state_dot, LV_OBJ_FLAG_SCROLLABLE);

    s_cs.state_label = lv_label_create(row);
    lv_obj_set_style_text_font(s_cs.state_label, resolve_font("titleSmall"), 0);
    lv_obj_set_style_text_color(s_cs.state_label, THEME_ON_SURFACE, 0);
    apply_text_style(s_cs.state_label, "titleSmall");

    s_cs.session_label = lv_label_create(tile);
    lv_obj_set_style_text_font(s_cs.session_label, resolve_font("labelMedium"), 0);
    lv_obj_set_style_text_color(s_cs.session_label, THEME_ON_SURFACE_VARIANT, 0);
    apply_text_style(s_cs.session_label, "labelMedium");
    lv_label_set_long_mode(s_cs.session_label, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_cs.session_label, LV_PCT(100));

    /* Pairing label — hidden until server rejects with close 4008. */
    s_cs.pairing_label = lv_label_create(tile);
    lv_obj_set_style_text_font(s_cs.pairing_label, resolve_font("labelMedium"), 0);
    lv_obj_set_style_text_color(s_cs.pairing_label, lv_color_hex(0xF9A825), 0); /* amber 800 */
    apply_text_style(s_cs.pairing_label, "labelMedium");
    lv_label_set_long_mode(s_cs.pairing_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_cs.pairing_label, LV_PCT(100));
    lv_obj_add_flag(s_cs.pairing_label, LV_OBJ_FLAG_HIDDEN);

    /* Save & Reconnect button — filled primary, full-width */
    s_cs.save_btn = lv_button_create(tile);
    lv_obj_set_width(s_cs.save_btn, LV_PCT(100));
    lv_obj_set_style_min_height(s_cs.save_btn, 44, 0);
    lv_obj_set_style_bg_color(s_cs.save_btn, THEME_PRIMARY, 0);
    lv_obj_set_style_radius(s_cs.save_btn, 22, 0);
    lv_obj_set_style_pad_hor(s_cs.save_btn, 14, 0);
    lv_obj_set_flex_flow(s_cs.save_btn, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(s_cs.save_btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(s_cs.save_btn, 8, 0);
    icon_label_create(s_cs.save_btn, "save", 20, THEME_ON_PRIMARY);
    lv_obj_t *btn_lbl = lv_label_create(s_cs.save_btn);
    lv_label_set_text(btn_lbl, "Save & Reconnect");
    lv_obj_set_style_text_color(btn_lbl, THEME_ON_PRIMARY, 0);
    lv_obj_set_style_text_font(btn_lbl, resolve_font("labelLarge"), 0);
    apply_text_style(btn_lbl, "labelLarge");
    lv_obj_add_event_cb(s_cs.save_btn, on_save_clicked, LV_EVENT_CLICKED, NULL);

    /* Keyboard overlay. LV_OBJ_FLAG_FLOATING keeps it out of the flex-column
     * layout and pins it to the tile bottom; hidden until a textarea is focused. */
    s_cs.keyboard = lv_keyboard_create(tile);
    lv_obj_add_flag(s_cs.keyboard, LV_OBJ_FLAG_FLOATING);
    lv_obj_set_size(s_cs.keyboard, LV_PCT(100), 200);
    lv_obj_align(s_cs.keyboard, LV_ALIGN_BOTTOM_MID, 0, 0);
    apply_unified_font(s_cs.keyboard, "bodyMedium");
    apply_material_keyboard_map(s_cs.keyboard);
    lv_obj_add_flag(s_cs.keyboard, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(s_cs.keyboard, on_kb_event, LV_EVENT_READY, NULL);
    lv_obj_add_event_cb(s_cs.keyboard, on_kb_event, LV_EVENT_CANCEL, NULL);

    refresh_state();

    /* Register exactly once — rebuild_tiles() calls config_screen_build on
     * every apps_changed; without the guard we'd register N duplicate handlers. */
    static bool handler_registered = false;
    if (!handler_registered) {
        esp_event_handler_register(STATE_EVENTS, STATE_EVT_CONN_CHANGED, on_conn_changed, NULL);
        esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_PAIRING_REQUIRED, on_pairing_required, NULL);
        handler_registered = true;
    }
}
