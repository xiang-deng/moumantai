#include "render_node.h"
#include "style_helpers.h"
#include "icon_map.h"
#include "data_model.h"
#include "design_system.h"

#include <string.h>
#include <stdio.h>
#include "esp_log.h"

static const char *TAG = "render_data";

/* --------------------------------------------------------------------------
 * Helper: derive a component's PascalCase kind name from its nanopb tag.
 * Mirrors the TS-side variantCaseToKind and Kotlin componentKind(). Consumers
 * feed the result into the design-system catalog (ds_container_child_gap).
 * Returns NULL for unknown / unset variants — caller substitutes "default".
 * ----------------------------------------------------------------------- */
static const char *component_kind_name(const moumantai_v1_ComponentDef *def) {
    if (!def)
        return NULL;
    switch (def->which_component) {
    case moumantai_v1_ComponentDef_text_tag:
        return "Text";
    case moumantai_v1_ComponentDef_icon_tag:
        return "Icon";
    case moumantai_v1_ComponentDef_image_tag:
        return "Image";
    case moumantai_v1_ComponentDef_divider_tag:
        return "Divider";
    case moumantai_v1_ComponentDef_column_tag:
        return "Column";
    case moumantai_v1_ComponentDef_row_tag:
        return "Row";
    case moumantai_v1_ComponentDef_card_tag:
        return "Card";
    case moumantai_v1_ComponentDef_box_tag:
        return "Box";
    case moumantai_v1_ComponentDef_scaffold_tag:
        return "Scaffold";
    case moumantai_v1_ComponentDef_top_bar_tag:
        return "TopBar";
    case moumantai_v1_ComponentDef_button_tag:
        return "Button";
    case moumantai_v1_ComponentDef_chip_tag:
        return "Chip";
    case moumantai_v1_ComponentDef_fab_tag:
        return "Fab";
    case moumantai_v1_ComponentDef_text_field_tag:
        return "TextField";
    case moumantai_v1_ComponentDef_check_box_tag:
        return "CheckBox";
    case moumantai_v1_ComponentDef_switch_toggle_tag:
        return "Switch";
    case moumantai_v1_ComponentDef_slider_tag:
        return "Slider";
    case moumantai_v1_ComponentDef_tabs_tag:
        return "Tabs";
    case moumantai_v1_ComponentDef_select_tag:
        return "Select";
    case moumantai_v1_ComponentDef_date_time_input_tag:
        return "DateTimeInput";
    case moumantai_v1_ComponentDef_list_tag:
        return "List";
    case moumantai_v1_ComponentDef_list_item_tag:
        return "ListItem";
    case moumantai_v1_ComponentDef_progress_ring_tag:
        return "ProgressRing";
    case moumantai_v1_ComponentDef_progress_bar_tag:
        return "ProgressBar";
    case moumantai_v1_ComponentDef_modal_tag:
        return "Modal";
    default:
        return NULL;
    }
}

/* --------------------------------------------------------------------------
 * Helper: map a catalog spacing-token name ("spacing.s", "spacing.none", ...)
 * to a pixel value resolved against the locally-generated tokens.h. NULL or
 * "spacing.none" → 0 (sentinel for "no gap"); unknown names → 0 (defensive).
 * ----------------------------------------------------------------------- */
static int resolve_spacing_token_px(const char *token) {
    if (!token)
        return 0;
    if (strcmp(token, "spacing.none") == 0)
        return 0;
    if (strcmp(token, "spacing.xs") == 0)
        return MOUMANTAI_SPACING_XS;
    if (strcmp(token, "spacing.s") == 0)
        return MOUMANTAI_SPACING_S;
    if (strcmp(token, "spacing.m") == 0)
        return MOUMANTAI_SPACING_M;
    if (strcmp(token, "spacing.l") == 0)
        return MOUMANTAI_SPACING_L;
    if (strcmp(token, "spacing.xl") == 0)
        return MOUMANTAI_SPACING_XL;
    return 0;
}

/* --------------------------------------------------------------------------
 * List — iterates an array from the data model and renders a template per item.
 *
 * children = ListChildren { path: "/expenses", component_id: "expense_item" }
 * ----------------------------------------------------------------------- */

lv_obj_t *render_list(lv_obj_t *parent, const moumantai_v1_ListComponent *c, const char *id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info) {
    lv_obj_t *container = lv_obj_create(parent);
    reset_container_paint(container);
    /* Catalog-driven sizing. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    const char *own_kw_h = (c->has_modifier && c->modifier.has_height &&
                            c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                               ? c->modifier.height.kind.keyword
                               : NULL;
    apply_resolved_size(container, parent_info, "List", NULL, own_kw_w, true);
    apply_resolved_size(container, parent_info, "List", NULL, own_kw_h, false);
    lv_obj_set_flex_flow(container, LV_FLEX_FLOW_COLUMN);
    lv_obj_remove_flag(container, LV_OBJ_FLAG_SCROLLABLE);

    if (c->has_modifier)
        apply_modifier(container, &c->modifier, ctx);

    if (!c->has_children)
        return container;

    const char *data_path = c->children.path;
    const char *template_id = c->children.component_id;
    if (!data_path[0] || !template_id[0]) {
        ESP_LOGW(TAG, "List '%s' missing path or component_id", id ? id : "?");
        return container;
    }

    /* Per-child-kind gap from catalog (containers.List.child_gaps):
     * Card → spacing.s, ListItem → spacing.none (M3 divider pattern). */
    const moumantai_v1_ComponentDef *tmpl = find_component(ctx->components, ctx->num_components, template_id);
    const char *child_kind = component_kind_name(tmpl);
    if (!child_kind)
        child_kind = "default";
    const char *gap_token = ds_container_child_gap("List", child_kind);
    lv_obj_set_style_pad_row(container, resolve_spacing_token_px(gap_token), 0);

    cJSON *array = data_model_resolve(ctx->data, data_path);
    if (!array || !cJSON_IsArray(array)) {
        ESP_LOGD(TAG, "List '%s' path '%s' not found / not array", id ? id : "?", data_path);
        return container;
    }

    int total = cJSON_GetArraySize(array);
    /* Cap at 20: covers 320×480 visible rows plus inertial scroll. Higher
     * risks LVGL pool exhaustion (~10 widgets/item → 1000+ at 100 items).
     * The "…and N more" footer signals truncation. */
    enum { LIST_RENDER_CAP = 20 };
    int count = total > LIST_RENDER_CAP ? LIST_RENDER_CAP : total;
    if (count < total) {
        ESP_LOGW(TAG, "List '%s' has %d items; capping at %d", id ? id : "?", total, count);
    }

    ds_render_parent_t item_parent_info = {
        .kind = "List",
        .slot_index = 0,
        .slot_name = NULL,
    };

    for (int i = 0; i < count; i++) {
        cJSON *item = cJSON_GetArrayItem(array, i);
        if (!item)
            continue;

        item_parent_info.slot_index = i;

        if (ctx->session) {
            /* Defer each item to its own batch with the cJSON node so
             * $.field paths resolve inside the template. item_scope_path
             * is recomputed from item_scope_data; not carried through queue. */
            render_session_queue(ctx->session, container, template_id, item_parent_info, item, RPS_POST_NONE, 0);
        } else {
            char item_path[256];
            snprintf(item_path, sizeof(item_path), "%s/%d", data_path, i);

            render_ctx_t item_ctx = *ctx;
            item_ctx.item_scope_path = item_path;
            item_ctx.item_scope_data = item;

            render_node(container, template_id, &item_ctx, item_parent_info);
        }
    }

    if (count < total) {
        lv_obj_t *more = lv_label_create(container);
        char buf[64];
        snprintf(buf, sizeof(buf), "\xe2\x80\xa6 and %d more", total - count);
        lv_label_set_text(more, buf);
        apply_typo(more, "labelLarge");
        lv_obj_set_style_text_color(more, THEME_ON_SURFACE_VARIANT, 0);
        lv_obj_set_style_pad_ver(more, MOUMANTAI_SPACING_M, 0);
    }
    return container;
}

/* --------------------------------------------------------------------------
 * ListItem
 * ----------------------------------------------------------------------- */

lv_obj_t *render_listitem(lv_obj_t *parent, const moumantai_v1_ListItemComponent *c, const char *id,
                          const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *row = lv_obj_create(parent);
    reset_container_paint(row);
    /* Catalog: ListItem is { width: parent, height: wrap }. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    const char *own_kw_h = (c->has_modifier && c->modifier.has_height &&
                            c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                               ? c->modifier.height.kind.keyword
                               : NULL;
    apply_resolved_size(row, parent_info, "ListItem", NULL, own_kw_w, true);
    apply_resolved_size(row, parent_info, "ListItem", NULL, own_kw_h, false);
    /* 52: min-height for content-collapsed rows; natural height with
     * pad_ver=16 exceeds this in practice. */
    lv_obj_set_style_min_height(row, 52, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(row, MOUMANTAI_SPACING_L, 0);
    lv_obj_set_style_pad_ver(row, MOUMANTAI_SPACING_M, 0);
    lv_obj_set_style_pad_gap(row, MOUMANTAI_SPACING_L, 0);
    lv_obj_remove_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    if (c->has_leading_icon) {
        const char *icon = dyn_string_resolve(&c->leading_icon, ctx);
        /* 24: Material Symbols mid-size bucket — not a sizing token (see render_icon). */
        if (icon)
            icon_label_create(row, icon, 24, THEME_ON_SURFACE);
    }

    /* Text column (headline + supporting) — only materialize when at least
     * one of them is going to render. Saves a flex-column wrapper widget on
     * every icon-only / trailing-only list row, which multiplies in lists. */
    if (c->has_headline || c->has_supporting) {
        lv_obj_t *text_col = lv_obj_create(row);
        reset_container_paint(text_col);
        lv_obj_set_flex_grow(text_col, 1);
        lv_obj_set_height(text_col, LV_SIZE_CONTENT);
        lv_obj_set_flex_flow(text_col, LV_FLEX_FLOW_COLUMN);
        lv_obj_remove_flag(text_col, LV_OBJ_FLAG_SCROLLABLE);

        if (c->has_headline) {
            const char *headline = dyn_string_resolve(&c->headline, ctx);
            if (headline) {
                lv_obj_t *hl = lv_label_create(text_col);
                lv_label_set_text(hl, headline);
                apply_typo(hl, "titleSmall");
                lv_obj_set_style_text_color(hl, THEME_ON_SURFACE, 0);
                lv_label_set_long_mode(hl, LV_LABEL_LONG_WRAP);
                lv_obj_set_width(hl, LV_PCT(100));
            }
        }

        if (c->has_supporting) {
            const char *supporting = dyn_string_resolve(&c->supporting, ctx);
            if (supporting) {
                lv_obj_t *sp = lv_label_create(text_col);
                lv_label_set_text(sp, supporting);
                apply_typo(sp, "bodyMedium");
                lv_obj_set_style_text_color(sp, THEME_ON_SURFACE_VARIANT, 0);
                lv_label_set_long_mode(sp, LV_LABEL_LONG_WRAP);
                lv_obj_set_width(sp, LV_PCT(100));
            }
        }
    }

    if (c->has_trailing_content) {
        ds_render_parent_t trailing_info = {
            .kind = "ListItem",
            .slot_index = 0,
            .slot_name = NULL,
        };
        if (ctx->session) {
            /* set_width(LV_SIZE_CONTENT) must run after the deferred render;
             * queue with the hook so it collapses from the flex fill default. */
            render_session_queue(ctx->session, row, c->trailing_content, trailing_info, ctx->item_scope_data,
                                 RPS_POST_SIZE_CONTENT_W, 0);
        } else {
            lv_obj_t *trailing = render_node(row, c->trailing_content, ctx, trailing_info);
            if (trailing)
                lv_obj_set_width(trailing, LV_SIZE_CONTENT);
        }
    }

    if (c->has_modifier)
        apply_modifier(row, &c->modifier, ctx);
    return row;
}

/* --------------------------------------------------------------------------
 * ProgressBar / ProgressRing — separate components in the intent-driven model.
 * Each renderer owns its own primitive (LVGL bar vs arc); no variant string.
 * ----------------------------------------------------------------------- */

static int progress_bar_height(const moumantai_v1_ProgressBarComponent *c) {
    return 6;
}

static int progress_ring_diameter(const moumantai_v1_ProgressRingComponent *c) {
    if (c->has_size && c->size > 0)
        return (int)c->size;
    return 56;
}

lv_obj_t *render_progress_bar(lv_obj_t *parent, const moumantai_v1_ProgressBarComponent *c, const char *id,
                              const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)id;
    lv_color_t indicator_color = (c->has_color && c->color[0]) ? resolve_color(c->color) : THEME_PRIMARY;
    int bar_h = progress_bar_height(c);

    bool has_label = c->has_label && dyn_string_resolve(&c->label, ctx) != NULL;

    lv_obj_t *host = parent;
    lv_obj_t *col = NULL;
    if (has_label) {
        col = lv_obj_create(parent);
        reset_container_paint(col);
        lv_obj_set_width(col, LV_PCT(100));
        lv_obj_set_height(col, LV_SIZE_CONTENT);
        lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_style_pad_gap(col, MOUMANTAI_SPACING_S, 0);
        lv_obj_remove_flag(col, LV_OBJ_FLAG_SCROLLABLE);

        const char *txt = dyn_string_resolve(&c->label, ctx);
        lv_obj_t *lbl = lv_label_create(col);
        lv_label_set_text(lbl, txt);
        apply_typo(lbl, "labelMedium");
        lv_obj_set_style_text_color(lbl, THEME_ON_SURFACE, 0);
        lv_label_set_long_mode(lbl, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(lbl, LV_PCT(100));
        host = col;
    }

    lv_obj_t *bar = lv_bar_create(host);
    const char *own_kw =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(bar, parent_info, "ProgressBar", NULL, own_kw, true);
    lv_obj_set_height(bar, bar_h);
    lv_obj_set_style_radius(bar, bar_h / 2, 0);
    lv_obj_set_style_bg_color(bar, THEME_OUTLINE_VARIANT, 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(bar, indicator_color, LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_INDICATOR);

    int max_val = c->has_max ? (int)c->max : 100;
    lv_bar_set_range(bar, 0, max_val);
    if (c->has_value) {
        double v = dyn_double_resolve(&c->value, ctx, 0.0);
        lv_bar_set_value(bar, (int32_t)v, LV_ANIM_OFF);
    }

    if (c->has_modifier)
        apply_modifier(col ? col : bar, &c->modifier, ctx);
    return col ? col : bar;
}

lv_obj_t *render_progress_ring(lv_obj_t *parent, const moumantai_v1_ProgressRingComponent *c, const char *id,
                               const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)id;
    (void)parent_info;
    lv_color_t indicator_color = (c->has_color && c->color[0]) ? resolve_color(c->color) : THEME_PRIMARY;
    int diameter = progress_ring_diameter(c);
    int stroke = diameter / 8;
    if (stroke < 4)
        stroke = 4;

    bool has_label = c->has_label && dyn_string_resolve(&c->label, ctx) != NULL;
    bool has_sublabel = c->has_sublabel && dyn_string_resolve(&c->sublabel, ctx) != NULL;

    lv_obj_t *host = parent;
    lv_obj_t *col = NULL;
    if (has_label || has_sublabel) {
        col = lv_obj_create(parent);
        reset_container_paint(col);
        lv_obj_set_width(col, LV_PCT(100));
        lv_obj_set_height(col, LV_SIZE_CONTENT);
        lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_style_pad_gap(col, MOUMANTAI_SPACING_S, 0);
        lv_obj_remove_flag(col, LV_OBJ_FLAG_SCROLLABLE);
        host = col;

        if (has_label) {
            const char *txt = dyn_string_resolve(&c->label, ctx);
            lv_obj_t *lbl = lv_label_create(host);
            lv_label_set_text(lbl, txt);
            apply_typo(lbl, "labelMedium");
            lv_obj_set_style_text_color(lbl, THEME_ON_SURFACE, 0);
            lv_label_set_long_mode(lbl, LV_LABEL_LONG_WRAP);
            lv_obj_set_width(lbl, LV_PCT(100));
        }
    }

    lv_obj_t *arc = lv_arc_create(host);
    lv_obj_set_size(arc, diameter, diameter);
    lv_arc_set_bg_angles(arc, 0, 360);
    lv_arc_set_rotation(arc, 270);
    lv_obj_set_style_arc_color(arc, THEME_OUTLINE_VARIANT, LV_PART_MAIN);
    lv_obj_set_style_arc_color(arc, indicator_color, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(arc, stroke, LV_PART_MAIN);
    lv_obj_set_style_arc_width(arc, stroke, LV_PART_INDICATOR);
    lv_obj_remove_flag(arc, LV_OBJ_FLAG_CLICKABLE);

    int max_val = c->has_max ? (int)c->max : 100;
    if (c->has_value) {
        double v = dyn_double_resolve(&c->value, ctx, 0.0);
        int angle = (int)(360.0 * v / (double)max_val);
        lv_arc_set_angles(arc, 0, (uint16_t)angle);
    }

    if (has_sublabel) {
        const char *txt = dyn_string_resolve(&c->sublabel, ctx);
        lv_obj_t *sub = lv_label_create(host);
        lv_label_set_text(sub, txt);
        apply_typo(sub, "labelSmall");
        lv_obj_set_style_text_color(sub, THEME_ON_SURFACE_VARIANT, 0);
        lv_label_set_long_mode(sub, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(sub, LV_PCT(100));
    }

    if (c->has_modifier)
        apply_modifier(col ? col : arc, &c->modifier, ctx);
    return col ? col : arc;
}

/* --------------------------------------------------------------------------
 * Modal — overlay container; the ESP32 client renders inline (no real overlay layer).
 * ----------------------------------------------------------------------- */

lv_obj_t *render_modal(lv_obj_t *parent, const moumantai_v1_ModalComponent *c, const char *id, const render_ctx_t *ctx,
                       ds_render_parent_t parent_info) {
    (void)id;
    (void)parent_info;
    bool open = c->has_open ? dyn_bool_resolve(&c->open, ctx, false) : true;
    if (!open)
        return NULL;

    lv_obj_t *box = lv_obj_create(parent);
    reset_container_paint(box);
    lv_obj_set_size(box, LV_PCT(90), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(box, LV_FLEX_FLOW_COLUMN);
    /* MOUMANTAI_SHAPE_MD=12; M3 canonical dialogRadius=xl=24, but md=12 preserves the visual. */
    lv_obj_set_style_radius(box, MOUMANTAI_SHAPE_MD, 0);
    lv_obj_set_style_bg_color(box, THEME_SURFACE, 0);
    lv_obj_set_style_bg_opa(box, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(box, THEME_OUTLINE, 0);
    lv_obj_set_style_border_width(box, 1, 0);
    lv_obj_set_style_pad_all(box, MOUMANTAI_DIALOG_PADDING, 0);
    lv_obj_set_style_pad_gap(box, MOUMANTAI_SPACING_M, 0);

    if (c->has_modifier)
        apply_modifier(box, &c->modifier, ctx);

    render_children_ids(box, c->children, c->children_count, ctx, "Modal");
    /* Center the modal on its parent — without this it lays out as a flex
     * child and ends up flush-left below its siblings instead of overlaying. */
    lv_obj_center(box);
    return box;
}
