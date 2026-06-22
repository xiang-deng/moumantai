/*
 * test_reassembly_cap.c — host-side test for the R5b multi-fragment
 * reassembly size cap (64 KB).
 *
 * The reassembly state machine in transport.c is entangled with the WS
 * event struct, but the cap decision is a small pure predicate. We
 * reproduce the exact conditions here and confirm the abort triggers.
 *
 *   cc test_reassembly_cap.c -o test_reassembly_cap
 *   ./test_reassembly_cap
 */

#include <stdio.h>
#include <stdbool.h>
#include <stdint.h>

/* Mirror constants from transport.c */
#define MOUMANTAI_REASSEMBLY_MAX_BYTES (64 * 1024)

/* The two predicates used in the WS_EVENT_DATA handler (multi-fragment
 * branch). Keep byte-identical with transport.c. */
static bool should_abort_on_first_fragment(int payload_len) {
    return payload_len > MOUMANTAI_REASSEMBLY_MAX_BYTES;
}

static bool should_abort_on_accumulate(int accum_len, int chunk_len) {
    return (accum_len + chunk_len) > MOUMANTAI_REASSEMBLY_MAX_BYTES;
}

static int failed = 0;
#define EXPECT(cond, msg)                                                                                              \
    do {                                                                                                               \
        if (!(cond)) {                                                                                                 \
            fprintf(stderr, "FAIL: %s (line %d)\n", msg, __LINE__);                                                    \
            failed++;                                                                                                  \
        }                                                                                                              \
    } while (0)

static void test_first_fragment_cap(void) {
    EXPECT(!should_abort_on_first_fragment(0), "0 bytes ok");
    EXPECT(!should_abort_on_first_fragment(1024), "1 KB ok");
    EXPECT(!should_abort_on_first_fragment(32 * 1024), "32 KB ok");
    EXPECT(!should_abort_on_first_fragment(64 * 1024), "exactly cap ok");
    EXPECT(should_abort_on_first_fragment(64 * 1024 + 1), "just over cap aborts");
    EXPECT(should_abort_on_first_fragment(128 * 1024), "2x cap aborts");
}

static void test_accumulate_cap(void) {
    /* A small buffer that's now getting a large chunk — would exceed. */
    EXPECT(!should_abort_on_accumulate(0, 0), "empty no chunk");
    EXPECT(!should_abort_on_accumulate(32 * 1024, 16 * 1024), "48 KB accumulated ok");
    EXPECT(!should_abort_on_accumulate(63 * 1024, 1024), "exactly at cap ok");
    EXPECT(should_abort_on_accumulate(63 * 1024, 1025), "just past cap aborts");
    EXPECT(should_abort_on_accumulate(64 * 1024, 1), "cap + 1 aborts");
    EXPECT(should_abort_on_accumulate(10, 64 * 1024), "huge chunk on tiny buffer aborts");
}

int main(void) {
    printf("test_first_fragment_cap...  ");
    test_first_fragment_cap();
    printf("done\n");
    printf("test_accumulate_cap...      ");
    test_accumulate_cap();
    printf("done\n");

    if (failed) {
        printf("\n%d assertion(s) FAILED\n", failed);
        return 1;
    }
    printf("\nAll tests passed.\n");
    return 0;
}
