#!/usr/bin/env python3
"""Generate platform-specific token files from shared YAML definitions.

Source: shared/tokens/{compact,expanded}.yaml (compact ≤ 240dp; expanded > 240dp).

Outputs:
  - clients/pwa/src/generated/tokens.css          (CSS variables, expanded)
  - clients/android/.../CompactTokens.kt          (Kotlin const, compact)
  - clients/android/.../ExpandedTokens.kt         (Kotlin const, expanded)
  - clients/wear-os/.../CompactTokens.kt          (Kotlin const, compact)
  - clients/esp32/.../include/generated_tokens.h  (C #defines, expanded)

Token categories (both profiles must declare the same keys;
`scripts/test-token-shape.py` enforces this):

  Scoped (values differ per SizeClass):
    typography, spacing, sizing

  Invariant (values must match across profiles):
    typographyLineHeight, shape, shapeAlias, elevation, motion, state, color, zIndex

Usage: uv run python scripts/generate-tokens.py
"""

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
TOKENS_DIR = ROOT / "shared" / "tokens"

# Output paths
PWA_OUT = ROOT / "clients" / "pwa" / "src" / "generated" / "tokens.css"
ANDROID_BASE = (
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
    / "generated"
)
WEAR_BASE = (
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
    / "generated"
)
ESP32_OUT = (
    ROOT
    / "clients"
    / "esp32"
    / "components"
    / "renderer"
    / "include"
    / "generated_tokens.h"
)

HEADER = "AUTO-GENERATED from shared/tokens/ — do not hand-edit"


# ---------------------------------------------------------------------------
# Loading + helpers
# ---------------------------------------------------------------------------


def load_profile(name: str) -> dict:
    with open(TOKENS_DIR / f"{name}.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def to_kebab(name: str) -> str:
    """displayLarge -> display-large"""
    return re.sub(r"([a-z])([A-Z])", r"\1-\2", name).lower()


def to_screaming_snake(name: str) -> str:
    """displayLarge -> DISPLAY_LARGE"""
    return re.sub(r"([a-z])([A-Z])", r"\1_\2", name).upper()


def hex_to_argb_int(hex_str: str) -> str:
    """#D0BCFF -> 0xFFD0BCFF (full alpha; M3 dark scheme assumes opaque)."""
    h = hex_str.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"Expected #RRGGBB color, got {hex_str!r}")
    return f"0xFF{h.upper()}"


def opacity_to_byte(opacity: float) -> int:
    """0.38 -> 97 (LVGL takes 0..255)."""
    return round(opacity * 255)


# ---------------------------------------------------------------------------
# Web CSS
# ---------------------------------------------------------------------------


def _emit_css_block(profile: dict, lines: list[str]) -> None:
    """Emit the variable assignments shared by :root + [data-size-class=...]."""

    lines.append("  /* Typography sizes (sp/px) */")
    for name, val in profile["typography"].items():
        lines.append(f"  --moumantai-{to_kebab(name)}: {val}px;")
    lines.append("")

    lines.append("  /* Spacing (dp/px) */")
    for name, val in profile["spacing"].items():
        lines.append(f"  --moumantai-spacing-{name}: {val}px;")
    lines.append("")

    lines.append("  /* Sizing — per-component dimensions */")
    for name, val in profile["sizing"].items():
        if isinstance(val, str):
            css_val = val
        elif val == 0:
            css_val = "0"  # unitless zero — stylelint-friendly
        else:
            css_val = f"{val}px"
        lines.append(f"  --moumantai-{to_kebab(name)}: {css_val};")
    lines.append("")


def _emit_css_invariants(profile: dict, lines: list[str]) -> None:
    """Emit invariant categories. Same values in both profiles, but emitted
    on both selectors so a child component can override only :root."""

    lines.append("  /* Typography line heights (unitless multipliers) */")
    for name, val in profile["typographyLineHeight"].items():
        lines.append(f"  --moumantai-{to_kebab(name)}-line-height: {val};")
    lines.append("")

    lines.append("  /* Shape — primitive scale */")
    for name, val in profile["shape"].items():
        lines.append(f"  --moumantai-shape-{name}: {val}px;")
    lines.append("")

    lines.append("  /* Shape — component aliases (resolve to a primitive) */")
    for alias, prim_key in profile["shapeAlias"].items():
        lines.append(
            f"  --moumantai-{to_kebab(alias)}: var(--moumantai-shape-{prim_key});"
        )
    lines.append("")

    lines.append("  /* Elevation — composite shadow strings */")
    for name, val in profile["elevation"].items():
        lines.append(f"  --moumantai-elevation-{name}: {val};")
    lines.append("")

    lines.append("  /* Motion — durations (ms) + easing */")
    for name, val in profile["motion"].items():
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            lines.append(f"  --moumantai-motion-{to_kebab(name)}: {val}ms;")
        else:
            lines.append(f"  --moumantai-motion-{to_kebab(name)}: {val};")
    lines.append("")

    lines.append("  /* State opacities */")
    for name, val in profile["state"].items():
        lines.append(f"  --moumantai-state-{to_kebab(name)}: {val};")
    lines.append("")

    # Use --md-sys-color-* (matches Compose's MaterialTheme.colorScheme.* convention).
    # No --moumantai-color-* mirror — all CSS consumers use --md-sys-color-*.
    lines.append("  /* Color — M3 dark scheme (--md-sys-color-*) */")
    for name, val in profile["color"].items():
        lines.append(f"  --md-sys-color-{to_kebab(name)}: {val};")
    lines.append("")

    lines.append("  /* z-index stack */")
    for name, val in profile["zIndex"].items():
        lines.append(f"  --moumantai-z-{to_kebab(name)}: {val};")
    lines.append("")


# Some sizing keys (min-touch-target, border-radius, default-text-align,
# default-align-items) are not emitted as CSS — no web consumer. The Kotlin
# generators still emit them for Android's DimensionProfile.


def generate_pwa_css(profile: dict) -> str:
    """Expanded-only tokens for the PWA (phones are always > 240dp)."""
    lines = [
        f"/* {HEADER} */",
        "/* PWA — expanded tokens. Override in theme/identity.css. */",
        "",
        ":root {",
    ]
    _emit_css_block(profile, lines)
    _emit_css_invariants(profile, lines)
    lines.append("}")
    lines.append("")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Kotlin (Android + Wear)
# ---------------------------------------------------------------------------


def _emit_kotlin_scoped(profile: dict, lines: list[str]) -> None:
    lines.append("    // Typography (sp)")
    for name, val in profile["typography"].items():
        lines.append(f"    const val {to_screaming_snake(name)} = {val}")
    lines.append("")
    lines.append("    // Spacing (dp)")
    for name, val in profile["spacing"].items():
        lines.append(f"    const val SPACING_{name.upper()} = {val}")
    lines.append("")
    lines.append("    // Sizing (dp)")
    for name, val in profile["sizing"].items():
        if isinstance(val, str):
            continue  # `scaffoldBodyPadding` is a CSS-only compound value
        lines.append(f"    const val {to_screaming_snake(name)} = {val}")
    lines.append("")


def _emit_kotlin_invariants(profile: dict, lines: list[str]) -> None:
    lines.append("    // Typography line heights (unitless multipliers)")
    for name, val in profile["typographyLineHeight"].items():
        # Kotlin doesn't accept 1.5 as Double from `const val Float`, so use Float-typed.
        lines.append(f"    const val {to_screaming_snake(name)}_LINE_HEIGHT = {val}f")
    lines.append("")

    lines.append("    // Shape primitives (dp). `full` is a pill sentinel — not")
    lines.append("    // emitted as a numeric const; consumers must dispatch on the")
    lines.append(
        '    // primitive key string `"full"` and call RoundedCornerShape(percent = 50)'
    )
    lines.append(
        "    // (9999.dp is not equivalent to a 50%-corner shape at every height)."
    )
    for name, val in profile["shape"].items():
        if name == "full":
            continue
        lines.append(f"    const val SHAPE_{name.upper()} = {val}")
    lines.append("")

    lines.append(
        "    // Shape aliases — map component → primitive key (look up via SHAPE_*)."
    )
    for alias, prim_key in profile["shapeAlias"].items():
        lines.append(
            f'    const val {to_screaming_snake(alias)}_PRIMITIVE = "{prim_key}"'
        )
    lines.append("")

    lines.append("    // Elevation — dp value per level (Material 3 mapping).")
    elev_dp = {"none": 0, "raised": 1, "floating": 3, "elevated": 6}
    for name in profile["elevation"]:
        lines.append(f"    const val ELEVATION_{name.upper()}_DP = {elev_dp[name]}")
    lines.append("")

    lines.append("    // Motion (ms / cubic-bezier components)")
    lines.append(
        f"    const val MOTION_DURATION_SHORT_MS = {profile['motion']['durationShort']}"
    )
    lines.append(
        f"    const val MOTION_DURATION_MEDIUM_MS = {profile['motion']['durationMedium']}"
    )
    # Parse cubic-bezier(x1, y1, x2, y2)
    cubic = profile["motion"]["easingStandard"]
    m = re.match(
        r"cubic-bezier\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)", cubic
    )
    if not m:
        raise ValueError(
            f"easingStandard must be a cubic-bezier(...) string, got {cubic!r}"
        )
    x1, y1, x2, y2 = m.groups()
    lines.append(f"    const val MOTION_EASING_STANDARD_X1 = {x1}f")
    lines.append(f"    const val MOTION_EASING_STANDARD_Y1 = {y1}f")
    lines.append(f"    const val MOTION_EASING_STANDARD_X2 = {x2}f")
    lines.append(f"    const val MOTION_EASING_STANDARD_Y2 = {y2}f")
    lines.append("")

    lines.append(
        "    // State opacities — each entry is `<state-name>: <opacity 0..1>`"
    )
    for name, val in profile["state"].items():
        lines.append(f"    const val STATE_{to_screaming_snake(name)}_OPACITY = {val}f")
    lines.append("")

    lines.append("    // Color — M3 dark scheme (0xAARRGGBB)")
    for name, val in profile["color"].items():
        lines.append(
            f"    const val COLOR_{to_screaming_snake(name)} = {hex_to_argb_int(val)}.toInt()"
        )
    lines.append("")


def generate_kotlin(profile: dict, class_name: str, package: str) -> str:
    lines = [
        f"// {HEADER}",
        f"package {package}",
        "",
        f"object {class_name} {{",
    ]
    _emit_kotlin_scoped(profile, lines)
    _emit_kotlin_invariants(profile, lines)
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# ESP32 C header
# ---------------------------------------------------------------------------


def generate_c_header(profile: dict) -> str:
    """ESP32 reads the expanded profile (ILI9488 320×480; server sends EXPANDED faces)."""
    lines = [
        f"// {HEADER}",
        "// ESP32 — expanded profile (320×480 ILI9488 CrowPanel).",
        "// Shape `full` → LV_RADIUS_CIRCLE. Opacities are 0..255 (LVGL lv_opa_t).",
        "// Elevation: LVGL shadow tuples via apply_elevation() in style_helpers.c.",
        "// Motion easing: easingStandard → LV_ANIM_PATH_EASE_IN_OUT.",
        "#pragma once",
        "",
        "#include <stdint.h>",
        "",
        "// Typography sizes (px)",
    ]
    for name, val in profile["typography"].items():
        lines.append(f"#define MOUMANTAI_TYPO_{to_screaming_snake(name)} {val}")
    lines.append("")
    lines.append("// Spacing (dp)")
    for name, val in profile["spacing"].items():
        lines.append(f"#define MOUMANTAI_SPACING_{name.upper()} {val}")
    lines.append("")
    lines.append("// Sizing (dp; compound paddings handled in style_helpers.c)")
    for name, val in profile["sizing"].items():
        if isinstance(val, str):
            continue
        lines.append(f"#define MOUMANTAI_{to_screaming_snake(name)} {val}")
    lines.append("")
    lines.append("// Shape primitives (dp). Use LV_RADIUS_CIRCLE for `full`.")
    for name, val in profile["shape"].items():
        if name == "full":
            continue
        lines.append(f"#define MOUMANTAI_SHAPE_{name.upper()} {val}")
    lines.append("")
    lines.append("// Motion (ms)")
    lines.append(
        f"#define MOUMANTAI_MOTION_DURATION_SHORT_MS {profile['motion']['durationShort']}"
    )
    lines.append(
        f"#define MOUMANTAI_MOTION_DURATION_MEDIUM_MS {profile['motion']['durationMedium']}"
    )
    lines.append("// Easing — semantic name, mapped at apply-site:")
    lines.append("//   easingStandard → LV_ANIM_PATH_EASE_IN_OUT")
    lines.append("")
    lines.append("// State opacities (LVGL 0..255 scale)")
    for name, val in profile["state"].items():
        lines.append(
            f"#define MOUMANTAI_STATE_{to_screaming_snake(name)}_OPA {opacity_to_byte(val)}"
        )
    lines.append("")
    # Elevation: M3 CSS shadow strings mapped to LVGL (width, ofs_y, opa 0..255).
    # LVGL supports only one shadow layer; we use the key (more opaque) layer.
    # M3 → LVGL: none(0,0,0) raised(2,1,77) floating(4,2,77) elevated(8,4,115).
    ELEVATION_TUPLES = {
        "none": (0, 0, 0),
        "raised": (2, 1, 77),
        "floating": (4, 2, 77),
        "elevated": (8, 4, 115),
    }
    lines.append("// Elevation — LVGL shadow tuples (width, ofs_y, opa 0..255).")
    lines.append(
        "// Use apply_elevation(obj, ELEV_<LEVEL>) — do NOT set shadow props directly."
    )
    lines.append("typedef enum {")
    for i, level in enumerate(ELEVATION_TUPLES):
        lines.append(f"    MOUMANTAI_ELEV_{level.upper()} = {i},")
    lines.append("    MOUMANTAI_ELEV_COUNT")
    lines.append("} moumantai_elevation_t;")
    lines.append("")
    lines.append(
        "typedef struct { int width; int ofs_y; int opa; } moumantai_shadow_tuple_t;"
    )
    lines.append("")
    lines.append(
        "// Defined in style_helpers.c — extern so renderers can call apply_elevation()."
    )
    lines.append(
        "extern const moumantai_shadow_tuple_t moumantai_elevation_table[MOUMANTAI_ELEV_COUNT];"
    )
    lines.append("")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def write_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        print(f"  [unchanged] {path.relative_to(ROOT)}")
        return
    path.write_text(content, encoding="utf-8")
    print(f"  [generated] {path.relative_to(ROOT)}")


def main() -> int:
    print("Loading token profiles...")
    profiles = {
        "compact": load_profile("compact"),
        "expanded": load_profile("expanded"),
    }

    print("Generating outputs:")
    write_file(PWA_OUT, generate_pwa_css(profiles["expanded"]))
    write_file(
        ANDROID_BASE / "CompactTokens.kt",
        generate_kotlin(
            profiles["compact"], "CompactTokens", "com.moumantai.client.generated"
        ),
    )
    write_file(
        ANDROID_BASE / "ExpandedTokens.kt",
        generate_kotlin(
            profiles["expanded"], "ExpandedTokens", "com.moumantai.client.generated"
        ),
    )
    write_file(
        WEAR_BASE / "CompactTokens.kt",
        generate_kotlin(
            profiles["compact"], "CompactTokens", "com.moumantai.wear.generated"
        ),
    )
    write_file(ESP32_OUT, generate_c_header(profiles["expanded"]))
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
