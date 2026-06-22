/*
 * transport.c — ESP32 WebSocket transport on the binary protobuf wire.
 *
 * Subprotocol `moumantai.v1.proto`; outbound frames produced by `proto_encode.c`;
 * inbound frames dispatched by `proto_decode.c`.
 */

#include "transport.h"
#include "binary_frame.h"
#include "proto_encode.h"
#include "proto_decode.h"
#include "config_store.h"

#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "esp_websocket_client.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_random.h"

static const char *TAG = "transport";

ESP_EVENT_DEFINE_BASE(TRANSPORT_EVENTS);

/* --------------------------------------------------------------------------
 * Hard limits
 * ----------------------------------------------------------------------- */

#define MOUMANTAI_MAX_PROTO_FRAME_BYTES (128 * 1024)
/* Internal-DMA-RAM headroom to preserve for WiFi/SPI/I2S. The reassembly
 * buffer lives in PSRAM, but decode helpers may still hit the internal pool,
 * so gate on MALLOC_CAP_INTERNAL, not total heap. */
#define MOUMANTAI_INTERNAL_RESERVE_BYTES (20 * 1024)
#define MOUMANTAI_REASSEMBLY_TIMEOUT_US (5 * 1000 * 1000)
#define MOUMANTAI_REASSEMBLY_MAX_BYTES (128 * 1024)

#define MOUMANTAI_RECONNECT_BASE_MS 1000
#define MOUMANTAI_RECONNECT_MAX_MS 30000
#define MOUMANTAI_RECONNECT_SHIFT_CAP 5

/* WS subprotocol — server flips into binary protobuf mode on this header. */
#define MOUMANTAI_WS_SUBPROTOCOL "moumantai.v1.proto"

/* --------------------------------------------------------------------------
 * Internal state
 * ----------------------------------------------------------------------- */

static esp_websocket_client_handle_t s_client = NULL;
static connection_state_t s_conn_state = CONN_DISCONNECTED;

/* deviceId loaded from NVS each hello; sessionId kept as a routing handle
 * for outbound frames — nothing else needs cred-locking. */
static char s_session_id[MOUMANTAI_MAX_ID_LEN] = {0};
static SemaphoreHandle_t s_cred_mutex = NULL;
static nav_intent_provider_fn s_nav_intent_provider = NULL;

#define CRED_LOCK()                                                                                                    \
    do {                                                                                                               \
        if (s_cred_mutex)                                                                                              \
            xSemaphoreTake(s_cred_mutex, portMAX_DELAY);                                                               \
    } while (0)
#define CRED_UNLOCK()                                                                                                  \
    do {                                                                                                               \
        if (s_cred_mutex)                                                                                              \
            xSemaphoreGive(s_cred_mutex);                                                                              \
    } while (0)

static int s_reconnect_attempt = 0;
static esp_timer_handle_t s_reconnect_timer = NULL;
static bool s_reconnect_pending = false;
static bool s_user_disconnected = false;
/* True between a PAIRING_REQUIRED close (4008) and the next successful hello —
 * drives a short fixed reconnect cadence so approval is picked up quickly. */
static bool s_pairing_pending = false;

/* WebSocket close code the server uses when a device isn't paired. Mirrors
 * CLOSE_CODE_PAIRING_REQUIRED in shared/protocol/proto/.../enums.proto. */
#define MOUMANTAI_CLOSE_PAIRING_REQUIRED 4008
/* Fixed reconnect cadence (ms) while waiting for pairing approval. */
#define MOUMANTAI_PAIRING_RETRY_MS 3000

static char s_last_scope[MOUMANTAI_MAX_ID_LEN] = {0};

/* --------------------------------------------------------------------------
 * Async send queue — outbound frames go through here so LVGL / default-loop
 * tasks never block on `esp_websocket_client_send_bin`.
 * ----------------------------------------------------------------------- */

#define SEND_QUEUE_DEPTH 32

typedef struct {
    uint8_t *bytes;
    size_t len;
} send_msg_t;

static QueueHandle_t s_send_queue = NULL;
static TaskHandle_t s_send_task = NULL;
static volatile bool s_send_task_run = false;

/* Single-slot mailbox for the latest viewing message; worker drains before
 * the main queue so rapid swipes never strand the user on "Loading…". */
static portMUX_TYPE s_viewing_lock = portMUX_INITIALIZER_UNLOCKED;
static send_msg_t s_pending_viewing = {.bytes = NULL, .len = 0};

/* --------------------------------------------------------------------------
 * Reconnect helpers
 * ----------------------------------------------------------------------- */

uint32_t compute_reconnect_delay_ms(int attempt, uint32_t jitter_rand) {
    if (attempt < 0)
        attempt = 0;
    int shift = attempt > MOUMANTAI_RECONNECT_SHIFT_CAP ? MOUMANTAI_RECONNECT_SHIFT_CAP : attempt;
    uint32_t delay_ms = (uint32_t)MOUMANTAI_RECONNECT_BASE_MS << shift;
    if (delay_ms > MOUMANTAI_RECONNECT_MAX_MS)
        delay_ms = MOUMANTAI_RECONNECT_MAX_MS;
    uint32_t jitter = jitter_rand % (delay_ms / 2 + 1);
    return delay_ms + jitter;
}

static bool heap_reserve(size_t want) {
    /* Gate on internal RAM (not total free) — the reassembly buffer is PSRAM,
     * but WiFi/SPI/I2S starvation comes from internal RAM exhaustion. */
    size_t internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    if (internal_free < MOUMANTAI_INTERNAL_RESERVE_BYTES) {
        ESP_LOGW(TAG, "Heap guard: want=%u psram, internal_free=%u < reserve=%u — rejecting", (unsigned)want,
                 (unsigned)internal_free, (unsigned)MOUMANTAI_INTERNAL_RESERVE_BYTES);
        return false;
    }
    return true;
}

/* --------------------------------------------------------------------------
 * Offline queue (R5d) — RAM FIFO for chat text during disconnect.
 * ----------------------------------------------------------------------- */

#define OFFLINE_QUEUE_CAP 8
#define OFFLINE_QUEUE_MAX_TEXT 1024
#define OFFLINE_QUEUE_MAX_SESSION MOUMANTAI_MAX_ID_LEN
#define OFFLINE_QUEUE_MAX_MSGID 40

typedef struct {
    char scope[OFFLINE_QUEUE_MAX_SESSION];
    char text[OFFLINE_QUEUE_MAX_TEXT];
    char client_msg_id[OFFLINE_QUEUE_MAX_MSGID];
} offline_chat_entry_t;

static offline_chat_entry_t s_oq[OFFLINE_QUEUE_CAP];
static size_t s_oq_head = 0;
static size_t s_oq_count = 0;

static esp_err_t send_chat_input_wire(const char *scope, const char *text, const char *client_msg_id);

bool offline_queue_enqueue(const char *scope, const char *text, const char *client_msg_id) {
    if (!text || !client_msg_id)
        return false;
    size_t tlen = strlen(text);
    if (tlen >= OFFLINE_QUEUE_MAX_TEXT) {
        ESP_LOGW(TAG, "offline_queue: dropping text (%u bytes > cap)", (unsigned)tlen);
        return false;
    }
    if (strlen(client_msg_id) >= OFFLINE_QUEUE_MAX_MSGID)
        return false;
    if (scope && strlen(scope) >= OFFLINE_QUEUE_MAX_SESSION)
        return false;

    if (s_oq_count == OFFLINE_QUEUE_CAP) {
        s_oq_head = (s_oq_head + 1) % OFFLINE_QUEUE_CAP;
        s_oq_count--;
    }
    size_t slot = (s_oq_head + s_oq_count) % OFFLINE_QUEUE_CAP;
    offline_chat_entry_t *e = &s_oq[slot];
    e->scope[0] = '\0';
    if (scope) {
        strncpy(e->scope, scope, OFFLINE_QUEUE_MAX_SESSION - 1);
        e->scope[OFFLINE_QUEUE_MAX_SESSION - 1] = '\0';
    }
    strncpy(e->text, text, OFFLINE_QUEUE_MAX_TEXT - 1);
    e->text[OFFLINE_QUEUE_MAX_TEXT - 1] = '\0';
    strncpy(e->client_msg_id, client_msg_id, OFFLINE_QUEUE_MAX_MSGID - 1);
    e->client_msg_id[OFFLINE_QUEUE_MAX_MSGID - 1] = '\0';
    s_oq_count++;
    return true;
}

size_t offline_queue_size(void) {
    return s_oq_count;
}

bool offline_queue_peek(size_t idx, const char **out_scope, const char **out_text, const char **out_client_msg_id) {
    if (idx >= s_oq_count)
        return false;
    size_t slot = (s_oq_head + idx) % OFFLINE_QUEUE_CAP;
    if (out_scope)
        *out_scope = s_oq[slot].scope;
    if (out_text)
        *out_text = s_oq[slot].text;
    if (out_client_msg_id)
        *out_client_msg_id = s_oq[slot].client_msg_id;
    return true;
}

void offline_queue_clear(void) {
    s_oq_head = 0;
    s_oq_count = 0;
}

void offline_queue_flush_on_connect(void) {
    size_t drained = 0;
    while (s_oq_count > 0) {
        offline_chat_entry_t *e = &s_oq[s_oq_head];
        esp_err_t ret = send_chat_input_wire(e->scope, e->text, e->client_msg_id);
        if (ret != ESP_OK) {
            ESP_LOGW(TAG, "offline_queue: flush paused (err=%d), %u left", (int)ret, (unsigned)s_oq_count);
            break;
        }
        s_oq_head = (s_oq_head + 1) % OFFLINE_QUEUE_CAP;
        s_oq_count--;
        drained++;
    }
    if (drained > 0) {
        ESP_LOGI(TAG, "offline_queue: flushed %u entries", (unsigned)drained);
    }
}

/* --------------------------------------------------------------------------
 * Send helpers
 * ----------------------------------------------------------------------- */

/* Swap the pending-viewing slot out under the lock. Returns the captured msg
 * (which the caller now owns) and clears the slot. */
static send_msg_t take_pending_viewing(void) {
    send_msg_t out = {.bytes = NULL, .len = 0};
    portENTER_CRITICAL(&s_viewing_lock);
    out = s_pending_viewing;
    s_pending_viewing.bytes = NULL;
    s_pending_viewing.len = 0;
    portEXIT_CRITICAL(&s_viewing_lock);
    return out;
}

/* 500 ms × 6 attempts = ~3 s aggregate patience. A single 5 s blocking call
 * would park the worker on a TLS/TCP stall and freeze the viewing mailbox. */
#define SEND_BIN_TIMEOUT_TICKS pdMS_TO_TICKS(500)
#define SEND_BIN_MAX_ATTEMPTS 6

static int send_bin_with_retry(const uint8_t *bytes, size_t len, const char *what) {
    for (int attempt = 0; attempt < SEND_BIN_MAX_ATTEMPTS; attempt++) {
        if (!s_client || !esp_websocket_client_is_connected(s_client))
            return -1;
        int ret = esp_websocket_client_send_bin(s_client, (const char *)bytes, len, SEND_BIN_TIMEOUT_TICKS);
        if (ret >= 0)
            return ret;
        ESP_LOGW(TAG, "%s send attempt %d/%d failed (%u bytes); retrying", what, attempt + 1, SEND_BIN_MAX_ATTEMPTS,
                 (unsigned)len);
    }
    ESP_LOGE(TAG, "%s send dropped after %d attempts (%u bytes)", what, SEND_BIN_MAX_ATTEMPTS, (unsigned)len);
    return -1;
}

static void send_worker(void *arg) {
    (void)arg;
    while (s_send_task_run) {
        /* Drain the pending-viewing mailbox first (single-slot, latest-wins).
         * A rapid swipe burst leaves only the most recent intent here. */
        send_msg_t vmsg = take_pending_viewing();
        if (vmsg.bytes) {
            send_bin_with_retry(vmsg.bytes, vmsg.len, "viewing");
            heap_caps_free(vmsg.bytes);
            continue; /* re-check the mailbox before pulling from main queue */
        }

        send_msg_t msg = {0};
        /* 50 ms timeout: re-check the viewing mailbox even when the main
         * queue is idle (a viewing posted during the wait would otherwise
         * wait for the next regular message). */
        if (xQueueReceive(s_send_queue, &msg, pdMS_TO_TICKS(50)) != pdTRUE)
            continue;
        if (!msg.bytes)
            continue; /* shutdown / drain sentinel */
        send_bin_with_retry(msg.bytes, msg.len, "send_bin");
        heap_caps_free(msg.bytes);
    }
    s_send_task = NULL;
    vTaskDelete(NULL);
}

/* Drop all in-flight buffers on disconnect so they can't fire against the
 * new s_client (or a NULL client) after reconnect. */
static void send_queue_drain(void) {
    if (!s_send_queue)
        return;
    send_msg_t msg;
    while (xQueueReceive(s_send_queue, &msg, 0) == pdTRUE) {
        if (msg.bytes)
            heap_caps_free(msg.bytes);
    }
    /* Also drain the viewing mailbox — state.c re-emits viewing on reconnect,
     * so any stale pending here would double-send against the new client. */
    send_msg_t v = take_pending_viewing();
    if (v.bytes)
        heap_caps_free(v.bytes);
}

/* Enqueue a copy of `data` for the worker to send asynchronously. Returns
 * ESP_OK on enqueue (NOT on wire-confirmed delivery). On a full queue,
 * drops the message and returns ESP_FAIL. */
static esp_err_t send_proto_bytes(const uint8_t *data, size_t len) {
    if (!s_client || !esp_websocket_client_is_connected(s_client)) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_send_queue)
        return ESP_ERR_INVALID_STATE;

    uint8_t *copy = heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
    if (!copy)
        return ESP_ERR_NO_MEM;
    memcpy(copy, data, len);
    send_msg_t msg = {.bytes = copy, .len = len};
    if (xQueueSend(s_send_queue, &msg, 0) != pdTRUE) {
        ESP_LOGW(TAG, "send queue full — dropping (%u bytes)", (unsigned)len);
        heap_caps_free(copy);
        return ESP_FAIL;
    }
    return ESP_OK;
}

/* Variant that takes ownership of an already-heap-allocated buffer. Used
 * by the audio path which builds its frame via binary_frame_encode_audio
 * (one alloc) — no need to copy a second time. */
static esp_err_t send_proto_bytes_owned(uint8_t *data, size_t len) {
    if (!data)
        return ESP_ERR_INVALID_ARG;
    if (!s_client || !esp_websocket_client_is_connected(s_client) || !s_send_queue) {
        heap_caps_free(data);
        return ESP_ERR_INVALID_STATE;
    }
    send_msg_t msg = {.bytes = data, .len = len};
    if (xQueueSend(s_send_queue, &msg, 0) != pdTRUE) {
        ESP_LOGW(TAG, "send queue full — dropping (%u bytes)", (unsigned)len);
        heap_caps_free(data);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static void gen_client_msg_id(char *out, size_t cap) {
    uint32_t a = esp_random();
    uint32_t b = esp_random();
    snprintf(out, cap, "esp-%08lx%08lx", (unsigned long)a, (unsigned long)b);
}

static esp_err_t send_chat_input_wire(const char *scope, const char *text, const char *client_msg_id) {
    /* ChatInput max wire size is ~1.2 KB; 2 KB stack buffer is comfortable. */
    uint8_t buf[2048];
    size_t out_len = 0;
    esp_err_t err = proto_encode_chat_input(buf, sizeof(buf), &out_len, scope, text, client_msg_id);
    if (err != ESP_OK)
        return err;
    return send_proto_bytes(buf, out_len);
}

/* --------------------------------------------------------------------------
 * WebSocket event handler — text/binary inbound dispatch + reconnect.
 * ----------------------------------------------------------------------- */

static void schedule_reconnect(void);

static char *s_text_buf = NULL;
static int s_text_len = 0;
static int s_text_cap = 0;
static int64_t s_text_last_fragment_us = 0;
/** Op-code of the buffered multi-part frame; always 0x02 (binary only). */
static uint8_t s_text_op = 0;

static void text_accum_reset(void) {
    /* Pair with the heap_caps_malloc(MALLOC_CAP_SPIRAM) below — heap_caps_free
     * routes back to the right pool regardless of where the buffer landed. */
    if (s_text_buf)
        heap_caps_free(s_text_buf);
    s_text_buf = NULL;
    s_text_len = 0;
    s_text_cap = 0;
    s_text_last_fragment_us = 0;
    s_text_op = 0;
}

static void send_client_hello(void) {
    nav_intent_t intent = {0};
    if (s_nav_intent_provider)
        s_nav_intent_provider(&intent);

    const char *cur_app =
        (intent.current_app_id[0] && strcmp(intent.current_app_id, "home") != 0) ? intent.current_app_id : NULL;
    const char *cur_face = (cur_app && intent.current_face_id[0]) ? intent.current_face_id : NULL;

    char device_id_buf[CFG_MAX_DEVICE_ID];
    config_store_get_device_id(device_id_buf, sizeof(device_id_buf));

    uint8_t buf[1024];
    size_t out_len = 0;
    esp_err_t err =
        proto_encode_hello(buf, sizeof(buf), &out_len, cur_app, cur_face, device_id_buf[0] ? device_id_buf : NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "proto_encode_hello failed");
        return;
    }
    send_proto_bytes(buf, out_len);
}

static void reconnect_timer_cb(void *arg) {
    (void)arg;
    s_reconnect_pending = false;
    if (s_user_disconnected || !s_client)
        return;
    s_reconnect_attempt++;
    ESP_LOGI(TAG, "reconnect attempt #%d", s_reconnect_attempt);
    esp_err_t err = esp_websocket_client_start(s_client);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ws start failed: %d — rescheduling", err);
        schedule_reconnect();
    }
}

static void ensure_reconnect_timer(void) {
    if (s_reconnect_timer)
        return;
    const esp_timer_create_args_t args = {
        .callback = reconnect_timer_cb,
        .name = "transport_reconnect",
    };
    if (esp_timer_create(&args, &s_reconnect_timer) != ESP_OK) {
        s_reconnect_timer = NULL;
    }
}

static void schedule_reconnect(void) {
    if (s_user_disconnected || !s_client || s_reconnect_pending)
        return;
    ensure_reconnect_timer();
    if (!s_reconnect_timer)
        return;

    /* While waiting for pairing approval, poll on a short fixed interval so the
     * device connects promptly once approved (don't grow the backoff). */
    uint32_t delay_ms =
        s_pairing_pending ? MOUMANTAI_PAIRING_RETRY_MS : compute_reconnect_delay_ms(s_reconnect_attempt, esp_random());
    ESP_LOGI(TAG, "reconnect in %u ms (attempt=%d%s)", (unsigned)delay_ms, s_reconnect_attempt,
             s_pairing_pending ? ", pairing" : "");
    s_reconnect_pending = true;
    if (esp_timer_start_once(s_reconnect_timer, (uint64_t)delay_ms * 1000ULL) != ESP_OK) {
        s_reconnect_pending = false;
    }
}

static void dispatch_buffered(uint8_t op_code, const uint8_t *data, size_t len) {
    /* Binary channel only; leading byte 1/2 = typed media envelope
     * ([type][LE header_len][header proto][payload]); else raw ServerMessage. */
    if (op_code != 0x02 || len == 0)
        return;
    uint8_t first = data[0];
    if (first == BINARY_FRAME_AUDIO || first == BINARY_FRAME_IMAGE) {
        binary_frame_t frame;
        if (binary_frame_decode(data, len, &frame) != 0) {
            ESP_LOGW(TAG, "binary frame decode failed (%u bytes)", (unsigned)len);
            return;
        }
        if (frame.type == BINARY_FRAME_AUDIO) {
            /* frame.payload is a borrowed slice of the reassembly buffer;
             * its lifetime ends before esp_event_post's async delivery.
             * Hand off via a heap-owned struct with PCM co-allocated in
             * PSRAM (single alloc, single free at the consumer). */
            binary_frame_t *out = heap_caps_malloc(sizeof(*out) + frame.payload_len, MALLOC_CAP_SPIRAM);
            if (!out) {
                ESP_LOGW(TAG, "audio chunk OOM (%u bytes payload)", (unsigned)frame.payload_len);
                return;
            }
            *out = frame;
            uint8_t *pcm = (uint8_t *)(out + 1);
            if (frame.payload_len > 0)
                memcpy(pcm, frame.payload, frame.payload_len);
            out->payload = pcm;
            esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_AUDIO_CHUNK, &out, sizeof(out), 0);
        } else {
            ESP_LOGW(TAG, "ignoring binary frame type 0x%02x", frame.type);
        }
        return;
    }
    proto_decode_dispatch(data, len);
}

static void ws_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    esp_websocket_event_data_t *ws = (esp_websocket_event_data_t *)event_data;

    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED: {
        ESP_LOGI(TAG, "WS connected, sending ClientHello");
        s_conn_state = CONN_HELLO_SENT;
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_CONNECTED, NULL, 0, 0);

        send_client_hello();

        /* Re-assert viewing scope post-connect. */
        s_last_scope[0] = '\0';
        char scope_buf[MOUMANTAI_MAX_ID_LEN + 8];
        scope_buf[0] = '\0';
        if (s_nav_intent_provider) {
            nav_intent_t intent = {0};
            s_nav_intent_provider(&intent);
            if (intent.current_app_id[0] && strcmp(intent.current_app_id, "home") != 0) {
                snprintf(scope_buf, sizeof(scope_buf), "app:%s", intent.current_app_id);
            } else {
                snprintf(scope_buf, sizeof(scope_buf), "home");
            }
        } else {
            snprintf(scope_buf, sizeof(scope_buf), "home");
        }
        transport_send_viewing(scope_buf);
        break;
    }

    case WEBSOCKET_EVENT_DATA:
        if ((ws->op_code == 0x01 || ws->op_code == 0x02) && ws->data_len > 0) {
            if (s_text_buf && s_text_last_fragment_us > 0 &&
                esp_timer_get_time() - s_text_last_fragment_us > MOUMANTAI_REASSEMBLY_TIMEOUT_US) {
                ESP_LOGW(TAG, "Reassembly timeout; discarding %d bytes", s_text_len);
                text_accum_reset();
            }

            if (ws->payload_len == ws->data_len) {
                dispatch_buffered((uint8_t)ws->op_code, (const uint8_t *)ws->data_ptr, ws->data_len);
            } else {
                if (ws->payload_offset == 0) {
                    text_accum_reset();
                    if (ws->payload_len > MOUMANTAI_REASSEMBLY_MAX_BYTES) {
                        ESP_LOGW(TAG, "reassembly aborted (payload_len=%d)", ws->payload_len);
                        break;
                    }
                    size_t want = (size_t)ws->payload_len + 1;
                    if (!heap_reserve(want))
                        break;
                    /* Up to 128 KB per frame — explicitly place in PSRAM
                     * so a busy session doesn't punch through internal
                     * heap and starve WiFi/SPI/I2S DMA buffers. */
                    s_text_buf = heap_caps_malloc(want, MALLOC_CAP_SPIRAM);
                    if (!s_text_buf) {
                        ESP_LOGW(TAG, "reassembly malloc PSRAM failed (%u bytes)", (unsigned)want);
                        text_accum_reset();
                        break;
                    }
                    s_text_cap = (int)want;
                    s_text_len = 0;
                    s_text_op = (uint8_t)ws->op_code;
                }
                s_text_last_fragment_us = esp_timer_get_time();
                if (s_text_buf && (s_text_len + ws->data_len) > MOUMANTAI_REASSEMBLY_MAX_BYTES) {
                    ESP_LOGW(TAG, "reassembly aborted: payload exceeds max (%d + %d > %d)", s_text_len, ws->data_len,
                             MOUMANTAI_REASSEMBLY_MAX_BYTES);
                    text_accum_reset();
                    break;
                }
                if (s_text_buf && s_text_len + ws->data_len <= s_text_cap - 1) {
                    memcpy(s_text_buf + s_text_len, ws->data_ptr, ws->data_len);
                    s_text_len += ws->data_len;
                } else if (s_text_buf) {
                    /* Buffer would overflow — abort so the next message gets a fresh buffer. */
                    ESP_LOGW(TAG, "reassembly buffer overflow at offset=%d data_len=%d cap=%d", s_text_len,
                             ws->data_len, s_text_cap);
                    text_accum_reset();
                    break;
                }
                /* Strict equality: wire contract is offsets summing to payload_len exactly. */
                if (s_text_buf && ws->payload_offset + ws->data_len == ws->payload_len) {
                    dispatch_buffered(s_text_op, (const uint8_t *)s_text_buf, (size_t)s_text_len);
                    text_accum_reset();
                } else if (s_text_buf && ws->payload_offset + ws->data_len > ws->payload_len) {
                    ESP_LOGW(TAG, "fragment overshot payload_len (offset=%d data_len=%d payload_len=%d); discarding",
                             ws->payload_offset, ws->data_len, ws->payload_len);
                    text_accum_reset();
                }
            }
        }
        break;

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED: {
        /* Best-effort close-code read: op 0x08 carries a 2-byte BE status code.
         * If unavailable, pairing isn't detected — the config screen still shows
         * the device code so the operator can approve regardless. */
        int close_code = -1;
        if (event_id == WEBSOCKET_EVENT_CLOSED && ws && ws->op_code == 0x08 && ws->data_ptr && ws->data_len >= 2) {
            close_code = ((uint8_t)ws->data_ptr[0] << 8) | (uint8_t)ws->data_ptr[1];
        }
        ESP_LOGW(TAG, "WS %s (close_code=%d)", event_id == WEBSOCKET_EVENT_CLOSED ? "closed" : "disconnected",
                 close_code);
        s_conn_state = CONN_DISCONNECTED;
        s_last_scope[0] = '\0';
        text_accum_reset();
        s_pairing_pending = (close_code == MOUMANTAI_CLOSE_PAIRING_REQUIRED);
        if (s_pairing_pending) {
            esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_PAIRING_REQUIRED, NULL, 0, 0);
        }
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_DISCONNECTED, NULL, 0, 0);
        schedule_reconnect();
        break;
    }

    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "WS error");
        schedule_reconnect();
        break;

    default:
        break;
    }
}

/* --------------------------------------------------------------------------
 * Internal post-processors
 * ----------------------------------------------------------------------- */

static void on_hello_ok_internal(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ServerHello *hello = (moumantai_v1_ServerHello *)data;

    s_conn_state = CONN_SESSION_ACTIVE;
    s_reconnect_attempt = 0;
    s_pairing_pending = false;

    CRED_LOCK();
    strncpy(s_session_id, hello->session_id, sizeof(s_session_id) - 1);
    s_session_id[sizeof(s_session_id) - 1] = '\0';
    CRED_UNLOCK();

    offline_queue_flush_on_connect();
}

static void on_error_internal(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ErrorMessage *err = (moumantai_v1_ErrorMessage *)data;
    if (!err)
        return;
    if (err->code == moumantai_v1_ProtocolErrorCode_PROTOCOL_ERROR_CODE_UNKNOWN_SESSION) {
        ESP_LOGW(TAG, "server disowned session — clearing routing handle");
        CRED_LOCK();
        s_session_id[0] = '\0';
        CRED_UNLOCK();
    }
}

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

esp_err_t transport_init(void) {
    if (!s_cred_mutex) {
        s_cred_mutex = xSemaphoreCreateMutex();
        if (!s_cred_mutex)
            return ESP_ERR_NO_MEM;
    }
    if (!s_send_queue) {
        s_send_queue = xQueueCreate(SEND_QUEUE_DEPTH, sizeof(send_msg_t));
        if (!s_send_queue)
            return ESP_ERR_NO_MEM;
    }
    if (!s_send_task) {
        s_send_task_run = true;
        /* Stack 4 KB: worker does heap_caps_free + esp_websocket_client_send_bin.
         * Priority 4 = same as default LVGL task; the WS client serializes
         * sends internally so contention is fine. */
        BaseType_t ok = xTaskCreate(send_worker, "ws_send", 4096, NULL, 4, &s_send_task);
        if (ok != pdPASS) {
            s_send_task = NULL;
            return ESP_ERR_NO_MEM;
        }
    }
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_HELLO_OK, on_hello_ok_internal, NULL);
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_ERROR, on_error_internal, NULL);
    ESP_LOGI(TAG, "transport initialized (proto wire)");
    return ESP_OK;
}

void transport_set_nav_intent_provider(nav_intent_provider_fn fn) {
    s_nav_intent_provider = fn;
}

esp_err_t transport_connect(const char *uri) {
    if (!uri)
        return ESP_ERR_INVALID_ARG;
    if (s_client) {
        ESP_LOGW(TAG, "Already connected, disconnecting first");
        transport_disconnect();
    }

    ESP_LOGI(TAG, "Connecting transport (proto wire)");
    s_conn_state = CONN_CONNECTING;
    s_user_disconnected = false;
    s_reconnect_attempt = 0;

    const esp_websocket_client_config_t ws_cfg = {
        .uri = uri,
        .disable_auto_reconnect = true,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 30,
        .subprotocol = MOUMANTAI_WS_SUBPROTOCOL,
        /* Default 4 KB overflows — nanopb + Struct→cJSON + repeated
         * ComponentDef decode walks the stack deeply. 12 KB comfortable
         * in ESP-IDF v5.4. */
        .task_stack = 12288,
    };

    s_client = esp_websocket_client_init(&ws_cfg);
    if (!s_client) {
        s_conn_state = CONN_DISCONNECTED;
        return ESP_FAIL;
    }

    ESP_RETURN_ON_ERROR(esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL), TAG,
                        "register events failed");

    return esp_websocket_client_start(s_client);
}

void transport_disconnect(void) {
    s_user_disconnected = true;
    if (s_reconnect_timer) {
        esp_timer_stop(s_reconnect_timer);
    }
    s_reconnect_pending = false;
    s_reconnect_attempt = 0;

    if (s_client) {
        /* Close before destroy: with disable_auto_reconnect=true the
         * worker task can still be mid-access when destroy frees the
         * context (espressif/esp-protocols #412). The 50 ms delay gives
         * FreeRTOS time to exit the worker task before destroy. */
        esp_websocket_client_close(s_client, pdMS_TO_TICKS(3000));
        vTaskDelay(pdMS_TO_TICKS(50));
        esp_websocket_client_destroy(s_client);
        s_client = NULL;
    }
    /* Drop buffered frames so the next reconnect doesn't send stale state. */
    send_queue_drain();
    text_accum_reset();
    s_conn_state = CONN_DISCONNECTED;
    CRED_LOCK();
    s_session_id[0] = '\0';
    CRED_UNLOCK();
    offline_queue_clear();
}

bool transport_is_connected(void) {
    return s_conn_state == CONN_SESSION_ACTIVE;
}

/* --------------------------------------------------------------------------
 * Senders
 * ----------------------------------------------------------------------- */

esp_err_t transport_send_chat_input(const char *scope, const char *text, const char *client_msg_id) {
    char msg_id[40];
    const char *effective_id;
    if (client_msg_id && client_msg_id[0] != '\0') {
        effective_id = client_msg_id;
    } else {
        gen_client_msg_id(msg_id, sizeof(msg_id));
        effective_id = msg_id;
    }

    if (s_conn_state != CONN_SESSION_ACTIVE) {
        if (offline_queue_enqueue(scope, text ? text : "", effective_id)) {
            ESP_LOGI(TAG, "offline_queue: enqueued chat (size=%u)", (unsigned)offline_queue_size());
            return ESP_OK;
        }
        return ESP_ERR_INVALID_SIZE;
    }
    return send_chat_input_wire(scope, text, effective_id);
}

esp_err_t transport_send_viewing(const char *scope) {
    const char *s = scope ? scope : "";
    /* Skip if scope unchanged (state.c also dedups; this guards direct callers). */
    if (strcmp(s_last_scope, s) == 0)
        return ESP_OK;

    uint8_t buf[128];
    size_t out_len = 0;
    esp_err_t err = proto_encode_viewing(buf, sizeof(buf), &out_len, s);
    if (err != ESP_OK)
        return err;

    /* Route via the single-slot mailbox, not the bounded main queue. The
     * main queue can drop viewings on saturation, leaving "Loading…" because
     * the server never knew which app was active. The mailbox always carries
     * the latest intent; worker sends it on the next drain. */
    if (!s_client || !esp_websocket_client_is_connected(s_client)) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t *copy = heap_caps_malloc(out_len, MALLOC_CAP_SPIRAM);
    if (!copy)
        return ESP_ERR_NO_MEM;
    memcpy(copy, buf, out_len);

    uint8_t *stale = NULL;
    portENTER_CRITICAL(&s_viewing_lock);
    stale = s_pending_viewing.bytes;
    s_pending_viewing.bytes = copy;
    s_pending_viewing.len = out_len;
    portEXIT_CRITICAL(&s_viewing_lock);
    if (stale)
        heap_caps_free(stale); /* coalesced — drop the older intent */

    strncpy(s_last_scope, s, sizeof(s_last_scope) - 1);
    s_last_scope[sizeof(s_last_scope) - 1] = '\0';
    return ESP_OK;
}

esp_err_t transport_send_reset_conversation(const char *scope) {
    uint8_t buf[128];
    size_t out_len = 0;
    esp_err_t err = proto_encode_reset_conversation(buf, sizeof(buf), &out_len, scope ? scope : "");
    if (err != ESP_OK)
        return err;
    return send_proto_bytes(buf, out_len);
}

esp_err_t transport_send_invoke_tool(const char *tool_name, const char *source_face_id, const char *client_request_id,
                                     const cJSON *args) {
    if (!tool_name || !tool_name[0])
        return ESP_ERR_INVALID_ARG;
    if (s_conn_state != CONN_SESSION_ACTIVE) {
        ESP_LOGD(TAG, "invoke_tool: not connected, dropping (tool=%s)", tool_name);
        return ESP_ERR_INVALID_STATE;
    }
    /* Most filter-chip args are tiny (<100 B); 1 KB is comfortable headroom.
     * Grow if a future face emits larger args. */
    uint8_t buf[1024];
    size_t out_len = 0;
    esp_err_t err =
        proto_encode_invoke_tool(buf, sizeof(buf), &out_len, tool_name, source_face_id ? source_face_id : "",
                                 client_request_id ? client_request_id : "", args);
    if (err != ESP_OK)
        return err;
    return send_proto_bytes(buf, out_len);
}

esp_err_t transport_send_audio_input(const uint8_t *pcm_data, size_t len, const char *scope, bool final) {
    if (!s_client || !esp_websocket_client_is_connected(s_client)) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t *frame = NULL;
    size_t frame_len = 0;
    if (binary_frame_encode_audio(scope, pcm_data, len, final, &frame, &frame_len) != 0) {
        return ESP_FAIL;
    }
    /* Transfer ownership of `frame` into the send queue — avoids a second
     * memcpy of the (potentially 30+ KB) audio payload. The worker frees. */
    return send_proto_bytes_owned(frame, frame_len);
}
