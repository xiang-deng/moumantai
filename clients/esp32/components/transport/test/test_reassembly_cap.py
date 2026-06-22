"""
Host-side verification of the R5b reassembly size-cap predicates.

The full multi-fragment state machine is entangled with the WS event
struct, so the C sibling test (test_reassembly_cap.c) reproduces only
the two pure decision points. Mirror them here byte-for-byte.

Run:
    python3 test_reassembly_cap.py
"""

import sys

MOUMANTAI_REASSEMBLY_MAX_BYTES = 64 * 1024


def should_abort_on_first_fragment(payload_len):
    return payload_len > MOUMANTAI_REASSEMBLY_MAX_BYTES


def should_abort_on_accumulate(accum_len, chunk_len):
    return (accum_len + chunk_len) > MOUMANTAI_REASSEMBLY_MAX_BYTES


failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def test_first_fragment_cap():
    check(not should_abort_on_first_fragment(0), "0 bytes ok")
    check(not should_abort_on_first_fragment(1024), "1 KB ok")
    check(not should_abort_on_first_fragment(32 * 1024), "32 KB ok")
    check(not should_abort_on_first_fragment(64 * 1024), "exactly cap ok")
    check(should_abort_on_first_fragment(64 * 1024 + 1), "just over cap aborts")
    check(should_abort_on_first_fragment(128 * 1024), "2x cap aborts")


def test_accumulate_cap():
    check(not should_abort_on_accumulate(0, 0), "empty no chunk")
    check(not should_abort_on_accumulate(32 * 1024, 16 * 1024), "48 KB ok")
    check(not should_abort_on_accumulate(63 * 1024, 1024), "exactly cap ok")
    check(should_abort_on_accumulate(63 * 1024, 1025), "just past cap aborts")
    check(should_abort_on_accumulate(64 * 1024, 1), "cap + 1 aborts")
    check(should_abort_on_accumulate(10, 64 * 1024), "huge chunk aborts")


if __name__ == "__main__":
    test_first_fragment_cap()
    test_accumulate_cap()
    if failures:
        print(f"FAIL: {len(failures)}")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("All tests passed.")
