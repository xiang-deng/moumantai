"""Generate every client's app icon from one source: branding/icon.source.png.

Run via `task icons` (uses `uv run --with pillow`, so Pillow isn't pinned).
Single source of truth for the app icon across all surfaces:

  PWA      clients/pwa/public/icons/{icon-192,icon-512,icon-maskable-512}.png
           clients/pwa/public/apple-touch-icon.png, .../favicon.ico
  Android  clients/android/app/src/main/res/  (adaptive + legacy mipmaps + bg colour)
  Wear OS  clients/wear-os/app/src/main/res/  (same)

The adaptive/maskable foreground places the artwork in the inner safe zone on a
background of the source's own corner colour, so circular/squircle masks never
crop it. Legacy (pre-API-26 / non-PWA) icons use the full square artwork.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "branding" / "icon.source.png"

src = Image.open(SRC).convert("RGB")
bg = src.getpixel((0, 0))  # corner colour → adaptive/maskable background
bg_hex = "#%02X%02X%02X" % bg


def square(size: int) -> Image.Image:
    return src.resize((size, size), Image.LANCZOS)


def circle(size: int) -> Image.Image:
    """Full artwork masked to a circle (RGBA)."""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(square(size).convert("RGBA"), (0, 0), mask)
    return out


def safe_zone(size: int, ratio: float, transparent: bool) -> Image.Image:
    """Artwork scaled to `ratio` of the canvas, centred. Background is either the
    corner colour (maskable) or transparent (adaptive foreground over a bg layer)."""
    fill = (0, 0, 0, 0) if transparent else bg
    canvas = Image.new("RGBA" if transparent else "RGB", (size, size), fill)
    art = int(size * ratio)
    canvas.paste(
        square(art).convert("RGBA") if transparent else square(art),
        ((size - art) // 2, (size - art) // 2),
    )
    return canvas


# ---------------------------------------------------------------- PWA
pub = ROOT / "clients/pwa/public"
icons = pub / "icons"
icons.mkdir(parents=True, exist_ok=True)
for s in (192, 512):
    square(s).save(icons / f"icon-{s}.png", optimize=True)
safe_zone(512, 0.80, transparent=False).save(
    icons / "icon-maskable-512.png", optimize=True
)
square(180).save(pub / "apple-touch-icon.png", optimize=True)
src.save(pub / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

# ------------------------------------------------------- Android / Wear OS
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

ADAPTIVE_XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '    <background android:drawable="@color/ic_launcher_background" />\n'
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
    "</adaptive-icon>\n"
)
BG_XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    f'    <color name="ic_launcher_background">{bg_hex}</color>\n</resources>\n'
)


def write_android(res: Path) -> None:
    for dens, px in LEGACY.items():
        d = res / f"mipmap-{dens}"
        d.mkdir(parents=True, exist_ok=True)
        square(px).save(d / "ic_launcher.png", optimize=True)
        circle(px).save(d / "ic_launcher_round.png", optimize=True)
        # Adaptive foreground layer (108dp): artwork in the inner 66% safe zone.
        safe_zone(ADAPTIVE[dens], 0.66, transparent=True).save(
            d / "ic_launcher_foreground.png", optimize=True
        )
    anydpi = res / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(ADAPTIVE_XML)
    (anydpi / "ic_launcher_round.xml").write_text(ADAPTIVE_XML)
    values = res / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(BG_XML)


write_android(ROOT / "clients/android/app/src/main/res")
write_android(ROOT / "clients/wear-os/app/src/main/res")

print(
    f"Generated PWA + Android + Wear icons from {SRC.relative_to(ROOT)} (background {bg_hex})"
)
