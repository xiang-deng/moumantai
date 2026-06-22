/*
 * style_helpers.c — LVGL style helpers driven by design-system tokens.
 *
 * Token source: clients/esp32/components/renderer/include/generated_tokens.h
 * (AUTO-GENERATED from shared/tokens/expanded.yaml — do not hand-edit that file).
 * Color constants (THEME_*) stay in style_helpers.h.
 */

#include "style_helpers.h" /* pulls in generated_tokens.h transitively */
#include "render_node.h"
#include "icon_map.h"
#include "design_system.h"

#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"

/* Three font families. NEVER merge icons or CJK into the primary text font —
 * line_height inflation regresses every textarea. Marked weak so firmware links
 * without generated .c files; resolvers fall back to LV_FONT_DEFAULT on NULL. */
extern const lv_font_t moumantai_text_14 __attribute__((weak));
extern const lv_font_t moumantai_text_20 __attribute__((weak));
extern const lv_font_t moumantai_text_28 __attribute__((weak));
extern const lv_font_t moumantai_icons_20 __attribute__((weak));
extern const lv_font_t moumantai_icons_24 __attribute__((weak));
extern const lv_font_t moumantai_icons_32 __attribute__((weak));

/* The volatile-cast defeats GCC's "address of foo will never be NULL"
 * optimization on weak refs so the NULL check is not elided. */
static const lv_font_t *resolve_weak_font(const lv_font_t *maybe) {
    const lv_font_t *volatile p = maybe;
    return p ? p : LV_FONT_DEFAULT;
}
static const lv_font_t *font14(void) {
    return resolve_weak_font(&moumantai_text_14);
}
static const lv_font_t *font20(void) {
    return resolve_weak_font(&moumantai_text_20);
}
static const lv_font_t *font28(void) {
    return resolve_weak_font(&moumantai_text_28);
}

const lv_font_t *resolve_icon_font(int size_px) {
    if (size_px <= 20)
        return resolve_weak_font(&moumantai_icons_20);
    if (size_px <= 24)
        return resolve_weak_font(&moumantai_icons_24);
    return resolve_weak_font(&moumantai_icons_32);
}

/* --------------------------------------------------------------------------
 * Color resolution
 * ----------------------------------------------------------------------- */

lv_color_t resolve_color(const char *color_str) {
    if (!color_str || color_str[0] == '\0')
        return THEME_ON_SURFACE;

    /* Hex color: "#RRGGBB" or "#RGB" */
    if (color_str[0] == '#') {
        unsigned long hex = strtoul(color_str + 1, NULL, 16);
        if (strlen(color_str) == 7) {
            return lv_color_hex((uint32_t)hex);
        }
        if (strlen(color_str) == 4) {
            /* Expand #RGB to #RRGGBB */
            uint32_t r = (hex >> 8) & 0xF;
            uint32_t g = (hex >> 4) & 0xF;
            uint32_t b = hex & 0xF;
            return lv_color_hex((r << 20) | (r << 16) | (g << 12) | (g << 8) | (b << 4) | b);
        }
    }

    /* Named tokens */
    if (strcmp(color_str, "primary") == 0)
        return THEME_PRIMARY;
    if (strcmp(color_str, "onPrimary") == 0)
        return THEME_ON_PRIMARY;
    if (strcmp(color_str, "primaryContainer") == 0)
        return THEME_PRIMARY_CONT;
    if (strcmp(color_str, "surface") == 0)
        return THEME_SURFACE;
    if (strcmp(color_str, "onSurface") == 0)
        return THEME_ON_SURFACE;
    if (strcmp(color_str, "surfaceContainer") == 0)
        return THEME_SURFACE_CONT;
    if (strcmp(color_str, "outline") == 0)
        return THEME_OUTLINE;
    if (strcmp(color_str, "error") == 0)
        return THEME_ERROR;
    if (strcmp(color_str, "onError") == 0)
        return THEME_ON_ERROR;
    /* Convenience aliases: "white" / "black" map to the design system's
     * #FFFFFF / #000000 hex tokens via LVGL's built-in helpers. */
    if (strcmp(color_str, "white") == 0)
        return lv_color_white();
    if (strcmp(color_str, "black") == 0)
        return lv_color_black();

    return THEME_ON_SURFACE;
}

/* --------------------------------------------------------------------------
 * Typography resolution
 * ----------------------------------------------------------------------- */

const lv_font_t *resolve_font(const char *typography) {
    /* All M3 tokens collapse onto three pre-rasterized sizes:
     * 14 (body + label), 20 (title + headline), 28 (display + headlineLarge). */

    if (!typography)
        return font14();

    /* Body + label + small title → 14 */
    if (strncmp(typography, "body", 4) == 0)
        return font14();
    if (strncmp(typography, "label", 5) == 0)
        return font14();
    if (strcmp(typography, "titleSmall") == 0)
        return font14();

    /* Large display → 28 */
    if (strcmp(typography, "displayLarge") == 0)
        return font28();
    if (strcmp(typography, "displayMedium") == 0)
        return font28();
    if (strcmp(typography, "displaySmall") == 0)
        return font28();
    if (strcmp(typography, "headlineLarge") == 0)
        return font28();

    /* Everything else (title/headline medium+large) → 20 */
    if (strncmp(typography, "title", 5) == 0)
        return font20();
    if (strncmp(typography, "headline", 8) == 0)
        return font20();
    if (strncmp(typography, "display", 7) == 0)
        return font28();

    return font14();
}

/* --------------------------------------------------------------------------
 * Text style — line/letter spacing tuned for 107 PPI ILI9488.
 * Body/label gets extra line-space (helps CJK+Latin runs); headlines tighten.
 * ----------------------------------------------------------------------- */

void apply_unified_font(lv_obj_t *obj, const char *typography) {
    if (!obj)
        return;
    const lv_font_t *font = resolve_font(typography);
    /* MAIN covers labels + textarea content + cursor; ITEMS covers
     * button-matrix keys (lv_keyboard). LVGL ignores the ITEMS selector
     * on widgets that don't have an items part. */
    lv_obj_set_style_text_font(obj, font, LV_PART_MAIN);
    lv_obj_set_style_text_font(obj, font, LV_PART_ITEMS);
}

void apply_text_style(lv_obj_t *label, const char *typography) {
    if (!label)
        return;

    /* Classify by role prefix — the exact token doesn't matter for line/letter. */
    bool is_display = typography && strncmp(typography, "display", 7) == 0;
    bool is_headline = typography && strncmp(typography, "headline", 8) == 0;
    bool is_title = typography && strncmp(typography, "title", 5) == 0;
    /* body / label / null → body defaults */

    if (is_display) {
        lv_obj_set_style_text_line_space(label, 0, 0);
        lv_obj_set_style_text_letter_space(label, -1, 0);
    } else if (is_headline || is_title) {
        lv_obj_set_style_text_line_space(label, 1, 0);
        lv_obj_set_style_text_letter_space(label, -1, 0);
    } else {
        /* body / label / caption */
        lv_obj_set_style_text_line_space(label, 3, 0);
        lv_obj_set_style_text_letter_space(label, 0, 0);
    }
}

/* --------------------------------------------------------------------------
 * Five shared typography styles covering all 15 M3 tokens via lv_obj_add_style
 * (no per-widget allocation). Initialized once in renderer_init.
 *
 *   s_typo_display          font28 / line=0  / letter=-1   display*
 *   s_typo_headline_xl      font28 / line=1  / letter=-1   headlineLarge
 *   s_typo_headline_title   font20 / line=1  / letter=-1   headline{M,S}, title{L,M}
 *   s_typo_title_small      font14 / line=1  / letter=-1   titleSmall
 *   s_typo_body_label       font14 / line=3  / letter=0    body*, label* (default)
 * ----------------------------------------------------------------------- */
static lv_style_t s_typo_display;
static lv_style_t s_typo_headline_xl;
static lv_style_t s_typo_headline_title;
static lv_style_t s_typo_title_small;
static lv_style_t s_typo_body_label;
static bool s_typo_initialized = false;

void style_helpers_init_styles(void) {
    if (s_typo_initialized)
        return;
    s_typo_initialized = true;

    lv_style_init(&s_typo_display);
    lv_style_set_text_font(&s_typo_display, font28());
    lv_style_set_text_line_space(&s_typo_display, 0);
    lv_style_set_text_letter_space(&s_typo_display, -1);

    lv_style_init(&s_typo_headline_xl);
    lv_style_set_text_font(&s_typo_headline_xl, font28());
    lv_style_set_text_line_space(&s_typo_headline_xl, 1);
    lv_style_set_text_letter_space(&s_typo_headline_xl, -1);

    lv_style_init(&s_typo_headline_title);
    lv_style_set_text_font(&s_typo_headline_title, font20());
    lv_style_set_text_line_space(&s_typo_headline_title, 1);
    lv_style_set_text_letter_space(&s_typo_headline_title, -1);

    lv_style_init(&s_typo_title_small);
    lv_style_set_text_font(&s_typo_title_small, font14());
    lv_style_set_text_line_space(&s_typo_title_small, 1);
    lv_style_set_text_letter_space(&s_typo_title_small, -1);

    lv_style_init(&s_typo_body_label);
    lv_style_set_text_font(&s_typo_body_label, font14());
    lv_style_set_text_line_space(&s_typo_body_label, 3);
    lv_style_set_text_letter_space(&s_typo_body_label, 0);
}

void apply_typo(lv_obj_t *obj, const char *typography) {
    if (!obj)
        return;
    /* Pick the right shared style by mirroring resolve_font + apply_text_style
     * classification. Unknown / NULL → body_label (safe default — matches
     * resolve_font's fallback to font14 and apply_text_style's body branch). */
    lv_style_t *style = &s_typo_body_label;
    if (typography) {
        if (strncmp(typography, "display", 7) == 0) {
            style = &s_typo_display;
        } else if (strcmp(typography, "headlineLarge") == 0) {
            style = &s_typo_headline_xl;
        } else if (strncmp(typography, "headline", 8) == 0) {
            style = &s_typo_headline_title;
        } else if (strcmp(typography, "titleSmall") == 0) {
            style = &s_typo_title_small;
        } else if (strncmp(typography, "title", 5) == 0) {
            style = &s_typo_headline_title;
        }
        /* body* and label* fall through to s_typo_body_label */
    }
    lv_obj_add_style(obj, style, 0);
}

/* --------------------------------------------------------------------------
 * Elevation — zeroed on ESP32.
 *
 * Software shadows cost ~50-200 ms each (circ_calc_aa4 + alpha blend at
 * 240 MHz/RGB565). A Card-heavy face with 5-15 ELEVATED cards would have
 * shadow rendering dominate. Surface-tier differentiation uses background
 * color instead (THEME_SURFACE_CONT in layout.c).
 *
 * The table and apply_elevation() stay intact so callers aren't #ifdef'd;
 * apply_elevation writes shadow_opa=0 / width=0 to clear any prior style
 * on recycled objects.
 * ----------------------------------------------------------------------- */
const moumantai_shadow_tuple_t moumantai_elevation_table[MOUMANTAI_ELEV_COUNT] = {
    [MOUMANTAI_ELEV_NONE] = {.width = 0, .ofs_y = 0, .opa = 0},
    [MOUMANTAI_ELEV_RAISED] = {.width = 0, .ofs_y = 0, .opa = 0},
    [MOUMANTAI_ELEV_FLOATING] = {.width = 0, .ofs_y = 0, .opa = 0},
    [MOUMANTAI_ELEV_ELEVATED] = {.width = 0, .ofs_y = 0, .opa = 0},
};

void apply_elevation(lv_obj_t *obj, moumantai_elevation_t level) {
    if (!obj)
        return;
    if ((unsigned)level >= MOUMANTAI_ELEV_COUNT)
        level = MOUMANTAI_ELEV_NONE;
    const moumantai_shadow_tuple_t *t = &moumantai_elevation_table[level];
    lv_obj_set_style_shadow_width(obj, t->width, 0);
    lv_obj_set_style_shadow_ofs_x(obj, 0, 0);
    lv_obj_set_style_shadow_ofs_y(obj, t->ofs_y, 0);
    lv_obj_set_style_shadow_opa(obj, t->opa, 0);
    if (t->width > 0) {
        lv_obj_set_style_shadow_color(obj, lv_color_black(), 0);
    }
}

/* --------------------------------------------------------------------------
 * Container + textfield baselines
 * ----------------------------------------------------------------------- */

void reset_container_paint(lv_obj_t *obj) {
    if (!obj)
        return;
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_radius(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_set_style_shadow_width(obj, 0, 0);
    lv_obj_set_style_outline_width(obj, 0, 0);
}

/* Shared body of the textfield baseline. Returns the resolved font line
 * height so callers can compute geometry off it. Pads / radius / colors /
 * cursor-blink / scrollbar are all set here; HEIGHT is left to the caller
 * variant (auto vs fixed-h). */
static int textfield_apply_baseline(lv_obj_t *ta, const char *font_token, int pad_ver) {
    lv_textarea_set_one_line(ta, true);
    apply_unified_font(ta, font_token);
    /* NOT apply_text_style — line_space=3 adds bbox slack the one-line cursor
     * doesn't expect, surfacing as keystroke-frequency jitter. */

    /* Cursor blink off — LVGL 9's blink animation reads as 1-2 px vertical
     * jitter at 107 PPI. Must be set before the textarea takes focus. */
    lv_obj_set_style_anim_duration(ta, 0, LV_PART_CURSOR);

    lv_obj_set_style_bg_color(ta, THEME_SURFACE_CONT, 0);
    lv_obj_set_style_bg_opa(ta, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(ta, THEME_OUTLINE_VARIANT, 0);
    lv_obj_set_style_border_width(ta, 1, 0);
    lv_obj_set_style_radius(ta, MOUMANTAI_SHAPE_SM, 0);
    lv_obj_set_style_pad_hor(ta, 10, 0); /* 10: textarea-tuned; not a spacing token */
    lv_obj_set_style_pad_ver(ta, pad_ver, 0);
    lv_obj_set_style_text_color(ta, THEME_ON_SURFACE, 0);
    lv_obj_set_scrollbar_mode(ta, LV_SCROLLBAR_MODE_OFF);
    /* Width resolved by caller via apply_resolved_size; FILL is the safe
     * default since textfield renderers always pass a Column-like context. */
    lv_obj_set_width(ta, LV_PCT(100));

    const lv_font_t *font = resolve_font(font_token);
    return (int)lv_font_get_line_height(font);
}

void apply_textfield_style(lv_obj_t *ta, const char *font_token) {
    if (!ta)
        return;
    int line_h = textfield_apply_baseline(ta, font_token, /*pad_ver=*/MOUMANTAI_SPACING_M);
    /* Auto-size: container = line_h + 2*MOUMANTAI_SPACING_M + 2*border (1 px each side). */
    lv_obj_set_height(ta, line_h + 2 * MOUMANTAI_SPACING_M + 2 * 1);
}

void apply_textfield_style_fixed_h(lv_obj_t *ta, const char *font_token, int target_h) {
    if (!ta)
        return;
    /* pad_ver = (target_h - line_h - 2*border) / 2; negative means target_h
     * is too short for the font → log error and fall back to auto-sizing. */
    const lv_font_t *font = resolve_font(font_token);
    int line_h = (int)lv_font_get_line_height(font);
    int pad_ver = (target_h - line_h - 2) / 2; /* 2 = border on both sides */
    if (pad_ver < 0) {
        ESP_LOGE("style",
                 "apply_textfield_style_fixed_h: target_h=%d too "
                 "small for font '%s' (line_h=%d). Falling back to auto-size.",
                 target_h, font_token ? font_token : "(null)", line_h);
        apply_textfield_style(ta, font_token);
        return;
    }
    textfield_apply_baseline(ta, font_token, pad_ver);
    lv_obj_set_height(ta, target_h);
}

/* --------------------------------------------------------------------------
 * Catalog-driven size resolver — maps ds_layout_resolve_{width,height} to LVGL.
 * ----------------------------------------------------------------------- */

void apply_resolved_size(lv_obj_t *obj, ds_render_parent_t parent_info, const char *child_kind,
                         const char *child_variant, const char *own_keyword, bool is_width) {
    ds_layout_size_t result =
        is_width ? ds_layout_resolve_width(parent_info.kind, parent_info.slot_index, parent_info.slot_name, child_kind,
                                           child_variant, own_keyword)
                 : ds_layout_resolve_height(parent_info.kind, parent_info.slot_index, parent_info.slot_name, child_kind,
                                            child_variant, own_keyword);
    switch (result) {
    case DS_LAYOUT_FILL:
        if (is_width)
            lv_obj_set_width(obj, LV_PCT(100));
        else
            lv_obj_set_height(obj, LV_PCT(100));
        break;
    case DS_LAYOUT_WRAP:
        if (is_width)
            lv_obj_set_width(obj, LV_SIZE_CONTENT);
        else
            lv_obj_set_height(obj, LV_SIZE_CONTENT);
        break;
    case DS_LAYOUT_GROW:
        lv_obj_set_flex_grow(obj, 1);
        break;
    case DS_LAYOUT_FIXED:
        /* Caller has already applied an explicit dp value from the modifier. */
        break;
    }
}

/* --------------------------------------------------------------------------
 * Icon rendering — Material Symbols glyph or text-chip fallback.
 *
 * Three bundled sizes (20 / 24 / 32 px). `icon_map.c` looks up the glyph
 * codepoint for a server-emitted name. If the Material Symbols font isn't
 * compiled in, we render the name abbreviated in a rounded chip so the
 * icon slot never appears blank.
 * ----------------------------------------------------------------------- */

static icon_size_t pick_size_bucket(int size_px) {
    if (size_px <= 20)
        return ICON_SIZE_SMALL;
    if (size_px <= 24)
        return ICON_SIZE_MEDIUM;
    return ICON_SIZE_LARGE;
}

/* Render the glyph in a fixed box; nudge label down ~size_px/14 so the
 * glyph's optical center aligns with the box's geometric center. */
static lv_obj_t *create_glyph_label(lv_obj_t *parent, const icon_glyph_t *g, int size_px, lv_color_t color) {
    /* Set the label's own size instead of wrapping in an lv_obj box —
     * same bounded slot at half the widget cost across many icons per face. */
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_size(label, size_px, size_px);
    lv_obj_set_style_text_font(label, g->font, 0);
    lv_obj_set_style_text_color(label, color, 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_pad_all(label, 0, 0);

    /* Encode codepoint as UTF-8. Material Symbols codepoints are in the
     * Private-Use Area (0xE000–0xF8FF) so 3 bytes in UTF-8. */
    char buf[5] = {0};
    uint32_t cp = g->codepoint;
    if (cp < 0x80) {
        buf[0] = (char)cp;
    } else if (cp < 0x800) {
        buf[0] = (char)(0xC0 | (cp >> 6));
        buf[1] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        buf[0] = (char)(0xE0 | (cp >> 12));
        buf[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        buf[2] = (char)(0x80 | (cp & 0x3F));
    } else {
        buf[0] = (char)(0xF0 | (cp >> 18));
        buf[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        buf[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
        buf[3] = (char)(0x80 | (cp & 0x3F));
    }
    lv_label_set_text(label, buf);
    /* Optical centering: nudge cap-height to visual center via pad_top. */
    int optical_offset = size_px / 14;
    if (optical_offset < 1)
        optical_offset = 1;
    lv_obj_set_style_pad_top(label, optical_offset, 0);
    return label;
}

/* Fallback: render the abbreviated label in a rounded chip so the icon
 * slot is never invisible. */
static lv_obj_t *create_chip_fallback(lv_obj_t *parent, const char *abbrev, int size_px, lv_color_t color) {
    lv_obj_t *chip = lv_obj_create(parent);
    lv_obj_set_size(chip, size_px, size_px);
    reset_container_paint(chip);
    lv_obj_set_style_radius(chip, size_px / 2, 0);
    lv_obj_set_style_border_color(chip, color, 0);
    lv_obj_set_style_border_width(chip, 1, 0);
    lv_obj_remove_flag(chip, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *label = lv_label_create(chip);
    lv_label_set_text(label, abbrev[0] ? abbrev : "?");
    lv_obj_set_style_text_color(label, color, 0);
    /* Body text font — chip fallback is text, not an icon glyph. */
    lv_obj_set_style_text_font(label, font14(), 0);
    lv_obj_center(label);
    return chip;
}

lv_obj_t *icon_label_create(lv_obj_t *parent, const char *icon_name, int size_px, lv_color_t color) {
    if (size_px <= 0)
        size_px = 24;
    icon_glyph_t g = icon_resolve(icon_name, pick_size_bucket(size_px));
    if (g.font && g.codepoint) {
        return create_glyph_label(parent, &g, size_px, color);
    }
    return create_chip_fallback(parent, g.fallback_label, size_px, color);
}

/* --------------------------------------------------------------------------
 * Material-Symbols keyboard layouts — substitutes Material Symbols glyphs
 * for the FontAwesome LV_SYMBOL_* strings that the unified font doesn't include.
 * ----------------------------------------------------------------------- */

#define MS_BACKSPACE "\xEE\x85\x8A"
#define MS_KEYBOARD_RET "\xEE\x85\x9E"
#define MS_KEYBOARD "\xEE\x8C\x92"
#define MS_LEFT "\xEE\x97\x8B"
#define MS_RIGHT "\xEE\x97\x8C"
#define MS_OK "\xEE\x97\x8A"
#define MS_CLOSE "\xEE\x97\x8D"

/* Mode-switch button labels. Match lv_keyboard's private defaults so the
 * widget's internal mode-switch parser still recognizes them. */
#define KB_MODE_LOWER "abc"
#define KB_MODE_UPPER "ABC"
#define KB_MODE_SPECIAL "1#"

/* Same as lv_keyboard.c's private LV_KB_BTN(): popovers + width units. */
#define KB_BTN(width) (LV_BUTTONMATRIX_CTRL_POPOVER | (width))

static const char *const ms_kb_map_lc[] = {KB_MODE_SPECIAL,
                                           "q",
                                           "w",
                                           "e",
                                           "r",
                                           "t",
                                           "y",
                                           "u",
                                           "i",
                                           "o",
                                           "p",
                                           MS_BACKSPACE,
                                           "\n",
                                           KB_MODE_UPPER,
                                           "a",
                                           "s",
                                           "d",
                                           "f",
                                           "g",
                                           "h",
                                           "j",
                                           "k",
                                           "l",
                                           MS_KEYBOARD_RET,
                                           "\n",
                                           "_",
                                           "-",
                                           "z",
                                           "x",
                                           "c",
                                           "v",
                                           "b",
                                           "n",
                                           "m",
                                           ".",
                                           ",",
                                           ":",
                                           "\n",
                                           MS_KEYBOARD,
                                           MS_LEFT,
                                           " ",
                                           MS_RIGHT,
                                           MS_OK,
                                           ""};

static const lv_buttonmatrix_ctrl_t ms_kb_ctrl_lc[] = {LV_KEYBOARD_CTRL_BUTTON_FLAGS | 5,
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 7,
                                                       LV_KEYBOARD_CTRL_BUTTON_FLAGS | 6,
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 7,
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2,
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 2,
                                                       6,
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 2,
                                                       LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2};

static const char *const ms_kb_map_uc[] = {KB_MODE_SPECIAL,
                                           "Q",
                                           "W",
                                           "E",
                                           "R",
                                           "T",
                                           "Y",
                                           "U",
                                           "I",
                                           "O",
                                           "P",
                                           MS_BACKSPACE,
                                           "\n",
                                           KB_MODE_LOWER,
                                           "A",
                                           "S",
                                           "D",
                                           "F",
                                           "G",
                                           "H",
                                           "J",
                                           "K",
                                           "L",
                                           MS_KEYBOARD_RET,
                                           "\n",
                                           "_",
                                           "-",
                                           "Z",
                                           "X",
                                           "C",
                                           "V",
                                           "B",
                                           "N",
                                           "M",
                                           ".",
                                           ",",
                                           ":",
                                           "\n",
                                           MS_CLOSE,
                                           MS_LEFT,
                                           " ",
                                           MS_RIGHT,
                                           MS_OK,
                                           ""};

static const lv_buttonmatrix_ctrl_t ms_kb_ctrl_uc[] = {LV_KEYBOARD_CTRL_BUTTON_FLAGS | 5,
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       KB_BTN(4),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 7,
                                                       LV_KEYBOARD_CTRL_BUTTON_FLAGS | 6,
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       KB_BTN(3),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 7,
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | KB_BTN(1),
                                                       LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2,
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 2,
                                                       6,
                                                       LV_BUTTONMATRIX_CTRL_CHECKED | 2,
                                                       LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2};

static const char *const ms_kb_map_spec[] = {
    "1", "2", "3", "4", "5", "6",  "7", "8",  "9",         "0",     MS_BACKSPACE, "\n",     KB_MODE_LOWER, "+", "&",
    "/", "*", "=", "%", "!", "?",  "#", "<",  ">",         "\n",    "\\",         "@",      "$",           "(", ")",
    "{", "}", "[", "]", ";", "\"", "'", "\n", MS_KEYBOARD, MS_LEFT, " ",          MS_RIGHT, MS_OK,         ""};

static const lv_buttonmatrix_ctrl_t ms_kb_ctrl_spec[] = {KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         LV_BUTTONMATRIX_CTRL_CHECKED | 2,
                                                         LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2,
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         KB_BTN(1),
                                                         LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2,
                                                         LV_BUTTONMATRIX_CTRL_CHECKED | 2,
                                                         6,
                                                         LV_BUTTONMATRIX_CTRL_CHECKED | 2,
                                                         LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2};

static const char *const ms_kb_map_num[] = {"1",  "2",   "3",  MS_KEYBOARD, "\n",    "4",      "5",
                                            "6",  MS_OK, "\n", "7",         "8",     "9",      MS_BACKSPACE,
                                            "\n", "+/-", "0",  ".",         MS_LEFT, MS_RIGHT, ""};

static const lv_buttonmatrix_ctrl_t ms_kb_ctrl_num[] = {
    1, 1, 1, LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2, 1, 1, 1, LV_KEYBOARD_CTRL_BUTTON_FLAGS | 2, 1, 1, 1, 2, 1, 1, 1, 1, 1};

/* --------------------------------------------------------------------------
 * Custom keyboard event cb — REPLACES LVGL's default cb, which dispatches
 * via FontAwesome LV_SYMBOL_* strcmp and always misses our Material Symbols
 * labels. Remove-then-add so ours is the only handler on VALUE_CHANGED.
 * ----------------------------------------------------------------------- */

static void material_keyboard_event_cb(lv_event_t *e) {
    lv_obj_t *kb = lv_event_get_target(e);
    uint32_t btn_id = lv_buttonmatrix_get_selected_button(kb);
    if (btn_id == LV_BUTTONMATRIX_BUTTON_NONE)
        return;
    const char *txt = lv_buttonmatrix_get_button_text(kb, btn_id);
    if (!txt)
        return;
    lv_obj_t *ta = lv_keyboard_get_textarea(kb);

    /* Mode switches */
    if (lv_strcmp(txt, KB_MODE_LOWER) == 0) {
        lv_keyboard_set_mode(kb, LV_KEYBOARD_MODE_TEXT_LOWER);
        return;
    }
    if (lv_strcmp(txt, KB_MODE_UPPER) == 0) {
        lv_keyboard_set_mode(kb, LV_KEYBOARD_MODE_TEXT_UPPER);
        return;
    }
    if (lv_strcmp(txt, KB_MODE_SPECIAL) == 0) {
        lv_keyboard_set_mode(kb, LV_KEYBOARD_MODE_SPECIAL);
        return;
    }

    /* Material Symbols specials */
    if (lv_strcmp(txt, MS_BACKSPACE) == 0) {
        if (ta)
            lv_textarea_delete_char(ta);
        return;
    }
    if (lv_strcmp(txt, MS_LEFT) == 0) {
        if (ta)
            lv_textarea_cursor_left(ta);
        return;
    }
    if (lv_strcmp(txt, MS_RIGHT) == 0) {
        if (ta)
            lv_textarea_cursor_right(ta);
        return;
    }
    if (lv_strcmp(txt, MS_OK) == 0) {
        lv_obj_send_event(kb, LV_EVENT_READY, NULL);
        if (ta)
            lv_obj_send_event(ta, LV_EVENT_READY, NULL);
        return;
    }
    if (lv_strcmp(txt, MS_CLOSE) == 0 || lv_strcmp(txt, MS_KEYBOARD) == 0) {
        lv_obj_send_event(kb, LV_EVENT_CANCEL, NULL);
        if (ta)
            lv_obj_send_event(ta, LV_EVENT_CANCEL, NULL);
        return;
    }
    if (lv_strcmp(txt, MS_KEYBOARD_RET) == 0) {
        if (ta) {
            if (lv_textarea_get_one_line(ta)) {
                lv_obj_send_event(ta, LV_EVENT_READY, NULL);
            } else {
                lv_textarea_add_char(ta, '\n');
            }
        }
        return;
    }

    /* Regular text key — insert into textarea. */
    if (ta)
        lv_textarea_add_text(ta, txt);
}

void apply_material_keyboard_map(lv_obj_t *kb) {
    if (!kb)
        return;
    lv_keyboard_set_map(kb, LV_KEYBOARD_MODE_TEXT_LOWER, ms_kb_map_lc, ms_kb_ctrl_lc);
    lv_keyboard_set_map(kb, LV_KEYBOARD_MODE_TEXT_UPPER, ms_kb_map_uc, ms_kb_ctrl_uc);
    lv_keyboard_set_map(kb, LV_KEYBOARD_MODE_SPECIAL, ms_kb_map_spec, ms_kb_ctrl_spec);
    lv_keyboard_set_map(kb, LV_KEYBOARD_MODE_NUMBER, ms_kb_map_num, ms_kb_ctrl_num);
    /* Remove LVGL's default cb (dispatches by FontAwesome strings) first,
     * then add ours so Material Symbols strings are the only handler. */
    lv_obj_remove_event_cb(kb, lv_keyboard_def_event_cb);
    lv_obj_add_event_cb(kb, material_keyboard_event_cb, LV_EVENT_VALUE_CHANGED, NULL);
}
