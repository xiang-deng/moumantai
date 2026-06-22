#include "pager_indicator.h"
#include "style_helpers.h"

#include <stdlib.h>
#include <string.h>

#define DOT_SIZE 6
#define DOT_GAP 6
#define DOT_SIZE_ACTIVE 8

struct pager_indicator {
    lv_obj_t *container;
    pager_indicator_orientation_t orient;
    int total;
    int active;
};

pager_indicator_t *pager_indicator_create(lv_obj_t *parent, pager_indicator_orientation_t orient) {
    pager_indicator_t *pi = calloc(1, sizeof(pager_indicator_t));
    if (!pi)
        return NULL;
    pi->orient = orient;

    pi->container = lv_obj_create(parent);
    lv_obj_set_style_bg_opa(pi->container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(pi->container, 0, 0);
    lv_obj_set_style_pad_all(pi->container, 4, 0);
    lv_obj_set_style_pad_gap(pi->container, DOT_GAP, 0);
    lv_obj_remove_flag(pi->container, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(pi->container, LV_OBJ_FLAG_CLICKABLE);

    if (orient == PAGER_INDICATOR_HORIZONTAL) {
        lv_obj_set_flex_flow(pi->container, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(pi->container, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    } else {
        lv_obj_set_flex_flow(pi->container, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(pi->container, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    }

    lv_obj_add_flag(pi->container, LV_OBJ_FLAG_HIDDEN); /* shown when total > 1 */
    return pi;
}

void pager_indicator_set(pager_indicator_t *pi, int total, int active) {
    if (!pi)
        return;
    pi->total = total;
    pi->active = active;

    if (total <= 1) {
        lv_obj_add_flag(pi->container, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clean(pi->container);
        return;
    }
    lv_obj_remove_flag(pi->container, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clean(pi->container);

    for (int i = 0; i < total; i++) {
        lv_obj_t *dot = lv_obj_create(pi->container);
        bool is_active = (i == active);
        int sz = is_active ? DOT_SIZE_ACTIVE : DOT_SIZE;
        lv_obj_set_size(dot, sz, sz);
        lv_obj_set_style_radius(dot, sz / 2, 0);
        lv_obj_set_style_bg_color(dot, is_active ? THEME_PRIMARY : THEME_ON_SURFACE_VARIANT, 0);
        lv_obj_set_style_bg_opa(dot, is_active ? LV_OPA_COVER : LV_OPA_40, 0);
        lv_obj_set_style_border_width(dot, 0, 0);
        lv_obj_set_style_pad_all(dot, 0, 0);
        lv_obj_remove_flag(dot, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_remove_flag(dot, LV_OBJ_FLAG_CLICKABLE);
    }
}

lv_obj_t *pager_indicator_obj(pager_indicator_t *pi) {
    return pi ? pi->container : NULL;
}
