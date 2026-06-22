#include "render_node.h"
#include "style_helpers.h"
#include "icon_map.h"
#include "action_dispatch.h"
#include "state.h"
#include "design_system.h"
#include "data_model.h"

#include <string.h>
#include <stdbool.h>
#include <stdlib.h>
#include <math.h>
#include "esp_log.h"

static const char __attribute__((unused)) *TAG = "render_int";

/* --------------------------------------------------------------------------
 * Action wiring — action pointer borrowed from face_state component array;
 * lifetime spans the face render (LVGL deletes the tree before face_state frees).
 * ----------------------------------------------------------------------- */

typedef struct {
    char component_id[64];
    char surface_id[128];
    const moumantai_v1_Action *action; /* borrowed; lifetime tied to face_state */
    const cJSON *args;                 /* borrowed; lifetime tied to face_state */
} action_ctx_t;

static void on_action_clicked(lv_event_t *e) {
    action_ctx_t *actx = (action_ctx_t *)lv_event_get_user_data(e);
    if (!actx || !actx->action)
        return;
    action_dispatch_from_def(actx->action, actx->args, actx->surface_id, actx->component_id);
}

static void on_obj_deleted(lv_event_t *e) {
    free(lv_event_get_user_data(e));
}

/* --------------------------------------------------------------------------
 * Slider step-snap — fires on RELEASED so snap is applied before
 * wire_action's VALUE_CHANGED. Setting value in RELEASED triggers another
 * VALUE_CHANGED (double-fire), which is acceptable — the action is idempotent
 * and matches Wear/Phone behaviour where the OS rounds on release.
 * ----------------------------------------------------------------------- */

typedef struct {
    double step;
    int32_t min;
    int32_t max;
} step_ctx_t;

static void on_slider_released(lv_event_t *e) {
    step_ctx_t *sctx = (step_ctx_t *)lv_event_get_user_data(e);
    if (!sctx || sctx->step <= 0.0)
        return;
    lv_obj_t *slider = lv_event_get_target(e);
    int32_t v = lv_slider_get_value(slider);
    int32_t snapped = sctx->min + (int32_t)round((double)(v - sctx->min) / sctx->step) * (int32_t)sctx->step;
    if (snapped < sctx->min)
        snapped = sctx->min;
    if (snapped > sctx->max)
        snapped = sctx->max;
    if (snapped != v)
        lv_slider_set_value(slider, snapped, LV_ANIM_ON);
}

static void wire_action(lv_obj_t *obj, const moumantai_v1_Action *action, const char *id, const render_ctx_t *ctx,
                        lv_event_code_t event_code) {
    if (!action)
        return;
    action_ctx_t *actx = calloc(1, sizeof(*actx));
    if (!actx)
        return;
    strncpy(actx->component_id, id ? id : "", sizeof(actx->component_id) - 1);
    strncpy(actx->surface_id, ctx->surface_id ? ctx->surface_id : "", sizeof(actx->surface_id) - 1);
    actx->action = action;
    /* Borrowed from per-face sidecar; same lifetime as `action`. */
    actx->args = (ctx->action_args && id) ? cJSON_GetObjectItemCaseSensitive((cJSON *)ctx->action_args, id) : NULL;
    lv_obj_add_event_cb(obj, on_action_clicked, event_code, actx);
    lv_obj_add_event_cb(obj, on_obj_deleted, LV_EVENT_DELETE, actx);
}

/* --------------------------------------------------------------------------
 * Button
 * ----------------------------------------------------------------------- */

lv_obj_t *render_button(lv_obj_t *parent, const moumantai_v1_ButtonComponent *c, const char *id,
                        const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    const char *text = c->has_text ? dyn_string_resolve(&c->text, ctx) : NULL;
    const char *icon = c->has_icon ? dyn_string_resolve(&c->icon, ctx) : NULL;

    lv_obj_t *btn = lv_button_create(parent);

    /* Catalog-driven width — Button intrinsic is wrap; modifier keyword overrides. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(btn, parent_info, "Button", NULL, own_kw_w, true);

    /* ESP32 renders Button as single-style (catalog default = tonal). The
     * intent-driven model (emphasis/tone) is not consumed here per the M5c
     * compile-only decision — falling back to the default variant gives
     * authors a consistent affordance on the panel. */
    ds_variant_spec_t spec = ds_button_resolve(NULL);

    switch (spec.kind) {
    case DS_KIND_OUTLINED_CONTAINER:
        lv_obj_set_style_bg_opa(btn, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_color(btn, THEME_OUTLINE, 0);
        lv_obj_set_style_border_width(btn, 1, 0);
        break;
    case DS_KIND_TRANSPARENT:
        lv_obj_set_style_bg_opa(btn, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(btn, 0, 0);
        lv_obj_set_style_shadow_width(btn, 0, 0);
        break;
    case DS_KIND_FILLED_CONTAINER:
    default:
        /* Tonal (secondary accent) uses the lighter primary container; plain
         * filled (primary accent) uses the saturated primary. */
        lv_obj_set_style_bg_color(btn, spec.accent == DS_ACCENT_SECONDARY ? THEME_PRIMARY_CONT : THEME_PRIMARY, 0);
        break;
    }

    /* 10: button radius — between shape.sm=8 and shape.md=12; no exact token. */
    lv_obj_set_style_radius(btn, 10, 0);
    lv_obj_set_style_min_height(btn, MOUMANTAI_BUTTON_HEIGHT, 0);
    /* Height: Button intrinsic is wrap; min_height above enforces the touch target. */
    const char *own_kw_h = (c->has_modifier && c->modifier.has_height &&
                            c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                               ? c->modifier.height.kind.keyword
                               : NULL;
    apply_resolved_size(btn, parent_info, "Button", NULL, own_kw_h, false);
    lv_obj_set_style_pad_hor(btn, 14, 0);
    lv_obj_set_style_pad_ver(btn, 10, 0);

    /* Foreground color: filled+primary uses on-primary for contrast; every
     * other treatment (outlined, text, tonal) puts the primary color on
     * the surface/transparent background. */
    bool is_filled_primary = spec.kind == DS_KIND_FILLED_CONTAINER && spec.accent == DS_ACCENT_PRIMARY;
    lv_color_t fg = is_filled_primary ? THEME_ON_PRIMARY : THEME_PRIMARY;

    if (icon && text) {
        lv_obj_set_flex_flow(btn, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_set_style_pad_gap(btn, MOUMANTAI_SPACING_M, 0);
        icon_label_create(btn, icon, MOUMANTAI_ICON_SIZE, fg);
        lv_obj_t *text_lbl = lv_label_create(btn);
        lv_label_set_text(text_lbl, text);
        apply_typo(text_lbl, "labelLarge");
        lv_obj_set_style_text_color(text_lbl, fg, 0);
    } else if (text) {
        lv_obj_t *label = lv_label_create(btn);
        lv_label_set_text(label, text);
        apply_typo(label, "labelLarge");
        lv_obj_set_style_text_color(label, fg, 0);
        lv_obj_center(label);
    } else if (icon) {
        /* 24: Material Symbols mid-size bucket — not a sizing token (see render_icon). */
        lv_obj_t *g = icon_label_create(btn, icon, 24, fg);
        lv_obj_center(g);
    }

    if (c->has_enabled && !dyn_bool_resolve(&c->enabled, ctx, true)) {
        lv_obj_add_state(btn, LV_STATE_DISABLED);
    }

    if (c->has_modifier)
        apply_modifier(btn, &c->modifier, ctx);
    if (c->has_action)
        wire_action(btn, &c->action, id, ctx, LV_EVENT_CLICKED);
    return btn;
}

/* --------------------------------------------------------------------------
 * Chip
 * ----------------------------------------------------------------------- */

lv_obj_t *render_chip(lv_obj_t *parent, const moumantai_v1_ChipComponent *c, const char *id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info) {
    lv_obj_t *chip = lv_button_create(parent);
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    const char *own_kw_h = (c->has_modifier && c->modifier.has_height &&
                            c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                               ? c->modifier.height.kind.keyword
                               : NULL;
    apply_resolved_size(chip, parent_info, "Chip", NULL, own_kw_w, true);
    apply_resolved_size(chip, parent_info, "Chip", NULL, own_kw_h, false);
    lv_obj_set_style_radius(chip, MOUMANTAI_SHAPE_SM, 0);
    lv_obj_set_style_pad_hor(chip, MOUMANTAI_CHIP_PADDING_X, 0);
    /* 6: chip pad_ver — below spacing.s=8; no exact token match. */
    lv_obj_set_style_pad_ver(chip, 6, 0);

    bool selected = c->has_selected ? dyn_bool_resolve(&c->selected, ctx, false) : false;
    if (selected) {
        lv_obj_set_style_bg_color(chip, THEME_PRIMARY_CONT, 0);
    } else {
        lv_obj_set_style_bg_opa(chip, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_color(chip, THEME_OUTLINE_VARIANT, 0);
        lv_obj_set_style_border_width(chip, 1, 0);
    }

    const char *label = c->has_label ? dyn_string_resolve(&c->label, ctx) : NULL;
    if (label) {
        lv_obj_t *lbl = lv_label_create(chip);
        lv_label_set_text(lbl, label);
        apply_typo(lbl, "labelMedium");
        lv_obj_set_style_text_color(lbl, THEME_ON_SURFACE, 0);
        lv_obj_center(lbl);
    }

    if (c->has_modifier)
        apply_modifier(chip, &c->modifier, ctx);
    if (c->has_action)
        wire_action(chip, &c->action, id, ctx, LV_EVENT_CLICKED);
    return chip;
}

/* --------------------------------------------------------------------------
 * TextField
 * ----------------------------------------------------------------------- */

lv_obj_t *render_textfield(lv_obj_t *parent, const moumantai_v1_TextFieldComponent *c, const char *id,
                           const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *ta = lv_textarea_create(parent);
    apply_textfield_style(ta, "bodyMedium");
    /* Override PCT(100) baseline with catalog-resolved width when parent wants wrap. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(ta, parent_info, "TextField", NULL, own_kw_w, true);
    /* The helper forces one_line=true for the canonical single-line baseline
     * (cursor caret + scrollbar geometry tuned to the unified font's
     * line_height). Multi-line widgets opt out here. */
    if (c->has_multiline && c->multiline) {
        lv_textarea_set_one_line(ta, false);
    }

    if (c->has_placeholder)
        lv_textarea_set_placeholder_text(ta, c->placeholder);

    const char *value = c->has_value ? dyn_string_resolve(&c->value, ctx) : NULL;
    if (value)
        lv_textarea_set_text(ta, value);

    if (c->has_modifier)
        apply_modifier(ta, &c->modifier, ctx);
    /* No `$form` writeback — see clients/esp32/spec.md "Known Limitations". */
    return ta;
}

/* --------------------------------------------------------------------------
 * CheckBox
 * ----------------------------------------------------------------------- */

lv_obj_t *render_checkbox(lv_obj_t *parent, const moumantai_v1_CheckBoxComponent *c, const char *id,
                          const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    lv_obj_t *cb = lv_checkbox_create(parent);

    /* Catalog: CheckBox is { width: parent, height: wrap }. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(cb, parent_info, "CheckBox", NULL, own_kw_w, true);

    const char *label = c->has_label ? dyn_string_resolve(&c->label, ctx) : NULL;
    /* Always set text — lv_checkbox_constructor sets a "Checkbox" placeholder
     * that leaks through if we only set it when a label is present. */
    lv_checkbox_set_text(cb, label ? label : "");

    if (c->has_checked && dyn_bool_resolve(&c->checked, ctx, false)) {
        lv_obj_add_state(cb, LV_STATE_CHECKED);
    }

    if (c->has_modifier)
        apply_modifier(cb, &c->modifier, ctx);
    if (c->has_action)
        wire_action(cb, &c->action, id, ctx, LV_EVENT_VALUE_CHANGED);
    return cb;
}

/* --------------------------------------------------------------------------
 * Switch
 * ----------------------------------------------------------------------- */

lv_obj_t *render_switch(lv_obj_t *parent, const moumantai_v1_SwitchComponent *c, const char *id,
                        const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    lv_obj_t *sw = lv_switch_create(parent);
    /* Switch renders as a bare toggle (wrap). Compose wraps it in a label-row,
     * but ESP32 renders the toggle only. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(sw, parent_info, "Switch", NULL, own_kw_w, true);

    if (c->has_checked && dyn_bool_resolve(&c->checked, ctx, false)) {
        lv_obj_add_state(sw, LV_STATE_CHECKED);
    }
    if (c->has_modifier)
        apply_modifier(sw, &c->modifier, ctx);
    if (c->has_action)
        wire_action(sw, &c->action, id, ctx, LV_EVENT_VALUE_CHANGED);
    return sw;
}

/* --------------------------------------------------------------------------
 * Slider
 * ----------------------------------------------------------------------- */

lv_obj_t *render_slider(lv_obj_t *parent, const moumantai_v1_SliderComponent *c, const char *id,
                        const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    lv_obj_t *slider = lv_slider_create(parent);

    /* Catalog-driven width. */
    const char *own_kw =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(slider, parent_info, "Slider", NULL, own_kw, true);

    int min_val = c->has_min ? (int)c->min : 0;
    int max_val = c->has_max ? (int)c->max : 100;
    lv_slider_set_range(slider, min_val, max_val);

    if (c->has_value) {
        double v = dyn_double_resolve(&c->value, ctx, (double)min_val);
        lv_slider_set_value(slider, (int32_t)v, LV_ANIM_OFF);
    }

    if (c->has_step && c->step > 0.0) {
        step_ctx_t *sctx = calloc(1, sizeof(*sctx));
        if (sctx) {
            sctx->step = c->step;
            sctx->min = min_val;
            sctx->max = max_val;
            lv_obj_add_event_cb(slider, on_slider_released, LV_EVENT_RELEASED, sctx);
            lv_obj_add_event_cb(slider, on_obj_deleted, LV_EVENT_DELETE, sctx);
        }
    }

    if (c->has_modifier)
        apply_modifier(slider, &c->modifier, ctx);
    if (c->has_action)
        wire_action(slider, &c->action, id, ctx, LV_EVENT_VALUE_CHANGED);
    return slider;
}

/* --------------------------------------------------------------------------
 * Tabs — renders labels as a row of chips; selecting fires action.
 * ----------------------------------------------------------------------- */

lv_obj_t *render_tabs(lv_obj_t *parent, const moumantai_v1_TabsComponent *c, const char *id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *strip = lv_obj_create(parent);
    reset_container_paint(strip);
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(strip, parent_info, "Tabs", NULL, own_kw_w, true);
    lv_obj_set_height(strip, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(strip, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_gap(strip, MOUMANTAI_SPACING_M, 0);

    int32_t selected = c->has_selected ? dyn_int32_resolve(&c->selected, ctx, 0) : 0;
    for (pb_size_t i = 0; i < c->tab_labels_count; i++) {
        if (c->tab_labels[i][0] == '\0')
            break;
        bool active = (int32_t)i == selected;
        lv_obj_t *btn = lv_button_create(strip);
        lv_obj_set_height(btn, LV_SIZE_CONTENT);
        lv_obj_set_style_radius(btn, MOUMANTAI_SHAPE_SM, 0);
        if (active) {
            lv_obj_set_style_bg_color(btn, THEME_PRIMARY_CONT, 0);
        } else {
            lv_obj_set_style_bg_opa(btn, LV_OPA_TRANSP, 0);
            lv_obj_set_style_border_width(btn, 0, 0);
        }
        lv_obj_t *lbl = lv_label_create(btn);
        lv_label_set_text(lbl, c->tab_labels[i]);
        apply_typo(lbl, "labelMedium");
        /* Explicit text color so a parent's text-color style doesn't bleed
         * through (inherited cascade meant a parent re-style would change
         * the tab labels too). */
        lv_obj_set_style_text_color(lbl, active ? THEME_PRIMARY : THEME_ON_SURFACE, 0);
    }

    /* Render the selected tab's content underneath. */
    if (selected >= 0 && selected < (int32_t)c->tab_content_count && c->tab_content[selected][0] != '\0') {
        ds_render_parent_t tab_child_info = {
            .kind = "Tabs",
            .slot_index = (int)selected,
            .slot_name = NULL,
        };
        render_node(parent, c->tab_content[selected], ctx, tab_child_info);
    }

    if (c->has_modifier)
        apply_modifier(strip, &c->modifier, ctx);
    return strip;
}

/* --------------------------------------------------------------------------
 * Select (Dropdown)
 * ----------------------------------------------------------------------- */

lv_obj_t *render_select(lv_obj_t *parent, const moumantai_v1_SelectComponent *c, const char *id,
                        const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    lv_obj_t *dd = lv_dropdown_create(parent);
    const char *own_kw =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(dd, parent_info, "Select", NULL, own_kw, true);

    if (c->has_options) {
        const int cap = 512;
        char *buf = calloc(cap, 1);
        if (buf) {
            int pos = 0;
            if (c->options.which_value == moumantai_v1_SelectOptions_literal_tag) {
                const moumantai_v1_SelectOptionList *list = &c->options.value.literal;
                for (pb_size_t i = 0; i < list->options_count; i++) {
                    const char *label = list->options[i].label;
                    if (!label || !*label)
                        continue;
                    int len = (int)strlen(label);
                    if (pos > 0 && pos < cap - 2)
                        buf[pos++] = '\n';
                    if (pos + len < cap - 1) {
                        memcpy(buf + pos, label, len);
                        pos += len;
                    }
                }
            } else if (c->options.which_value == moumantai_v1_SelectOptions_path_tag) {
                cJSON *arr = data_model_resolve(ctx->data, c->options.value.path);
                if (!arr || !cJSON_IsArray(arr)) {
                    ESP_LOGD(TAG, "Select '%s' options.path '%s' not found / not array", id ? id : "?",
                             c->options.value.path);
                } else {
                    int n = cJSON_GetArraySize(arr);
                    for (int i = 0; i < n; i++) {
                        cJSON *item = cJSON_GetArrayItem(arr, i);
                        if (!item)
                            continue;
                        cJSON *lbl_node = cJSON_GetObjectItemCaseSensitive(item, "label");
                        const char *label = (lbl_node && cJSON_IsString(lbl_node)) ? lbl_node->valuestring : NULL;
                        if (!label || !*label)
                            continue;
                        int len = (int)strlen(label);
                        if (pos > 0 && pos < cap - 2)
                            buf[pos++] = '\n';
                        if (pos + len < cap - 1) {
                            memcpy(buf + pos, label, len);
                            pos += len;
                        }
                    }
                }
            }
            buf[pos] = '\0';
            lv_dropdown_set_options(dd, buf);
            free(buf);
        }
    }

    if (c->has_modifier)
        apply_modifier(dd, &c->modifier, ctx);
    if (c->has_action)
        wire_action(dd, &c->action, id, ctx, LV_EVENT_VALUE_CHANGED);
    return dd;
}

/* --------------------------------------------------------------------------
 * DateTimeInput
 * ----------------------------------------------------------------------- */

lv_obj_t *render_datetime_input(lv_obj_t *parent, const moumantai_v1_DateTimeInputComponent *c, const char *id,
                                const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    /* Plain textarea fallback — full date picker is out-of-scope for v1.
     * When action is set, the textarea becomes tappable and fires the action
     * on click (matches Phone/Wear tap-fires-action pattern). */
    lv_obj_t *ta = lv_textarea_create(parent);
    apply_textfield_style(ta, "bodyMedium");
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(ta, parent_info, "DateTimeInput", NULL, own_kw_w, true);

    const char *value = c->has_value ? dyn_string_resolve(&c->value, ctx) : NULL;
    if (value)
        lv_textarea_set_text(ta, value);
    if (c->has_label)
        lv_textarea_set_placeholder_text(ta, c->label);

    if (c->has_modifier)
        apply_modifier(ta, &c->modifier, ctx);
    if (c->has_action) {
        lv_obj_add_flag(ta, LV_OBJ_FLAG_CLICKABLE);
        wire_action(ta, &c->action, id, ctx, LV_EVENT_CLICKED);
    }
    return ta;
}

/* --------------------------------------------------------------------------
 * Fab — floating action button. The ESP32 client renders inline (no overlay layer),
 * styled as a filled button with the primary-container accent.
 * ----------------------------------------------------------------------- */

lv_obj_t *render_fab(lv_obj_t *parent, const moumantai_v1_FabComponent *c, const char *id, const render_ctx_t *ctx,
                     ds_render_parent_t parent_info) {
    const char *label = c->has_label ? dyn_string_resolve(&c->label, ctx) : NULL;
    const char *icon = c->has_icon ? dyn_string_resolve(&c->icon, ctx) : NULL;

    lv_obj_t *btn = lv_button_create(parent);
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(btn, parent_info, "Fab", NULL, own_kw_w, true);

    lv_obj_set_style_bg_color(btn, THEME_PRIMARY_CONT, 0);
    lv_obj_set_style_radius(btn, MOUMANTAI_SHAPE_LG, 0);
    lv_obj_set_style_pad_hor(btn, 16, 0);
    lv_obj_set_style_pad_ver(btn, 12, 0);

    if (icon) {
        lv_obj_t *lbl = lv_label_create(btn);
        lv_label_set_text(lbl, icon);
        apply_typo(lbl, "labelLarge");
        lv_obj_set_style_text_color(lbl, THEME_ON_SURFACE, 0);
    }
    if (label && *label) {
        lv_obj_t *lbl = lv_label_create(btn);
        lv_label_set_text(lbl, label);
        apply_typo(lbl, "labelLarge");
        lv_obj_set_style_text_color(lbl, THEME_ON_SURFACE, 0);
    }

    if (c->has_action) {
        wire_action(btn, &c->action, id, ctx, LV_EVENT_CLICKED);
    }
    return btn;
}
