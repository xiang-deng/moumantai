// AUTO-GENERATED from shared/tokens/ — do not hand-edit
package com.moumantai.wear.generated

object CompactTokens {
    // Typography (sp)
    const val DISPLAY_LARGE = 34
    const val DISPLAY_MEDIUM = 30
    const val DISPLAY_SMALL = 28
    const val HEADLINE_LARGE = 18
    const val HEADLINE_MEDIUM = 17
    const val HEADLINE_SMALL = 16
    const val TITLE_LARGE = 18
    const val TITLE_MEDIUM = 16
    const val TITLE_SMALL = 15
    const val BODY_LARGE = 14
    const val BODY_MEDIUM = 13
    const val BODY_SMALL = 11
    const val LABEL_LARGE = 11
    const val LABEL_MEDIUM = 10
    const val LABEL_SMALL = 9

    // Spacing (dp)
    const val SPACING_XS = 2
    const val SPACING_S = 4
    const val SPACING_M = 8
    const val SPACING_L = 12
    const val SPACING_XL = 16

    // Sizing (dp)
    const val BUTTON_HEIGHT = 48
    const val BUTTON_PADDING_X = 16
    const val CHIP_HEIGHT = 36
    const val CHIP_PADDING_X = 12
    const val FAB_SIZE = 48
    const val FAB_EXTENDED_HEIGHT = 48
    const val INPUT_HEIGHT = 48
    const val INPUT_PADDING_X = 12
    const val DIALOG_PADDING = 16
    const val ICON_SIZE_SMALL = 16
    const val ICON_SIZE = 20
    const val ICON_SIZE_LARGE = 28
    const val LIST_ITEM_HEIGHT = 44
    const val TOPBAR_HEIGHT = 0
    const val CARD_PADDING = 8
    const val SWITCH_TRACK_W = 52
    const val SWITCH_TRACK_H = 32
    const val SWITCH_THUMB_SM = 16
    const val SWITCH_THUMB_LG = 24
    const val ICON_TAP_TARGET = 40

    // Typography line heights (unitless multipliers)
    const val DISPLAY_LARGE_LINE_HEIGHT = 1.12f
    const val DISPLAY_MEDIUM_LINE_HEIGHT = 1.16f
    const val DISPLAY_SMALL_LINE_HEIGHT = 1.22f
    const val HEADLINE_LARGE_LINE_HEIGHT = 1.25f
    const val HEADLINE_MEDIUM_LINE_HEIGHT = 1.29f
    const val HEADLINE_SMALL_LINE_HEIGHT = 1.33f
    const val TITLE_LARGE_LINE_HEIGHT = 1.27f
    const val TITLE_MEDIUM_LINE_HEIGHT = 1.5f
    const val TITLE_SMALL_LINE_HEIGHT = 1.43f
    const val BODY_LARGE_LINE_HEIGHT = 1.5f
    const val BODY_MEDIUM_LINE_HEIGHT = 1.43f
    const val BODY_SMALL_LINE_HEIGHT = 1.33f
    const val LABEL_LARGE_LINE_HEIGHT = 1.43f
    const val LABEL_MEDIUM_LINE_HEIGHT = 1.33f
    const val LABEL_SMALL_LINE_HEIGHT = 1.45f

    // Shape primitives (dp). `full` is a pill sentinel — not
    // emitted as a numeric const; consumers must dispatch on the
    // primitive key string `"full"` and call RoundedCornerShape(percent = 50)
    // (9999.dp is not equivalent to a 50%-corner shape at every height).
    const val SHAPE_NONE = 0
    const val SHAPE_XS = 4
    const val SHAPE_SM = 8
    const val SHAPE_MD = 12
    const val SHAPE_LG = 16
    const val SHAPE_XL = 24

    // Shape aliases — map component → primitive key (look up via SHAPE_*).
    const val CARD_RADIUS_PRIMITIVE = "md"
    const val DIALOG_RADIUS_PRIMITIVE = "xl"
    const val FAB_RADIUS_PRIMITIVE = "lg"
    const val CHIP_RADIUS_PRIMITIVE = "sm"
    const val INPUT_RADIUS_PRIMITIVE = "xs"
    const val BUTTON_RADIUS_PRIMITIVE = "full"

    // Elevation — dp value per level (Material 3 mapping).
    const val ELEVATION_NONE_DP = 0
    const val ELEVATION_RAISED_DP = 1
    const val ELEVATION_FLOATING_DP = 3
    const val ELEVATION_ELEVATED_DP = 6

    // Motion (ms / cubic-bezier components)
    const val MOTION_DURATION_SHORT_MS = 150
    const val MOTION_DURATION_MEDIUM_MS = 250
    const val MOTION_EASING_STANDARD_X1 = 0.2f
    const val MOTION_EASING_STANDARD_Y1 = 0f
    const val MOTION_EASING_STANDARD_X2 = 0f
    const val MOTION_EASING_STANDARD_Y2 = 1f

    // State opacities — each entry is `<state-name>: <opacity 0..1>`
    const val STATE_DISABLED_OPACITY = 0.38f
    const val STATE_HOVER_OPACITY = 0.08f
    const val STATE_FOCUS_OPACITY = 0.1f
    const val STATE_PRESSED_OPACITY = 0.1f
    const val STATE_DRAGGED_OPACITY = 0.16f

    // Color — M3 dark scheme (0xAARRGGBB)
    const val COLOR_PRIMARY = 0xFFD0BCFF.toInt()
    const val COLOR_ON_PRIMARY = 0xFF381E72.toInt()
    const val COLOR_PRIMARY_CONTAINER = 0xFF4F378B.toInt()
    const val COLOR_ON_PRIMARY_CONTAINER = 0xFFEADDFF.toInt()
    const val COLOR_SECONDARY = 0xFFCCC2DC.toInt()
    const val COLOR_ON_SECONDARY = 0xFF332D41.toInt()
    const val COLOR_SECONDARY_CONTAINER = 0xFF4A4458.toInt()
    const val COLOR_ON_SECONDARY_CONTAINER = 0xFFE8DEF8.toInt()
    const val COLOR_TERTIARY = 0xFFAECAE5.toInt()
    const val COLOR_ON_TERTIARY = 0xFF163348.toInt()
    const val COLOR_TERTIARY_CONTAINER = 0xFF2E4A60.toInt()
    const val COLOR_ON_TERTIARY_CONTAINER = 0xFFCAE6FF.toInt()
    const val COLOR_ERROR = 0xFFF2B8B5.toInt()
    const val COLOR_ON_ERROR = 0xFF601410.toInt()
    const val COLOR_ERROR_CONTAINER = 0xFF8C1D18.toInt()
    const val COLOR_ON_ERROR_CONTAINER = 0xFFF9DEDC.toInt()
    const val COLOR_SURFACE = 0xFF1C1B1F.toInt()
    const val COLOR_ON_SURFACE = 0xFFE6E1E5.toInt()
    const val COLOR_SURFACE_VARIANT = 0xFF49454F.toInt()
    const val COLOR_ON_SURFACE_VARIANT = 0xFFCAC4D0.toInt()
    const val COLOR_SURFACE_CONTAINER_LOWEST = 0xFF080E0C.toInt()
    const val COLOR_SURFACE_CONTAINER_LOW = 0xFF1D1B20.toInt()
    const val COLOR_SURFACE_CONTAINER = 0xFF211F26.toInt()
    const val COLOR_SURFACE_CONTAINER_HIGH = 0xFF2B2930.toInt()
    const val COLOR_SURFACE_CONTAINER_HIGHEST = 0xFF36343B.toInt()
    const val COLOR_OUTLINE = 0xFF938F99.toInt()
    const val COLOR_OUTLINE_VARIANT = 0xFF49454F.toInt()
    const val COLOR_INVERSE_SURFACE = 0xFFE6E1E5.toInt()
    const val COLOR_INVERSE_ON_SURFACE = 0xFF313033.toInt()

}
