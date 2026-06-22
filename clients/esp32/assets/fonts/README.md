# ESP32 font pipeline

All LVGL fonts are produced by a single script: **`build_unified_font.py`**.

## Font families

Three families are wired into every label via an LVGL fallback chain:

| Family | Sizes | Contents |
|---|---|---|
| `moumantai_text_{14,20,28}` | 14 / 20 / 28 px | Inter-Bold (primary body font; Latin, Greek, Cyrillic, punct, math, arrows) + NotoSansSymbols2 (dingbats) + NotoEmoji. No CJK, no icons. Line metric is driven by Inter + emoji. |
| `moumantai_text_cjk_{14,20,28}` | 14 / 20 / 28 px | NotoSansCJK Bold — CJK Unified Ideographs subset + CJK punctuation + box-drawing. Used only as LVGL fallback; layout uses the primary font's line metric to avoid CJK's larger em-square inflating textarea caret height. |
| `moumantai_icons_{20,24,32}` | 20 / 24 / 32 px | Material Symbols Rounded only. Used inside fixed-size `icon_label_create()` boxes; never mixed into body layout. |

## One-time setup

Install Node.js (16+) and `lv_font_conv`:

```bash
npm install -g lv_font_conv
```

Download the TTFs into **this directory** (gitignored):

```bash
cd clients/esp32/assets/fonts

# Inter (body text)
curl -L -o Inter-Bold.ttf \
  "https://github.com/rsms/inter/releases/latest/download/Inter-Bold.ttf"

# Noto Sans CJK SC (CJK fallback)
curl -L -o NotoSansCJKsc-Bold.otf \
  "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf"

# Noto Sans Symbols 2 (dingbats)
curl -L -o NotoSansSymbols2-Regular.ttf \
  "https://github.com/google/fonts/raw/main/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf"

# Noto Emoji (monochrome)
curl -L -o NotoEmoji-Regular.ttf \
  "https://github.com/google/fonts/raw/main/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf"

# Material Symbols Rounded (icons)
curl -L -o MaterialSymbolsRounded.ttf \
  "https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf"
```

## Regenerating

```bash
# All families and sizes (from the repo root)
task esp32:fonts

# One family while iterating
uv run python clients/esp32/assets/fonts/build_unified_font.py --family text --sizes 14
uv run python clients/esp32/assets/fonts/build_unified_font.py --family icons --sizes 24
```

Generated `.c` files go into `components/renderer/fonts/` — **gitignored** and regenerated at build time when the TTFs are present (`components/renderer/CMakeLists.txt`). If a `.c` is absent, the weak `extern` in `components/renderer/style_helpers.c` resolves to NULL and the font resolver falls back to `LV_FONT_DEFAULT` (icons render as text chips) — the build never breaks.

## Adding a new icon

1. Look up the canonical codepoint at <https://fonts.google.com/icons>.
2. Append `name  hex` to `icon_codepoints.txt`.
3. Add the same `name → codepoint` row to `components/renderer/icon_map.c`.
4. Re-run `uv run python build_unified_font.py --family icons` (or `task esp32:fonts`) and rebuild. Commit the **source** changes (`icon_codepoints.txt`, `icon_map.c`) — the generated `.c` is gitignored.

## Expanding CJK coverage

`cjk_sc_codepoints.txt` ships with a starter set (~500 chars). For production:

- **HSK 1–6** (~2663 chars) covers ~98% of modern everyday Chinese — <https://www.hskhsk.com/word-lists.html>.
- Convert a character list to codepoints:

```bash
uv run python -c 'import sys
for c in sys.stdin.read():
    if ord(c) >= 0x4E00:
        print(f"0x{ord(c):04X}")' < hsk3000.txt > cjk_sc_codepoints.txt
```

## Flash cost

| Asset | Sizes | ≈ Flash |
|---|---|---|
| Inter + CJK + emoji fallback (~3000 CJK + all ranges + ~100 emoji) | 14/20/28 | ~600 KB |
| Icons (~90 each, 4 bpp) | 20/24/32 | ~185 KB |

ESP32-S3 has 16 MB flash — ample headroom.
