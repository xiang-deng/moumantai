/*
 * proto_decode.c — inbound ServerMessage dispatcher.
 *
 * Non-trivial pieces:
 *   1. FaceUpdateMsg.components: pb_callback_t that grows a heap array of
 *      ComponentDef (capped at MOUMANTAI_MAX_COMPONENTS).
 *   2. FaceUpdateMsg.data / action args: google.protobuf.Struct decoded into
 *      a cJSON tree via submsg callbacks (only dynamic-JSON strategy on ESP32).
 *   3. ChatWindowMsg.entries / ChatMessage.ui_blocks: callback-backed to keep
 *      static memory bounded for these unbounded repeated fields.
 */

#include "proto_decode.h"

#include <pb_decode.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_system.h"

#include "transport.h"
#include "binary_frame.h"
#include "transport_limits.h"
#include "moumantai/v1/actions.pb.h"
#include "moumantai/v1/envelope.pb.h"
#include "moumantai/v1/apps.pb.h"
#include "moumantai/v1/chat.pb.h"
#include "moumantai/v1/lifecycle.pb.h"
#include "moumantai/v1/components.pb.h"
#include "google/protobuf/struct.pb.h"

static const char *TAG = "proto_decode";

/* Heap-aware alloc-drop logger. Silent drops accumulate with heap
 * fragmentation and explain "faces get stuck after a while". */
#define LOG_ALLOC_DROP(kind)                                                                                           \
    ESP_LOGE(TAG, "%s: alloc failed; dropped (free=%u largest=%u)", (kind), (unsigned)esp_get_free_heap_size(),        \
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT))

/* Forward declarations needed by the component-array decoder's action.args
 * pipeline — the actual definitions live in the Struct→cJSON section below. */
static bool struct_fields_cb(pb_istream_t *stream, const pb_field_t *field, void **arg);

/* --------------------------------------------------------------------------
 * Component-array decoder — heap-grown typed moumantai_v1_ComponentDef[].
 *
 * ctx installed into FaceUpdateMsg.components.arg; after decode,
 * ctx->components/count own the array.
 *
 * Action.args sidecar: the decode cascade is
 *   cb_component_setup → installs Action.cb_args
 *   cb_action_args     → installs Struct.fields → struct_fields_cb
 *   struct_fields_cb   → populates cJSON
 * Result attached to ctx->args_by_id keyed by def->id; read by
 * the renderer via state.c at wire_action time.
 * ----------------------------------------------------------------------- */

typedef struct {
    moumantai_v1_ComponentDef *components;
    int count;
    int capacity;
    /* component_id -> cJSON args. Owned by this ctx until the FaceUpdate
     * handler claims it (see state.c on_face_update). Allocated lazily on
     * the first action with args. */
    cJSON *args_by_id;
} components_decode_ctx_t;

/* Per-ComponentDef decode-time context, lives on decode_components_callback's
 * stack and is passed via ComponentDef.cb_component.arg → Action.cb_args.arg
 * so action-args decode knows which component_id to attach the cJSON to. */
typedef struct {
    moumantai_v1_ComponentDef *def; /* current component (id read pre-callback) */
    components_decode_ctx_t *ctx;   /* shared component-array ctx (for args_by_id) */
} action_decode_ctx_t;

/* Fires when Action.args is on the wire (submsg_callback:true), AFTER the
 * Struct memset and BEFORE body decode — the window to install struct_fields_cb.
 * Allocates a cJSON object and attaches it to args_by_id keyed by the def's id. */
static bool cb_action_args(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    (void)stream;
    action_decode_ctx_t *adctx = (action_decode_ctx_t *)*arg;
    if (!adctx || !adctx->def || !adctx->ctx || !field->pData)
        return true;

    google_protobuf_Struct *args = (google_protobuf_Struct *)field->pData;

    cJSON *obj = cJSON_CreateObject();
    if (!obj)
        return false;

    args->fields.funcs.decode = struct_fields_cb;
    args->fields.arg = obj;

    /* Lazy-allocate the args map on first hit. */
    if (!adctx->ctx->args_by_id) {
        adctx->ctx->args_by_id = cJSON_CreateObject();
        if (!adctx->ctx->args_by_id) {
            cJSON_Delete(obj);
            return false;
        }
    }

    /* id is tag 1 (decoded before tag 2+ variant body), so def->id is valid here. */
    if (adctx->def->id[0]) {
        cJSON_AddItemToObject(adctx->ctx->args_by_id, adctx->def->id, obj);
    } else {
        cJSON_Delete(obj);
    }
    return true;
}

/* Fires per ComponentDef variant (submsg_callback:true), AFTER oneof memset
 * and BEFORE variant body — the window to install Action.cb_args. */
static bool cb_component_setup_action(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    (void)stream;
    action_decode_ctx_t *adctx = (action_decode_ctx_t *)*arg;
    if (!adctx || !field->pData)
        return true;

    moumantai_v1_Action *action = NULL;
    switch (field->tag) {
    case moumantai_v1_ComponentDef_button_tag:
        action = &((moumantai_v1_ButtonComponent *)field->pData)->action;
        break;
    case moumantai_v1_ComponentDef_chip_tag:
        action = &((moumantai_v1_ChipComponent *)field->pData)->action;
        break;
    case moumantai_v1_ComponentDef_switch_toggle_tag:
        action = &((moumantai_v1_SwitchComponent *)field->pData)->action;
        break;
    case moumantai_v1_ComponentDef_check_box_tag:
        action = &((moumantai_v1_CheckBoxComponent *)field->pData)->action;
        break;
    case moumantai_v1_ComponentDef_slider_tag:
        action = &((moumantai_v1_SliderComponent *)field->pData)->action;
        break;
    case moumantai_v1_ComponentDef_select_tag:
        action = &((moumantai_v1_SelectComponent *)field->pData)->action;
        break;
    case moumantai_v1_ComponentDef_date_time_input_tag:
        action = &((moumantai_v1_DateTimeInputComponent *)field->pData)->action;
        break;
    case moumantai_v1_ComponentDef_fab_tag:
        action = &((moumantai_v1_FabComponent *)field->pData)->action;
        break;
    default:
        return true;
    }

    if (action) {
        action->cb_args.funcs.decode = cb_action_args;
        action->cb_args.arg = adctx;
    }
    return true;
}

static bool decode_components_callback(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    (void)field;
    components_decode_ctx_t *ctx = (components_decode_ctx_t *)*arg;
    if (!ctx)
        return false;

    if (ctx->count >= MOUMANTAI_MAX_COMPONENTS) {
        ESP_LOGW(TAG, "components: cap %d reached, dropping rest", MOUMANTAI_MAX_COMPONENTS);
        /* Still consume the stream so decode doesn't fail outright */
        return pb_read(stream, NULL, stream->bytes_left);
    }

    if (ctx->count >= ctx->capacity) {
        int new_cap = ctx->capacity == 0 ? 8 : ctx->capacity * 2;
        if (new_cap > MOUMANTAI_MAX_COMPONENTS)
            new_cap = MOUMANTAI_MAX_COMPONENTS;
        /* PSRAM: face data stays resident across swipes; keeping it out of
         * internal SRAM lets LVGL widget churn finish without fragmenting. */
        moumantai_v1_ComponentDef *nb =
            heap_caps_realloc(ctx->components, new_cap * sizeof(*ctx->components), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!nb) {
            ESP_LOGE(TAG, "components: realloc failed at %d", new_cap);
            return false;
        }
        ctx->components = nb;
        ctx->capacity = new_cap;
    }

    moumantai_v1_ComponentDef *def = &ctx->components[ctx->count];
    *def = (moumantai_v1_ComponentDef)moumantai_v1_ComponentDef_init_zero;

    /* Install the variant callback so Action.cb_args is wired at variant-decode
     * time (the only window after the oneof memset). adctx is stack-local and
     * consumed synchronously by pb_decode below. */
    action_decode_ctx_t adctx = {.def = def, .ctx = ctx};
    def->cb_component.funcs.decode = cb_component_setup_action;
    def->cb_component.arg = &adctx;

    if (!pb_decode(stream, moumantai_v1_ComponentDef_fields, def)) {
        ESP_LOGW(TAG, "ComponentDef decode failed: %s", PB_GET_ERROR(stream));
        return false;
    }
    ctx->count++;
    return true;
}

/* --------------------------------------------------------------------------
 * google.protobuf.Struct → cJSON
 *
 * Key decisions:
 *   - Value.string_value: max_size:512 (fixed buffer). A callback here would
 *     be clobbered by the PB_HTYPE_ONEOF + SUBMSG memset — static buffer
 *     sidesteps the union-clobber hazard.
 *   - Value.struct_value / list_value: submsg_callback:true → nanopb
 *     generates a parent-side cb_kind that fires AFTER union memset, BEFORE
 *     variant body. We dispatch on field->tag and install the inner callback
 *     there. Pre-installing all three variants' callbacks would clobber itself.
 *   - Struct.FieldsEntry.key: max_size:64 (fixed buffer).
 *   The cJSON node is allocated inside cb_kind (when the variant is known).
 * ----------------------------------------------------------------------- */

/* Forward declarations — Struct/Value reference each other via callbacks. */
static bool struct_fields_cb(pb_istream_t *stream, const pb_field_t *field, void **arg);
static bool listvalue_values_cb(pb_istream_t *stream, const pb_field_t *field, void **arg);

/* Recursion-depth guard — the decoder is mutually recursive
 * (struct_fields_cb → pb_decode(FieldsEntry) → cb_value_kind → …) and
 * an adversarial server can blow the WS task's 12 KB stack with deep nesting.
 * Runs only on the WS event task, so a plain static counter suffices. */
#define STRUCT_DECODE_MAX_DEPTH 32
static int s_struct_decode_depth = 0;

/* Output slot for cb_kind: which variant fired and its allocated cJSON node
 * (only set when the variant is struct_value or list_value; primitive
 * variants are read directly from the Value struct). */
typedef struct {
    cJSON *result;
} value_kind_ctx_t;

/* Fires per struct_value / list_value variant, AFTER union memset and BEFORE
 * variant body — allocate the cJSON node and wire the inner field callback. */
static bool cb_value_kind(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    (void)stream;
    value_kind_ctx_t *ctx = (value_kind_ctx_t *)*arg;
    if (!ctx || !field->pData)
        return false;

    switch (field->tag) {
    case google_protobuf_Value_struct_value_tag: {
        google_protobuf_Struct *s = (google_protobuf_Struct *)field->pData;
        cJSON *obj = cJSON_CreateObject();
        if (!obj)
            return false;
        s->fields.funcs.decode = struct_fields_cb;
        s->fields.arg = obj;
        ctx->result = obj; /* ownership transferred to caller via switch below */
        break;
    }
    case google_protobuf_Value_list_value_tag: {
        google_protobuf_ListValue *l = (google_protobuf_ListValue *)field->pData;
        cJSON *arr = cJSON_CreateArray();
        if (!arr)
            return false;
        l->values.funcs.decode = listvalue_values_cb;
        l->values.arg = arr;
        ctx->result = arr;
        break;
    }
    default:
        /* Primitive variants don't fire submsg_callback — handled by the
         * which_kind switch on the caller side. */
        break;
    }
    return true;
}

/** Convert a fully-decoded google_protobuf_Value into a cJSON node. For
 *  struct/list variants, ownership of the cJSON tree built inside cb_value_kind
 *  transfers from ctx->result to the returned node. Returns NULL for unknown
 *  variants. Shared between decode_value_to_cjson and struct_fields_cb. */
static cJSON *value_to_cjson(const google_protobuf_Value *v, value_kind_ctx_t *ctx) {
    switch (v->which_kind) {
    case google_protobuf_Value_null_value_tag:
        return cJSON_CreateNull();
    case google_protobuf_Value_number_value_tag:
        return cJSON_CreateNumber(v->kind.number_value);
    case google_protobuf_Value_string_value_tag:
        return cJSON_CreateString(v->kind.string_value);
    case google_protobuf_Value_bool_value_tag:
        return cJSON_CreateBool(v->kind.bool_value);
    case google_protobuf_Value_struct_value_tag:
    case google_protobuf_Value_list_value_tag: {
        cJSON *node = ctx->result;
        ctx->result = NULL; /* ownership transferred */
        return node;
    }
    default:
        return NULL;
    }
}

/** Decode the Value at the current stream position into a freshly-allocated
 *  cJSON node. Returns NULL on decode failure. */
static cJSON *decode_value_to_cjson(pb_istream_t *stream) {
    google_protobuf_Value v = google_protobuf_Value_init_zero;
    value_kind_ctx_t ctx = {.result = NULL};

    v.cb_kind.funcs.decode = cb_value_kind;
    v.cb_kind.arg = &ctx;

    if (!pb_decode(stream, google_protobuf_Value_fields, &v)) {
        ESP_LOGW(TAG, "Value decode failed: %s", PB_GET_ERROR(stream));
        if (ctx.result)
            cJSON_Delete(ctx.result);
        return NULL;
    }

    cJSON *result = value_to_cjson(&v, &ctx);
    if (ctx.result)
        cJSON_Delete(ctx.result);
    return result;
}

/** Decode one Struct.FieldsEntry, attaching its (key, value) into `parent`. */
static bool struct_fields_cb(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    (void)field;
    cJSON *parent = (cJSON *)*arg;
    if (!parent)
        return false;

    google_protobuf_Struct_FieldsEntry entry = google_protobuf_Struct_FieldsEntry_init_zero;
    value_kind_ctx_t ctx = {.result = NULL};

    /* Wire cb_kind for submsg variants; primitives are read directly
     * from entry.value after pb_decode. */
    entry.value.cb_kind.funcs.decode = cb_value_kind;
    entry.value.cb_kind.arg = &ctx;

    if (s_struct_decode_depth >= STRUCT_DECODE_MAX_DEPTH) {
        ESP_LOGW(TAG, "Struct nesting depth %d exceeds %d — rejecting", s_struct_decode_depth, STRUCT_DECODE_MAX_DEPTH);
        return false;
    }
    s_struct_decode_depth++;
    bool ok = pb_decode(stream, google_protobuf_Struct_FieldsEntry_fields, &entry);
    s_struct_decode_depth--;
    if (!ok) {
        ESP_LOGW(TAG, "Struct.FieldsEntry decode failed: %s", PB_GET_ERROR(stream));
        if (ctx.result)
            cJSON_Delete(ctx.result);
        return false;
    }

    cJSON *node = entry.has_value ? value_to_cjson(&entry.value, &ctx) : NULL;
    if (ctx.result)
        cJSON_Delete(ctx.result);

    if (node && entry.key[0]) {
        cJSON_AddItemToObject(parent, entry.key, node);
    } else if (node) {
        cJSON_Delete(node);
    }
    return true;
}

static bool listvalue_values_cb(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    (void)field;
    cJSON *parent = (cJSON *)*arg;
    if (!parent)
        return false;

    if (s_struct_decode_depth >= STRUCT_DECODE_MAX_DEPTH) {
        ESP_LOGW(TAG, "ListValue nesting depth %d exceeds %d — rejecting", s_struct_decode_depth,
                 STRUCT_DECODE_MAX_DEPTH);
        return false;
    }
    s_struct_decode_depth++;
    cJSON *node = decode_value_to_cjson(stream);
    s_struct_decode_depth--;
    if (node)
        cJSON_AddItemToArray(parent, node);
    return true;
}

/* --------------------------------------------------------------------------
 * Stub: skip ChatMessage.ui_blocks (we don't render inline ui_blocks today).
 * Stub: skip ChatWindowEntry.tool_calls fields (we only need text + role).
 *
 * Note: for ChatWindowMsg.entries (the list of entries), we DO need to decode
 * — supply a callback that grows a heap array of ChatWindowEntry structs.
 * ----------------------------------------------------------------------- */

typedef struct {
    moumantai_v1_ChatWindowEntry *entries;
    int count;
    int capacity;
} chat_entries_ctx_t;

static bool decode_chat_entries_cb(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    (void)field;
    chat_entries_ctx_t *ctx = (chat_entries_ctx_t *)*arg;
    if (!ctx)
        return false;

    if (ctx->count >= ctx->capacity) {
        int new_cap = ctx->capacity == 0 ? 16 : ctx->capacity * 2;
        if (new_cap > 256)
            new_cap = 256; /* hard cap; pathological windows truncate */
        if (ctx->count >= new_cap) {
            ESP_LOGW(TAG, "chat entries: cap %d reached, dropping rest", new_cap);
            return pb_read(stream, NULL, stream->bytes_left);
        }
        moumantai_v1_ChatWindowEntry *nb =
            heap_caps_realloc(ctx->entries, new_cap * sizeof(*ctx->entries), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!nb)
            return false;
        ctx->entries = nb;
        ctx->capacity = new_cap;
    }
    moumantai_v1_ChatWindowEntry *e = &ctx->entries[ctx->count];
    *e = (moumantai_v1_ChatWindowEntry)moumantai_v1_ChatWindowEntry_init_zero;
    /* tool_calls is OPTIONAL MESSAGE google.protobuf.Struct — skip */

    if (!pb_decode(stream, moumantai_v1_ChatWindowEntry_fields, e)) {
        ESP_LOGW(TAG, "ChatWindowEntry decode failed: %s", PB_GET_ERROR(stream));
        return false;
    }
    ctx->count++;
    return true;
}

/* --------------------------------------------------------------------------
 * Top-level dispatch
 * ----------------------------------------------------------------------- */

void proto_decode_dispatch(const uint8_t *bytes, size_t len) {
    /* First pass: peek the envelope tag without parsing the full payload.
     * We read tag 1 (varint = field*8 + wire_type), then if wire_type=2 a
     * length, then the payload bytes. ServerMessage.payload is a oneof so
     * exactly one tagged sub-message appears at the top level (plus any
     * optional unknown fields the server adds, which we'll skip).
     */
    pb_istream_t outer = pb_istream_from_buffer(bytes, len);

    /* Walk top-level tags to find the payload tag. */
    pb_size_t payload_tag = 0;
    const uint8_t *payload_ptr = NULL;
    size_t payload_len_inner = 0;

    while (outer.bytes_left > 0) {
        pb_wire_type_t wt;
        uint32_t tag;
        bool eof;
        if (!pb_decode_tag(&outer, &wt, &tag, &eof)) {
            if (eof)
                break;
            ESP_LOGW(TAG, "envelope: decode_tag failed");
            return;
        }
        if (eof)
            break;

        if (wt == PB_WT_STRING) {
            uint32_t sub_len;
            if (!pb_decode_varint32(&outer, &sub_len))
                return;
            if (sub_len > outer.bytes_left)
                return;

            /* tag matches one of ServerMessage's payload variants */
            if (tag >= 1 && tag <= 13 && payload_tag == 0) {
                payload_tag = (pb_size_t)tag;
                /* Compute pointer into original buffer. */
                size_t consumed = len - outer.bytes_left;
                payload_ptr = bytes + consumed;
                payload_len_inner = sub_len;
            }

            /* Skip past the sub-bytes. */
            if (!pb_read(&outer, NULL, sub_len))
                return;
        } else {
            if (!pb_skip_field(&outer, wt))
                return;
        }
    }

    if (payload_tag == 0 || payload_ptr == NULL) {
        ESP_LOGW(TAG, "ServerMessage with no recognized payload tag");
        return;
    }

    pb_istream_t inner = pb_istream_from_buffer(payload_ptr, payload_len_inner);

    switch (payload_tag) {
    case moumantai_v1_ServerMessage_hello_ok_tag: {
        moumantai_v1_ServerHello hello = moumantai_v1_ServerHello_init_zero;
        if (!pb_decode(&inner, moumantai_v1_ServerHello_fields, &hello)) {
            ESP_LOGW(TAG, "ServerHello decode failed: %s", PB_GET_ERROR(&inner));
            return;
        }
        ESP_LOGI(TAG, "hello-ok: session=%s", hello.session_id);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_HELLO_OK, &hello, sizeof(hello), 0);
        break;
    }
    case moumantai_v1_ServerMessage_chat_tag: {
        moumantai_v1_ChatMessage *msg = calloc(1, sizeof(*msg));
        if (!msg) {
            LOG_ALLOC_DROP("ChatMessage");
            return;
        }
        *msg = (moumantai_v1_ChatMessage)moumantai_v1_ChatMessage_init_zero;
        /* ui_blocks is callback — leave NULL to skip */
        if (!pb_decode(&inner, moumantai_v1_ChatMessage_fields, msg)) {
            ESP_LOGW(TAG, "ChatMessage decode failed: %s", PB_GET_ERROR(&inner));
            free(msg);
            return;
        }
        ESP_LOGI(TAG, "chat: role=%d text=%.40s", (int)msg->role, msg->text);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_CHAT, &msg, sizeof(msg), 0);
        break;
    }
    case moumantai_v1_ServerMessage_chat_window_tag: {
        moumantai_v1_ChatWindowMsg *msg = calloc(1, sizeof(*msg));
        chat_entries_ctx_t *ctx = calloc(1, sizeof(*ctx));
        if (!msg || !ctx) {
            LOG_ALLOC_DROP("ChatWindowMsg");
            free(msg);
            free(ctx);
            return;
        }
        *msg = (moumantai_v1_ChatWindowMsg)moumantai_v1_ChatWindowMsg_init_zero;
        msg->entries.funcs.decode = decode_chat_entries_cb;
        msg->entries.arg = ctx;

        if (!pb_decode(&inner, moumantai_v1_ChatWindowMsg_fields, msg)) {
            ESP_LOGW(TAG, "ChatWindowMsg decode failed: %s", PB_GET_ERROR(&inner));
            free(ctx->entries);
            free(ctx);
            free(msg);
            return;
        }
        ESP_LOGI(TAG, "chatWindow: scope=%s conv=%s entries=%d", msg->scope, msg->conversation_id, ctx->count);

        /* Store ctx in the arg slot so the receiver can find the entries array. */
        msg->entries.arg = ctx; /* receiver casts and frees */
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_CHAT_WINDOW, &msg, sizeof(msg), 0);
        break;
    }
    case moumantai_v1_ServerMessage_chat_update_tag: {
        moumantai_v1_ChatUpdateMsg *msg = calloc(1, sizeof(*msg));
        if (!msg) {
            LOG_ALLOC_DROP("ChatUpdateMsg");
            return;
        }
        *msg = (moumantai_v1_ChatUpdateMsg)moumantai_v1_ChatUpdateMsg_init_zero;
        if (!pb_decode(&inner, moumantai_v1_ChatUpdateMsg_fields, msg)) {
            ESP_LOGW(TAG, "ChatUpdateMsg decode failed: %s", PB_GET_ERROR(&inner));
            free(msg);
            return;
        }
        ESP_LOGI(TAG, "chatUpdate: scope=%s id=%s status=%d", msg->scope, msg->id, (int)msg->status);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_CHAT_UPDATE, &msg, sizeof(msg), 0);
        break;
    }
    case moumantai_v1_ServerMessage_reset_notice_tag: {
        moumantai_v1_ResetNoticeMsg notice = moumantai_v1_ResetNoticeMsg_init_zero;
        if (!pb_decode(&inner, moumantai_v1_ResetNoticeMsg_fields, &notice)) {
            ESP_LOGW(TAG, "ResetNoticeMsg decode failed: %s", PB_GET_ERROR(&inner));
            return;
        }
        ESP_LOGI(TAG, "resetNotice: scope=%s conv=%s", notice.scope, notice.conversation_id);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_RESET_NOTICE, &notice, sizeof(notice), 0);
        break;
    }
    case moumantai_v1_ServerMessage_voice_state_tag: {
        moumantai_v1_VoiceState vs = moumantai_v1_VoiceState_init_zero;
        if (!pb_decode(&inner, moumantai_v1_VoiceState_fields, &vs)) {
            ESP_LOGW(TAG, "VoiceState decode failed: %s", PB_GET_ERROR(&inner));
            return;
        }
        ESP_LOGI(TAG, "voiceState: %d", (int)vs.state);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_VOICE_STATE, &vs, sizeof(vs), 0);
        break;
    }
    case moumantai_v1_ServerMessage_app_list_tag: {
        moumantai_v1_AppListMsg *msg = calloc(1, sizeof(*msg));
        if (!msg) {
            LOG_ALLOC_DROP("AppListMsg");
            return;
        }
        *msg = (moumantai_v1_AppListMsg)moumantai_v1_AppListMsg_init_zero;
        if (!pb_decode(&inner, moumantai_v1_AppListMsg_fields, msg)) {
            ESP_LOGW(TAG, "AppListMsg decode failed: %s", PB_GET_ERROR(&inner));
            free(msg);
            return;
        }
        ESP_LOGI(TAG, "appList: %d apps", (int)msg->apps_count);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_APP_LIST, &msg, sizeof(msg), 0);
        break;
    }
    case moumantai_v1_ServerMessage_face_list_tag: {
        moumantai_v1_FaceListMsg *msg = calloc(1, sizeof(*msg));
        if (!msg) {
            LOG_ALLOC_DROP("FaceListMsg");
            return;
        }
        *msg = (moumantai_v1_FaceListMsg)moumantai_v1_FaceListMsg_init_zero;
        if (!pb_decode(&inner, moumantai_v1_FaceListMsg_fields, msg)) {
            ESP_LOGW(TAG, "FaceListMsg decode failed: %s", PB_GET_ERROR(&inner));
            free(msg);
            return;
        }
        ESP_LOGI(TAG, "faceList: app=%s %d faces", msg->app_id, (int)msg->faces_count);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_FACE_LIST, &msg, sizeof(msg), 0);
        break;
    }
    case moumantai_v1_ServerMessage_face_update_tag: {
        moumantai_v1_FaceUpdateMsg *msg = calloc(1, sizeof(*msg));
        components_decode_ctx_t *cctx = calloc(1, sizeof(*cctx));
        cJSON *data = cJSON_CreateObject();
        if (!msg || !cctx || !data) {
            LOG_ALLOC_DROP("FaceUpdateMsg");
            free(msg);
            free(cctx);
            if (data)
                cJSON_Delete(data);
            return;
        }
        *msg = (moumantai_v1_FaceUpdateMsg)moumantai_v1_FaceUpdateMsg_init_zero;
        msg->components.funcs.decode = decode_components_callback;
        msg->components.arg = cctx;
        msg->data.fields.funcs.decode = struct_fields_cb;
        msg->data.fields.arg = data;

        if (!pb_decode(&inner, moumantai_v1_FaceUpdateMsg_fields, msg)) {
            ESP_LOGW(TAG, "FaceUpdateMsg decode failed: %s", PB_GET_ERROR(&inner));
            if (cctx->args_by_id)
                cJSON_Delete(cctx->args_by_id);
            free(cctx->components);
            free(cctx);
            cJSON_Delete(data);
            free(msg);
            return;
        }

        ESP_LOGI(TAG, "faceUpdate: app=%s face=%s components=%d", msg->app_id, msg->face_id, cctx->count);

        /* Handoff: msg->components.arg = cctx (array + count);
         * msg->data.fields.arg = data (cJSON). */
        msg->data.fields.arg = data; /* receiver retrieves */
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_FACE_UPDATE, &msg, sizeof(msg), 0);
        break;
    }
    case moumantai_v1_ServerMessage_navigate_tag: {
        moumantai_v1_NavigateMsg nav = moumantai_v1_NavigateMsg_init_zero;
        if (!pb_decode(&inner, moumantai_v1_NavigateMsg_fields, &nav)) {
            ESP_LOGW(TAG, "NavigateMsg decode failed: %s", PB_GET_ERROR(&inner));
            return;
        }
        ESP_LOGI(TAG, "navigate: app=%s face=%s", nav.app_id, nav.has_face_id ? nav.face_id : "");
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_NAVIGATE, &nav, sizeof(nav), 0);
        break;
    }
    case moumantai_v1_ServerMessage_error_tag: {
        moumantai_v1_ErrorMessage err = moumantai_v1_ErrorMessage_init_zero;
        if (!pb_decode(&inner, moumantai_v1_ErrorMessage_fields, &err)) {
            ESP_LOGW(TAG, "ErrorMessage decode failed: %s", PB_GET_ERROR(&inner));
            return;
        }
        ESP_LOGW(TAG, "server error: code=%d msg=%s", (int)err.code, err.message);
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_ERROR, &err, sizeof(err), 0);
        break;
    }
    case moumantai_v1_ServerMessage_ui_action_escalated_tag: {
        /* scope is char[64] (max_size:64 in nanopb.options); no callbacks needed. */
        moumantai_v1_UiActionEscalated esc = moumantai_v1_UiActionEscalated_init_zero;
        if (!pb_decode(&inner, moumantai_v1_UiActionEscalated_fields, &esc)) {
            ESP_LOGW(TAG, "UiActionEscalated decode failed: %s", PB_GET_ERROR(&inner));
            return;
        }
        ESP_LOGI(TAG, "uiActionEscalated: scope=%s", esc.scope);
        ui_escalated_evt_t evt = {0};
        strncpy(evt.scope, esc.scope, sizeof(evt.scope) - 1);
        /* Post stack copy — no sequence, not replayed. */
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_UI_ACTION_ESCALATED, &evt, sizeof(evt), 0);
        break;
    }
    case moumantai_v1_ServerMessage_chat_history_tag: {
        moumantai_v1_ChatHistoryMsg *msg = calloc(1, sizeof(*msg));
        chat_entries_ctx_t *ctx = calloc(1, sizeof(*ctx));
        if (!msg || !ctx) {
            LOG_ALLOC_DROP("ChatHistoryMsg");
            free(msg);
            free(ctx);
            return;
        }
        *msg = (moumantai_v1_ChatHistoryMsg)moumantai_v1_ChatHistoryMsg_init_zero;
        msg->entries.funcs.decode = decode_chat_entries_cb;
        msg->entries.arg = ctx;

        if (!pb_decode(&inner, moumantai_v1_ChatHistoryMsg_fields, msg)) {
            ESP_LOGW(TAG, "ChatHistoryMsg decode failed: %s", PB_GET_ERROR(&inner));
            free(ctx->entries);
            free(ctx);
            free(msg);
            return;
        }
        ESP_LOGI(TAG, "chatHistory: scope=%s conv=%s entries=%d has_more=%d", msg->scope, msg->conversation_id,
                 ctx->count, (int)msg->has_more);

        msg->entries.arg = ctx; /* receiver casts and frees */
        esp_event_post(TRANSPORT_EVENTS, TRANSPORT_EVT_CHAT_HISTORY, &msg, sizeof(msg), 0);
        break;
    }
    default:
        ESP_LOGW(TAG, "Unknown ServerMessage payload variant: tag=%u", (unsigned)payload_tag);
        break;
    }
}
