/*
 * test_reconnect_backoff.c — host-side unit test for the pure
 * exponential-backoff delay helper used by the ESP32 transport.
 *
 * Build & run without ESP-IDF:
 *
 *   cc test_reconnect_backoff.c -o test_reconnect_backoff
 *   ./test_reconnect_backoff
 *
 * The function body here is a byte-for-byte copy of
 * compute_reconnect_delay_ms() in transport.c. If you change one, change
 * the other AND the Python mirror (test_reconnect_backoff.py). They
 * should always produce identical output.
 */

#include <assert.h>
#include <stdio.h>
#include <stdint.h>

/* Constants — mirror transport.c */
#define MOUMANTAI_RECONNECT_BASE_MS 1000
#define MOUMANTAI_RECONNECT_MAX_MS 30000
#define MOUMANTAI_RECONNECT_SHIFT_CAP 5

/* Pure function — copy of the definition in transport.c. Keep in sync. */
static uint32_t compute_reconnect_delay_ms(int attempt, uint32_t jitter_rand) {
    if (attempt < 0)
        attempt = 0;
    int shift = attempt > MOUMANTAI_RECONNECT_SHIFT_CAP ? MOUMANTAI_RECONNECT_SHIFT_CAP : attempt;
    uint32_t delay_ms = (uint32_t)MOUMANTAI_RECONNECT_BASE_MS << shift;
    if (delay_ms > MOUMANTAI_RECONNECT_MAX_MS)
        delay_ms = MOUMANTAI_RECONNECT_MAX_MS;
    uint32_t jitter = jitter_rand % (delay_ms / 2 + 1);
    return delay_ms + jitter;
}

/* --------------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------------- */

static int failed = 0;

#define ASSERT_EQ(got, want, msg)                                                                                      \
    do {                                                                                                               \
        if ((got) != (want)) {                                                                                         \
            fprintf(stderr, "FAIL: %s  got=%u expected=%u  (line %d)\n", msg, (unsigned)(got), (unsigned)(want),       \
                    __LINE__);                                                                                         \
            failed++;                                                                                                  \
        }                                                                                                              \
    } while (0)

#define ASSERT_RANGE(got, lo, hi, msg)                                                                                 \
    do {                                                                                                               \
        if ((got) < (lo) || (got) > (hi)) {                                                                            \
            fprintf(stderr, "FAIL: %s  got=%u not in [%u,%u]  (line %d)\n", msg, (unsigned)(got), (unsigned)(lo),      \
                    (unsigned)(hi), __LINE__);                                                                         \
            failed++;                                                                                                  \
        }                                                                                                              \
    } while (0)

static void test_base_delays_no_jitter(void) {
    /* attempt=0 → 1 s, jitter=0 → exactly 1000 ms */
    ASSERT_EQ(compute_reconnect_delay_ms(0, 0), 1000u, "attempt=0,jitter=0");
    /* attempt=0 with jitter=500 raw: 500 % (500+1) = 500 → 1500 ms */
    ASSERT_EQ(compute_reconnect_delay_ms(0, 500), 1500u, "attempt=0,jitter=500");
    /* attempt=1 → 2 s, no jitter */
    ASSERT_EQ(compute_reconnect_delay_ms(1, 0), 2000u, "attempt=1,jitter=0");
    /* attempt=2 → 4 s */
    ASSERT_EQ(compute_reconnect_delay_ms(2, 0), 4000u, "attempt=2,jitter=0");
    /* attempt=3 → 8 s */
    ASSERT_EQ(compute_reconnect_delay_ms(3, 0), 8000u, "attempt=3,jitter=0");
    /* attempt=4 → 16 s */
    ASSERT_EQ(compute_reconnect_delay_ms(4, 0), 16000u, "attempt=4,jitter=0");
}

static void test_cap_at_30s(void) {
    /* attempt=5 → 32 s base, capped to 30 s */
    ASSERT_EQ(compute_reconnect_delay_ms(5, 0), 30000u, "attempt=5,jitter=0");
    /* attempt=10 → still capped to 30 s */
    ASSERT_EQ(compute_reconnect_delay_ms(10, 0), 30000u, "attempt=10,jitter=0");
    /* attempt=100 → still capped */
    ASSERT_EQ(compute_reconnect_delay_ms(100, 0), 30000u, "attempt=100,jitter=0");
}

static void test_negative_attempt_treated_as_zero(void) {
    /* Negative input shouldn't underflow or shift weirdly. */
    ASSERT_EQ(compute_reconnect_delay_ms(-1, 0), 1000u, "attempt=-1,jitter=0");
    ASSERT_EQ(compute_reconnect_delay_ms(-100, 0), 1000u, "attempt=-100,jitter=0");
}

static void test_jitter_bounds(void) {
    /* For attempt=0 (base=1000), jitter ∈ [0, 500]. Probe a wide range of
     * raw "random" inputs and confirm every output lands in [1000, 1500]. */
    for (uint32_t r = 0; r < 100000; r += 997) {
        uint32_t out = compute_reconnect_delay_ms(0, r);
        ASSERT_RANGE(out, 1000u, 1500u, "attempt=0 jitter_bounds");
    }
    /* For attempt=5 (capped to 30000), jitter ∈ [0, 15000]. */
    for (uint32_t r = 0; r < 100000; r += 997) {
        uint32_t out = compute_reconnect_delay_ms(5, r);
        ASSERT_RANGE(out, 30000u, 45000u, "attempt=5 jitter_bounds");
    }
}

static void test_jitter_max_is_inclusive(void) {
    /* The "+1" in `delay_ms / 2 + 1` means the max jitter IS reachable
     * (not off-by-one). Craft a raw value that exercises the high end. */
    /* attempt=0: delay=1000, jitter ∈ [0, 500]. A raw of 500 produces
     * 500 % 501 = 500 — exactly at the boundary. */
    ASSERT_EQ(compute_reconnect_delay_ms(0, 500), 1500u, "jitter_max_inclusive@0");
    /* attempt=1: delay=2000, jitter ∈ [0, 1000]. Raw 1000 produces 1000. */
    ASSERT_EQ(compute_reconnect_delay_ms(1, 1000), 3000u, "jitter_max_inclusive@1");
}

static void test_monotonic_up_to_cap(void) {
    /* Without jitter (raw=0), each successive attempt up to the cap
     * doubles the previous delay. */
    uint32_t prev = compute_reconnect_delay_ms(0, 0);
    for (int a = 1; a <= MOUMANTAI_RECONNECT_SHIFT_CAP; a++) {
        uint32_t cur = compute_reconnect_delay_ms(a, 0);
        if (cur < prev) {
            fprintf(stderr, "FAIL: monotonic: attempt=%d produced %u < prev %u\n", a, cur, prev);
            failed++;
        }
        prev = cur;
    }
}

int main(void) {
    printf("test_base_delays_no_jitter...          ");
    test_base_delays_no_jitter();
    printf("done\n");
    printf("test_cap_at_30s...                     ");
    test_cap_at_30s();
    printf("done\n");
    printf("test_negative_attempt_treated_as_zero.");
    test_negative_attempt_treated_as_zero();
    printf("done\n");
    printf("test_jitter_bounds...                  ");
    test_jitter_bounds();
    printf("done\n");
    printf("test_jitter_max_is_inclusive...        ");
    test_jitter_max_is_inclusive();
    printf("done\n");
    printf("test_monotonic_up_to_cap...            ");
    test_monotonic_up_to_cap();
    printf("done\n");

    if (failed) {
        printf("\n%d assertion(s) FAILED\n", failed);
        return 1;
    }
    printf("\nAll tests passed.\n");
    return 0;
}
