#!/usr/bin/env python3
"""
Generate the LVGL fonts used by every label on the device.

THREE FAMILIES wired into a fallback chain so primary line_height stays small:

  * `moumantai_text_{14,20,28}` (PRIMARY for body text)
      Inter + Latin/Greek/Cyrillic/punct/math/arrows + NotoSansSymbols2
      (geometric + misc + dingbats) + NotoEmoji. **No CJK, no icons.**
      Line metric ~20/28/40 — driven by Inter + emoji's natural ascender/
      descender. **This is what body widgets size against.**
      Fallback → moumantai_text_cjk_{14,20,28}.

  * `moumantai_text_cjk_{14,20,28}` (FALLBACK)
      NotoSansCJK ranges that primary doesn't cover: box drawing, block
      elements, CJK punctuation + CJK Unified Ideographs subset. Its
      line_height is ~27/39/54 (CJK em-square is bigger than primary's),
      but ONLY consumed via fallback resolution — LVGL keeps using the
      PRIMARY's line metric for layout, which is the whole point.

  * `moumantai_icons_{20,24,32}` (standalone)
      Material Symbols Rounded only. Used exclusively inside
      `icon_label_create()` inside fixed-size square boxes; never enters
      body-text layout.

WHY THREE? `lv_font_conv` reports `line_height = MAX across all merged
glyph ranges`. NotoSansCJK ships its symbol-range glyphs (box drawing,
block elements, CJK punctuation) at full em-square dimensions — when
those merge into the primary text font, line_height jumps from 20 to 27
at the 14-px size. LVGL's `lv_textarea` uses `font.line_height` for the
cursor caret height, so a body textarea designed around the 14-px
visible glyph ends up with a 27-px caret that overflows its content
area on every keystroke and surfaces as a "bouncing cursor".

The fix: keep CJK in its own font; chain via LVGL fallback so glyphs
still render but the layout uses the primary's line metric. This is a
structural property of the asset pipeline — adding a new tall script in
the future doesn't regress body widgets unless it lands in the primary
font (which the family separation makes obviously wrong at PR review).

Source TTFs (NOT checked in; see README.md for download URLs):

  - Inter-Bold.ttf, NotoSansCJKsc-Bold.otf, NotoSansSymbols2-Regular.ttf,
    NotoEmoji-Regular.ttf, MaterialSymbolsRounded.ttf.

Usage:
  python3 clients/esp32/assets/fonts/build_unified_font.py            # all families + sizes
  python3 clients/esp32/assets/fonts/build_unified_font.py --family text --sizes 14
  python3 clients/esp32/assets/fonts/build_unified_font.py --family icons --sizes 24
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUT_DIR = REPO / "components" / "renderer" / "fonts"

# Source TTFs (place alongside this script).
#
# Font strategy (December 2025 rework):
#   - Inter-Bold handles Latin + Greek + Cyrillic + punctuation + math +
#     arrows + box-drawing + geometric shapes. Inter was designed by
#     Rasmus Andersson specifically for small-pixel UI rendering; it has
#     comprehensive coverage and a chunky weight that stays legible on
#     107 PPI LCD panels where a hairline would anti-alias to nothing.
#   - Noto Sans CJK SC Bold handles only CJK glyphs + CJK punctuation.
#     Matched-weight Bold pairs visually with Inter-Bold for mixed runs.
#   - NotoSansSymbols2 covers dingbats (Inter doesn't ship ✓ ✗ ❤).
#   - NotoEmoji + MaterialSymbolsRounded as before.
TTF_LATIN = HERE / "Inter-Bold.ttf"
TTF_CJK = HERE / "NotoSansCJKsc-Bold.otf"
TTF_SYMBOLS = HERE / "NotoSansSymbols2-Regular.ttf"
TTF_EMOJI = HERE / "NotoEmoji-Regular.ttf"
TTF_ICONS = HERE / "MaterialSymbolsRounded.ttf"

# Codepoint files.
CJK_LIST = HERE / "cjk_sc_codepoints.txt"
EMOJI_LIST = HERE / "emoji_codepoints.txt"
ICON_LIST = HERE / "icon_codepoints.txt"

# Three strategic sizes — body, title/headline, display. Every Material 3
# typography token collapses onto one of these in style_helpers.c.
TEXT_SIZES = (14, 20, 28)
# Three icon size buckets — match style_helpers.c::pick_size_bucket
# (SMALL=20, MEDIUM=24, LARGE=32). icon_label_create requests exactly one
# of these for every Material Symbols glyph it renders.
ICON_SIZES = (20, 24, 32)
BPP = 4

# Ranges rendered from Inter — Latin alphabets, Greek, Cyrillic, and
# the common text punctuation/math/arrows Inter actually carries.
# Inter is a UI-first font (designed by Rasmus Andersson for small-pixel
# screen rendering) with high x-height and clean terminals that survive
# pixel-snapping at 14 px on a 107 PPI LCD.
LATIN_TTF_RANGES = [
    (0x0020, 0x007F),  # Basic Latin
    (0x00A0, 0x00FF),  # Latin-1 Supplement
    (0x0100, 0x017F),  # Latin Extended-A
    (0x0370, 0x03FF),  # Greek and Coptic (α β γ π Σ Ω Θ …)
    (0x0400, 0x04FF),  # Cyrillic
    (0x2000, 0x206F),  # General Punctuation (–, ‘, “, …, •, ‰)
    (0x20A0, 0x20CF),  # Currency Symbols (€, ₹, ₽, ¥-alt, ...)
    (0x2100, 0x214F),  # Letterlike (№, ℃, ™, ...)
    (0x2190, 0x21FF),  # Arrows (→ ← ↑ ↓ ↔ ⇒ ⇐ …)
    (0x2200, 0x22FF),  # Math Operators (∑ ∫ ∞ ≈ ≤ ≥ ± × ÷ ∂ …)
]

# Ranges in the CJK FALLBACK font. NotoSansCJK ships box-drawing / block /
# CJK-punct at full em-square dimensions, which inflates line_height — so
# we keep these out of the PRIMARY text font and reach them via fallback.
CJK_FALLBACK_RANGES = [
    (0x2500, 0x257F),  # Box Drawing (── │ ┌ ┐ — LLM ASCII art)
    (0x2580, 0x259F),  # Block Elements (▀ ▄ █ ░ ▒ ▓)
    (0x3000, 0x303F),  # CJK Symbols and Punctuation (，。！？「」…)
]

# Ranges PRIMARY font can absorb without inflating line_height. Geometric
# Shapes + Misc Symbols are in NotoSansSymbols2 with proper metrics.
PRIMARY_SYMBOL_RANGES = [
    (0x25A0, 0x25FF),  # Geometric Shapes (■ ● ▲ ◆ …)
    (0x2600, 0x26FF),  # Misc Symbols (☀ ☂ ☯ …)
    (0x2700, 0x27BF),  # Dingbats (✓ ✗ ❤ ✈ …)
]


def parse_codepoint_file(path: Path) -> list[int]:
    """Read hex codepoints, one per line. `#` starts a comment. Range syntax:
    `0x4E00-0x4E10` or `U+4E00-U+4E10` is expanded inclusively.
    Lines with multiple whitespace-separated tokens (e.g. the icon table
    `add 0xe145`) take the LAST token as the codepoint."""
    cps: list[int] = []
    if not path.exists():
        return cps
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            token = line.split()[-1]
            token = token.replace("U+", "0x").replace("u+", "0x")
            try:
                if "-" in token:
                    lo_s, hi_s = token.split("-", 1)
                    lo = int(lo_s.strip(), 16)
                    hi = int(hi_s.strip(), 16)
                    cps.extend(range(lo, hi + 1))
                else:
                    cps.append(int(token, 16))
            except ValueError:
                print(
                    f"warn: skipping unparseable line in {path.name}: {line!r}",
                    file=sys.stderr,
                )
    return cps


def range_arg(rs: list[tuple[int, int]]) -> str:
    return ",".join(f"0x{lo:04X}-0x{hi:04X}" for lo, hi in rs)


def symbols_arg(cps: list[int]) -> str:
    # lv_font_conv --symbols takes a literal UTF-8 string. Python's chr()
    # handles BMP (3-byte UTF-8) and SMP (4-byte UTF-8, emoji) codepoints.
    return "".join(chr(cp) for cp in sorted(set(cps)))


def build_text_primary(size: int) -> None:
    """Primary text font — Inter + Latin/Greek/Cyrillic + Symbols2 + emoji
    + Material Symbols icons (at this body size). Line_height stays small
    (~20 at 14-px) because Material Symbols glyphs render at the requested
    pixel size, not at their design em-square — empirically verified by
    probing each glyph range (NotoSansCJK's symbol ranges were the actual
    line_height inflator, not the icons).
    Wired with `--lv-fallback` to the CJK fallback so glyphs missing here
    are resolved transparently at runtime."""
    out = OUT_DIR / f"moumantai_text_{size}.c"
    out.parent.mkdir(parents=True, exist_ok=True)

    emoji_cps = parse_codepoint_file(EMOJI_LIST)
    icon_cps = parse_codepoint_file(ICON_LIST)

    lv_font_conv = shutil.which("lv_font_conv") or "lv_font_conv"
    cmd = [
        lv_font_conv,
        "--size",
        str(size),
        "--bpp",
        str(BPP),
        "--format",
        "lvgl",
        "--lv-include",
        "lvgl.h",
        "--lv-fallback",
        f"moumantai_text_cjk_{size}",
    ]

    if not TTF_LATIN.exists():
        raise FileNotFoundError(f"missing {TTF_LATIN.name}")
    cmd += [
        "--font",
        str(TTF_LATIN),
        "--range",
        range_arg(LATIN_TTF_RANGES),
    ]

    if TTF_SYMBOLS.exists():
        cmd += [
            "--font",
            str(TTF_SYMBOLS),
            "--range",
            range_arg(PRIMARY_SYMBOL_RANGES),
        ]

    if TTF_EMOJI.exists() and emoji_cps:
        cmd += [
            "--font",
            str(TTF_EMOJI),
            "--symbols",
            symbols_arg(emoji_cps),
        ]

    # Include Material Symbols at the body sizes too — the on-screen
    # keyboard inlines a few icon glyphs (backspace, return, chevrons,
    # check/close) into its layout strings, and those need to resolve in
    # the body-text font that the keyboard widget uses. Verified to NOT
    # inflate line_height (icons render at the requested pixel size).
    if TTF_ICONS.exists() and icon_cps:
        cmd += [
            "--font",
            str(TTF_ICONS),
            "--symbols",
            symbols_arg(icon_cps),
        ]

    cmd += ["-o", str(out)]

    total = sum(hi - lo + 1 for lo, hi in LATIN_TTF_RANGES)
    total += sum(hi - lo + 1 for lo, hi in PRIMARY_SYMBOL_RANGES)
    total += len(set(emoji_cps))
    total += len(set(icon_cps))
    print(
        f"[text]     {out.relative_to(REPO)} (~{total} glyphs @ {size}px, "
        f"fallback→moumantai_text_cjk_{size})"
    )
    subprocess.run(cmd, check=True)


def build_text_cjk(size: int) -> None:
    """CJK fallback font — NotoSansCJK box-drawing + block + CJK punct +
    CJK Unified Ideographs. Line_height is naturally tall (~27 at 14-px)
    because of CJK em-square dimensions; OK because this is only resolved
    via fallback — the primary's line_height drives layout."""
    out = OUT_DIR / f"moumantai_text_cjk_{size}.c"
    out.parent.mkdir(parents=True, exist_ok=True)

    cjk_cps = parse_codepoint_file(CJK_LIST)
    if not TTF_CJK.exists():
        raise FileNotFoundError(f"missing {TTF_CJK.name}")

    lv_font_conv = shutil.which("lv_font_conv") or "lv_font_conv"
    cmd = [
        lv_font_conv,
        "--size",
        str(size),
        "--bpp",
        str(BPP),
        "--format",
        "lvgl",
        "--lv-include",
        "lvgl.h",
        "--font",
        str(TTF_CJK),
        "--range",
        range_arg(CJK_FALLBACK_RANGES),
    ]
    if cjk_cps:
        cmd += ["--symbols", symbols_arg(cjk_cps)]
    cmd += ["-o", str(out)]

    total = sum(hi - lo + 1 for lo, hi in CJK_FALLBACK_RANGES) + len(set(cjk_cps))
    print(f"[text-cjk] {out.relative_to(REPO)} (~{total} glyphs @ {size}px)")
    subprocess.run(cmd, check=True)


def build_icon_font(size: int) -> None:
    """Material Symbols Rounded — icons only. Consumed exclusively inside
    `icon_label_create()` boxes; its line_height never reaches text widgets."""
    out = OUT_DIR / f"moumantai_icons_{size}.c"
    out.parent.mkdir(parents=True, exist_ok=True)

    icon_cps = parse_codepoint_file(ICON_LIST)
    if not icon_cps:
        raise FileNotFoundError(f"icon list empty: {ICON_LIST.name}")
    if not TTF_ICONS.exists():
        raise FileNotFoundError(f"missing {TTF_ICONS.name}")

    lv_font_conv = shutil.which("lv_font_conv") or "lv_font_conv"
    cmd = [
        lv_font_conv,
        "--size",
        str(size),
        "--bpp",
        str(BPP),
        "--format",
        "lvgl",
        "--lv-include",
        "lvgl.h",
        "--font",
        str(TTF_ICONS),
        "--symbols",
        symbols_arg(icon_cps),
        "-o",
        str(out),
    ]
    print(f"[icons] {out.relative_to(REPO)} (~{len(set(icon_cps))} glyphs @ {size}px)")
    subprocess.run(cmd, check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--family", choices=("text", "text-cjk", "icons", "all"), default="all"
    )
    ap.add_argument(
        "--sizes",
        nargs="+",
        type=int,
        help="Override sizes (defaults: text=14,20,28; icons=20,24,32)",
    )
    args = ap.parse_args()

    if not shutil.which("lv_font_conv"):
        print("error: lv_font_conv not found on PATH.", file=sys.stderr)
        print("install: npm install -g lv_font_conv", file=sys.stderr)
        return 2

    missing: list[str] = []
    for ttf in (TTF_LATIN, TTF_CJK, TTF_SYMBOLS, TTF_EMOJI, TTF_ICONS):
        if not ttf.exists():
            missing.append(ttf.name)
    if missing:
        print("error: missing TTF source(s) in assets/fonts/:", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        print("see README.md for download URLs.", file=sys.stderr)
        return 2

    text_sizes = (
        args.sizes
        if args.sizes and args.family in ("text", "text-cjk")
        else list(TEXT_SIZES)
    )
    icon_sizes = (
        args.sizes if args.sizes and args.family == "icons" else list(ICON_SIZES)
    )

    written = 0
    # text-cjk MUST build before text — primary's --lv-fallback declares an
    # extern reference to the CJK font's symbol, the linker needs the symbol
    # to be present in the build tree (a missing .c just makes the renderer
    # CMake list inconsistent on the next configure).
    if args.family in ("text-cjk", "all"):
        for size in text_sizes:
            build_text_cjk(size)
            written += 1
    if args.family in ("text", "all"):
        for size in text_sizes:
            build_text_primary(size)
            written += 1
    if args.family in ("icons", "all"):
        for size in icon_sizes:
            build_icon_font(size)
            written += 1

    print(
        f"done — {written} font(s) written to {OUT_DIR.relative_to(REPO)}/moumantai_*.c"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
