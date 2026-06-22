/*
 * Icon name → Material Symbols codepoint table.
 *
 * Keep aligned with `assets/fonts/icon_codepoints.txt`. When adding an icon,
 * update BOTH files (the text list is authoritative for font generation;
 * this table is what the runtime uses to look up codepoints).
 */

#include "icon_map.h"

#include <ctype.h>
#include <stdbool.h>
#include <string.h>

/* --------------------------------------------------------------------------
 * Icon font family — Material Symbols Rounded only, separate from body
 * text. Generated at three sizes (20 / 24 / 32) by build_unified_font.py;
 * this map picks one based on the requested icon size bucket.
 *
 * Why a separate family? See assets/fonts/build_unified_font.py: merging
 * Material Symbols glyphs into the body text font inflates its line_height
 * to ~27 (the icon em-square), which causes textareas to over-allocate
 * cursor-caret height and bounce on every keystroke. Keeping icons in
 * their own font isolates that line metric to icon containers.
 *
 * Weak externs keep the client running if the generator hasn't been run.
 * ----------------------------------------------------------------------- */

extern const lv_font_t moumantai_icons_20 __attribute__((weak));
extern const lv_font_t moumantai_icons_24 __attribute__((weak));
extern const lv_font_t moumantai_icons_32 __attribute__((weak));

/* Returns the weak symbol's address (NULL when the .c font file isn't
 * compiled in). Wrapped in a function + volatile cast to defeat GCC's
 * "address of foo will never be NULL" optimization. */
static const lv_font_t *weak_font_addr(const lv_font_t *maybe) {
    const lv_font_t *volatile p = maybe;
    return p;
}

static const lv_font_t *font_for_size(icon_size_t size) {
    switch (size) {
    case ICON_SIZE_SMALL:
        return weak_font_addr(&moumantai_icons_20);
    case ICON_SIZE_MEDIUM:
        return weak_font_addr(&moumantai_icons_24);
    case ICON_SIZE_LARGE:
        return weak_font_addr(&moumantai_icons_32);
    }
    return NULL;
}

/* --------------------------------------------------------------------------
 * Name → codepoint table (keep sorted alphabetically for readability)
 * ----------------------------------------------------------------------- */

typedef struct {
    const char *name;
    uint32_t codepoint;
} icon_entry_t;

static const icon_entry_t ICON_TABLE[] = {
    {"account_balance_wallet", 0xe850},
    {"add", 0xe145},
    {"add_circle", 0xe3ba},
    {"alarm", 0xe855},
    {"arrow_back", 0xe5c4},
    {"arrow_downward", 0xe5db},
    {"arrow_forward", 0xe5c8},
    {"arrow_upward", 0xe5d8},
    {"attach_money", 0xe227},
    {"backspace", 0xe14a},
    {"battery_empty", 0xe88b},
    {"battery_full", 0xe1a5},
    {"bluetooth", 0xe1a7},
    {"bookmark", 0xe8e7},
    {"cancel", 0xe888},
    {"chat", 0xe0c9},
    {"check", 0xe5ca},
    {"check_circle", 0xf0be},
    {"chevron_left", 0xe5cb},
    {"chevron_right", 0xe5cc},
    {"close", 0xe5cd},
    {"cloud_done", 0xe2bf},
    {"cloud_off", 0xe2c1},
    {"coffee", 0xefef},
    {"dashboard", 0xe871},
    {"delete", 0xe92e},
    {"directions_car", 0xeff7},
    {"directions_run", 0xe566},
    {"download", 0xf090},
    {"edit", 0xf097},
    {"error", 0xf8b6},
    {"event", 0xe878},
    {"fastfood", 0xe57a},
    {"favorite", 0xe87e},
    {"fitness_center", 0xeb43},
    {"flag", 0xf0c6},
    {"group", 0xea21},
    {"help", 0xe8fd},
    {"help_outline", 0xe8fd},
    {"home", 0xe9b2},
    {"info", 0xe88e},
    {"keyboard", 0xe312},
    {"keyboard_return", 0xe15e},
    {"list", 0xe896},
    {"local_cafe", 0xeb44},
    {"local_fire_department", 0xef55},
    {"local_hospital", 0xe548},
    {"login", 0xea77},
    {"logout", 0xe9ba},
    {"mic", 0xe31d},
    {"mic_off", 0xe02b},
    {"more_horiz", 0xe5d3},
    {"more_vert", 0xe5d4},
    {"movie", 0xe404},
    {"nightlight", 0xf03d},
    {"notifications", 0xe7f5},
    {"pause", 0xe034},
    {"payments", 0xef63},
    {"person", 0xf0d3},
    {"photo_camera", 0xe412},
    {"play_arrow", 0xe037},
    {"power_settings_new", 0xf8c7},
    {"public", 0xe80b},
    {"radio", 0xe03e},
    {"radio_button_unchecked", 0xe836},
    {"receipt", 0xe8b0},
    {"receipt_long", 0xef6e},
    {"refresh", 0xe5d5},
    {"remove", 0xe15b},
    {"replay", 0xe042},
    {"restaurant", 0xe56c},
    {"save", 0xe161},
    {"savings", 0xe2eb},
    {"schedule", 0xefd6},
    {"search", 0xe8b6},
    {"send", 0xe163},
    {"settings", 0xe8b8},
    {"shopping_bag", 0xf1cc},
    {"shopping_cart", 0xe8cc},
    {"skip_next", 0xe044},
    {"skip_previous", 0xe045},
    {"smart_toy", 0xf06c},
    {"star", 0xf09a},
    {"star_border", 0xf09a},
    {"stop", 0xe047},
    {"today", 0xe8df},
    {"train", 0xe570},
    {"trending_up", 0xe8e5},
    {"upload", 0xf09b},
    {"volume_off", 0xe04f},
    {"volume_up", 0xe050},
    {"warning", 0xf083},
    {"wb_sunny", 0xe430},
    {"whatshot", 0xe80e},
    {"wifi", 0xe63e},
};

static const size_t ICON_COUNT = sizeof(ICON_TABLE) / sizeof(ICON_TABLE[0]);

/* --------------------------------------------------------------------------
 * Normalization: lowercase + convert '-' → '_'. Writes up to dst_len-1 bytes.
 * ----------------------------------------------------------------------- */
static void normalize_name(const char *src, char *dst, size_t dst_len) {
    size_t i = 0;
    for (; src[i] != '\0' && i + 1 < dst_len; i++) {
        char c = src[i];
        if (c == '-')
            c = '_';
        else
            c = (char)tolower((unsigned char)c);
        dst[i] = c;
    }
    dst[i] = '\0';
}

static uint32_t lookup_codepoint(const char *normalized) {
    /* Linear scan — ~90 entries, negligible at this scale. */
    for (size_t i = 0; i < ICON_COUNT; i++) {
        if (strcmp(ICON_TABLE[i].name, normalized) == 0) {
            return ICON_TABLE[i].codepoint;
        }
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * Fallback label: take the first letter, then the letter after each '_'.
 * "account_balance_wallet" → "ABW", "restaurant" → "R", "arrow_back" → "AB".
 * Cap at 4 chars to fit a 24px chip.
 * ----------------------------------------------------------------------- */
static void build_fallback_label(const char *normalized, char *out, size_t out_len) {
    if (out_len == 0)
        return;
    size_t o = 0;
    bool want_next = true;
    for (size_t i = 0; normalized[i] != '\0' && o + 1 < out_len && o < 4; i++) {
        char c = normalized[i];
        if (c == '_') {
            want_next = true;
            continue;
        }
        if (want_next) {
            out[o++] = (char)toupper((unsigned char)c);
            want_next = false;
        }
    }
    if (o == 0 && normalized[0] != '\0' && out_len >= 2) {
        /* Fallback-of-fallback: first char uppercased */
        out[o++] = (char)toupper((unsigned char)normalized[0]);
    }
    if (o == 0 && out_len >= 2) {
        out[o++] = '?';
    }
    out[o] = '\0';
}

/* --------------------------------------------------------------------------
 * Public resolver
 * ----------------------------------------------------------------------- */

icon_glyph_t icon_resolve(const char *name, icon_size_t size) {
    icon_glyph_t out = {.font = NULL, .codepoint = 0, .fallback_label = {0}};

    if (!name || name[0] == '\0')
        return out;

    char normalized[40];
    /* `fa:` prefix is the FontAwesome escape hatch (phone and wear handle it
     * specially). We don't render it, but surface the rest as text. */
    const char *base = name;
    if (strncmp(name, "fa:", 3) == 0)
        base = name + 3;
    normalize_name(base, normalized, sizeof(normalized));

    out.codepoint = lookup_codepoint(normalized);
    out.font = font_for_size(size);

    /* Always populate the fallback — the caller decides whether to use
     * the glyph or the chip based on (font != NULL && codepoint != 0). */
    build_fallback_label(normalized, out.fallback_label, sizeof(out.fallback_label));
    return out;
}
