#pragma once

/*
 * state_types.h — cached-state structs for faces, apps, and the client.
 *
 * Wire types come from generated nanopb headers. Transport primitives
 * (limits, connection_state_t, voice_state_t) live in transport_limits.h
 * and are re-exported here so callers need not include transport headers.
 */

#include <stdbool.h>
#include <stdint.h>
#include "cJSON.h"
#include "moumantai/v1/components.pb.h"
#include "transport_limits.h"

/* --------------------------------------------------------------------------
 * Cached face / app / client state.
 * ----------------------------------------------------------------------- */

typedef struct {
    char face_id[MOUMANTAI_MAX_ID_LEN];
    char label[MOUMANTAI_MAX_LABEL_LEN];
    int position;
    moumantai_v1_ComponentDef *components; /* heap array, owned */
    int num_components;
    cJSON *data; /* face data model, owned */
    /* component_id → cJSON args sidecar. NULL when no component had Action.args.
     * Read via state_get_action_args(face, component_id) at wire_action time. */
    cJSON *action_args;
} face_state_t;

typedef struct {
    char app_id[MOUMANTAI_MAX_ID_LEN];
    char label[MOUMANTAI_MAX_LABEL_LEN];
    char icon[64];
    int position;
    face_state_t *faces; /* heap array, owned */
    int num_faces;
    int active_face_idx;
} app_state_t;

typedef struct {
    char session_id[MOUMANTAI_MAX_ID_LEN];
    connection_state_t conn_state;
    voice_state_t voice;
    app_state_t *apps; /* heap array, owned */
    int num_apps;
    int active_app_idx;
} client_state_t;
