#!/usr/bin/env python3
"""Layout-imposing token drift sentinel.

Greps every renderer source tree for layout-imposing tokens and fails when
they appear outside the catalog-driven resolver helpers or documented chrome
exceptions.

Run via: uv run python scripts/lint-layout.py
Exit 0 = clean. Exit 1 = drift found.
"""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Resolver helper files — fully exempt (they ARE the canonical implementations).
RESOLVER_FILES = {
    "clients/android/app/src/main/java/com/moumantai/client/renderer/StyleHelpers.kt",
    "clients/wear-os/app/src/main/java/com/moumantai/wear/renderer/WearStyleHelpers.kt",
    "clients/esp32/components/renderer/style_helpers.c",
    "clients/esp32/components/renderer/include/style_helpers.h",
    # render_node.c: apply_modifier/apply_dimension implement the modifier-dispatch
    # layer (weight/fill/wrap from the wire proto) — the resolver on ESP32.
    "clients/esp32/components/renderer/render_node.c",
}

# Generated outputs — always exempt.
GENERATED_PREFIX = "shared/protocol/design-system/generated/"

# Source trees to scan, each with the file extensions to check.
SCAN_DIRS: list[tuple[str, set[str]]] = [
    ("clients/android/app/src/main", {".kt"}),
    ("clients/wear-os/app/src/main", {".kt"}),
    ("clients/esp32/components/renderer", {".c", ".h"}),
]

# Patterns that flag layout-imposing tokens, per file extension.
PATTERNS: dict[str, list[re.Pattern]] = {
    ".kt": [
        re.compile(r"\.fillMaxWidth\("),
        re.compile(r"\.fillMaxHeight\("),
        re.compile(r"\.fillMaxSize\("),
        re.compile(r"Modifier\.weight\("),
    ],
    ".c": [
        re.compile(r"LV_PCT\(\s*[0-9]+\s*\)"),
        re.compile(r"\bLV_SIZE_CONTENT\b"),
        re.compile(r"\blv_obj_set_flex_grow\b"),
    ],
    ".h": [
        re.compile(r"LV_PCT\(\s*[0-9]+\s*\)"),
        re.compile(r"\bLV_SIZE_CONTENT\b"),
        re.compile(r"\blv_obj_set_flex_grow\b"),
    ],
    ".ts": [
        re.compile(r"width\s*:\s*['\"]100%['\"]"),
        re.compile(r"height\s*:\s*['\"]100%['\"]"),
        re.compile(r"flex\s*:\s*1\b"),
        re.compile(r"style\.width\s*=\s*['\"]100%['\"]"),
        re.compile(r"style\.flex\s*=\s*1\b"),
    ],
    ".tsx": [
        re.compile(r"width\s*:\s*['\"]100%['\"]"),
        re.compile(r"height\s*:\s*['\"]100%['\"]"),
        re.compile(r"flex\s*:\s*1\b"),
        re.compile(r"style\.width\s*=\s*['\"]100%['\"]"),
        re.compile(r"style\.flex\s*=\s*1\b"),
    ],
}

# Per-file allowlist.
# Key: repo-relative path (forward slashes).
# Value: list of (line_substring, rationale) pairs.
#   "" substring = entire file exempt.
#   non-empty substring = only matching lines exempt.
# Every entry MUST have a non-empty rationale (enforced at startup).
FILE_ALLOWLIST: dict[str, list[tuple[str, str]]] = {
    # -------------------------------------------------------------------
    # Android — non-renderer UI chrome (owns its own layout values)
    # -------------------------------------------------------------------
    "clients/android/app/src/main/java/com/moumantai/client/ui/AppPager.kt": [
        (
            "",
            "AppPager is chrome: horizontal/vertical scroll-snap pager for apps and faces. "
            "fillMaxSize/fillMaxWidth set the pager scroll container dimensions — "
            "these are navigator chrome, not catalog-driven component sizing.",
        ),
    ],
    "clients/android/app/src/main/java/com/moumantai/client/ui/ChatScreen.kt": [
        (
            "",
            "ChatScreen is chrome: full-screen chat UI owned by the Android client. "
            "All layout tokens here are native UI chrome, not Moumantai component sizing.",
        ),
    ],
    "clients/android/app/src/main/java/com/moumantai/client/ui/ConfigScreen.kt": [
        (
            "",
            "ConfigScreen is chrome: settings screen owned by the Android client. "
            "Not a catalog-driven Moumantai renderer.",
        ),
    ],
    "clients/android/app/src/main/java/com/moumantai/client/camera/CameraCapture.kt": [
        (
            "",
            "CameraCapture is chrome: camera preview composable. "
            "fillMaxSize fills the camera viewfinder — not catalog sizing.",
        ),
    ],
    # -------------------------------------------------------------------
    # Android — renderer leaf files with documented per-component exceptions
    # -------------------------------------------------------------------
    "clients/android/app/src/main/java/com/moumantai/client/renderer/renderers/Chrome.kt": [
        (
            ".fillMaxSize()",
            "Scaffold body Box.fillMaxSize() is chrome convention: "
            "the Scaffold body always fills the remaining space inside the "
            "M3 Scaffold container. This is per-platform chrome padding, "
            "not catalog-encoded component sizing.",
        ),
    ],
    "clients/android/app/src/main/java/com/moumantai/client/renderer/renderers/Feedback.kt": [
        (
            ".fillMaxWidth()",
            "Progress linear variant: a LinearProgressIndicator always spans "
            "its container width. The catalog encodes this as "
            "variant_overrides.linear.width=fill; the renderer applies it "
            "directly here (decoupled from the catalog resolver per the "
            "Progress-local variant comment in the file).",
        ),
        (
            ".fillMaxSize()",
            "CircularProgressIndicator.fillMaxSize() fills the fixed-size "
            "Box wrapping the ring so the indicator arc draws edge-to-edge "
            "within the sized Box. This is an intrinsic component layout "
            "convention, not a dynamic sizing decision.",
        ),
    ],
    "clients/android/app/src/main/java/com/moumantai/client/renderer/renderers/Layout.kt": [
        (
            "Modifier.weight(childWeight)",
            "Column/Row child weight forwarding: Compose's "
            "ColumnScope/RowScope.weight() can only be invoked "
            "inside the immediate scope, so we wrap each weighted "
            "child in a Box(propagateMinConstraints=true) inside "
            "the scope and apply the weight there. This forwards "
            "the catalog-resolved weight modifier from the wire "
            "proto — it's the resolver, just expressed via the "
            "Compose scope contract.",
        ),
    ],
    "clients/android/app/src/main/java/com/moumantai/client/renderer/renderers/Input.kt": [
        (
            "Modifier.weight(1f)",
            "Switch label Text.weight(1f): within the Switch Row, the "
            "label expands to push the toggle to the end. This is an "
            "internal layout of the Switch component — not a catalog "
            "modifier applied to a child Moumantai node.",
        ),
        (
            ".fillMaxWidth()",
            "Slider and Select: Slider.fillMaxWidth() makes the track span "
            "the column width (intrinsic for a range control). "
            "Select/OutlinedTextField.fillMaxWidth() fills the ExposedDropdownMenuBox "
            "anchor — required by Material3 ExposedDropdown contract.",
        ),
    ],
    # -------------------------------------------------------------------
    # Wear OS — non-renderer UI chrome
    # -------------------------------------------------------------------
    "clients/wear-os/app/src/main/java/com/moumantai/wear/ui/WearNavigation.kt": [
        (
            "",
            "WearNavigation is chrome: the outer Wear OS Scaffold + HorizontalPager + "
            "VerticalPager navigator. All fillMaxSize here fills the pager chrome containers "
            "— not catalog-driven Moumantai component sizing.",
        ),
    ],
    "clients/wear-os/app/src/main/java/com/moumantai/wear/ui/WearChatScreen.kt": [
        (
            "",
            "WearChatScreen is chrome: full-screen chat UI owned by the Wear OS client. "
            "Not a catalog-driven Moumantai renderer.",
        ),
    ],
    "clients/wear-os/app/src/main/java/com/moumantai/wear/ui/WearConfigScreen.kt": [
        (
            "",
            "WearConfigScreen is chrome: settings screen owned by the Wear OS client. "
            "Not a catalog-driven Moumantai renderer.",
        ),
    ],
    # -------------------------------------------------------------------
    # Wear OS — renderer leaf files with documented per-component exceptions
    # -------------------------------------------------------------------
    "clients/wear-os/app/src/main/java/com/moumantai/wear/renderer/WearComposites.kt": [
        (
            ".fillMaxSize()",
            "ScaffoldRenderer body Box.fillMaxSize() is chrome convention: "
            "Wear Scaffold body always fills the chrome-padded container. "
            "Same rationale as Chrome.kt on phone.",
        ),
        (
            ".fillMaxWidth()",
            "TopBarRenderer action Row.fillMaxWidth(): centers the action "
            "icons across the full watch face width. This is Wear-specific "
            "TopBar chrome — there is no M3 TopAppBar on Wear.",
        ),
    ],
    "clients/wear-os/app/src/main/java/com/moumantai/wear/renderer/WearPrimitives.kt": [
        (
            ".fillMaxSize()",
            "Three uses: (1) ScalingLazyColumn (List).fillMaxSize() — list fills "
            "the Scaffold body, which is the chrome convention for Wear lists. "
            "(2) Modal Box.fillMaxSize() — Wear has no AlertDialog; modal is "
            "rendered full-screen as per Wear UX convention. "
            "(3) Progress inner Box.fillMaxSize() fills the sized outer Box "
            "(same intrinsic convention as phone circular progress).",
        ),
        (
            ".fillMaxWidth(",
            "Progress linear pill: outerModifier.fillMaxWidth() and "
            "inner track Box.fillMaxWidth() / .fillMaxWidth(progress) — "
            "linear progress always spans width (catalog rule). The inner "
            ".fillMaxWidth(progress) is the fill-fraction trick for the "
            "progress indicator itself, not a layout keyword.",
        ),
    ],
    # -------------------------------------------------------------------
    # ESP32 — renderer leaf files with documented exceptions
    # -------------------------------------------------------------------
    "clients/esp32/components/renderer/renderers/layout.c": [
        (
            "",
            "layout.c renders Scaffold, TopBar, Column, Row, Card — structural chrome "
            "and layout containers. These components have well-known fixed sizes "
            "(scaffold LV_PCT(100)×LV_PCT(100), topbar LV_PCT(100)×48, body LV_PCT(100) "
            "with flex_grow=1, column/row/card LV_PCT(100)×LV_SIZE_CONTENT). "
            "The title label .flex_grow(1) is internal TopBar chrome. All are documented "
            "catalog conventions that apply_resolved_size does not cover (scaffold is "
            "always 100%, container widths always fill their parent column).",
        ),
    ],
    "clients/esp32/components/renderer/renderers/data.c": [
        (
            "",
            "data.c renders List, ListItem, Progress, Modal. "
            "List container and ListItem row are always LV_PCT(100)×LV_SIZE_CONTENT "
            "(catalog rule: list fills column, item fills list). "
            "ListItem text_col.flex_grow(1) is internal chrome (label pushes trailing to end). "
            "ListItem label/supporting text lv_obj_set_width(LV_PCT(100)) ensures label wraps "
            "inside the text column — intrinsic text layout. "
            "Progress bar LV_PCT(100) is the linear variant fill rule. "
            "Modal LV_PCT(90) is Wear/ESP32 overlay chrome (no AlertDialog equivalent).",
        ),
    ],
    "clients/esp32/components/renderer/renderers/atoms.c": [
        (
            "LV_SIZE_CONTENT",
            "Image placeholder chip and Divider: Image chip is LV_SIZE_CONTENT "
            "(intrinsic wrap — correct). Divider is LV_PCT(100)×thickness "
            "(always fill-width, fixed-height — catalog convention).",
        ),
        (
            "LV_PCT(100)",
            "Divider: always fill-width, fixed-height — catalog convention.",
        ),
    ],
    "clients/esp32/components/renderer/renderers/interactive.c": [
        (
            "LV_SIZE_CONTENT",
            "Button height and Chip height are LV_SIZE_CONTENT (wrap, correct). "
            "Tab strip LV_SIZE_CONTENT height. These are intrinsic wrap sizes.",
        ),
        (
            "LV_PCT(100)",
            "Tabs strip width LV_PCT(100): a Tabs row always fills its parent "
            "column width — catalog convention.",
        ),
    ],
    "clients/esp32/components/renderer/include/render_node.h": [
        (
            "RPS_POST_SIZE_CONTENT_W",
            "Enum-value documentation: RPS_POST_SIZE_CONTENT_W names a render-session "
            "post-op; the LV_SIZE_CONTENT token appears only inside the /* ... */ "
            "comment describing what the post-op does, not as layout-imposing code.",
        ),
    ],
}

# Startup: every allowlist entry must have a non-empty rationale.
for _path, _entries in FILE_ALLOWLIST.items():
    for _sub, _rationale in _entries:
        assert _rationale.strip(), (
            f"Allowlist entry for '{_path}' with substring '{_sub}' has no rationale. "
            "Every exemption MUST be documented inline."
        )


def _norm(path: str) -> str:
    return path.replace("\\", "/")


def _is_resolver(rel: str) -> bool:
    return _norm(rel) in {_norm(f) for f in RESOLVER_FILES}


def _is_generated(rel: str) -> bool:
    return _norm(rel).startswith(GENERATED_PREFIX)


def _is_test_file(path: Path) -> bool:
    name = path.name
    return (
        name.endswith("Test.kt")
        or name.endswith(".test.ts")
        or name.endswith(".test.tsx")
    )


def _is_vendored(path: Path) -> bool:
    parts = set(path.parts)
    return "managed_components" in parts or "fonts" in parts


def _check_allowlist(rel: str, line_text: str) -> bool:
    """Return True if this (file, line) is covered by the allowlist."""
    norm = _norm(rel)
    for key, entries in FILE_ALLOWLIST.items():
        if _norm(key) != norm:
            continue
        for substring, _rationale in entries:
            if substring == "" or substring in line_text:
                return True
    return False


def main() -> int:
    violations: list[str] = []

    for rel_dir, exts in SCAN_DIRS:
        scan_path = REPO_ROOT / rel_dir
        if not scan_path.exists():
            print(
                f"WARNING: scan dir not found, skipping: {scan_path}", file=sys.stderr
            )
            continue

        for path in sorted(scan_path.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix not in exts:
                continue
            if _is_test_file(path):
                continue
            if _is_vendored(path):
                continue

            try:
                rel = _norm(str(path.relative_to(REPO_ROOT)))
            except ValueError:
                continue

            if _is_resolver(rel) or _is_generated(rel):
                continue

            patterns_for_ext = PATTERNS.get(path.suffix, [])
            if not patterns_for_ext:
                continue

            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError as exc:
                print(f"WARNING: cannot read {path}: {exc}", file=sys.stderr)
                continue

            for lineno, line in enumerate(lines, start=1):
                for pat in patterns_for_ext:
                    if pat.search(line):
                        if not _check_allowlist(rel, line):
                            violations.append(
                                f"{rel}:{lineno}: [{pat.pattern}]"
                                f" — route through the resolver instead, or document"
                                f" as chrome-convention in the lint allowlist.\n"
                                f"    {line.strip()}"
                            )

    if violations:
        print(
            f"\nlint-layout: FAIL — {len(violations)} disallowed layout-imposing token(s).\n"
        )
        print("Route them through the catalog-driven resolver helpers:")
        print("  Phone:  resolveModifierWithSize()  in StyleHelpers.kt")
        print("  Wear:   resolveModifierWithSize()  in WearStyleHelpers.kt")
        print("  ESP32:  apply_resolved_size()  in style_helpers.c")
        print()
        print(
            "If it is a legitimate chrome exception, add an entry with a rationale to"
        )
        print("FILE_ALLOWLIST in scripts/lint-layout.py.")
        print()
        for v in violations:
            print(f"  {v}")
            print()
        return 1

    print("lint-layout: OK — no disallowed layout-imposing tokens found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
