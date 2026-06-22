/*
 * test_offline_queue.c — host-side unit test for the pure RAM FIFO
 * used by the ESP32 transport's chat offline queue (R5d).
 *
 * Build & run without ESP-IDF:
 *
 *   cc test_offline_queue.c -o test_offline_queue
 *   ./test_offline_queue
 *
 * The body below is a byte-for-byte copy of the enqueue/peek/clear/size
 * functions in transport.c — with ESP_LOGW reduced to fprintf. If you
 * change one, change both.
 */

#include <assert.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

/* Mirror constants from transport.c / transport_limits.h */
#define MOUMANTAI_MAX_ID_LEN 64
#define OFFLINE_QUEUE_CAP 8
#define OFFLINE_QUEUE_MAX_TEXT 1024
#define OFFLINE_QUEUE_MAX_SESSION MOUMANTAI_MAX_ID_LEN
#define OFFLINE_QUEUE_MAX_MSGID 40

typedef struct {
    char scope[OFFLINE_QUEUE_MAX_SESSION];
    char text[OFFLINE_QUEUE_MAX_TEXT];
    char client_msg_id[OFFLINE_QUEUE_MAX_MSGID];
} offline_chat_entry_t;

static offline_chat_entry_t s_oq[OFFLINE_QUEUE_CAP];
static size_t s_oq_head = 0;
static size_t s_oq_count = 0;

static bool offline_queue_enqueue(const char *scope, const char *text, const char *client_msg_id) {
    if (!text || !client_msg_id)
        return false;
    size_t tlen = strlen(text);
    if (tlen >= OFFLINE_QUEUE_MAX_TEXT) {
        /* ESP_LOGW in the real impl */
        return false;
    }
    if (strlen(client_msg_id) >= OFFLINE_QUEUE_MAX_MSGID)
        return false;
    if (scope && strlen(scope) >= OFFLINE_QUEUE_MAX_SESSION)
        return false;

    if (s_oq_count == OFFLINE_QUEUE_CAP) {
        s_oq_head = (s_oq_head + 1) % OFFLINE_QUEUE_CAP;
        s_oq_count--;
    }
    size_t slot = (s_oq_head + s_oq_count) % OFFLINE_QUEUE_CAP;
    offline_chat_entry_t *e = &s_oq[slot];
    e->scope[0] = '\0';
    if (scope) {
        strncpy(e->scope, scope, OFFLINE_QUEUE_MAX_SESSION - 1);
        e->scope[OFFLINE_QUEUE_MAX_SESSION - 1] = '\0';
    }
    strncpy(e->text, text, OFFLINE_QUEUE_MAX_TEXT - 1);
    e->text[OFFLINE_QUEUE_MAX_TEXT - 1] = '\0';
    strncpy(e->client_msg_id, client_msg_id, OFFLINE_QUEUE_MAX_MSGID - 1);
    e->client_msg_id[OFFLINE_QUEUE_MAX_MSGID - 1] = '\0';
    s_oq_count++;
    return true;
}

static size_t offline_queue_size(void) {
    return s_oq_count;
}

static bool offline_queue_peek(size_t idx, const char **out_scope, const char **out_text,
                               const char **out_client_msg_id) {
    if (idx >= s_oq_count)
        return false;
    size_t slot = (s_oq_head + idx) % OFFLINE_QUEUE_CAP;
    if (out_scope)
        *out_scope = s_oq[slot].scope;
    if (out_text)
        *out_text = s_oq[slot].text;
    if (out_client_msg_id)
        *out_client_msg_id = s_oq[slot].client_msg_id;
    return true;
}

static void offline_queue_clear(void) {
    s_oq_head = 0;
    s_oq_count = 0;
}

/* Test-only: drain by removing the head, to simulate successful flush. */
static bool offline_queue_pop_head(void) {
    if (s_oq_count == 0)
        return false;
    s_oq_head = (s_oq_head + 1) % OFFLINE_QUEUE_CAP;
    s_oq_count--;
    return true;
}

/* --------------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------------- */

static int failed = 0;

#define EXPECT(cond, msg)                                                                                              \
    do {                                                                                                               \
        if (!(cond)) {                                                                                                 \
            fprintf(stderr, "FAIL (%s:%d): %s\n", __FILE__, __LINE__, msg);                                            \
            failed++;                                                                                                  \
        }                                                                                                              \
    } while (0)

static void test_enqueue_three_fifo_order(void) {
    offline_queue_clear();
    EXPECT(offline_queue_size() == 0, "fresh size=0");

    EXPECT(offline_queue_enqueue("s1", "hello", "m1"), "enq 1");
    EXPECT(offline_queue_enqueue("s1", "world", "m2"), "enq 2");
    EXPECT(offline_queue_enqueue("s2", "goodbye", "m3"), "enq 3");
    EXPECT(offline_queue_size() == 3, "size=3");

    const char *sk, *tx, *mi;
    EXPECT(offline_queue_peek(0, &sk, &tx, &mi), "peek 0 ok");
    EXPECT(strcmp(sk, "s1") == 0 && strcmp(tx, "hello") == 0 && strcmp(mi, "m1") == 0, "FIFO idx=0 is oldest");
    EXPECT(offline_queue_peek(1, &sk, &tx, &mi), "peek 1 ok");
    EXPECT(strcmp(sk, "s1") == 0 && strcmp(tx, "world") == 0 && strcmp(mi, "m2") == 0, "FIFO idx=1");
    EXPECT(offline_queue_peek(2, &sk, &tx, &mi), "peek 2 ok");
    EXPECT(strcmp(sk, "s2") == 0 && strcmp(tx, "goodbye") == 0 && strcmp(mi, "m3") == 0, "FIFO idx=2 is newest");
    EXPECT(!offline_queue_peek(3, &sk, &tx, &mi), "peek past end rejected");
}

static void test_overflow_drops_oldest(void) {
    offline_queue_clear();
    char text[16];
    char msgid[16];
    for (int i = 0; i < 10; i++) {
        snprintf(text, sizeof(text), "t%d", i);
        snprintf(msgid, sizeof(msgid), "m%d", i);
        EXPECT(offline_queue_enqueue("s", text, msgid), "enq");
    }
    EXPECT(offline_queue_size() == OFFLINE_QUEUE_CAP, "cap holds at 8");

    /* The oldest two (m0, m1) were dropped; queue should be m2..m9. */
    const char *sk, *tx, *mi;
    offline_queue_peek(0, &sk, &tx, &mi);
    EXPECT(strcmp(mi, "m2") == 0, "head is m2 (m0/m1 evicted)");
    offline_queue_peek(OFFLINE_QUEUE_CAP - 1, &sk, &tx, &mi);
    EXPECT(strcmp(mi, "m9") == 0, "tail is m9");
}

static void test_clear(void) {
    offline_queue_clear();
    offline_queue_enqueue("s", "a", "m1");
    offline_queue_enqueue("s", "b", "m2");
    EXPECT(offline_queue_size() == 2, "size=2 before clear");
    offline_queue_clear();
    EXPECT(offline_queue_size() == 0, "size=0 after clear");
    const char *sk, *tx, *mi;
    EXPECT(!offline_queue_peek(0, &sk, &tx, &mi), "cleared peek rejected");
}

static void test_text_cap_rejects(void) {
    offline_queue_clear();
    char big[OFFLINE_QUEUE_MAX_TEXT + 16];
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    EXPECT(!offline_queue_enqueue("s", big, "m1"), "oversized text rejected");
    EXPECT(offline_queue_size() == 0, "size unchanged after reject");

    /* Exactly MAX_TEXT - 1 bytes fits (null terminator takes the last). */
    char atcap[OFFLINE_QUEUE_MAX_TEXT];
    memset(atcap, 'y', sizeof(atcap) - 1);
    atcap[sizeof(atcap) - 1] = '\0'; /* length = MAX_TEXT - 1 */
    EXPECT(offline_queue_enqueue("s", atcap, "m1"), "at-cap text accepted");
    EXPECT(offline_queue_size() == 1, "accepted increments size");
}

static void test_null_args_rejected(void) {
    offline_queue_clear();
    EXPECT(!offline_queue_enqueue("s", NULL, "m1"), "NULL text rejected");
    EXPECT(!offline_queue_enqueue("s", "hi", NULL), "NULL msg_id rejected");
    EXPECT(offline_queue_size() == 0, "no enqueue on NULL");
}

static void test_drain_preserves_order(void) {
    /* Simulate "flush on reconnect" as successive pop_head calls and check
     * the order we'd send to the wire. */
    offline_queue_clear();
    offline_queue_enqueue("s", "first", "m1");
    offline_queue_enqueue("s", "second", "m2");
    offline_queue_enqueue("s", "third", "m3");

    const char *sk, *tx, *mi;
    offline_queue_peek(0, &sk, &tx, &mi);
    EXPECT(strcmp(tx, "first") == 0, "drain: first");
    offline_queue_pop_head();
    offline_queue_peek(0, &sk, &tx, &mi);
    EXPECT(strcmp(tx, "second") == 0, "drain: second");
    offline_queue_pop_head();
    offline_queue_peek(0, &sk, &tx, &mi);
    EXPECT(strcmp(tx, "third") == 0, "drain: third");
    offline_queue_pop_head();
    EXPECT(offline_queue_size() == 0, "drain: empty");
}

static void test_wraparound(void) {
    /* Fill to cap, drain a couple, add more — exercises the ring wrap. */
    offline_queue_clear();
    char t[8], m[8];
    for (int i = 0; i < OFFLINE_QUEUE_CAP; i++) {
        snprintf(t, sizeof(t), "t%d", i);
        snprintf(m, sizeof(m), "m%d", i);
        offline_queue_enqueue("s", t, m);
    }
    offline_queue_pop_head(); /* drain t0 */
    offline_queue_pop_head(); /* drain t1 */
    EXPECT(offline_queue_size() == 6, "size=6 after drain 2");

    offline_queue_enqueue("s", "new1", "mn1");
    offline_queue_enqueue("s", "new2", "mn2");
    EXPECT(offline_queue_size() == 8, "refilled to cap");

    /* Head should now be t2, tail should be new2. */
    const char *sk, *tx, *mi;
    offline_queue_peek(0, &sk, &tx, &mi);
    EXPECT(strcmp(mi, "m2") == 0, "wraparound head=m2");
    offline_queue_peek(7, &sk, &tx, &mi);
    EXPECT(strcmp(mi, "mn2") == 0, "wraparound tail=mn2");
}

int main(void) {
    printf("test_enqueue_three_fifo_order...   ");
    test_enqueue_three_fifo_order();
    printf("done\n");
    printf("test_overflow_drops_oldest...      ");
    test_overflow_drops_oldest();
    printf("done\n");
    printf("test_clear...                      ");
    test_clear();
    printf("done\n");
    printf("test_text_cap_rejects...           ");
    test_text_cap_rejects();
    printf("done\n");
    printf("test_null_args_rejected...         ");
    test_null_args_rejected();
    printf("done\n");
    printf("test_drain_preserves_order...      ");
    test_drain_preserves_order();
    printf("done\n");
    printf("test_wraparound...                 ");
    test_wraparound();
    printf("done\n");

    if (failed) {
        printf("\n%d assertion(s) FAILED\n", failed);
        return 1;
    }
    printf("\nAll tests passed.\n");
    return 0;
}
