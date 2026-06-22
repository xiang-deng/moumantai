/*
 * test_display_state.c — host-side unit test for derive_display_state().
 *
 * Build & run without ESP-IDF:
 *   cc -I ../include -I ../../transport/include \
 *      test_display_state.c -o test_display_state && ./test_display_state
 *
 * Compiles in isolation (no FreeRTOS / esp_event / esp_timer deps).
 */

#include <assert.h>
#include <stdio.h>
#include <stdint.h>

/* Self-contained declarations (copied from display_state.h / transport_limits.h
 * to avoid ESP-IDF header dependency). Keep in sync with the real headers. */

typedef enum {
    CONN_DISCONNECTED = 0,
    CONN_CONNECTING,
    CONN_CONNECTED,
    CONN_HELLO_SENT,
    CONN_SESSION_ACTIVE,
} connection_state_t;

typedef enum {
    DISPLAY_CONNECTED = 0,
    DISPLAY_RECONNECTING,
    DISPLAY_OFFLINE,
} display_state_t;

#define MOUMANTAI_RECONNECT_INDICATOR_DELAY_MS 2000
#define MOUMANTAI_OFFLINE_THRESHOLD_MS 15000

/* Can't link display_state.c (pulls in esp_timer) — copy the pure function
 * body here. Keep byte-identical with production; diff on every PR. */
display_state_t derive_display_state(connection_state_t cur, uint64_t now_us, uint64_t last_non_connected_us) {
    if (cur == CONN_SESSION_ACTIVE) {
        return DISPLAY_CONNECTED;
    }
    if (last_non_connected_us == 0 || now_us < last_non_connected_us) {
        return DISPLAY_CONNECTED;
    }
    uint64_t elapsed_ms = (now_us - last_non_connected_us) / 1000ULL;
    if (elapsed_ms < (uint64_t)MOUMANTAI_RECONNECT_INDICATOR_DELAY_MS) {
        return DISPLAY_CONNECTED;
    }
    if (elapsed_ms < (uint64_t)MOUMANTAI_OFFLINE_THRESHOLD_MS) {
        return DISPLAY_RECONNECTING;
    }
    return DISPLAY_OFFLINE;
}

/* Tests — virtual clock (microseconds), no real sleep. */

#define ASSERT_EQ(a, b, msg)                                                                                           \
    do {                                                                                                               \
        if ((a) != (b)) {                                                                                              \
            fprintf(stderr, "FAIL: %s  got=%d expected=%d  (line %d)\n", msg, (int)(a), (int)(b), __LINE__);           \
            return 1;                                                                                                  \
        }                                                                                                              \
    } while (0)

static int test_session_active_always_connected(void) {
    /* SESSION_ACTIVE always returns CONNECTED regardless of timestamps. */
    uint64_t one_hour_us = 3600ULL * 1000 * 1000;
    ASSERT_EQ(derive_display_state(CONN_SESSION_ACTIVE, one_hour_us, 0), DISPLAY_CONNECTED, "active@now=1h");
    ASSERT_EQ(derive_display_state(CONN_SESSION_ACTIVE, one_hour_us, 1), DISPLAY_CONNECTED, "active@stale-ts");
    ASSERT_EQ(derive_display_state(CONN_SESSION_ACTIVE, 0, 0), DISPLAY_CONNECTED, "active@zero");
    return 0;
}

static int test_flap_under_2s_stays_connected(void) {
    /* 1s elapsed — debounce window not yet crossed. */
    uint64_t drop_at = 10ULL * 1000 * 1000;
    uint64_t now = drop_at + 1ULL * 1000 * 1000; /* +1s */
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, now, drop_at), DISPLAY_CONNECTED, "disconnected@1s");
    ASSERT_EQ(derive_display_state(CONN_CONNECTING, now, drop_at), DISPLAY_CONNECTED, "connecting@1s");
    ASSERT_EQ(derive_display_state(CONN_HELLO_SENT, now, drop_at), DISPLAY_CONNECTED, "hello_sent@1s");

    /* 1.999 s — still under the 2 s threshold. */
    now = drop_at + 1999ULL * 1000;
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, now, drop_at), DISPLAY_CONNECTED, "disconnected@1999ms");
    return 0;
}

static int test_reconnecting_2s_to_15s(void) {
    uint64_t drop_at = 10ULL * 1000 * 1000;

    /* Exactly 2 s — threshold crossed. */
    uint64_t now = drop_at + 2ULL * 1000 * 1000;
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, now, drop_at), DISPLAY_RECONNECTING, "disconnected@2s");
    ASSERT_EQ(derive_display_state(CONN_CONNECTING, now, drop_at), DISPLAY_RECONNECTING, "connecting@2s");

    /* 7.5 s — well inside the window. */
    now = drop_at + 7500ULL * 1000;
    ASSERT_EQ(derive_display_state(CONN_HELLO_SENT, now, drop_at), DISPLAY_RECONNECTING, "hello@7.5s");

    /* 14.999 s — still under the 15 s escalation. */
    now = drop_at + 14999ULL * 1000;
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, now, drop_at), DISPLAY_RECONNECTING, "disconnected@14999ms");
    return 0;
}

static int test_offline_at_or_above_15s(void) {
    uint64_t drop_at = 10ULL * 1000 * 1000;

    /* 15 s exactly. */
    uint64_t now = drop_at + 15ULL * 1000 * 1000;
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, now, drop_at), DISPLAY_OFFLINE, "disconnected@15s");

    /* 5 minutes. */
    now = drop_at + 300ULL * 1000 * 1000;
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, now, drop_at), DISPLAY_OFFLINE, "disconnected@5min");
    ASSERT_EQ(derive_display_state(CONN_HELLO_SENT, now, drop_at), DISPLAY_OFFLINE, "hello@5min");
    return 0;
}

static int test_edge_cases(void) {
    /* Cold boot: last_non_connected_us == 0 and cur != SESSION_ACTIVE.
     * Treat as CONNECTED so the first tick can stamp the timestamp. */
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, 5000, 0), DISPLAY_CONNECTED, "cold_boot@zero_ts");

    /* now_us < last_non_connected_us — clock skew; monotonic should prevent
     * this, but stay safe. */
    ASSERT_EQ(derive_display_state(CONN_DISCONNECTED, 1000, 5000), DISPLAY_CONNECTED, "skew");
    return 0;
}

int main(void) {
    int failed = 0;

    printf("test_session_active_always_connected...  ");
    if (test_session_active_always_connected()) {
        failed++;
        printf("FAIL\n");
    } else
        printf("ok\n");

    printf("test_flap_under_2s_stays_connected...    ");
    if (test_flap_under_2s_stays_connected()) {
        failed++;
        printf("FAIL\n");
    } else
        printf("ok\n");

    printf("test_reconnecting_2s_to_15s...           ");
    if (test_reconnecting_2s_to_15s()) {
        failed++;
        printf("FAIL\n");
    } else
        printf("ok\n");

    printf("test_offline_at_or_above_15s...          ");
    if (test_offline_at_or_above_15s()) {
        failed++;
        printf("FAIL\n");
    } else
        printf("ok\n");

    printf("test_edge_cases...                       ");
    if (test_edge_cases()) {
        failed++;
        printf("FAIL\n");
    } else
        printf("ok\n");

    if (failed) {
        printf("\n%d test(s) FAILED\n", failed);
        return 1;
    }
    printf("\nAll tests passed.\n");
    return 0;
}
