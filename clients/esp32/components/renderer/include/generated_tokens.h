// AUTO-GENERATED from shared/tokens/ — do not hand-edit
// ESP32 reads the expanded profile (320×480 ILI9488 CrowPanel).
//
// Sizing values are integers (dp at native pixel density). Shape `full`
// resolves to LV_RADIUS_CIRCLE — use that constant instead of 9999.
// Opacities are scaled 0..255 to match LVGL's lv_opa_t.
//
// Elevation is a static array of LVGL shadow tuples; resolve via the
// apply_elevation() helper in style_helpers.c.
//
// Motion easing is a semantic name mapped to the closest LVGL preset:
//   easingStandard → LV_ANIM_PATH_EASE_IN_OUT.
#pragma once

#include <stdint.h>

// Typography sizes (px)
#define MOUMANTAI_TYPO_DISPLAY_LARGE 57
#define MOUMANTAI_TYPO_DISPLAY_MEDIUM 45
#define MOUMANTAI_TYPO_DISPLAY_SMALL 36
#define MOUMANTAI_TYPO_HEADLINE_LARGE 32
#define MOUMANTAI_TYPO_HEADLINE_MEDIUM 28
#define MOUMANTAI_TYPO_HEADLINE_SMALL 24
#define MOUMANTAI_TYPO_TITLE_LARGE 22
#define MOUMANTAI_TYPO_TITLE_MEDIUM 16
#define MOUMANTAI_TYPO_TITLE_SMALL 14
#define MOUMANTAI_TYPO_BODY_LARGE 16
#define MOUMANTAI_TYPO_BODY_MEDIUM 14
#define MOUMANTAI_TYPO_BODY_SMALL 12
#define MOUMANTAI_TYPO_LABEL_LARGE 14
#define MOUMANTAI_TYPO_LABEL_MEDIUM 12
#define MOUMANTAI_TYPO_LABEL_SMALL 11

// Spacing (dp)
#define MOUMANTAI_SPACING_XS 4
#define MOUMANTAI_SPACING_S 8
#define MOUMANTAI_SPACING_M 16
#define MOUMANTAI_SPACING_L 24
#define MOUMANTAI_SPACING_XL 32

// Sizing (dp; compound paddings handled in style_helpers.c)
#define MOUMANTAI_BUTTON_HEIGHT 40
#define MOUMANTAI_BUTTON_PADDING_X 24
#define MOUMANTAI_CHIP_HEIGHT 32
#define MOUMANTAI_CHIP_PADDING_X 16
#define MOUMANTAI_FAB_SIZE 56
#define MOUMANTAI_FAB_EXTENDED_HEIGHT 56
#define MOUMANTAI_INPUT_HEIGHT 56
#define MOUMANTAI_INPUT_PADDING_X 16
#define MOUMANTAI_DIALOG_PADDING 24
#define MOUMANTAI_ICON_SIZE_SMALL 18
#define MOUMANTAI_ICON_SIZE 24
#define MOUMANTAI_ICON_SIZE_LARGE 32
#define MOUMANTAI_LIST_ITEM_HEIGHT 56
#define MOUMANTAI_TOPBAR_HEIGHT 56
#define MOUMANTAI_CARD_PADDING 16
#define MOUMANTAI_SWITCH_TRACK_W 52
#define MOUMANTAI_SWITCH_TRACK_H 32
#define MOUMANTAI_SWITCH_THUMB_SM 16
#define MOUMANTAI_SWITCH_THUMB_LG 24
#define MOUMANTAI_ICON_TAP_TARGET 40

// Shape primitives (dp). Use LV_RADIUS_CIRCLE for `full`.
#define MOUMANTAI_SHAPE_NONE 0
#define MOUMANTAI_SHAPE_XS 4
#define MOUMANTAI_SHAPE_SM 8
#define MOUMANTAI_SHAPE_MD 12
#define MOUMANTAI_SHAPE_LG 16
#define MOUMANTAI_SHAPE_XL 24

// Motion (ms)
#define MOUMANTAI_MOTION_DURATION_SHORT_MS 150
#define MOUMANTAI_MOTION_DURATION_MEDIUM_MS 250
// Easing — semantic name, mapped at apply-site:
//   easingStandard → LV_ANIM_PATH_EASE_IN_OUT

// State opacities (LVGL 0..255 scale)
#define MOUMANTAI_STATE_DISABLED_OPA 97
#define MOUMANTAI_STATE_HOVER_OPA 20
#define MOUMANTAI_STATE_FOCUS_OPA 26
#define MOUMANTAI_STATE_PRESSED_OPA 26
#define MOUMANTAI_STATE_DRAGGED_OPA 41

// Elevation — LVGL shadow tuples (width, ofs_y, opa 0..255).
// Use apply_elevation(obj, ELEV_<LEVEL>) — do NOT set shadow props directly.
typedef enum {
    MOUMANTAI_ELEV_NONE = 0,
    MOUMANTAI_ELEV_RAISED = 1,
    MOUMANTAI_ELEV_FLOATING = 2,
    MOUMANTAI_ELEV_ELEVATED = 3,
    MOUMANTAI_ELEV_COUNT
} moumantai_elevation_t;

typedef struct { int width; int ofs_y; int opa; } moumantai_shadow_tuple_t;

// Defined in style_helpers.c — extern so renderers can call apply_elevation().
extern const moumantai_shadow_tuple_t moumantai_elevation_table[MOUMANTAI_ELEV_COUNT];

