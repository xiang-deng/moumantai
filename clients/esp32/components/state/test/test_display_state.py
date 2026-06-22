"""
Host-side verification of display_state.c::derive_display_state.

Reimplements the pure function in Python (byte-for-byte translation of the C)
and runs the same test cases as test_display_state.c. Runs anywhere with a
Python 3 interpreter — no C toolchain required.

If derive_display_state() in display_state.c changes, update both this file
and the C sibling test. They should always produce identical results.

Run:
    python3 test_display_state.py
"""

import sys

# Enums — mirror transport_limits.h / display_state.h
CONN_DISCONNECTED = 0
CONN_CONNECTING = 1
CONN_CONNECTED = 2
CONN_HELLO_SENT = 3
CONN_SESSION_ACTIVE = 4

DISPLAY_CONNECTED = 0
DISPLAY_RECONNECTING = 1
DISPLAY_OFFLINE = 2

# Constants — mirror display_state.h
MOUMANTAI_RECONNECT_INDICATOR_DELAY_MS = 2000
MOUMANTAI_OFFLINE_THRESHOLD_MS = 15000


def derive_display_state(cur, now_us, last_non_connected_us):
    """Pure port of C derive_display_state() in display_state.c."""
    if cur == CONN_SESSION_ACTIVE:
        return DISPLAY_CONNECTED
    if last_non_connected_us == 0 or now_us < last_non_connected_us:
        return DISPLAY_CONNECTED
    elapsed_ms = (now_us - last_non_connected_us) // 1000
    if elapsed_ms < MOUMANTAI_RECONNECT_INDICATOR_DELAY_MS:
        return DISPLAY_CONNECTED
    if elapsed_ms < MOUMANTAI_OFFLINE_THRESHOLD_MS:
        return DISPLAY_RECONNECTING
    return DISPLAY_OFFLINE


# ---- Tests -----------------------------------------------------------------

failures = []


def check(label, got, want):
    name = {0: "CONNECTED", 1: "RECONNECTING", 2: "OFFLINE"}
    if got != want:
        failures.append(f"{label}: got {name[got]}, want {name[want]}")


def test_session_active_always_connected():
    one_hour_us = 3600 * 1_000_000
    check(
        "active@now=1h",
        derive_display_state(CONN_SESSION_ACTIVE, one_hour_us, 0),
        DISPLAY_CONNECTED,
    )
    check(
        "active@stale-ts",
        derive_display_state(CONN_SESSION_ACTIVE, one_hour_us, 1),
        DISPLAY_CONNECTED,
    )
    check(
        "active@zero",
        derive_display_state(CONN_SESSION_ACTIVE, 0, 0),
        DISPLAY_CONNECTED,
    )


def test_flap_under_2s_stays_connected():
    drop_at = 10 * 1_000_000
    now = drop_at + 1 * 1_000_000  # +1s
    check(
        "disconnected@1s",
        derive_display_state(CONN_DISCONNECTED, now, drop_at),
        DISPLAY_CONNECTED,
    )
    check(
        "connecting@1s",
        derive_display_state(CONN_CONNECTING, now, drop_at),
        DISPLAY_CONNECTED,
    )
    check(
        "hello_sent@1s",
        derive_display_state(CONN_HELLO_SENT, now, drop_at),
        DISPLAY_CONNECTED,
    )

    now = drop_at + 1999 * 1000  # 1999 ms
    check(
        "disconnected@1999ms",
        derive_display_state(CONN_DISCONNECTED, now, drop_at),
        DISPLAY_CONNECTED,
    )


def test_reconnecting_2s_to_15s():
    drop_at = 10 * 1_000_000

    now = drop_at + 2 * 1_000_000  # 2 s exactly
    check(
        "disconnected@2s",
        derive_display_state(CONN_DISCONNECTED, now, drop_at),
        DISPLAY_RECONNECTING,
    )
    check(
        "connecting@2s",
        derive_display_state(CONN_CONNECTING, now, drop_at),
        DISPLAY_RECONNECTING,
    )

    now = drop_at + 7500 * 1000  # 7.5 s
    check(
        "hello@7.5s",
        derive_display_state(CONN_HELLO_SENT, now, drop_at),
        DISPLAY_RECONNECTING,
    )

    now = drop_at + 14999 * 1000  # 14999 ms — still under 15 s
    check(
        "disconnected@14999ms",
        derive_display_state(CONN_DISCONNECTED, now, drop_at),
        DISPLAY_RECONNECTING,
    )


def test_offline_at_or_above_15s():
    drop_at = 10 * 1_000_000

    now = drop_at + 15 * 1_000_000  # 15 s exactly
    check(
        "disconnected@15s",
        derive_display_state(CONN_DISCONNECTED, now, drop_at),
        DISPLAY_OFFLINE,
    )

    now = drop_at + 300 * 1_000_000  # 5 min
    check(
        "disconnected@5min",
        derive_display_state(CONN_DISCONNECTED, now, drop_at),
        DISPLAY_OFFLINE,
    )
    check(
        "hello@5min",
        derive_display_state(CONN_HELLO_SENT, now, drop_at),
        DISPLAY_OFFLINE,
    )


def test_edge_cases():
    # Cold boot — last_non_connected_us == 0 and cur is non-SESSION_ACTIVE.
    check(
        "cold_boot@zero_ts",
        derive_display_state(CONN_DISCONNECTED, 5000, 0),
        DISPLAY_CONNECTED,
    )

    # Clock skew — now_us < last_non_connected_us. Shouldn't happen on a
    # monotonic timer but the guard keeps us from underflowing uint64.
    check(
        "skew", derive_display_state(CONN_DISCONNECTED, 1000, 5000), DISPLAY_CONNECTED
    )


def test_manual_trace_20s():
    """Skepticism / manual-trace log — simulate 20 s of disconnection and
    print the derived state at every 500 ms tick. Expected timeline:

        0.0 - 2.0 s  → CONNECTED (debounce)
        2.0 - 15.0 s → RECONNECTING
       15.0 - 20.0 s → OFFLINE
    """
    drop_at = 1  # non-zero so the cold-boot guard doesn't fire
    print("    manual trace (20s disconnection):")
    last_name = None
    names = {0: "CONNECTED", 1: "RECONNECTING", 2: "OFFLINE"}
    for tick in range(0, 41):  # 41 ticks of 500 ms = 20 s
        now = tick * 500 * 1000 + drop_at
        d = derive_display_state(CONN_DISCONNECTED, now, drop_at)
        name = names[d]
        if name != last_name:
            print(f"      t={tick * 0.5:5.1f}s  ->  {name}")
            last_name = name


if __name__ == "__main__":
    test_session_active_always_connected()
    test_flap_under_2s_stays_connected()
    test_reconnecting_2s_to_15s()
    test_offline_at_or_above_15s()
    test_edge_cases()
    test_manual_trace_20s()

    if failures:
        print(f"\nFAIL: {len(failures)} assertion(s)")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nAll tests passed.")
