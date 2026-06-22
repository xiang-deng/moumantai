#pragma once

#include "lvgl.h"

typedef enum {
    PAGER_INDICATOR_HORIZONTAL,
    PAGER_INDICATOR_VERTICAL,
} pager_indicator_orientation_t;

typedef struct pager_indicator pager_indicator_t;

/**
 * Create a dot-row page indicator. The widget manages its own dots; call
 * `pager_indicator_set(...)` whenever the total count or active index
 * changes. Hidden automatically when total <= 1.
 *
 * Parent should be the screen or a bottom/edge anchor container.
 */
pager_indicator_t *pager_indicator_create(lv_obj_t *parent, pager_indicator_orientation_t orient);

/** Update the indicator state. */
void pager_indicator_set(pager_indicator_t *pi, int total, int active);

/** Returns the underlying lv_obj (for alignment / z-order). */
lv_obj_t *pager_indicator_obj(pager_indicator_t *pi);
