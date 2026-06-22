#include "render_node.h"
#include "style_helpers.h"
#include "action_dispatch.h"
#include "state.h"
#include "design_system.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include "esp_log.h"

/* --------------------------------------------------------------------------
 * Flex alignment helpers — string → LVGL flex const
 * ----------------------------------------------------------------------- */

static lv_flex_align_t resolve_main_align(const char *arrangement) {
    if (!arrangement || !*arrangement)
        return LV_FLEX_ALIGN_START;
    if (strcmp(arrangement, "center") == 0)
        return LV_FLEX_ALIGN_CENTER;
    if (strcmp(arrangement, "end") == 0 || strcmp(arrangement, "bottom") == 0)
        return LV_FLEX_ALIGN_END;
    if (strcmp(arrangement, "spaceBetween") == 0)
        return LV_FLEX_ALIGN_SPACE_BETWEEN;
    if (strcmp(arrangement, "spaceAround") == 0)
        return LV_FLEX_ALIGN_SPACE_AROUND;
    if (strcmp(arrangement, "spaceEvenly") == 0)
        return LV_FLEX_ALIGN_SPACE_EVENLY;
    return LV_FLEX_ALIGN_START;
}

static lv_flex_align_t resolve_cross_align(const char *alignment) {
    if (!alignment || !*alignment)
        return LV_FLEX_ALIGN_START;
    if (strcmp(alignment, "center") == 0)
        return LV_FLEX_ALIGN_CENTER;
    if (strcmp(alignment, "end") == 0)
        return LV_FLEX_ALIGN_END;
    return LV_FLEX_ALIGN_START;
}

/* Box / per-child alignment */
static lv_align_t resolve_box_alignment(const char *alignment) {
    if (!alignment || !*alignment)
        return LV_ALIGN_TOP_LEFT;
    if (strcmp(alignment, "topStart") == 0)
        return LV_ALIGN_TOP_LEFT;
    if (strcmp(alignment, "topCenter") == 0)
        return LV_ALIGN_TOP_MID;
    if (strcmp(alignment, "topEnd") == 0)
        return LV_ALIGN_TOP_RIGHT;
    if (strcmp(alignment, "centerStart") == 0)
        return LV_ALIGN_LEFT_MID;
    if (strcmp(alignment, "center") == 0)
        return LV_ALIGN_CENTER;
    if (strcmp(alignment, "centerEnd") == 0)
        return LV_ALIGN_RIGHT_MID;
    if (strcmp(alignment, "bottomStart") == 0)
        return LV_ALIGN_BOTTOM_LEFT;
    if (strcmp(alignment, "bottomCenter") == 0)
        return LV_ALIGN_BOTTOM_MID;
    if (strcmp(alignment, "bottomEnd") == 0)
        return LV_ALIGN_BOTTOM_RIGHT;
    return LV_ALIGN_TOP_LEFT;
}

/* --------------------------------------------------------------------------
 * TopBar back-button click context
 * ----------------------------------------------------------------------- */

typedef struct {
    char surface_id[128];
    char comp_id[64];
} back_ctx_t;

static void on_back_clicked(lv_event_t *e) {
    back_ctx_t *bctx = (back_ctx_t *)lv_event_get_user_data(e);
    if (bctx)
        action_dispatch_back(bctx->surface_id, bctx->comp_id);
}

static void on_back_deleted(lv_event_t *e) {
    free(lv_event_get_user_data(e));
}

/* --------------------------------------------------------------------------
 * Scaffold — root container with topBar/body/fab slots
 * ----------------------------------------------------------------------- */

lv_obj_t *render_scaffold(lv_obj_t *parent, const moumantai_v1_ScaffoldComponent *c, const char *id,
                          const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)id;
    (void)parent_info;
    lv_obj_t *scaffold = lv_obj_create(parent);
    reset_container_paint(scaffold);
    lv_obj_set_size(scaffold, LV_PCT(100), LV_PCT(100));
    lv_obj_set_flex_flow(scaffold, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_gap(scaffold, 0, 0);
    lv_obj_set_style_bg_color(scaffold, THEME_SURFACE, 0);
    lv_obj_set_style_bg_opa(scaffold, LV_OPA_COVER, 0);

    if (c->has_modifier)
        apply_modifier(scaffold, &c->modifier, ctx);

    if (c->has_top_bar) {
        ds_render_parent_t slot_info = {.kind = "Scaffold", .slot_index = 0, .slot_name = "top_bar"};
        render_node(scaffold, c->top_bar, ctx, slot_info);
    }

    if (c->has_body) {
        ds_render_parent_t slot_info = {.kind = "Scaffold", .slot_index = 0, .slot_name = "body"};
        lv_obj_t *body = render_node(scaffold, c->body, ctx, slot_info);
        if (body) {
            /* Framework owns the body container; body_kind selects list vs canvas. */
            const moumantai_v1_BodyKind kind = c->has_body_kind ? c->body_kind : moumantai_v1_BodyKind_BODY_KIND_LIST;

            lv_obj_set_width(body, LV_PCT(100));
            lv_obj_set_flex_grow(body, 1);
            if (lv_obj_get_style_pad_left(body, 0) == 0) {
                /* M3 compact-window margin = 16dp. SPACING_XL=32 left only
                 * 256px of content on 320px; SPACING_M=16 recovers 32px. */
                lv_obj_set_style_pad_left(body, MOUMANTAI_SPACING_M, 0);
                lv_obj_set_style_pad_right(body, MOUMANTAI_SPACING_M, 0);
            }
            if (lv_obj_get_style_pad_top(body, 0) == 0) {
                lv_obj_set_style_pad_top(body, MOUMANTAI_SPACING_M, 0);
            }
            if (lv_obj_get_style_pad_bottom(body, 0) == 0) {
                lv_obj_set_style_pad_bottom(body, MOUMANTAI_SPACING_L, 0); /* spacing.l = 24 — pager-dot clearance */
            }

            if (kind == moumantai_v1_BodyKind_BODY_KIND_CANVAS) {
                /* Glance canvas: bounded + centered, no scroll. Children
                 * centered on both axes; author's own flex_align (set by
                 * render_column / render_box) is overridden here because the
                 * framework, not the author, owns body layout in CANVAS. */
                lv_obj_remove_flag(body, LV_OBJ_FLAG_SCROLLABLE);
                lv_obj_set_scrollbar_mode(body, LV_SCROLLBAR_MODE_OFF);
                lv_obj_set_flex_align(body, LV_FLEX_ALIGN_CENTER, /* main (vertical) */
                                      LV_FLEX_ALIGN_CENTER,       /* cross (horizontal) */
                                      LV_FLEX_ALIGN_CENTER);      /* track cross */
            } else {
                /* LIST (default, also for BODY_KIND_UNSPECIFIED): scrolling
                 * column. Each top-level body child becomes one flex child of
                 * the body's own column flow. */
                lv_obj_add_flag(body, LV_OBJ_FLAG_SCROLLABLE);
                lv_obj_set_scrollbar_mode(body, LV_SCROLLBAR_MODE_AUTO);
            }
        }
    }

    if (c->has_fab) {
        ds_render_parent_t slot_info = {.kind = "Scaffold", .slot_index = 0, .slot_name = "fab"};
        render_node(scaffold, c->fab, ctx, slot_info);
    }
    return scaffold;
}

/* --------------------------------------------------------------------------
 * TopBar status cluster — clock, connection icon, session dot.
 * ----------------------------------------------------------------------- */

typedef struct {
    lv_obj_t *time_label;
    lv_obj_t *session_dot;
    lv_obj_t *conn_icon;
    lv_timer_t *tick_timer;
    connection_state_t last_conn;
} topbar_status_t;

static void status_format_time(char out[8]) {
    time_t now = time(NULL);
    if (now < 24 * 3600) {
        out[0] = '-';
        out[1] = '-';
        out[2] = ':';
        out[3] = '-';
        out[4] = '-';
        out[5] = '\0';
        return;
    }
    struct tm lt;
    localtime_r(&now, &lt);
    snprintf(out, 8, "%02d:%02d", lt.tm_hour, lt.tm_min);
}

static lv_color_t status_dot_color(connection_state_t s) {
    switch (s) {
    case CONN_SESSION_ACTIVE:
        return lv_color_hex(0x2E7D32);
    case CONN_CONNECTING:
    case CONN_CONNECTED:
    case CONN_HELLO_SENT:
        return lv_color_hex(0xF9A825);
    case CONN_DISCONNECTED:
    default:
        return THEME_ERROR;
    }
}

static const char *status_conn_icon_name(connection_state_t s) {
    return s == CONN_SESSION_ACTIVE ? "cloud_done" : "cloud_off";
}

static void status_rebuild_icon(topbar_status_t *st, connection_state_t s) {
    if (!st->conn_icon)
        return;
    lv_obj_t *parent = lv_obj_get_parent(st->conn_icon);
    int idx = (int)lv_obj_get_index(st->conn_icon);
    lv_obj_delete(st->conn_icon);
    st->conn_icon = icon_label_create(parent, status_conn_icon_name(s), MOUMANTAI_ICON_SIZE,
                                      s == CONN_SESSION_ACTIVE ? THEME_PRIMARY : THEME_ON_SURFACE_VARIANT);
    if (st->conn_icon && idx >= 0)
        lv_obj_move_to_index(st->conn_icon, idx);
}

static void status_tick(lv_timer_t *t) {
    topbar_status_t *st = lv_timer_get_user_data(t);
    if (!st)
        return;
    if (st->time_label) {
        char buf[8];
        status_format_time(buf);
        lv_label_set_text(st->time_label, buf);
    }
    connection_state_t c = state_get_connection();
    if (c != st->last_conn) {
        if (st->session_dot)
            lv_obj_set_style_bg_color(st->session_dot, status_dot_color(c), 0);
        status_rebuild_icon(st, c);
        st->last_conn = c;
    }
}

static void status_on_deleted(lv_event_t *e) {
    topbar_status_t *st = lv_event_get_user_data(e);
    if (!st)
        return;
    if (st->tick_timer) {
        lv_timer_delete(st->tick_timer);
        st->tick_timer = NULL;
    }
    free(st);
}

static lv_obj_t *create_topbar_status_cluster(lv_obj_t *parent) {
    topbar_status_t *st = calloc(1, sizeof(*st));
    if (!st)
        return NULL;
    lv_obj_t *cluster = lv_obj_create(parent);
    reset_container_paint(cluster);
    /* 32: cluster height — fits inside 56dp topbar; sub-touch-target, intentional. */
    lv_obj_set_size(cluster, LV_SIZE_CONTENT, 32);
    lv_obj_set_flex_flow(cluster, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(cluster, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    /* spacing.s=8: SPACING_M=16 left only 136px for the title. */
    lv_obj_set_style_pad_gap(cluster, MOUMANTAI_SPACING_S, 0);
    lv_obj_remove_flag(cluster, LV_OBJ_FLAG_SCROLLABLE);

    connection_state_t c = state_get_connection();

    st->time_label = lv_label_create(cluster);
    char buf[8];
    status_format_time(buf);
    lv_label_set_text(st->time_label, buf);
    apply_typo(st->time_label, "labelMedium");
    lv_obj_set_style_text_color(st->time_label, THEME_ON_SURFACE_VARIANT, 0);

    st->conn_icon = icon_label_create(cluster, status_conn_icon_name(c), 20,
                                      c == CONN_SESSION_ACTIVE ? THEME_PRIMARY : THEME_ON_SURFACE_VARIANT);

    st->session_dot = lv_obj_create(cluster);
    /* 8×8 status dot — no token for this size; SPACING_M=16 is too large. */
    lv_obj_set_size(st->session_dot, 8, 8);
    lv_obj_set_style_radius(st->session_dot, MOUMANTAI_SHAPE_XS, 0);
    lv_obj_set_style_bg_color(st->session_dot, status_dot_color(c), 0);
    lv_obj_set_style_bg_opa(st->session_dot, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(st->session_dot, 0, 0);
    lv_obj_remove_flag(st->session_dot, LV_OBJ_FLAG_SCROLLABLE);

    st->last_conn = c;
    st->tick_timer = lv_timer_create(status_tick, 3000, st);

    lv_obj_add_event_cb(cluster, status_on_deleted, LV_EVENT_DELETE, st);
    return cluster;
}

/* --------------------------------------------------------------------------
 * TopBar
 * ----------------------------------------------------------------------- */

lv_obj_t *render_topbar(lv_obj_t *parent, const moumantai_v1_TopBarComponent *c, const char *id,
                        const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)parent_info;
    lv_obj_t *bar = lv_obj_create(parent);
    reset_container_paint(bar);
    lv_obj_set_size(bar, LV_PCT(100), MOUMANTAI_TOPBAR_HEIGHT); /* sizing.topBarHeight = 56 (M3 SmallTopBar) */
    lv_obj_set_flex_flow(bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(bar, MOUMANTAI_SPACING_M, 0); /* spacing.m = 16 — matches body gutter */
    lv_obj_set_style_bg_color(bar, THEME_SURFACE, 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_remove_flag(bar, LV_OBJ_FLAG_SCROLLABLE);

    /* Navigation back button */
    if (c->has_navigation_action) {
        lv_obj_t *back_btn = lv_button_create(bar);
        /* BUTTON_HEIGHT=40; LIST_ITEM_HEIGHT=56 overflows the topbar. */
        lv_obj_set_size(back_btn, MOUMANTAI_BUTTON_HEIGHT, MOUMANTAI_BUTTON_HEIGHT);
        lv_obj_set_style_bg_opa(back_btn, LV_OPA_TRANSP, 0);
        lv_obj_set_style_shadow_width(back_btn, 0, 0);
        /* 24: Material Symbols mid-size bucket (not a sizing token, see render_icon). */
        lv_obj_t *back_icon = icon_label_create(back_btn, "arrow_back", 24, THEME_ON_SURFACE);
        lv_obj_center(back_icon);

        back_ctx_t *bctx = calloc(1, sizeof(back_ctx_t));
        if (bctx) {
            strncpy(bctx->surface_id, ctx->surface_id ? ctx->surface_id : "", sizeof(bctx->surface_id) - 1);
            strncpy(bctx->comp_id, id ? id : "", sizeof(bctx->comp_id) - 1);
            lv_obj_add_event_cb(back_btn, on_back_clicked, LV_EVENT_CLICKED, bctx);
            lv_obj_add_event_cb(back_btn, on_back_deleted, LV_EVENT_DELETE, bctx);
        }
    }

    if (c->has_title) {
        const char *title = dyn_string_resolve(&c->title, ctx);
        if (title) {
            lv_obj_t *title_lbl = lv_label_create(bar);
            lv_label_set_text(title_lbl, title);
            apply_typo(title_lbl, "titleLarge");
            lv_obj_set_style_text_color(title_lbl, THEME_ON_SURFACE, 0);
            lv_obj_set_flex_grow(title_lbl, 1);
        }
    }

    create_topbar_status_cluster(bar);

    /* Trailing actions */
    for (pb_size_t i = 0; i < c->actions_count; i++) {
        if (c->actions[i][0] == '\0')
            break;
        ds_render_parent_t action_info = {
            .kind = "TopBar",
            .slot_index = (int)i,
            .slot_name = NULL,
        };
        render_node(bar, c->actions[i], ctx, action_info);
    }

    if (c->has_modifier)
        apply_modifier(bar, &c->modifier, ctx);
    return bar;
}

/* --------------------------------------------------------------------------
 * Column
 * ----------------------------------------------------------------------- */

lv_obj_t *render_column(lv_obj_t *parent, const moumantai_v1_ColumnComponent *c, const char *id,
                        const render_ctx_t *ctx, ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *col = lv_obj_create(parent);
    reset_container_paint(col);
    /* Catalog-driven sizing: parent-slot policy + own modifier keyword. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    const char *own_kw_h = (c->has_modifier && c->modifier.has_height &&
                            c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                               ? c->modifier.height.kind.keyword
                               : NULL;
    apply_resolved_size(col, parent_info, "Column", NULL, own_kw_w, true);
    apply_resolved_size(col, parent_info, "Column", NULL, own_kw_h, false);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);

    const char *v_arrange = c->has_vertical_arrangement ? c->vertical_arrangement : NULL;
    const char *h_align = c->has_horizontal_alignment ? c->horizontal_alignment : NULL;
    lv_obj_set_flex_align(col, resolve_main_align(v_arrange), resolve_cross_align(h_align), LV_FLEX_ALIGN_START);

    int spacing = c->has_spacing ? c->spacing : 0;
    lv_obj_set_style_pad_gap(col, spacing, 0);

    lv_obj_remove_flag(col, LV_OBJ_FLAG_SCROLLABLE);

    if (c->has_modifier)
        apply_modifier(col, &c->modifier, ctx);

    render_children_ids(col, c->children, c->children_count, ctx, "Column");
    return col;
}

/* --------------------------------------------------------------------------
 * Row
 * ----------------------------------------------------------------------- */

lv_obj_t *render_row(lv_obj_t *parent, const moumantai_v1_RowComponent *c, const char *id, const render_ctx_t *ctx,
                     ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *row = lv_obj_create(parent);
    reset_container_paint(row);
    /* Catalog-driven sizing. */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    const char *own_kw_h = (c->has_modifier && c->modifier.has_height &&
                            c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                               ? c->modifier.height.kind.keyword
                               : NULL;
    apply_resolved_size(row, parent_info, "Row", NULL, own_kw_w, true);
    apply_resolved_size(row, parent_info, "Row", NULL, own_kw_h, false);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);

    const char *h_arrange = c->has_horizontal_arrangement ? c->horizontal_arrangement : NULL;
    const char *v_align = c->has_vertical_alignment ? c->vertical_alignment : NULL;
    lv_obj_set_flex_align(row, resolve_main_align(h_arrange), resolve_cross_align(v_align), LV_FLEX_ALIGN_START);

    int spacing = c->has_spacing ? c->spacing : 0;
    lv_obj_set_style_pad_gap(row, spacing, 0);

    lv_obj_remove_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    if (c->has_modifier)
        apply_modifier(row, &c->modifier, ctx);

    render_children_ids(row, c->children, c->children_count, ctx, "Row");
    return row;
}

/* --------------------------------------------------------------------------
 * Card
 * ----------------------------------------------------------------------- */

lv_obj_t *render_card(lv_obj_t *parent, const moumantai_v1_CardComponent *c, const char *id, const render_ctx_t *ctx,
                      ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *card = lv_obj_create(parent);
    reset_container_paint(card);
    /* Catalog-driven sizing — Card intrinsic sizing applies regardless of
     * tone/emphasis on ESP32 (single-style render per M5c). */
    const char *own_kw_w =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    const char *own_kw_h = (c->has_modifier && c->modifier.has_height &&
                            c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                               ? c->modifier.height.kind.keyword
                               : NULL;
    apply_resolved_size(card, parent_info, "Card", NULL, own_kw_w, true);
    apply_resolved_size(card, parent_info, "Card", NULL, own_kw_h, false);
    lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_radius(card, MOUMANTAI_SHAPE_MD, 0);
    lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
    /* 14: card h-pad — between spacing.s=8 and spacing.m=16; no exact token.
     * sizing.cardPadding=16 is the inter-child gap (pad_gap below), not h-pad. */
    lv_obj_set_style_pad_hor(card, 14, 0);
    lv_obj_set_style_pad_ver(card, MOUMANTAI_SPACING_M, 0);
    lv_obj_set_style_pad_gap(card, MOUMANTAI_CARD_PADDING, 0);
    lv_obj_remove_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    /* Variant owns border + background. Setting border_width before the switch
     * would leave FILLED Cards with a stray border — the switch owns it. */
    ds_variant_spec_t spec = ds_card_resolve(NULL);
    lv_color_t bg = THEME_SURFACE_CONT;
    if (spec.accent == DS_ACCENT_SECONDARY)
        bg = THEME_PRIMARY_CONT;
    else if (spec.accent == DS_ACCENT_ERROR)
        bg = THEME_ERROR_CONT;

    switch (spec.kind) {
    case DS_KIND_OUTLINED_CONTAINER:
        lv_obj_set_style_bg_color(card, THEME_SURFACE, 0);
        lv_obj_set_style_border_color(card, THEME_OUTLINE_VARIANT, 0);
        lv_obj_set_style_border_width(card, 1, 0);
        break;
    case DS_KIND_ELEVATED_CONTAINER:
        /* Surface-tier shift via background color — no shadow on ESP32. */
        lv_obj_set_style_bg_color(card, bg, 0);
        break;
    case DS_KIND_FILLED_CONTAINER:
    default:
        lv_obj_set_style_bg_color(card, bg, 0);
        break;
    }

    if (c->has_modifier)
        apply_modifier(card, &c->modifier, ctx);

    render_children_ids(card, c->children, c->children_count, ctx, "Card");
    return card;
}

/* --------------------------------------------------------------------------
 * Box — z-stack; children[0] is bottommost. Each child anchors via
 * child_alignment[i], falling back to content_alignment.
 * ----------------------------------------------------------------------- */

lv_obj_t *render_box(lv_obj_t *parent, const moumantai_v1_BoxComponent *c, const char *id, const render_ctx_t *ctx,
                     ds_render_parent_t parent_info) {
    (void)id;
    lv_obj_t *box = lv_obj_create(parent);
    reset_container_paint(box);
    lv_obj_remove_flag(box, LV_OBJ_FLAG_SCROLLABLE);

    /* No flex layout — children positioned absolutely via lv_obj_align. */
    const char *own_kw =
        (c->has_modifier && c->modifier.has_width && c->modifier.width.which_kind == moumantai_v1_Dimension_keyword_tag)
            ? c->modifier.width.kind.keyword
            : NULL;
    apply_resolved_size(box, parent_info, "Box", NULL, own_kw, true);
    const char *own_kh = (c->has_modifier && c->modifier.has_height &&
                          c->modifier.height.which_kind == moumantai_v1_Dimension_keyword_tag)
                             ? c->modifier.height.kind.keyword
                             : NULL;
    apply_resolved_size(box, parent_info, "Box", NULL, own_kh, false);

    const lv_align_t default_align = resolve_box_alignment(c->has_content_alignment ? c->content_alignment : NULL);

    for (pb_size_t i = 0; i < c->children_count; i++) {
        if (c->children[i][0] == '\0')
            break;
        ds_render_parent_t child_info = {
            .kind = "Box",
            .slot_index = (int)i,
            .slot_name = NULL,
        };

        const char *override =
            (i < c->child_alignment_count && c->child_alignment[i][0] != '\0') ? c->child_alignment[i] : NULL;
        lv_align_t align_value = override ? resolve_box_alignment(override) : default_align;

        if (ctx->session) {
            /* Defer the child with its alignment as a post-render hook —
             * lv_obj_align needs to run on the widget after it exists. */
            render_session_queue(ctx->session, box, c->children[i], child_info, ctx->item_scope_data, RPS_POST_ALIGN,
                                 align_value);
        } else {
            lv_obj_t *child = render_node(box, c->children[i], ctx, child_info);
            if (child)
                lv_obj_align(child, align_value, 0, 0);
        }
    }

    if (c->has_modifier)
        apply_modifier(box, &c->modifier, ctx);
    return box;
}
