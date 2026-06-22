#include "chat.h"
#include "state.h"
#include "transport.h"
#include "style_helpers.h"
#include "icon_map.h"
#include "moumantai/v1/chat.pb.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>
#include "esp_event.h"
#include "esp_lvgl_port.h"
#include "esp_log.h"
#include "esp_random.h"

/* Local mirror of proto_decode.c's chat-entries decoder context. The decoder
 * stashes (entries, count) here and we read it back from msg->entries.arg. */
typedef struct {
    moumantai_v1_ChatWindowEntry *entries;
    int count;
    int capacity;
} chat_entries_ctx_t;

/** Convert the typed ChatRole enum to the string the chat ring uses. */
static const char *chat_role_to_str(moumantai_v1_ChatRole role) {
    switch (role) {
    case moumantai_v1_ChatRole_CHAT_ROLE_USER:
        return "user";
    case moumantai_v1_ChatRole_CHAT_ROLE_ASSISTANT:
        return "assistant";
    case moumantai_v1_ChatRole_CHAT_ROLE_SYSTEM:
        return "system";
    default:
        return "";
    }
}

static const char *TAG = "chat";

/* --------------------------------------------------------------------------
 * Chat message storage (simple ring buffer)
 * ----------------------------------------------------------------------- */

#define MAX_MESSAGES 30

/* LLM responses can easily exceed 256 bytes, so message text is stored on
 * the heap (not a fixed inline buffer that would truncate) and the prior
 * slot's contents are freed when the ring wraps. */
typedef struct {
    char id[MOUMANTAI_MAX_ID_LEN]; /* Server-assigned message id (empty for unechoed optimistic) */
    char role[16];
    char *text;
    char scope[64];
    char conversation_id[MOUMANTAI_MAX_ID_LEN];
    char *client_msg_id; /* Heap; non-NULL for optimistic entries awaiting echo */
} chat_msg_t;

static chat_msg_t s_messages[MAX_MESSAGES];
static int s_msg_count = 0;
static int s_msg_head = 0; /* Next write position */

/* Per-scope conversation_id table. Each scope tracks its own conv_id so
 * outbound optimistic bubbles stamp the right value — a single global
 * conv_id would bleed across scopes and cause apply_chat_window to silently
 * drop optimistic entries from other scopes on the next snapshot.
 * Sized to AppListMsg.apps max_count (16) + 1 for "home". */
#define MAX_SCOPE_CONVS 17
typedef struct {
    char scope[64];
    char conversation_id[MOUMANTAI_MAX_ID_LEN];
} scope_conv_t;
static scope_conv_t s_scope_convs[MAX_SCOPE_CONVS];
static int s_scope_conv_count = 0;

static void set_scope_conv_id(const char *scope, const char *conversation_id) {
    if (!scope || !*scope || !conversation_id)
        return;
    for (int i = 0; i < s_scope_conv_count; i++) {
        if (strcmp(s_scope_convs[i].scope, scope) == 0) {
            strncpy(s_scope_convs[i].conversation_id, conversation_id, sizeof(s_scope_convs[i].conversation_id) - 1);
            s_scope_convs[i].conversation_id[sizeof(s_scope_convs[i].conversation_id) - 1] = '\0';
            return;
        }
    }
    if (s_scope_conv_count >= MAX_SCOPE_CONVS) {
        ESP_LOGW(TAG, "scope_conv table full; dropping %s", scope);
        return;
    }
    scope_conv_t *e = &s_scope_convs[s_scope_conv_count++];
    strncpy(e->scope, scope, sizeof(e->scope) - 1);
    e->scope[sizeof(e->scope) - 1] = '\0';
    strncpy(e->conversation_id, conversation_id, sizeof(e->conversation_id) - 1);
    e->conversation_id[sizeof(e->conversation_id) - 1] = '\0';
}

/* Returns "" for unknown scopes. The empty conv_id flows through
 * store_message_full → outbound chatInput; the server will assign a new
 * conversation and the next chatWindow re-keys this table. */
static const char *get_scope_conv_id(const char *scope) {
    if (!scope || !*scope)
        return "";
    for (int i = 0; i < s_scope_conv_count; i++) {
        if (strcmp(s_scope_convs[i].scope, scope) == 0) {
            return s_scope_convs[i].conversation_id;
        }
    }
    return "";
}

static void clear_scope_conv_table(void) {
    s_scope_conv_count = 0;
}

static void chat_msg_reset(chat_msg_t *msg) {
    free(msg->text);
    msg->text = NULL;
    free(msg->client_msg_id);
    msg->client_msg_id = NULL;
    msg->id[0] = '\0';
    msg->role[0] = '\0';
    msg->scope[0] = '\0';
    msg->conversation_id[0] = '\0';
}

static void store_message_full(const char *id, const char *role, const char *text, const char *scope,
                               const char *conversation_id, const char *client_msg_id) {
    chat_msg_t *msg = &s_messages[s_msg_head];
    chat_msg_reset(msg);

    if (id) {
        strncpy(msg->id, id, sizeof(msg->id) - 1);
        msg->id[sizeof(msg->id) - 1] = '\0';
    }
    strncpy(msg->role, role ? role : "", sizeof(msg->role) - 1);
    msg->role[sizeof(msg->role) - 1] = '\0';
    msg->text = strdup(text ? text : "");
    strncpy(msg->scope, scope ? scope : "", sizeof(msg->scope) - 1);
    msg->scope[sizeof(msg->scope) - 1] = '\0';
    if (conversation_id) {
        strncpy(msg->conversation_id, conversation_id, sizeof(msg->conversation_id) - 1);
        msg->conversation_id[sizeof(msg->conversation_id) - 1] = '\0';
    }
    if (client_msg_id) {
        msg->client_msg_id = strdup(client_msg_id);
    }

    s_msg_head = (s_msg_head + 1) % MAX_MESSAGES;
    if (s_msg_count < MAX_MESSAGES)
        s_msg_count++;
}

/**
 * Apply a chatWindow authoritative snapshot.
 *
 * Semantics:
 *  1. Snapshot optimistic entries for `msg->scope` — those whose
 *     client_msg_id != NULL AND whose id does not appear in msg->entries.
 *  2. Wipe all ring entries whose scope == msg->scope.
 *  3. Insert each msg->entries[i] as a canonical entry with
 *     client_msg_id = NULL and conversation_id = msg->conversation_id.
 *  4. Re-insert the preserved optimistic entries so they remain visible
 *     until their echo reconciles.
 *  5. Register msg->conversation_id under msg->scope in the per-scope
 *     conv_id table so future outbound bubbles in this scope stamp with it.
 */
static void apply_chat_window(const moumantai_v1_ChatWindowMsg *msg, const chat_entries_ctx_t *ectx) {
    if (!msg)
        return;
    const char *scope = msg->scope;
    const moumantai_v1_ChatWindowEntry *entries = ectx ? ectx->entries : NULL;
    int entries_count = ectx ? ectx->count : 0;

    /* Snapshot optimistic entries to preserve (shallow copies; originals
     * are about to be overwritten). Heap-allocated, not stack: two
     * chat_msg_t[30] arrays = ~13 KB, which is too close to the 16 KB
     * LVGL task stack limit. Stack allocation previously corrupted an
     * adjacent FreeRTOS queue control block and surfaced as
     * `xQueueGenericSend` asserts on an unrelated task. */
    chat_msg_t *preserved = calloc(MAX_MESSAGES, sizeof(*preserved));
    chat_msg_t *kept = calloc(MAX_MESSAGES, sizeof(*kept));
    if (!preserved || !kept) {
        ESP_LOGE(TAG, "apply_chat_window: OOM allocating ring snapshots");
        free(preserved);
        free(kept);
        return;
    }
    int preserved_n = 0;
    int start = (s_msg_count >= MAX_MESSAGES) ? s_msg_head : 0;
    for (int i = 0; i < s_msg_count; i++) {
        int idx = (start + i) % MAX_MESSAGES;
        chat_msg_t *m = &s_messages[idx];
        if (strcmp(m->scope, scope) != 0)
            continue;
        if (m->client_msg_id == NULL)
            continue;
        /* Drop optimistic entries from older conversations on REPLACE —
         * chatWindow.conversationId is the server's authoritative generation
         * marker. Anything stamped with a different conv id is stale. */
        if (strcmp(m->conversation_id, msg->conversation_id) != 0)
            continue;
        /* Is this optimistic entry now present in the window? If so, the
         * authoritative snapshot will supersede it and we drop. */
        bool in_window = false;
        for (int j = 0; j < entries_count; j++) {
            if (m->id[0] && strcmp(m->id, entries[j].id) == 0) {
                in_window = true;
                break;
            }
        }
        if (in_window)
            continue;
        /* Shallow copy — we'll transfer ownership of text/client_msg_id by
         * NULLing the originals below. */
        preserved[preserved_n] = *m;
        m->text = NULL;
        m->client_msg_id = NULL;
        preserved_n++;
    }

    /* Wipe matching ring entries; keep others. Rebuild by compacting
     * non-matching entries first, then clearing the tail. */
    int kept_n = 0;
    for (int i = 0; i < s_msg_count; i++) {
        int idx = (start + i) % MAX_MESSAGES;
        chat_msg_t *m = &s_messages[idx];
        if (strcmp(m->scope, scope) == 0) {
            /* Drop: free any still-owned heap fields. */
            chat_msg_reset(m);
            continue;
        }
        kept[kept_n++] = *m;
        m->text = NULL;
        m->client_msg_id = NULL;
    }

    /* Ring is ownership-clean: matching-scope slots were reset above;
     * non-matching slots had heap pointers transferred into kept[] and
     * NULLed; each write slot is reset again before use below. */
    s_msg_count = 0;
    s_msg_head = 0;

    /* Re-append kept (other-scope) messages first, in chronological order.
     * Reset the target slot before each write to avoid leaking heap strings
     * if the ring wraps. */
    for (int i = 0; i < kept_n; i++) {
        chat_msg_reset(&s_messages[s_msg_head]);
        s_messages[s_msg_head] = kept[i];
        s_msg_head = (s_msg_head + 1) % MAX_MESSAGES;
        if (s_msg_count < MAX_MESSAGES)
            s_msg_count++;
    }

    /* Now append the authoritative entries for the target scope. */
    for (int i = 0; i < entries_count; i++) {
        store_message_full(entries[i].id, chat_role_to_str(entries[i].role), entries[i].text, scope,
                           msg->conversation_id, NULL);
    }

    /* Re-insert preserved optimistic entries at the tail. */
    for (int i = 0; i < preserved_n; i++) {
        chat_msg_reset(&s_messages[s_msg_head]);
        s_messages[s_msg_head] = preserved[i];
        s_msg_head = (s_msg_head + 1) % MAX_MESSAGES;
        if (s_msg_count < MAX_MESSAGES)
            s_msg_count++;
    }

    /* Register the conversationId for this scope; other scopes are untouched. */
    set_scope_conv_id(msg->scope, msg->conversation_id);

    /* All heap strings moved into the ring or freed; snapshot arrays are safe to release. */
    free(preserved);
    free(kept);
}

/* --------------------------------------------------------------------------
 * LVGL objects
 * ----------------------------------------------------------------------- */

static lv_obj_t *s_chat_panel = NULL;
static lv_obj_t *s_msg_list = NULL;
static lv_obj_t *s_textarea = NULL;
static lv_obj_t *s_keyboard = NULL;
static lv_obj_t *s_fab_btn = NULL;
static bool s_visible = false;

/* --------------------------------------------------------------------------
 * Scope helper
 * ----------------------------------------------------------------------- */

/* Write the current scope key into a caller-provided buffer (avoids a shared
 * static that would break concurrent or back-to-back callers). */
static void get_current_scope(char *out, size_t cap) {
    if (!out || cap == 0)
        return;
    const app_state_t *app = state_get_active_app();
    if (!app || strcmp(app->app_id, "home") == 0) {
        strncpy(out, "home", cap - 1);
    } else {
        snprintf(out, cap, "app:%s", app->app_id);
    }
    out[cap - 1] = '\0';
}

/* --------------------------------------------------------------------------
 * Rebuild message list
 * ----------------------------------------------------------------------- */

static void rebuild_messages(void) {
    if (!s_msg_list)
        return;

    lv_obj_clean(s_msg_list);

    char active_scope[96];
    get_current_scope(active_scope, sizeof(active_scope));
    int start = (s_msg_count >= MAX_MESSAGES) ? s_msg_head : 0;
    for (int i = 0; i < s_msg_count; i++) {
        int idx = (start + i) % MAX_MESSAGES;
        chat_msg_t *msg = &s_messages[idx];

        /* Only show messages for the active scope. Skip empty-scope entries
         * (uninitialized / post-reset) — they must not bleed across apps. */
        if (strcmp(msg->scope, active_scope) != 0)
            continue;

        bool is_user = strcmp(msg->role, "user") == 0;

        /* Row container controls bubble alignment via flex; lv_obj_align
         * conflicts with flex parents, so LV_FLEX_ALIGN_END aligns user bubbles. */
        lv_obj_t *row = lv_obj_create(s_msg_list);
        reset_container_paint(row);
        lv_obj_set_width(row, LV_PCT(100));
        lv_obj_set_height(row, LV_SIZE_CONTENT);
        lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(row, is_user ? LV_FLEX_ALIGN_END : LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                              LV_FLEX_ALIGN_CENTER);
        lv_obj_remove_flag(row, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t *bubble = lv_obj_create(row);
        reset_container_paint(bubble);
        lv_obj_set_width(bubble, LV_PCT(85));
        lv_obj_set_height(bubble, LV_SIZE_CONTENT);
        lv_obj_set_style_radius(bubble, 16, 0);
        lv_obj_set_style_pad_hor(bubble, 12, 0);
        lv_obj_set_style_pad_ver(bubble, 8, 0);
        lv_obj_set_style_bg_color(bubble, is_user ? THEME_PRIMARY : THEME_SURFACE_CONT, 0);
        lv_obj_set_style_bg_opa(bubble, LV_OPA_COVER, 0);
        lv_obj_remove_flag(bubble, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t *label = lv_label_create(bubble);
        lv_label_set_text(label, msg->text ? msg->text : "");
        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(label, LV_PCT(100));
        lv_obj_set_style_text_color(label, is_user ? THEME_ON_PRIMARY : THEME_ON_SURFACE, 0);
        lv_obj_set_style_text_font(label, resolve_font("bodyMedium"), 0);
        apply_text_style(label, "bodyMedium");
    }

    /* Auto-scroll to bottom */
    lv_obj_scroll_to_y(s_msg_list, LV_COORD_MAX, LV_ANIM_ON);
}

/* --------------------------------------------------------------------------
 * Transient notice (for /reset while disconnected)
 * ----------------------------------------------------------------------- */

static void notice_close_timer_cb(lv_timer_t *timer) {
    lv_obj_t *notice = (lv_obj_t *)lv_timer_get_user_data(timer);
    if (notice)
        lv_obj_delete(notice);
    lv_timer_delete(timer);
}

static void show_transient_notice(const char *text) {
    if (!s_chat_panel)
        return;
    lv_obj_t *notice = lv_label_create(s_chat_panel);
    lv_label_set_text(notice, text);
    lv_obj_set_style_bg_color(notice, THEME_SURFACE_CONT, 0);
    lv_obj_set_style_bg_opa(notice, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(notice, THEME_ON_SURFACE, 0);
    lv_obj_set_style_pad_all(notice, 10, 0);
    lv_obj_set_style_radius(notice, 12, 0);
    lv_obj_align(notice, LV_ALIGN_TOP_MID, 0, 56);
    lv_timer_t *t = lv_timer_create(notice_close_timer_cb, 2000, notice);
    lv_timer_set_repeat_count(t, 1);
}

/* --------------------------------------------------------------------------
 * Client msg id generator (mirrors transport.c's gen_client_msg_id)
 * ----------------------------------------------------------------------- */

static void gen_client_msg_id(char *out, size_t cap) {
    uint32_t a = esp_random();
    uint32_t b = esp_random();
    snprintf(out, cap, "esp-%08lx%08lx", (unsigned long)a, (unsigned long)b);
}

/* --------------------------------------------------------------------------
 * /reset detection
 * ----------------------------------------------------------------------- */

static bool is_reset_command(const char *text) {
    if (!text)
        return false;
    /* Trim leading whitespace */
    while (*text && isspace((unsigned char)*text))
        text++;
    /* Find end, ignoring trailing whitespace */
    size_t end = strlen(text);
    while (end > 0 && isspace((unsigned char)text[end - 1]))
        end--;
    if (end != 6)
        return false;
    /* Case-insensitive compare to "/reset" */
    const char *want = "/reset";
    for (size_t i = 0; i < 6; i++) {
        if (tolower((unsigned char)text[i]) != want[i])
            return false;
    }
    return true;
}

/* --------------------------------------------------------------------------
 * Send chat input
 * ----------------------------------------------------------------------- */

static void send_chat_text(void) {
    if (!s_textarea)
        return;
    const char *text = lv_textarea_get_text(s_textarea);
    if (!text || text[0] == '\0')
        return;

    char scope[96];
    get_current_scope(scope, sizeof(scope));

    /* /reset interception — no local bubble, no chatInput on the wire. */
    if (is_reset_command(text)) {
        if (transport_is_connected()) {
            transport_send_reset_conversation(scope);
        } else {
            show_transient_notice("Reset ignored: offline");
        }
        lv_textarea_set_text(s_textarea, "");
        return;
    }

    /* Generate the clientMsgId here so we can stamp it on the optimistic
     * bubble for later reconciliation when the server echoes it back. */
    char msg_id[40];
    gen_client_msg_id(msg_id, sizeof(msg_id));

    /* Local optimistic echo — stamp client_msg_id so the server echo
     * reconciles in place rather than duplicating the bubble, and
     * apply_chat_window can preserve it across any intervening snapshot.
     * The conversation_id is looked up by scope so a message typed in
     * app:foo never gets stamped with home's conversation. */
    const char *conv_id = get_scope_conv_id(scope);
    store_message_full(NULL, "user", text, scope, conv_id, msg_id);
    rebuild_messages();

    /* Send to server using the same msg_id so the echo's clientMsgId
     * matches our optimistic entry. */
    transport_send_chat_input(scope, text, msg_id);

    /* Clear input */
    lv_textarea_set_text(s_textarea, "");
}

/* --------------------------------------------------------------------------
 * LVGL event callbacks
 * ----------------------------------------------------------------------- */

static void on_send_clicked(lv_event_t *e) {
    (void)e;
    send_chat_text();
}

static void on_ta_event(lv_event_t *e) {
    lv_event_code_t code = lv_event_get_code(e);

    if (code == LV_EVENT_FOCUSED) {
        lv_keyboard_set_textarea(s_keyboard, s_textarea);
        lv_obj_remove_flag(s_keyboard, LV_OBJ_FLAG_HIDDEN);
        /* Shrink message list to the remaining column height while the
         * keyboard is up so the latest message stays visible.
         * 480 (screen) - 48 (topbar) - 56 (input bar) - 200 (keyboard) = 176 */
        if (s_msg_list) {
            lv_obj_set_flex_grow(s_msg_list, 0);
            lv_obj_set_height(s_msg_list, 176);
            lv_obj_scroll_to_y(s_msg_list, LV_COORD_MAX, LV_ANIM_OFF);
        }
    } else if (code == LV_EVENT_DEFOCUSED) {
        lv_obj_add_flag(s_keyboard, LV_OBJ_FLAG_HIDDEN);
        if (s_msg_list) {
            lv_obj_set_flex_grow(s_msg_list, 1);
            lv_obj_set_height(s_msg_list, LV_PCT(100));
        }
    } else if (code == LV_EVENT_READY) {
        send_chat_text();
    }
}

static void on_back_clicked(lv_event_t *e) {
    (void)e;
    chat_show(false);
}

static void on_fab_clicked(lv_event_t *e) {
    (void)e;
    chat_show(true);
}

/* --------------------------------------------------------------------------
 * State event handlers
 * ----------------------------------------------------------------------- */

/* All chat-ring mutation runs on the LVGL task via lv_async_call. Event-loop
 * handlers only transfer heap ownership. Mutating the ring from the event-loop
 * task while rebuild_messages reads it would race and corrupt FreeRTOS metadata
 * (observed as `xQueueGenericSend` asserts). Single-task ownership removes
 * the race without a mutex. */

static void deferred_rebuild_chat(void *user_data) {
    (void)user_data;
    if (s_visible && lvgl_port_lock(500)) {
        rebuild_messages();
        lvgl_port_unlock();
    }
}

/**
 * Apply an incoming chat echo/assistant frame on the LVGL task. If the
 * server stamped clientMsgId, try to reconcile against a local optimistic
 * entry by matching on it and upgrading in-place. Otherwise just append.
 */
static void deferred_apply_chat_message(void *user_data) {
    moumantai_v1_ChatMessage *msg = (moumantai_v1_ChatMessage *)user_data;
    if (!msg)
        return;

    if (lvgl_port_lock(500)) {
        const char *role_str = chat_role_to_str(msg->role);
        const char *cmid = msg->has_client_msg_id ? msg->client_msg_id : NULL;

        bool reconciled = false;
        if (cmid && cmid[0]) {
            int start = (s_msg_count >= MAX_MESSAGES) ? s_msg_head : 0;
            for (int i = 0; i < s_msg_count; i++) {
                int idx = (start + i) % MAX_MESSAGES;
                chat_msg_t *m = &s_messages[idx];
                if (m->client_msg_id && strcmp(m->client_msg_id, cmid) == 0) {
                    strncpy(m->id, msg->id, sizeof(m->id) - 1);
                    m->id[sizeof(m->id) - 1] = '\0';
                    if (role_str[0]) {
                        strncpy(m->role, role_str, sizeof(m->role) - 1);
                        m->role[sizeof(m->role) - 1] = '\0';
                    }
                    free(m->text);
                    m->text = strdup(msg->text);
                    strncpy(m->conversation_id, msg->conversation_id, sizeof(m->conversation_id) - 1);
                    m->conversation_id[sizeof(m->conversation_id) - 1] = '\0';
                    free(m->client_msg_id);
                    m->client_msg_id = NULL;
                    reconciled = true;
                    break;
                }
            }
        }
        if (!reconciled) {
            store_message_full(msg->id, role_str, msg->text, msg->scope, msg->conversation_id, NULL);
        }

        /* Register the conv_id under the message's scope so subsequent
         * outbound bubbles in this scope stamp with it. */
        if (msg->conversation_id[0]) {
            set_scope_conv_id(msg->scope, msg->conversation_id);
        }

        if (s_visible)
            rebuild_messages();
        lvgl_port_unlock();
    }

    free(msg);
}

static void on_chat_message(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ChatMessage *msg = *(moumantai_v1_ChatMessage **)data;
    if (!msg)
        return;
    if (lv_async_call(deferred_apply_chat_message, msg) != LV_RESULT_OK) {
        ESP_LOGW(TAG, "lv_async_call(chat_message) failed; dropping");
        free(msg);
    }
}

/* chatWindow: authoritative replacement for the scope's log; runs on the
 * LVGL task to avoid cross-task ring mutation. */
static void deferred_apply_chat_window(void *user_data) {
    moumantai_v1_ChatWindowMsg *msg = (moumantai_v1_ChatWindowMsg *)user_data;
    if (!msg)
        return;

    chat_entries_ctx_t *ectx = (chat_entries_ctx_t *)msg->entries.arg;
    if (lvgl_port_lock(500)) {
        apply_chat_window(msg, ectx);
        if (s_visible)
            rebuild_messages();
        lvgl_port_unlock();
    }

    if (ectx) {
        free(ectx->entries);
        free(ectx);
    }
    free(msg);
}

static void on_chat_window(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ChatWindowMsg *msg = *(moumantai_v1_ChatWindowMsg **)data;
    if (!msg)
        return;
    if (lv_async_call(deferred_apply_chat_window, msg) != LV_RESULT_OK) {
        ESP_LOGW(TAG, "lv_async_call(chat_window) failed; dropping");
        chat_entries_ctx_t *ectx = (chat_entries_ctx_t *)msg->entries.arg;
        if (ectx) {
            free(ectx->entries);
            free(ectx);
        }
        free(msg);
    }
}

/* chatUpdate: incremental status transition. Not rendered today (no thinking
 * indicator on ESP32); free and log. Ring-entry patching can land when the
 * UI adopts a status-aware render. */
static void on_chat_update(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    moumantai_v1_ChatUpdateMsg *msg = *(moumantai_v1_ChatUpdateMsg **)data;
    if (!msg)
        return;
    /* Minimal treatment: free. A future UI pass can patch the ring entry
     * matching msg->id and repaint with status-aware affordances. */
    free(msg);
}

/* Active-app changed: rebuild the visible chat list so the previous app's
 * messages don't bleed through during a swipe. */
static void on_active_app_changed(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    (void)data;
    lv_async_call(deferred_rebuild_chat, NULL);
}

/* On disconnect, drop the per-scope conv_id cache; the server's conversation
 * generation may roll on reconnect. Deferred to the LVGL task for single-task
 * ownership (racing the event-loop task against a deferred apply would corrupt
 * the table). lv_async_call failure is harmless — the next chatWindow re-keys. */
static void deferred_clear_scope_conv_table(void *user_data) {
    (void)user_data;
    clear_scope_conv_table();
}

static void on_transport_disconnected(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    (void)data;
    lv_async_call(deferred_clear_scope_conv_table, NULL);
}

/* UiActionEscalated: server requests the chat overlay (UI tap lacked required
 * args). Guard against scope mismatch — server targets the originating socket,
 * but an explicit check makes the contract clear. Stack-copy payload; not
 * replayed on reconnect. */
static void on_ui_action_escalated(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)id;
    if (!data)
        return;
    const ui_escalated_evt_t *evt = (const ui_escalated_evt_t *)data;

    char active_scope[96];
    get_current_scope(active_scope, sizeof(active_scope));

    if (strcmp(evt->scope, active_scope) != 0)
        return;
    chat_show(true);
}

/* --------------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

void chat_show(bool visible) {
    s_visible = visible;

    if (!lvgl_port_lock(500))
        return;

    if (visible) {
        lv_obj_remove_flag(s_chat_panel, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_fab_btn, LV_OBJ_FLAG_HIDDEN);
        rebuild_messages();
    } else {
        lv_obj_add_flag(s_chat_panel, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_keyboard, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_fab_btn, LV_OBJ_FLAG_HIDDEN);
        /* Reset msg_list geometry in case the user backed out with the
         * keyboard still up — DEFOCUSED doesn't fire when the panel hides. */
        if (s_msg_list) {
            lv_obj_set_flex_grow(s_msg_list, 1);
            lv_obj_set_height(s_msg_list, LV_PCT(100));
        }
    }

    lvgl_port_unlock();
}

void chat_fab_set_visible(bool visible) {
    if (!s_fab_btn)
        return;
    if (!lvgl_port_lock(500))
        return;
    /* Chat panel ownership wins: if the panel is open, FAB stays hidden
     * regardless of this caller's intent. The chat_show(false) path will
     * restore the FAB when the panel closes. */
    if (!s_visible) {
        if (visible)
            lv_obj_remove_flag(s_fab_btn, LV_OBJ_FLAG_HIDDEN);
        else
            lv_obj_add_flag(s_fab_btn, LV_OBJ_FLAG_HIDDEN);
    }
    lvgl_port_unlock();
}

esp_err_t chat_init(lv_obj_t *parent) {
    if (!lvgl_port_lock(0))
        return ESP_FAIL;

    /* ── FAB button (floating, always visible over face content) ──
     * Parented to screen so it rides above the tileview. 16px margin from
     * the right/bottom edges, above the app-pager dot row (~24px). */
    s_fab_btn = lv_button_create(parent);
    lv_obj_set_size(s_fab_btn, 56, 56);
    lv_obj_align(s_fab_btn, LV_ALIGN_BOTTOM_RIGHT, -16, -40);
    lv_obj_set_style_radius(s_fab_btn, 28, 0);
    lv_obj_set_style_bg_color(s_fab_btn, THEME_PRIMARY, 0);
    lv_obj_set_style_bg_opa(s_fab_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_shadow_width(s_fab_btn, 12, 0);
    lv_obj_set_style_shadow_ofs_y(s_fab_btn, 3, 0);
    lv_obj_set_style_shadow_color(s_fab_btn, lv_color_hex(0x000000), 0);
    lv_obj_set_style_shadow_opa(s_fab_btn, LV_OPA_40, 0);
    lv_obj_t *fab_icon = icon_label_create(s_fab_btn, "chat", 24, THEME_ON_PRIMARY);
    lv_obj_center(fab_icon);
    lv_obj_add_event_cb(s_fab_btn, on_fab_clicked, LV_EVENT_CLICKED, NULL);

    /* ── Chat panel (full screen, initially hidden) ──
     * CRITICAL: zero the flex row-gap. LVGL's default theme sets pad_row on
     * generic containers; across top_bar + msg_list + input_bar + keyboard
     * that pushes the keyboard past the 480-px bottom. `pad_all` does not
     * touch pad_row/pad_column — requires an explicit pad_gap call. */
    s_chat_panel = lv_obj_create(parent);
    reset_container_paint(s_chat_panel);
    lv_obj_set_size(s_chat_panel, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_pad_gap(s_chat_panel, 0, 0);
    lv_obj_set_style_bg_color(s_chat_panel, THEME_SURFACE, 0);
    lv_obj_set_style_bg_opa(s_chat_panel, LV_OPA_COVER, 0);
    lv_obj_set_flex_flow(s_chat_panel, LV_FLEX_FLOW_COLUMN);
    lv_obj_remove_flag(s_chat_panel, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(s_chat_panel, LV_OBJ_FLAG_HIDDEN);

    /* ── Top bar ── */
    lv_obj_t *top_bar = lv_obj_create(s_chat_panel);
    reset_container_paint(top_bar);
    lv_obj_set_size(top_bar, LV_PCT(100), 48);
    lv_obj_set_flex_flow(top_bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(top_bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(top_bar, 8, 0);
    lv_obj_remove_flag(top_bar, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *back_btn = lv_button_create(top_bar);
    lv_obj_set_size(back_btn, 44, 44);
    lv_obj_set_style_bg_opa(back_btn, LV_OPA_TRANSP, 0);
    lv_obj_set_style_shadow_width(back_btn, 0, 0);
    lv_obj_t *back_icon = icon_label_create(back_btn, "arrow_back", 24, THEME_ON_SURFACE);
    lv_obj_center(back_icon);
    lv_obj_add_event_cb(back_btn, on_back_clicked, LV_EVENT_CLICKED, NULL);

    lv_obj_t *title = lv_label_create(top_bar);
    lv_label_set_text(title, "Chat");
    lv_obj_set_style_text_font(title, resolve_font("titleLarge"), 0);
    lv_obj_set_style_text_color(title, THEME_ON_SURFACE, 0);
    apply_text_style(title, "titleLarge");

    /* ── Message list (scrollable) ── */
    s_msg_list = lv_obj_create(s_chat_panel);
    reset_container_paint(s_msg_list);
    lv_obj_set_width(s_msg_list, LV_PCT(100));
    lv_obj_set_flex_grow(s_msg_list, 1);
    lv_obj_set_flex_flow(s_msg_list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(s_msg_list, 8, 0);
    lv_obj_set_style_pad_gap(s_msg_list, 8, 0);
    lv_obj_add_flag(s_msg_list, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scrollbar_mode(s_msg_list, LV_SCROLLBAR_MODE_AUTO);

    /* ── Input bar ──
     * Height 56 = 4 top pad + 44 textarea/send button + 8 bottom pad. A 44px
     * row would clip the 44x44 send button: pad_all=4 leaves only 36px of
     * interior, cropping the bottom 8px. */
    lv_obj_t *input_bar = lv_obj_create(s_chat_panel);
    reset_container_paint(input_bar);
    lv_obj_set_size(input_bar, LV_PCT(100), 56);
    lv_obj_set_flex_flow(input_bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(input_bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(input_bar, 8, 0);
    lv_obj_set_style_pad_ver(input_bar, 6, 0);
    lv_obj_set_style_pad_gap(input_bar, 8, 0);
    lv_obj_set_style_bg_color(input_bar, THEME_SURFACE_CONT, 0);
    lv_obj_set_style_bg_opa(input_bar, LV_OPA_COVER, 0);
    lv_obj_remove_flag(input_bar, LV_OBJ_FLAG_SCROLLABLE);

    s_textarea = lv_textarea_create(input_bar);
    /* Fixed 44 px to match the round send button. The helper rebalances
     * pad_ver for the font's line metric — DO NOT hardcode pad_ver after. */
    apply_textfield_style_fixed_h(s_textarea, "bodyMedium", 44);
    lv_textarea_set_placeholder_text(s_textarea, "Type a message...");
    lv_obj_set_flex_grow(s_textarea, 1);
    lv_obj_set_style_pad_hor(s_textarea, 12, 0); /* horizontal-only override is safe */
    lv_obj_set_style_radius(s_textarea, 22, 0);  /* pill shape — visual only */
    /* Register only the three events on_ta_event consumes; LV_EVENT_ALL
     * would fire on every redraw and style refresh unnecessarily. */
    lv_obj_add_event_cb(s_textarea, on_ta_event, LV_EVENT_FOCUSED, NULL);
    lv_obj_add_event_cb(s_textarea, on_ta_event, LV_EVENT_DEFOCUSED, NULL);
    lv_obj_add_event_cb(s_textarea, on_ta_event, LV_EVENT_READY, NULL);

    lv_obj_t *send_btn = lv_button_create(input_bar);
    lv_obj_set_size(send_btn, 44, 44);
    lv_obj_set_style_radius(send_btn, 22, 0);
    lv_obj_set_style_bg_color(send_btn, THEME_PRIMARY, 0);
    lv_obj_set_style_bg_opa(send_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(send_btn, 0, 0);
    lv_obj_t *send_icon = icon_label_create(send_btn, "send", 20, THEME_ON_PRIMARY);
    lv_obj_center(send_icon);
    lv_obj_add_event_cb(send_btn, on_send_clicked, LV_EVENT_CLICKED, NULL);

    /* ── Keyboard (hidden initially, shown on textarea focus).
     * LV_PCT(100) width adapts to panel insets; explicit 320 was fragile. */
    s_keyboard = lv_keyboard_create(s_chat_panel);
    lv_obj_set_size(s_keyboard, LV_PCT(100), 200);
    lv_obj_set_style_border_width(s_keyboard, 0, 0);
    lv_obj_set_style_radius(s_keyboard, 0, 0);
    apply_unified_font(s_keyboard, "bodyMedium");
    apply_material_keyboard_map(s_keyboard);
    lv_keyboard_set_textarea(s_keyboard, s_textarea);
    lv_obj_add_flag(s_keyboard, LV_OBJ_FLAG_HIDDEN);

    lvgl_port_unlock();

    /* Register for chat messages */
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_CHAT_MESSAGE, on_chat_message, NULL);
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_CHAT_WINDOW, on_chat_window, NULL);
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_CHAT_UPDATE, on_chat_update, NULL);

    /* Rebuild on app switch so the panel shows the new scope's history. */
    esp_event_handler_register(STATE_EVENTS, STATE_EVT_ACTIVE_APP_CHANGED, on_active_app_changed, NULL);

    /* Drop the scope→conv_id cache on disconnect; may roll on reconnect. */
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_DISCONNECTED, on_transport_disconnected, NULL);

    /* Open the chat overlay when the server escalates a UI tap to chat. */
    esp_event_handler_register(TRANSPORT_EVENTS, TRANSPORT_EVT_UI_ACTION_ESCALATED, on_ui_action_escalated, NULL);

    ESP_LOGI(TAG, "Chat initialized");
    return ESP_OK;
}
