#!/usr/bin/env python3
"""Drift guard for shared/tokens/*.yaml profiles.

Both profiles must declare the same key set. Invariant categories (INVARIANT_KEYS)
must also have identical values. Fails fast on either kind of drift.

Run: uv run python scripts/test-token-shape.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
TOKENS_DIR = ROOT / "shared" / "tokens"

# Categories whose VALUES must match across profiles.
# Scoped categories (typography, spacing, sizing) intentionally diverge per SizeClass.
INVARIANT_KEYS = {
    "typographyLineHeight",
    "shape",
    "shapeAlias",
    "elevation",
    "motion",
    "state",
    "color",
    "zIndex",
}


def load(name: str) -> dict:
    with open(TOKENS_DIR / f"{name}.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def compare_keys(a: dict, b: dict, path: str, errors: list[str]) -> None:
    """Recursively compare two dicts for identical key sets."""
    a_keys = set(a.keys())
    b_keys = set(b.keys())
    only_a = a_keys - b_keys
    only_b = b_keys - a_keys
    for k in sorted(only_a):
        errors.append(f"  {path}: present in compact but missing in expanded — {k}")
    for k in sorted(only_b):
        errors.append(f"  {path}: present in expanded but missing in compact — {k}")
    for k in sorted(a_keys & b_keys):
        av, bv = a[k], b[k]
        if isinstance(av, dict) and isinstance(bv, dict):
            compare_keys(av, bv, f"{path}.{k}", errors)


def compare_values(a: dict, b: dict, path: str, errors: list[str]) -> None:
    """Recursively assert two dicts hold the same VALUES (for invariants)."""
    for k in sorted(set(a.keys()) | set(b.keys())):
        av, bv = a.get(k), b.get(k)
        if isinstance(av, dict) and isinstance(bv, dict):
            compare_values(av, bv, f"{path}.{k}", errors)
            continue
        if av != bv:
            errors.append(
                f"  {path}.{k}: compact={av!r} vs expanded={bv!r} — invariant values must match"
            )


def main() -> int:
    profiles = {"compact": load("compact"), "expanded": load("expanded")}

    errors: list[str] = []
    compare_keys(profiles["compact"], profiles["expanded"], "<root>", errors)

    for key in INVARIANT_KEYS:
        a, b = profiles["compact"].get(key), profiles["expanded"].get(key)
        if a is None or b is None:
            errors.append(
                f"  {key}: missing from at least one profile (compact={a is not None}, expanded={b is not None})"
            )
            continue
        if not isinstance(a, dict) or not isinstance(b, dict):
            errors.append(f"  {key}: not a mapping in at least one profile")
            continue
        compare_values(a, b, key, errors)

    if errors:
        print("token-shape drift detected:", file=sys.stderr)
        for e in errors:
            print(e, file=sys.stderr)
        return 1

    n_categories = len(profiles["compact"])
    print(
        f"OK — both profiles declare identical shape ({n_categories} top-level categories)."
    )
    print(
        f"     Invariant value-match verified for: {', '.join(sorted(INVARIANT_KEYS))}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
