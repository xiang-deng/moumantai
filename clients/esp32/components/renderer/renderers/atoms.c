#include "render_node.h"
#include "style_helpers.h"
#include "icon_map.h"

#include <string.h>

/* --------------------------------------------------------------------------
 * Text — label with typography and dynamic data binding
 * ----------------------------------------------------------------------- */

lv_obj_t *render_text(lv_obj_t *parent, const moumantai_v1_TextComponent *c, const char *id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *label = lv_label_create(parent);

    const char *text = c->has_text ? dyn_string_resolve(&c->text, ctx) : NULL;
    lv_label_set_text(label, text ? text : "");

    const char *typo = c->has_typography ? c->typography : NULL;
    /* Shared typography style — font + line/letter spacing in one
     * lv_obj_add_style. Override of LVGL's UNSCII_8 default still happens
     * because shared styles win over inherited cascade. */
    apply_typo(label, typo);

    if (c->has_color) {
        lv_obj_set_style_text_color(label, resolve_color(c->color), 0);
    } else {
        lv_obj_set_style_text_color(label, THEME_ON_SURFACE, 0);
    }

    if (c->has_text_align) {
        if (strcmp(c->text_align, "center") == 0)
            lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
        else if (strcmp(c->text_align, "end") == 0)
            lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_RIGHT, 0);
    }

    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);

    /* Resolve width via the catalog: Text intrinsic is wrap; parent context
     * may widen it (e.g. explicit fill modifier). */
    const char *own_kw =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(label, parent_info, "Text", NULL, own_kw, true);

    /* LVGL quirk: a label with LV_SIZE_CONTENT width and LV_LABEL_LONG_WRAP
     * measures to its natural single-line text width — wrap never engages
     * because there's no constrained max width to wrap against. PWA's <div>
     * and Compose's Text get this bound for free from their layout systems;
     * on LVGL we have to declare it. Capping max_width at LV_PCT(100) keeps
     * the catalog's wrap intent (short text stays compact) while letting
     * long strings wrap inside the parent instead of overflowing the screen.
     * LVGL 9.5 includes the max_width-on-label fix (lvgl/lvgl#5636 → PR 5644). */
    lv_obj_set_style_max_width(label, LV_PCT(100), 0);

    if (c->has_modifier)
        apply_modifier(label, &c->modifier, ctx);
    return label;
}

/* --------------------------------------------------------------------------
 * Icon — Material Symbols glyph (or abbreviated-text fallback chip)
 * ----------------------------------------------------------------------- */

lv_obj_t *render_icon(lv_obj_t *parent, const moumantai_v1_IconComponent *c, const char *id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info) {
    (void)id;
    (void)parent_info; /* Icon size is always fixed (size_px × size_px) */
    const char *icon_name = c->has_name ? dyn_string_resolve(&c->name, ctx) : NULL;
    /* Default 24: Material Symbols mid-size bucket (20/24/32); 24 is between
     * MOUMANTAI_ICON_SIZE=20 and MOUMANTAI_ICON_SIZE_LARGE=28 and is the M3 default. */
    int size = c->has_size ? c->size : 24;

    const char *color_str = c->has_color ? dyn_string_resolve(&c->color, ctx) : NULL;
    lv_color_t color = color_str ? resolve_color(color_str) : THEME_ON_SURFACE;

    lv_obj_t *obj = icon_label_create(parent, icon_name, size, color);
    if (c->has_modifier)
        apply_modifier(obj, &c->modifier, ctx);
    return obj;
}

/* --------------------------------------------------------------------------
 * Image — URL-loaded picture (LVGL-image fallback chip on ESP32)
 * ----------------------------------------------------------------------- */

lv_obj_t *render_image(lv_obj_t *parent, const moumantai_v1_ImageComponent *c, const char *id, const render_ctx_t *ctx,
                       ds_render_parent_t parent_info) {
    (void)id;
    (void)c;
    (void)ctx;
    (void)parent_info;
    /* No URL fetcher on the ESP32 client — and even if one is added, rendering
     * a placeholder chip+label combo here would cost 2 widgets + ~12 style
     * calls + 1 text rasterization per Image. In a face like scoreboard:game
     * with a list of team-logo rows, that compounds into the dominant
     * render-time offender. Returning a hidden zero-size widget keeps the caller contract
     * (render_node / render_children_ids both expect a widget pointer) while
     * emitting zero draw work and collapsing the slot in flex layouts.
     *
     * App authors targeting ESP32 must not rely on Image for layout balance —
     * see spec.md "ESP32 visual policy". */
    lv_obj_t *stub = lv_obj_create(parent);
    reset_container_paint(stub);
    lv_obj_set_size(stub, 0, 0);
    lv_obj_add_flag(stub, LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(stub, LV_OBJ_FLAG_SCROLLABLE);
    return stub;
}

/* --------------------------------------------------------------------------
 * Divider — horizontal line
 * ----------------------------------------------------------------------- */

lv_obj_t *render_divider(lv_obj_t *parent, const moumantai_v1_DividerComponent *c, const char *id,
                         const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)id;
    (void)parent_info; /* Divider is always fill-width, fixed-height=thickness */
    lv_obj_t *line = lv_obj_create(parent);
    int thickness = c->has_thickness ? c->thickness : 1;
    lv_obj_set_size(line, LV_PCT(100), thickness);
    if (c->has_color) {
        lv_obj_set_style_bg_color(line, resolve_color(c->color), 0);
    } else {
        lv_obj_set_style_bg_color(line, THEME_OUTLINE_VARIANT, 0);
    }
    lv_obj_set_style_bg_opa(line, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(line, 0, 0);
    lv_obj_set_style_radius(line, 0, 0);
    lv_obj_set_style_pad_all(line, 0, 0);
    lv_obj_remove_flag(line, LV_OBJ_FLAG_SCROLLABLE);

    if (c->has_modifier)
        apply_modifier(line, &c->modifier, ctx);
    return line;
}
