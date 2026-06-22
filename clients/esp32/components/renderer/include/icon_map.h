#pragma once

#include <stdint.h>
#include "lvgl.h"

/* --------------------------------------------------------------------------
 * Icon resolution — server-emitted icon names → Material Symbols glyph.
 *
 * Canonical name list in `assets/fonts/icon_codepoints.txt`.
 * Table below is kept in lock-step with that file by hand (small enough).
 * ----------------------------------------------------------------------- */

/** Size bucket for picking the Material Symbols font. */
typedef enum {
    ICON_SIZE_SMALL = 20,
    ICON_SIZE_MEDIUM = 24,
    ICON_SIZE_LARGE = 32,
} icon_size_t;

/** Resolved glyph. `font` is NULL if the Material Symbols font is not
 *  compiled in (i.e. the font pipeline has not been run yet). In that case
 *  the caller should render `fallback_label` as a text chip instead. */
typedef struct {
    const lv_font_t *font;  /* Material Symbols font, or NULL */
    uint32_t codepoint;     /* Glyph codepoint, 0 if unknown  */
    char fallback_label[5]; /* ≤4 char abbrev + NUL for chip fallback */
} icon_glyph_t;

/**
 * Resolve an icon name emitted by the server to a glyph.
 *
 * Accepts lowercase `snake_case` (as emitted by servers) as well as
 * `kebab-case` and mixed casing — the lookup is case-insensitive.
 *
 * If the name is unknown, `codepoint` is 0 and `fallback_label` is populated
 * with an abbreviated form so the caller can draw a chip instead of a blank.
 */
icon_glyph_t icon_resolve(const char *name, icon_size_t size);
