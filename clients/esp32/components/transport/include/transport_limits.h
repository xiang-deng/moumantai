#pragma once

/*
 * transport_limits.h — sizing constants + transport-only enums shared
 * across transport and consumers (renderer, state).
 *
 * Lives under transport because:
 *   - `connection_state_t` is purely client-side (never crosses the wire)
 *   - the size constants are tied to the WebSocket / nanopb buffer caps
 *   - keeping these here lets `state` depend on `transport` (the natural
 *     direction; state subscribes to TRANSPORT_EVENTS), without reversing
 *     the dependency for limit definitions.
 */

#include "moumantai/v1/enums.pb.h"

#define MOUMANTAI_MAX_APPS 32
#define MOUMANTAI_MAX_FACES 8
#define MOUMANTAI_MAX_COMPONENTS 64
#define MOUMANTAI_MAX_ID_LEN 64
#define MOUMANTAI_MAX_LABEL_LEN 64

typedef enum {
    CONN_DISCONNECTED = 0,
    CONN_CONNECTING,
    CONN_CONNECTED,
    CONN_HELLO_SENT,
    CONN_SESSION_ACTIVE,
} connection_state_t;

/* Voice-pipeline state alias to the typed protobuf enum. */
typedef moumantai_v1_VoiceStateValue voice_state_t;

#define VOICE_IDLE moumantai_v1_VoiceStateValue_VOICE_STATE_VALUE_IDLE
#define VOICE_LISTENING moumantai_v1_VoiceStateValue_VOICE_STATE_VALUE_LISTENING
#define VOICE_THINKING moumantai_v1_VoiceStateValue_VOICE_STATE_VALUE_THINKING
#define VOICE_SPEAKING moumantai_v1_VoiceStateValue_VOICE_STATE_VALUE_SPEAKING
