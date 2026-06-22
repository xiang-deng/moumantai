#pragma once

#include "esp_err.h"
#include "cJSON.h"
#include "moumantai/v1/actions.pb.h"

/*
 * action_dispatch — component tap → InvokeToolMsg over WebSocket.
 *
 * `args` comes from the per-face cJSON sidecar (state_get_action_args).
 * `__back` (TopBar nav button) is a local-only stack pop.
 */

/** Synthetic back-navigation action wired by TopBar's nav button. */
esp_err_t action_dispatch_back(const char *surface_id, const char *source_component_id);

/** Dispatch a component tap. Encodes `args` into InvokeToolMsg.args Struct.
 *  `args` is borrowed (lifetime tied to face_state); NULL → empty Struct. */
esp_err_t action_dispatch_from_def(const moumantai_v1_Action *action, const cJSON *args, const char *surface_id,
                                   const char *source_component_id);
