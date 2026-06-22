"""
Host-side verification of the ESP32 transport offline chat queue (R5d).

Byte-for-byte Python port of the ring-buffer helpers in transport.c. Runs
with just Python 3 — no C toolchain required. If the C changes, update
both this file and test_offline_queue.c.

Run:
    python3 test_offline_queue.py
"""

import sys

# Constants — mirror transport.c
OFFLINE_QUEUE_CAP = 8
OFFLINE_QUEUE_MAX_TEXT = 1024
OFFLINE_QUEUE_MAX_SESSION = 64
OFFLINE_QUEUE_MAX_MSGID = 40


class OfflineQueue:
    """Python port of the s_oq ring buffer + enqueue/peek/clear semantics."""

    def __init__(self):
        self._buf = [None] * OFFLINE_QUEUE_CAP
        self._head = 0
        self._count = 0

    def enqueue(self, scope, text, client_msg_id):
        if text is None or client_msg_id is None:
            return False
        # Null-terminator semantics: strlen >= max → reject.
        if len(text) >= OFFLINE_QUEUE_MAX_TEXT:
            return False
        if len(client_msg_id) >= OFFLINE_QUEUE_MAX_MSGID:
            return False
        if scope is not None and len(scope) >= OFFLINE_QUEUE_MAX_SESSION:
            return False

        if self._count == OFFLINE_QUEUE_CAP:
            # Drop oldest.
            self._head = (self._head + 1) % OFFLINE_QUEUE_CAP
            self._count -= 1

        slot = (self._head + self._count) % OFFLINE_QUEUE_CAP
        self._buf[slot] = {
            "scope": scope if scope is not None else "",
            "text": text,
            "client_msg_id": client_msg_id,
        }
        self._count += 1
        return True

    def size(self):
        return self._count

    def peek(self, idx):
        if idx >= self._count:
            return None
        slot = (self._head + idx) % OFFLINE_QUEUE_CAP
        return self._buf[slot]

    def clear(self):
        self._head = 0
        self._count = 0

    def pop_head(self):
        """Test-only: simulate successful flush of one entry."""
        if self._count == 0:
            return False
        self._head = (self._head + 1) % OFFLINE_QUEUE_CAP
        self._count -= 1
        return True


# ---- Tests -----------------------------------------------------------------

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def test_enqueue_three_fifo_order():
    q = OfflineQueue()
    check(q.size() == 0, "fresh size=0")
    check(q.enqueue("s1", "hello", "m1"), "enq 1")
    check(q.enqueue("s1", "world", "m2"), "enq 2")
    check(q.enqueue("s2", "goodbye", "m3"), "enq 3")
    check(q.size() == 3, "size=3")

    e0 = q.peek(0)
    check(
        e0["scope"] == "s1" and e0["text"] == "hello" and e0["client_msg_id"] == "m1",
        "FIFO idx=0 oldest",
    )
    e1 = q.peek(1)
    check(e1["text"] == "world", "FIFO idx=1")
    e2 = q.peek(2)
    check(e2["text"] == "goodbye", "FIFO idx=2 newest")
    check(q.peek(3) is None, "peek past end is None")


def test_overflow_drops_oldest():
    q = OfflineQueue()
    for i in range(10):
        q.enqueue("s", f"t{i}", f"m{i}")
    check(q.size() == OFFLINE_QUEUE_CAP, "cap holds at 8")
    check(q.peek(0)["client_msg_id"] == "m2", "head=m2 (m0/m1 evicted)")
    check(q.peek(OFFLINE_QUEUE_CAP - 1)["client_msg_id"] == "m9", "tail=m9")


def test_clear():
    q = OfflineQueue()
    q.enqueue("s", "a", "m1")
    q.enqueue("s", "b", "m2")
    check(q.size() == 2, "size=2 before clear")
    q.clear()
    check(q.size() == 0, "size=0 after clear")
    check(q.peek(0) is None, "cleared peek rejected")


def test_text_cap_rejects():
    q = OfflineQueue()
    big = "x" * (OFFLINE_QUEUE_MAX_TEXT + 16)
    check(not q.enqueue("s", big, "m1"), "oversized text rejected")
    check(q.size() == 0, "size unchanged after reject")

    at_cap = "y" * (OFFLINE_QUEUE_MAX_TEXT - 1)
    check(q.enqueue("s", at_cap, "m1"), "at-cap text accepted")
    check(q.size() == 1, "accepted increments size")


def test_null_args_rejected():
    q = OfflineQueue()
    check(not q.enqueue("s", None, "m1"), "None text rejected")
    check(not q.enqueue("s", "hi", None), "None msg_id rejected")
    check(q.size() == 0, "no enqueue on None")


def test_drain_preserves_order():
    q = OfflineQueue()
    q.enqueue("s", "first", "m1")
    q.enqueue("s", "second", "m2")
    q.enqueue("s", "third", "m3")
    check(q.peek(0)["text"] == "first", "drain: first")
    q.pop_head()
    check(q.peek(0)["text"] == "second", "drain: second")
    q.pop_head()
    check(q.peek(0)["text"] == "third", "drain: third")
    q.pop_head()
    check(q.size() == 0, "drain: empty")


def test_wraparound():
    q = OfflineQueue()
    for i in range(OFFLINE_QUEUE_CAP):
        q.enqueue("s", f"t{i}", f"m{i}")
    q.pop_head()
    q.pop_head()
    check(q.size() == 6, "size=6 after drain 2")
    q.enqueue("s", "new1", "mn1")
    q.enqueue("s", "new2", "mn2")
    check(q.size() == 8, "refilled to cap")
    check(q.peek(0)["client_msg_id"] == "m2", "wraparound head=m2")
    check(q.peek(7)["client_msg_id"] == "mn2", "wraparound tail=mn2")


if __name__ == "__main__":
    test_enqueue_three_fifo_order()
    test_overflow_drops_oldest()
    test_clear()
    test_text_cap_rejects()
    test_null_args_rejected()
    test_drain_preserves_order()
    test_wraparound()

    if failures:
        print(f"FAIL: {len(failures)} assertion(s)")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("All tests passed.")
