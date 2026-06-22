#pragma once

#include "lvgl.h"
#include "render_node.h"      /* ds_render_parent_t */
#include "generated_tokens.h" /* MOUMANTAI_* token #defines + moumantai_elevation_t */

/* --------------------------------------------------------------------------
 * Material Design 3 inspired color tokens
 * ----------------------------------------------------------------------- */

#define THEME_PRIMARY lv_color_hex(0x6750A4)
#define THEME_ON_PRIMARY lv_color_hex(0xFFFFFF)
#define THEME_PRIMARY_CONT lv_color_hex(0xEADDFF)
#define THEME_SURFACE lv_color_hex(0xFEF7FF)
#define THEME_ON_SURFACE lv_color_hex(0x1D1B20)
#define THEME_SURFACE_CONT lv_color_hex(0xE6E0E9)
#define THEME_OUTLINE lv_color_hex(0x79747E)
#define THEME_OUTLINE_VARIANT lv_color_hex(0xCAC4D0)
#define THEME_ON_SURFACE_VARIANT lv_color_hex(0x49454F)
#define THEME_ERROR lv_color_hex(0xB3261E)
#define THEME_ON_ERROR lv_color_hex(0xFFFFFF)
/* Material 3 light-theme errorContainer — readable tinted-red background
 * for surfaces that need to signal error semantics without painting the
 * full saturated THEME_ERROR (which is unreadable as a card background). */
#define THEME_ERROR_CONT lv_color_hex(0xF9DEDC)
#define THEME_BG_DARK lv_color_hex(0x1C1B1F)

/* --------------------------------------------------------------------------
 * Color resolution
 * ----------------------------------------------------------------------- */

/**
 * Resolve a color string to lv_color_t.
 * Handles: "#RRGGBB", "primary", "error", "surface", "onSurface", "outline", etc.
 * Falls back to THEME_ON_SURFACE for unknown values.
 */
lv_color_t resolve_color(const char *color_str);

/* --------------------------------------------------------------------------
 * Typography resolution
 * ----------------------------------------------------------------------- */

/**
 * Resolve a typography token to the primary text font.
 * All 15 M3 tokens collapse onto 14 px (body/label/titleSmall), 20 px
 * (title/headline), or 28 px (display/headlineLarge). CJK resolves via
 * the fallback chain. Material Symbols are NOT in this font — use
 * resolve_icon_font / icon_label_create for icons.
 */
const lv_font_t *resolve_font(const char *typography);

/**
 * Resolve a Material Symbols font for a size (rounds to 20/24/32).
 * NEVER use for body text — icon-em metrics inflate line_height and
 * re-introduce the cursor-bounce regression.
 */
const lv_font_t *resolve_icon_font(int size_px);

/**
 * Apply line/letter spacing for `typography`.
 * display: line=0 letter=-1; headline/title: line=1 letter=-1;
 * body/label/null: line=3 letter=0.
 * Prefer apply_typo() — it packages font + spacing into one add_style call.
 */
void apply_text_style(lv_obj_t *label, const char *typography);

/**
 * Initialize the shared typography lv_style_t set. Must be called once at
 * startup, inside lvgl_port_lock(), before any apply_typo() call.
 *
 * Renderer wires this into renderer_init().
 */
void style_helpers_init_styles(void);

/**
 * Apply typography (font + line/letter spacing) via a shared lv_style_t.
 * Single lv_obj_add_style() call; reusable across N widgets — eliminates
 * per-widget style allocations. Color stays per-widget at the call site.
 * Unknown token falls back to body/label (font14, line=3, letter=0).
 */
void apply_typo(lv_obj_t *obj, const char *typography);

/**
 * Force the unified font onto lv_keyboard / lv_textarea, which don't
 * reliably inherit the screen cascade (LVGL forum guidance: set explicitly).
 * Sets both LV_PART_MAIN and LV_PART_ITEMS; harmless on widgets without items.
 */
void apply_unified_font(lv_obj_t *obj, const char *typography);

/**
 * Apply the catalog's resolved size policy to an LVGL object for one axis.
 *
 * Calls ds_layout_resolve_width (is_width=true) or ds_layout_resolve_height
 * and maps the result to LVGL idioms:
 *   DS_LAYOUT_FILL  → lv_obj_set_width/height(obj, LV_PCT(100))
 *   DS_LAYOUT_WRAP  → lv_obj_set_width/height(obj, LV_SIZE_CONTENT)
 *   DS_LAYOUT_GROW  → lv_obj_set_flex_grow(obj, 1)
 *   DS_LAYOUT_FIXED → no-op; caller has already applied the explicit dp value
 *
 * Pass own_keyword = NULL when no explicit Modifier.width/height keyword is set.
 */
void apply_resolved_size(lv_obj_t *obj, ds_render_parent_t parent_info, const char *child_kind,
                         const char *child_variant, const char *own_keyword, bool is_width);

/* --------------------------------------------------------------------------
 * Container + textfield baselines
 * ----------------------------------------------------------------------- */

/**
 * Zero LVGL's theme paint on a bare lv_obj_create() — bg_opa, border_width,
 * radius, pad_all, shadow_width, outline_width. Idempotent.
 * Renderers that need paint re-apply those properties after calling this.
 */
void reset_container_paint(lv_obj_t *obj);

/**
 * Apply the canonical textfield baseline to an lv_textarea.
 *
 * Auto-sizes height from font.line_height — the unified font's line_height
 * is the MAX across all merged glyph ranges. If the content area is shorter
 * than line_height, the cursor caret overflows and re-triggers internal scroll
 * on every keystroke ("bouncing cursor" jitter).
 *
 * Sets: bg=SURFACE_CONT, 1px OUTLINE_VARIANT border, radius=SHAPE_SM,
 * pad_hor=10, pad_ver=SPACING_M, font, cursor blink off, scrollbar off,
 * width=fill, height=line_height + 2*SPACING_M + 2.
 * MUST be called immediately after lv_textarea_create, before focus. Idempotent.
 */
void apply_textfield_style(lv_obj_t *ta, const char *font_token);

/**
 * Same baseline but forces `target_h`. Use when the textarea must align with
 * a fixed-height sibling (e.g., the chat input pill next to the send button).
 * Re-balances pad_ver = (target_h - line_height - 2) / 2; falls back to
 * auto-sizing and logs an error if target_h is too small for the font.
 */
void apply_textfield_style_fixed_h(lv_obj_t *ta, const char *font_token, int target_h);

/* --------------------------------------------------------------------------
 * Elevation helper
 * ----------------------------------------------------------------------- */

/**
 * Apply the M3 shadow tuple for `level` — shadow_width, shadow_ofs_y,
 * shadow_opa (x-offset is always 0). All levels are zeroed on ESP32
 * (see style_helpers.c elevation section). Values from moumantai_elevation_table[].
 */
void apply_elevation(lv_obj_t *obj, moumantai_elevation_t level);

/* --------------------------------------------------------------------------
 * Icon mapping
 * ----------------------------------------------------------------------- */

/**
 * Create a widget rendering a Material Symbols icon (or a text-chip fallback
 * if the font is unavailable or the name is unmapped). Returns a single
 * LVGL child of `parent` sized to the requested px size.
 *
 * `color` is the glyph/text color; `size_px` picks one of the three bundled
 * Material Symbols sizes (rounded to nearest of 20/24/32).
 */
lv_obj_t *icon_label_create(lv_obj_t *parent, const char *icon_name, int size_px, lv_color_t color);

/**
 * Replace lv_keyboard's FontAwesome special-key glyphs with Material Symbols
 * equivalents. The default maps hardcode FontAwesome PUA strings; our font
 * ships Material Symbols Rounded only, so backspace/chevrons/enter render as
 * missing-glyph boxes without this. Layout and behavior are otherwise identical.
 */
void apply_material_keyboard_map(lv_obj_t *kb);
