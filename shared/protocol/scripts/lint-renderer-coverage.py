#!/usr/bin/env python3
"""Renderer coverage lint — drift sentinel for the silent-drop bug class.

For each renderer (Phone / Wear / PWA / ESP32), statically check that:

1. **Component coverage** — every variant in `ComponentDef.component` oneof
   has a dispatch branch in the renderer.
2. **Field coverage** — every proto field on each *Component message is
   referenced in the renderer's render path (so adding a field forces a
   renderer update or an explicit allowlist entry).
3. **Modifier coverage** — every Modifier field is referenced in the
   renderer's `resolveModifier` / style-mapping helper.

This is a STATIC ANALYSIS over source — no test framework, no AVDs.
Catches the entire silent-drop class in seconds.

Per user direction (no CI staff), this is a developer tool — runnable on
demand via `task protocol:lint-coverage`. Not wired as a hard PR gate.
Allowlist exceptions live in `coverage-allowlist.yaml` with a documented
reason per entry.

Usage:
  uv run python shared/protocol/scripts/lint-renderer-coverage.py
  uv run python shared/protocol/scripts/lint-renderer-coverage.py --strict
    # exit 1 on any unallowed gap
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML not installed (uv sync)", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[3]
PROTO = ROOT / "shared" / "protocol" / "proto" / "moumantai" / "v1" / "components.proto"
ALLOWLIST = Path(__file__).resolve().parent / "coverage-allowlist.yaml"

# ---------------------------------------------------------------------------
# Renderer source roots
# ---------------------------------------------------------------------------

RENDERERS = {
    "phone": {
        "roots": [
            ROOT
            / "clients"
            / "android"
            / "app"
            / "src"
            / "main"
            / "java"
            / "com"
            / "moumantai"
            / "client"
            / "renderer",
        ],
        "globs": ["**/*.kt"],
        # Kotlin from Wire preserves snake_case → we look for c.font_weight style.
        "case": "snake",
    },
    "wear": {
        "roots": [
            ROOT
            / "clients"
            / "wear-os"
            / "app"
            / "src"
            / "main"
            / "java"
            / "com"
            / "moumantai"
            / "wear"
            / "renderer",
        ],
        "globs": ["**/*.kt"],
        "case": "snake",
    },
    "pwa": {
        "roots": [
            ROOT / "clients" / "pwa" / "src" / "renderer",
        ],
        "globs": ["**/*.ts", "**/*.tsx"],
        # protobuf-es generates camelCase TS names.
        "case": "camel",
    },
    "esp32": {
        "roots": [
            ROOT / "clients" / "esp32" / "components" / "renderer",
        ],
        "globs": ["**/*.c", "**/*.h"],
        # nanopb generates snake_case C field names.
        "case": "snake",
    },
}

# ---------------------------------------------------------------------------
# Proto parser (regex-based — handles components.proto's shape)
# ---------------------------------------------------------------------------


def snake_to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def parse_proto(text: str) -> dict:
    """Return {variants: [(case_name, message_name)], messages: {msg: [field, ...]}}.

    Skips field 200 (modifier) and the `id` field on ComponentDef.
    """
    # Strip line comments.
    text = re.sub(r"//.*$", "", text, flags=re.MULTILINE)

    # Find ComponentDef oneof — search directly for the oneof block since
    # nested-brace matching with regex is brittle.
    variants: list[tuple[str, str]] = []
    oneof_match = re.search(r"oneof\s+component\s*\{(.+?)\n  \}", text, re.DOTALL)
    if oneof_match:
        for m in re.finditer(r"(\w+)\s+(\w+)\s*=\s*\d+\s*;", oneof_match.group(1)):
            msg_type, case_name = m.group(1), m.group(2)
            variants.append((case_name, msg_type))

    # Find every message: field list.
    messages: dict[str, list[str]] = {}
    for m in re.finditer(r"message\s+(\w+)\s*\{(.+?)\n\}", text, re.DOTALL):
        name, body = m.group(1), m.group(2)
        fields: list[str] = []
        for f in re.finditer(
            r"(?:optional\s+|repeated\s+)?[\w.]+\s+(\w+)\s*=\s*(\d+)\s*;",
            body,
        ):
            field_name, tag = f.group(1), int(f.group(2))
            if tag == 200:
                continue  # skip Modifier field
            fields.append(field_name)
        messages[name] = fields

    return {"variants": variants, "messages": messages}


# ---------------------------------------------------------------------------
# Renderer scanner
# ---------------------------------------------------------------------------


def load_renderer_source(renderer_key: str) -> str:
    """Concatenate every source file under the renderer's roots."""
    info = RENDERERS[renderer_key]
    chunks: list[str] = []
    for root in info["roots"]:
        if not root.exists():
            continue
        for glob in info["globs"]:
            for f in root.rglob(glob.split("/")[-1]):
                try:
                    chunks.append(f.read_text(encoding="utf-8", errors="ignore"))
                except OSError:
                    pass
    return "\n".join(chunks)


def check_field(source: str, field_snake: str, case: str) -> bool:
    """Return True if the field appears referenced in the renderer source."""
    candidates: list[str] = []
    if case == "snake":
        candidates = [field_snake]
    elif case == "camel":
        candidates = [snake_to_camel(field_snake), field_snake]
    # Look for `.<field>` or `->`<field>` or word boundary.
    patterns = [rf"[.>]{re.escape(c)}\b" for c in candidates] + [
        rf"\b{re.escape(c)}\b" for c in candidates
    ]
    for pat in patterns:
        if re.search(pat, source):
            return True
    return False


def check_variant(source: str, case_name: str, msg_name: str) -> bool:
    """Return True if the variant has a dispatch branch in the renderer.

    Looks for either the oneof case name (camelCase) or the message type
    name (PascalCase) somewhere in the source.
    """
    patterns = [
        rf"\b{re.escape(msg_name)}\b",  # `is TextComponent ->`, `as TextComponent`, `MOUMANTAI_V1_COMPONENT_DEF_TEXT`
        rf"['\"]{re.escape(case_name)}['\"]",  # `case 'text':`
        rf"\.{re.escape(case_name)}\b",  # `c.text` access on the oneof
    ]
    for pat in patterns:
        if re.search(pat, source):
            return True
    return False


# ---------------------------------------------------------------------------
# Allowlist
# ---------------------------------------------------------------------------


def load_allowlist() -> dict:
    """Allowlist shape:
    {
      'phone': {
        'TextComponent': ['some_field'],  # don't flag this field on phone
        '_components': ['Box'],  # don't flag missing Box dispatch on phone (use sparingly)
      },
      ...
    }
    Each entry must be accompanied by a comment in the YAML.
    """
    if not ALLOWLIST.exists():
        return {}
    try:
        return yaml.safe_load(ALLOWLIST.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        print(f"error: failed to parse {ALLOWLIST}: {e}", file=sys.stderr)
        sys.exit(2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--strict", action="store_true", help="Exit 1 on any unallowed gap")
    args = p.parse_args(argv)

    if not PROTO.exists():
        print(f"error: {PROTO} not found", file=sys.stderr)
        return 2

    proto = parse_proto(PROTO.read_text(encoding="utf-8"))
    allowlist = load_allowlist()

    total_gaps = 0
    for renderer_key in RENDERERS:
        info = RENDERERS[renderer_key]
        source = load_renderer_source(renderer_key)
        if not source:
            print(f"\n[{renderer_key}] no source found at {info['roots'][0]}; skipped")
            continue

        allow = allowlist.get(renderer_key, {})
        skip_components = set(allow.get("_components", []))

        gaps: list[str] = []

        # Component dispatch coverage
        for case_name, msg_name in proto["variants"]:
            if msg_name in skip_components:
                continue
            if not check_variant(source, case_name, msg_name):
                gaps.append(f"  [MISS] dispatch: {msg_name} (oneof case '{case_name}')")

        # Field coverage per component
        for case_name, msg_name in proto["variants"]:
            if msg_name in skip_components:
                continue
            fields = proto["messages"].get(msg_name, [])
            allowed_fields = set(allow.get(msg_name, []))
            for f in fields:
                if f in allowed_fields:
                    continue
                if not check_field(source, f, info["case"]):
                    gaps.append(f"  [DROP] field: {msg_name}.{f}")

        # Modifier coverage
        mod_fields = proto["messages"].get("Modifier", [])
        allowed_mod = set(allow.get("Modifier", []))
        for f in mod_fields:
            if f in allowed_mod:
                continue
            if not check_field(source, f, info["case"]):
                gaps.append(f"  [DROP] Modifier.{f}")

        if gaps:
            print(f"\n[{renderer_key}] {len(gaps)} gap(s):")
            for g in gaps:
                print(g)
            total_gaps += len(gaps)
        else:
            print(f"\n[{renderer_key}] OK full coverage")

    if total_gaps > 0:
        print(f"\nTotal: {total_gaps} gap(s) across renderers.")
        print(
            "Add allowlist entries with a comment in shared/protocol/scripts/coverage-allowlist.yaml,"
        )
        print("OR fix the renderer to reference the missing field/component.")
        if args.strict:
            return 1
    else:
        print("\nAll renderers fully covered. OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
