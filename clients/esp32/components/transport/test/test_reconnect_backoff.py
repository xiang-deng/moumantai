"""
Host-side verification of transport.c::compute_reconnect_delay_ms.

Byte-for-byte Python port of the C function. Runs anywhere with Python 3;
no C toolchain required.

If compute_reconnect_delay_ms() in transport.c changes, update both this
file and test_reconnect_backoff.c. They should always produce identical
results.

Run:
    python3 test_reconnect_backoff.py
"""

import sys

# Constants — mirror transport.c
MOUMANTAI_RECONNECT_BASE_MS = 1000
MOUMANTAI_RECONNECT_MAX_MS = 30000
MOUMANTAI_RECONNECT_SHIFT_CAP = 5


def compute_reconnect_delay_ms(attempt, jitter_rand):
    """Byte-for-byte port of the C body. uint32 semantics are respected
    via the modulo / truncation we use."""
    if attempt < 0:
        attempt = 0
    shift = (
        MOUMANTAI_RECONNECT_SHIFT_CAP
        if attempt > MOUMANTAI_RECONNECT_SHIFT_CAP
        else attempt
    )
    delay_ms = (MOUMANTAI_RECONNECT_BASE_MS << shift) & 0xFFFFFFFF
    if delay_ms > MOUMANTAI_RECONNECT_MAX_MS:
        delay_ms = MOUMANTAI_RECONNECT_MAX_MS
    jitter = jitter_rand % (delay_ms // 2 + 1)
    return (delay_ms + jitter) & 0xFFFFFFFF


# ---- Tests -----------------------------------------------------------------

failures = []


def check_eq(label, got, want):
    if got != want:
        failures.append(f"{label}: got {got}, want {want}")


def check_range(label, got, lo, hi):
    if got < lo or got > hi:
        failures.append(f"{label}: got {got}, not in [{lo}, {hi}]")


def test_base_delays_no_jitter():
    check_eq("attempt=0,jitter=0", compute_reconnect_delay_ms(0, 0), 1000)
    check_eq("attempt=0,jitter=500", compute_reconnect_delay_ms(0, 500), 1500)
    check_eq("attempt=1,jitter=0", compute_reconnect_delay_ms(1, 0), 2000)
    check_eq("attempt=2,jitter=0", compute_reconnect_delay_ms(2, 0), 4000)
    check_eq("attempt=3,jitter=0", compute_reconnect_delay_ms(3, 0), 8000)
    check_eq("attempt=4,jitter=0", compute_reconnect_delay_ms(4, 0), 16000)


def test_cap_at_30s():
    check_eq("attempt=5,jitter=0", compute_reconnect_delay_ms(5, 0), 30000)
    check_eq("attempt=10,jitter=0", compute_reconnect_delay_ms(10, 0), 30000)
    check_eq("attempt=100,jitter=0", compute_reconnect_delay_ms(100, 0), 30000)


def test_negative_attempt_treated_as_zero():
    check_eq("attempt=-1,jitter=0", compute_reconnect_delay_ms(-1, 0), 1000)
    check_eq("attempt=-100,jitter=0", compute_reconnect_delay_ms(-100, 0), 1000)


def test_jitter_bounds():
    # attempt=0: delay=1000, jitter ∈ [0, 500], total ∈ [1000, 1500]
    for r in range(0, 100_000, 997):
        out = compute_reconnect_delay_ms(0, r)
        check_range(f"attempt=0 r={r}", out, 1000, 1500)
    # attempt=5 capped: delay=30000, jitter ∈ [0, 15000], total ∈ [30000, 45000]
    for r in range(0, 100_000, 997):
        out = compute_reconnect_delay_ms(5, r)
        check_range(f"attempt=5 r={r}", out, 30000, 45000)


def test_jitter_max_is_inclusive():
    check_eq("max@0", compute_reconnect_delay_ms(0, 500), 1500)
    check_eq("max@1", compute_reconnect_delay_ms(1, 1000), 3000)


def test_monotonic_up_to_cap():
    prev = compute_reconnect_delay_ms(0, 0)
    for a in range(1, MOUMANTAI_RECONNECT_SHIFT_CAP + 1):
        cur = compute_reconnect_delay_ms(a, 0)
        if cur < prev:
            failures.append(f"monotonic@{a}: {cur} < {prev}")
        prev = cur


def test_manual_trace():
    """Human-readable trace — print the first 8 attempts with zero jitter."""
    print("    backoff schedule (jitter=0):")
    for a in range(8):
        d = compute_reconnect_delay_ms(a, 0)
        print(f"      attempt={a:2d} → {d:5d} ms")


if __name__ == "__main__":
    test_base_delays_no_jitter()
    test_cap_at_30s()
    test_negative_attempt_treated_as_zero()
    test_jitter_bounds()
    test_jitter_max_is_inclusive()
    test_monotonic_up_to_cap()
    test_manual_trace()

    if failures:
        print(f"\nFAIL: {len(failures)} assertion(s)")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nAll tests passed.")
