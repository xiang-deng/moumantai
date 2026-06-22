/*
 * render_node.c — typed-protobuf component dispatch.
 *
 * Replaces the JSON-string-discriminator registry with a oneof-tag switch on
 * `def->which_component`. Each renderer takes the typed sub-message pointer
 * (e.g. `const moumantai_v1_TextComponent *`) plus the def's id (for action
 * dispatch) and the render context.
 */

#include "render_node.h"
#include "style_helpers.h"
#include "data_model.h"
#include "design_system.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "render";

/* --------------------------------------------------------------------------
 * Session queue — BFS work-list for batched rendering.
 *
 * Each entry queues one child component; the drain loop pops entries up to
 * a wall-clock budget per batch and yields back to the LVGL task between
 * batches (wired in renderer.c).
 *
 * Lifetime: entries borrow `parent` (render-tree lv_obj_t*) and
 * `item_scope_data` (cJSON node inside the snapshot). Both remain valid for
 * the session — the tile body is not deleted while the session is active,
 * and the cJSON tree lives until state_drain_face_free at session end.
 * ----------------------------------------------------------------------- */

typedef struct render_pending_s render_pending_t;
struct render_pending_s {
    lv_obj_t *parent;
    char child_id[64];
    ds_render_parent_t parent_info;
    const cJSON *item_scope_data; /* NULL = no list-item context */
    render_session_post_op_t post_op;
    lv_align_t post_align;
    render_pending_t *next;
};

struct render_session_s {
    render_pending_t *head;
    render_pending_t *tail;
};

render_session_t *render_session_create(void) {
    return calloc(1, sizeof(render_session_t));
}

void render_session_destroy(render_session_t *session) {
    if (!session)
        return;
    render_pending_t *p = session->head;
    while (p) {
        render_pending_t *next = p->next;
        free(p);
        p = next;
    }
    free(session);
}

bool render_session_has_work(const render_session_t *session) {
    return session && session->head;
}

void render_session_queue(render_session_t *session, lv_obj_t *parent, const char *child_id,
                          ds_render_parent_t parent_info, const cJSON *item_scope_data,
                          render_session_post_op_t post_op, lv_align_t post_align) {
    if (!session || !parent || !child_id || !child_id[0])
        return;
    render_pending_t *p = calloc(1, sizeof(*p));
    if (!p)
        return; /* OOM — drop this entry; downstream will see a missing widget */
    p->parent = parent;
    strncpy(p->child_id, child_id, sizeof(p->child_id) - 1);
    p->parent_info = parent_info;
    p->item_scope_data = item_scope_data;
    p->post_op = post_op;
    p->post_align = post_align;
    p->next = NULL;
    if (session->tail)
        session->tail->next = p;
    else
        session->head = p;
    session->tail = p;
}

void render_session_drain_batch(render_session_t *session, const render_ctx_t *ctx_template, int64_t budget_us) {
    if (!session || !ctx_template)
        return;
    int64_t start = esp_timer_get_time();
    while (session->head) {
        render_pending_t *p = session->head;
        session->head = p->next;
        if (!session->head)
            session->tail = NULL;

        /* If the parent was deleted out from under us (e.g., a new face
         * render called lv_obj_clean on the body and our parent was a
         * descendant), skip — the entry's work is moot. lv_obj_is_valid
         * checks the LVGL handle registry, not a stale pointer. */
        if (lv_obj_is_valid(p->parent)) {
            render_ctx_t ctx = *ctx_template;
            ctx.item_scope_data = p->item_scope_data;
            ctx.item_scope_path = NULL; /* path only used inside list iteration */
            lv_obj_t *child = render_node(p->parent, p->child_id, &ctx, p->parent_info);
            if (child) {
                if (p->post_op == RPS_POST_ALIGN) {
                    lv_obj_align(child, p->post_align, 0, 0);
                } else if (p->post_op == RPS_POST_SIZE_CONTENT_W) {
                    lv_obj_set_width(child, LV_SIZE_CONTENT);
                }
            }
        }
        free(p);

        /* Re-check budget per entry — component complexity varies (1-10 widgets). */
        if (esp_timer_get_time() - start > budget_us)
            break;
    }
}

/* --------------------------------------------------------------------------
 * Per-component renderer prototypes (declared in atoms/layout/interactive/data)
 * ----------------------------------------------------------------------- */

extern lv_obj_t *render_text(lv_obj_t *parent, const moumantai_v1_TextComponent *c, const char *id,
                             const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_icon(lv_obj_t *parent, const moumantai_v1_IconComponent *c, const char *id,
                             const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_image(lv_obj_t *parent, const moumantai_v1_ImageComponent *c, const char *id,
                              const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_divider(lv_obj_t *parent, const moumantai_v1_DividerComponent *c, const char *id,
                                const render_ctx_t *ctx, ds_render_parent_t parent_info);

extern lv_obj_t *render_column(lv_obj_t *parent, const moumantai_v1_ColumnComponent *c, const char *id,
                               const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_row(lv_obj_t *parent, const moumantai_v1_RowComponent *c, const char *id,
                            const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_card(lv_obj_t *parent, const moumantai_v1_CardComponent *c, const char *id,
                             const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_box(lv_obj_t *parent, const moumantai_v1_BoxComponent *c, const char *id,
                            const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_scaffold(lv_obj_t *parent, const moumantai_v1_ScaffoldComponent *c, const char *id,
                                 const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_topbar(lv_obj_t *parent, const moumantai_v1_TopBarComponent *c, const char *id,
                               const render_ctx_t *ctx, ds_render_parent_t parent_info);

extern lv_obj_t *render_button(lv_obj_t *parent, const moumantai_v1_ButtonComponent *c, const char *id,
                               const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_chip(lv_obj_t *parent, const moumantai_v1_ChipComponent *c, const char *id,
                             const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_textfield(lv_obj_t *parent, const moumantai_v1_TextFieldComponent *c, const char *id,
                                  const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_checkbox(lv_obj_t *parent, const moumantai_v1_CheckBoxComponent *c, const char *id,
                                 const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_switch(lv_obj_t *parent, const moumantai_v1_SwitchComponent *c, const char *id,
                               const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_slider(lv_obj_t *parent, const moumantai_v1_SliderComponent *c, const char *id,
                               const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_tabs(lv_obj_t *parent, const moumantai_v1_TabsComponent *c, const char *id,
                             const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_select(lv_obj_t *parent, const moumantai_v1_SelectComponent *c, const char *id,
                               const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_datetime_input(lv_obj_t *parent, const moumantai_v1_DateTimeInputComponent *c, const char *id,
                                       const render_ctx_t *ctx, ds_render_parent_t parent_info);

extern lv_obj_t *render_list(lv_obj_t *parent, const moumantai_v1_ListComponent *c, const char *id,
                             const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_listitem(lv_obj_t *parent, const moumantai_v1_ListItemComponent *c, const char *id,
                                 const render_ctx_t *ctx, ds_render_parent_t parent_info);

extern lv_obj_t *render_progress_ring(lv_obj_t *parent, const moumantai_v1_ProgressRingComponent *c, const char *id,
                                      const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_progress_bar(lv_obj_t *parent, const moumantai_v1_ProgressBarComponent *c, const char *id,
                                     const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_fab(lv_obj_t *parent, const moumantai_v1_FabComponent *c, const char *id,
                            const render_ctx_t *ctx, ds_render_parent_t parent_info);
extern lv_obj_t *render_modal(lv_obj_t *parent, const moumantai_v1_ModalComponent *c, const char *id,
                              const render_ctx_t *ctx, ds_render_parent_t parent_info);

/* --------------------------------------------------------------------------
 * Component lookup
 * ----------------------------------------------------------------------- */

const moumantai_v1_ComponentDef *find_component(const moumantai_v1_ComponentDef *comps, int count, const char *id) {
    if (!id || !comps)
        return NULL;
    for (int i = 0; i < count; i++) {
        if (strcmp(comps[i].id, id) == 0)
            return &comps[i];
    }
    return NULL;
}

/* --------------------------------------------------------------------------
 * Dynamic-value resolution
 * ----------------------------------------------------------------------- */

/** Look up a `path` (with optional `$.` prefix) against the surrounding data. */
static cJSON *resolve_path_to_cjson(const char *path, const render_ctx_t *ctx) {
    if (!path || !*path)
        return NULL;
    if (path[0] == '/') {
        return data_model_resolve(ctx->data, path);
    }
    /* Relative: strip $. prefix; resolve against item scope if any. */
    if (path[0] == '$' && path[1] == '.')
        path += 2;
    if (ctx->item_scope_data) {
        return cJSON_GetObjectItem((cJSON *)ctx->item_scope_data, path);
    }
    /* No item scope — try as root-relative key. */
    char buf[256];
    snprintf(buf, sizeof(buf), "/%s", path);
    return data_model_resolve(ctx->data, buf);
}

const char *dyn_string_resolve(const moumantai_v1_DynamicString *ds, const render_ctx_t *ctx) {
    if (!ds)
        return NULL;
    if (ds->which_value == moumantai_v1_DynamicString_literal_tag) {
        return ds->value.literal;
    }
    if (ds->which_value == moumantai_v1_DynamicString_path_tag) {
        cJSON *node = resolve_path_to_cjson(ds->value.path, ctx);
        if (!node)
            return NULL;
        if (cJSON_IsString(node))
            return node->valuestring;
        if (cJSON_IsNumber(node)) {
            static __thread char num_buf[32];
            if (node->valuedouble == (double)node->valueint) {
                snprintf(num_buf, sizeof(num_buf), "%d", node->valueint);
            } else {
                snprintf(num_buf, sizeof(num_buf), "%.2f", node->valuedouble);
            }
            return num_buf;
        }
        if (cJSON_IsBool(node))
            return cJSON_IsTrue(node) ? "true" : "false";
    } else if (ds->which_value != 0) {
        ESP_LOGW(TAG, "Unknown DynamicString tag: %d", (int)ds->which_value);
    }
    return NULL;
}

bool dyn_bool_resolve(const moumantai_v1_DynamicBool *db, const render_ctx_t *ctx, bool fallback) {
    if (!db)
        return fallback;
    if (db->which_value == moumantai_v1_DynamicBool_literal_tag) {
        return db->value.literal;
    }
    if (db->which_value == moumantai_v1_DynamicBool_path_tag) {
        cJSON *node = resolve_path_to_cjson(db->value.path, ctx);
        if (!node)
            return fallback;
        if (cJSON_IsBool(node))
            return cJSON_IsTrue(node);
        if (cJSON_IsNumber(node))
            return node->valueint != 0;
    } else if (db->which_value != 0) {
        ESP_LOGW(TAG, "Unknown DynamicBool tag: %d", (int)db->which_value);
    }
    return fallback;
}

double dyn_double_resolve(const moumantai_v1_DynamicDouble *dd, const render_ctx_t *ctx, double fallback) {
    if (!dd)
        return fallback;
    if (dd->which_value == moumantai_v1_DynamicDouble_literal_tag) {
        return dd->value.literal;
    }
    if (dd->which_value == moumantai_v1_DynamicDouble_path_tag) {
        cJSON *node = resolve_path_to_cjson(dd->value.path, ctx);
        if (node && cJSON_IsNumber(node))
            return node->valuedouble;
    } else if (dd->which_value != 0) {
        ESP_LOGW(TAG, "Unknown DynamicDouble tag: %d", (int)dd->which_value);
    }
    return fallback;
}

int32_t dyn_int32_resolve(const moumantai_v1_DynamicInt32 *di, const render_ctx_t *ctx, int32_t fallback) {
    if (!di)
        return fallback;
    if (di->which_value == moumantai_v1_DynamicInt32_literal_tag) {
        return di->value.literal;
    }
    if (di->which_value == moumantai_v1_DynamicInt32_path_tag) {
        cJSON *node = resolve_path_to_cjson(di->value.path, ctx);
        if (node && cJSON_IsNumber(node))
            return node->valueint;
    } else if (di->which_value != 0) {
        ESP_LOGW(TAG, "Unknown DynamicInt32 tag: %d", (int)di->which_value);
    }
    return fallback;
}

/* --------------------------------------------------------------------------
 * Modifier application
 * ----------------------------------------------------------------------- */

bool modifier_visible(const moumantai_v1_Modifier *mod, const render_ctx_t *ctx) {
    if (!mod || !mod->has_visible)
        return true;
    return dyn_bool_resolve(&mod->visible, ctx, true);
}

static void apply_dimension(lv_obj_t *obj, const moumantai_v1_Dimension *dim, bool is_width) {
    if (!dim)
        return;
    switch (dim->which_kind) {
    case moumantai_v1_Dimension_dp_tag:
        if (is_width)
            lv_obj_set_width(obj, dim->kind.dp);
        else
            lv_obj_set_height(obj, dim->kind.dp);
        break;
    case moumantai_v1_Dimension_keyword_tag:
        if (strcmp(dim->kind.keyword, "fill") == 0) {
            if (is_width)
                lv_obj_set_width(obj, LV_PCT(100));
            else
                lv_obj_set_height(obj, LV_PCT(100));
        } else if (strcmp(dim->kind.keyword, "wrap") == 0) {
            if (is_width)
                lv_obj_set_width(obj, LV_SIZE_CONTENT);
            else
                lv_obj_set_height(obj, LV_SIZE_CONTENT);
        }
        break;
    default:
        break;
    }
}

static void apply_padding(lv_obj_t *obj, const moumantai_v1_Dimension *padding) {
    if (!padding)
        return;
    if (padding->which_kind == moumantai_v1_Dimension_dp_tag) {
        lv_obj_set_style_pad_all(obj, padding->kind.dp, 0);
    } else if (padding->which_kind == moumantai_v1_Dimension_edges_tag) {
        const moumantai_v1_PaddingEdges *e = &padding->kind.edges;
        if (e->has_top)
            lv_obj_set_style_pad_top(obj, e->top, 0);
        else if (e->has_vertical)
            lv_obj_set_style_pad_top(obj, e->vertical, 0);
        if (e->has_bottom)
            lv_obj_set_style_pad_bottom(obj, e->bottom, 0);
        else if (e->has_vertical)
            lv_obj_set_style_pad_bottom(obj, e->vertical, 0);
        if (e->has_start)
            lv_obj_set_style_pad_left(obj, e->start, 0);
        else if (e->has_horizontal)
            lv_obj_set_style_pad_left(obj, e->horizontal, 0);
        if (e->has_end)
            lv_obj_set_style_pad_right(obj, e->end, 0);
        else if (e->has_horizontal)
            lv_obj_set_style_pad_right(obj, e->horizontal, 0);
    }
}

void apply_modifier(lv_obj_t *obj, const moumantai_v1_Modifier *mod, const render_ctx_t *ctx) {
    if (!mod)
        return;
    if (mod->has_padding)
        apply_padding(obj, &mod->padding);
    if (mod->has_width)
        apply_dimension(obj, &mod->width, true);
    if (mod->has_height)
        apply_dimension(obj, &mod->height, false);
    if (mod->has_weight)
        lv_obj_set_flex_grow(obj, (int)mod->weight);
    if (mod->has_background) {
        const char *color = dyn_string_resolve(&mod->background, ctx);
        if (color) {
            lv_obj_set_style_bg_color(obj, resolve_color(color), 0);
            lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
        }
    }
}

/* --------------------------------------------------------------------------
 * Top-level dispatch — switch on which_component
 * ----------------------------------------------------------------------- */

lv_obj_t *render_node(lv_obj_t *parent, const char *component_id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info) {
    if (!component_id || !ctx)
        return NULL;

    /* Yielding is handled by the batched-session driver in renderer.c;
     * when session is NULL the render is small enough to run synchronously. */

    const moumantai_v1_ComponentDef *def = find_component(ctx->components, ctx->num_components, component_id);
    if (!def) {
        /* WARN not DEBUG — orphan IDs should be visible at the default log level. */
        ESP_LOGW(TAG, "Component '%s' not found; parent slot will render empty", component_id);
        return NULL;
    }

    /* Pull modifier from whichever variant is selected; check visibility. */
    const moumantai_v1_Modifier *mod = NULL;
    switch (def->which_component) {
    case moumantai_v1_ComponentDef_text_tag:
        mod = def->component.text.has_modifier ? &def->component.text.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_icon_tag:
        mod = def->component.icon.has_modifier ? &def->component.icon.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_image_tag:
        mod = def->component.image.has_modifier ? &def->component.image.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_divider_tag:
        mod = def->component.divider.has_modifier ? &def->component.divider.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_column_tag:
        mod = def->component.column.has_modifier ? &def->component.column.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_row_tag:
        mod = def->component.row.has_modifier ? &def->component.row.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_card_tag:
        mod = def->component.card.has_modifier ? &def->component.card.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_box_tag:
        mod = def->component.box.has_modifier ? &def->component.box.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_scaffold_tag:
        mod = def->component.scaffold.has_modifier ? &def->component.scaffold.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_top_bar_tag:
        mod = def->component.top_bar.has_modifier ? &def->component.top_bar.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_button_tag:
        mod = def->component.button.has_modifier ? &def->component.button.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_chip_tag:
        mod = def->component.chip.has_modifier ? &def->component.chip.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_text_field_tag:
        mod = def->component.text_field.has_modifier ? &def->component.text_field.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_check_box_tag:
        mod = def->component.check_box.has_modifier ? &def->component.check_box.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_switch_toggle_tag:
        mod = def->component.switch_toggle.has_modifier ? &def->component.switch_toggle.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_slider_tag:
        mod = def->component.slider.has_modifier ? &def->component.slider.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_tabs_tag:
        mod = def->component.tabs.has_modifier ? &def->component.tabs.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_select_tag:
        mod = def->component.select.has_modifier ? &def->component.select.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_date_time_input_tag:
        mod = def->component.date_time_input.has_modifier ? &def->component.date_time_input.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_list_tag:
        mod = def->component.list.has_modifier ? &def->component.list.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_list_item_tag:
        mod = def->component.list_item.has_modifier ? &def->component.list_item.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_progress_ring_tag:
        mod = def->component.progress_ring.has_modifier ? &def->component.progress_ring.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_progress_bar_tag:
        mod = def->component.progress_bar.has_modifier ? &def->component.progress_bar.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_fab_tag:
        mod = def->component.fab.has_modifier ? &def->component.fab.modifier : NULL;
        break;
    case moumantai_v1_ComponentDef_modal_tag:
        mod = def->component.modal.has_modifier ? &def->component.modal.modifier : NULL;
        break;
    default:
        break;
    }

    if (!modifier_visible(mod, ctx))
        return NULL;

    /* Dispatch to the typed renderer, forwarding parent_info so each
     * renderer can call apply_resolved_size for the catalog layout policy. */
    switch (def->which_component) {
    case moumantai_v1_ComponentDef_text_tag:
        return render_text(parent, &def->component.text, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_icon_tag:
        return render_icon(parent, &def->component.icon, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_image_tag:
        return render_image(parent, &def->component.image, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_divider_tag:
        return render_divider(parent, &def->component.divider, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_column_tag:
        return render_column(parent, &def->component.column, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_row_tag:
        return render_row(parent, &def->component.row, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_card_tag:
        return render_card(parent, &def->component.card, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_box_tag:
        return render_box(parent, &def->component.box, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_scaffold_tag:
        return render_scaffold(parent, &def->component.scaffold, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_top_bar_tag:
        return render_topbar(parent, &def->component.top_bar, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_button_tag:
        return render_button(parent, &def->component.button, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_chip_tag:
        return render_chip(parent, &def->component.chip, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_text_field_tag:
        return render_textfield(parent, &def->component.text_field, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_check_box_tag:
        return render_checkbox(parent, &def->component.check_box, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_switch_toggle_tag:
        return render_switch(parent, &def->component.switch_toggle, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_slider_tag:
        return render_slider(parent, &def->component.slider, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_tabs_tag:
        return render_tabs(parent, &def->component.tabs, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_select_tag:
        return render_select(parent, &def->component.select, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_date_time_input_tag:
        return render_datetime_input(parent, &def->component.date_time_input, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_list_tag:
        return render_list(parent, &def->component.list, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_list_item_tag:
        return render_listitem(parent, &def->component.list_item, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_progress_ring_tag:
        return render_progress_ring(parent, &def->component.progress_ring, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_progress_bar_tag:
        return render_progress_bar(parent, &def->component.progress_bar, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_fab_tag:
        return render_fab(parent, &def->component.fab, def->id, ctx, parent_info);
    case moumantai_v1_ComponentDef_modal_tag:
        return render_modal(parent, &def->component.modal, def->id, ctx, parent_info);
    default: {
        ESP_LOGW(TAG, "Unknown component variant for id=%s (tag=%d)", def->id, (int)def->which_component);
        /* Loud red error chip — same pattern as the JSON-wire iteration. */
        lv_obj_t *chip = lv_obj_create(parent);
        lv_obj_set_size(chip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_radius(chip, 4, 0);
        lv_obj_set_style_bg_color(chip, lv_color_hex(0xFFE5E5), 0);
        lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
        lv_obj_set_style_border_color(chip, lv_color_hex(0xB3261E), 0);
        lv_obj_set_style_border_width(chip, 2, 0);
        lv_obj_set_style_pad_all(chip, 6, 0);
        lv_obj_remove_flag(chip, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_t *label = lv_label_create(chip);
        lv_label_set_text_fmt(label, "? tag=%d", (int)def->which_component);
        lv_obj_set_style_text_color(label, lv_color_hex(0xB3261E), 0);
        lv_obj_set_style_text_font(label, resolve_font("labelSmall"), 0);
        return chip;
    }
    }
}

void render_children_ids(lv_obj_t *parent, const char (*children)[64], int count, const render_ctx_t *ctx,
                         const char *parent_kind) {
    for (int i = 0; i < count; i++) {
        if (children[i][0] == '\0')
            break;
        ds_render_parent_t child_info = {
            .kind = parent_kind,
            .slot_index = i,
            .slot_name = NULL,
        };
        if (ctx->session) {
            /* Inherit item-scope so list-template grandchildren can resolve $.field. */
            render_session_queue(ctx->session, parent, children[i], child_info, ctx->item_scope_data, RPS_POST_NONE, 0);
        } else {
            render_node(parent, children[i], ctx, child_info);
        }
    }
}
