#include "action_dispatch.h"
#include "data_model.h"
#include "state.h"
#include "transport.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_random.h"
#include "esp_event.h"

static const char *TAG = "action";

/* --------------------------------------------------------------------------
 * Back-navigation — TopBar nav button. Local-only (no server round-trip).
 * ----------------------------------------------------------------------- */

esp_err_t action_dispatch_back(const char *surface_id, const char *source_component_id) {
    (void)surface_id;
    (void)source_component_id;
    ESP_LOGD(TAG, "back navigation (no-op on proto wire)");
    return ESP_OK;
}

/* --------------------------------------------------------------------------
 * Action dispatch — typed `Action { tool, args }` → InvokeToolMsg over WS.
 * Same wire path as the LLM's executeTool; triggered by user tap.
 * `args` comes from the per-face cJSON sidecar (state_get_action_args) and
 * round-trips through proto_encode_invoke_tool's struct_fields_encode_cb.
 * ----------------------------------------------------------------------- */

/* Generate a client_request_id. Two esp_random() draws give 64-bit uniqueness,
 * sufficient for tap-rate volume on a panel. */
static void gen_request_id(char *out, size_t cap) {
    uint32_t a = esp_random();
    uint32_t b = esp_random();
    snprintf(out, cap, "esp-%08lx%08lx", (unsigned long)a, (unsigned long)b);
}

/* Return pointer past the ':' in "appId:faceId", or "" if absent. */
static const char *face_id_of(const char *surface_id) {
    if (!surface_id)
        return "";
    const char *colon = strchr(surface_id, ':');
    return colon ? colon + 1 : "";
}

esp_err_t action_dispatch_from_def(const moumantai_v1_Action *action, const cJSON *args, const char *surface_id,
                                   const char *source_component_id) {
    if (!action)
        return ESP_OK;
    if (!action->tool[0]) {
        ESP_LOGD(TAG, "action with empty tool name (component=%s) — skipping",
                 source_component_id ? source_component_id : "?");
        return ESP_OK;
    }

    char request_id[40];
    gen_request_id(request_id, sizeof(request_id));

    const char *face_id = face_id_of(surface_id);
    ESP_LOGI(TAG, "invoke_tool: tool=%s face=%s req=%s args=%s", action->tool, face_id, request_id,
             args ? "yes" : "(empty)");

    esp_err_t err = transport_send_invoke_tool(action->tool, face_id, request_id, args);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "transport_send_invoke_tool failed: 0x%x (tool=%s)", err, action->tool);
    }
    return err;
}
