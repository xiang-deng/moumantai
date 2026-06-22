#pragma once

#include <stdint.h>
#include "state_types.h"

/* --------------------------------------------------------------------------
 * DisplayState — time-aware UI indicator derived from connection_state_t.
 *   < 2 s non-connected  → CONNECTED (flap suppression)
 *   2–14.999 s           → RECONNECTING
 *   ≥ 15 s               → OFFLINE
 * ----------------------------------------------------------------------- */

/** How long a non-CONNECTED state is debounced before RECONNECTING shows. */
#define MOUMANTAI_RECONNECT_INDICATOR_DELAY_MS 2000
/** When non-CONNECTED persists this long, escalate to OFFLINE. */
#define MOUMANTAI_OFFLINE_THRESHOLD_MS 15000

typedef enum {
    DISPLAY_CONNECTED = 0,
    DISPLAY_RECONNECTING,
    DISPLAY_OFFLINE,
} display_state_t;

/**
 * Pure derivation — no globals. Given the transport state and the monotonic
 * timestamp (esp_timer_get_time() scale, µs) at which it first became
 * non-SESSION_ACTIVE, return the current display state.
 * last_non_connected_us is ignored when cur == CONN_SESSION_ACTIVE.
 */
display_state_t derive_display_state(connection_state_t cur, uint64_t now_us, uint64_t last_non_connected_us);

/** Start the 500 ms poll timer. Posts STATE_EVT_DISPLAY_CHANGED on transitions.
 *  Idempotent. */
void display_state_init(void);

/** Read the current derived display state. Lock-free. */
display_state_t display_state_get(void);
