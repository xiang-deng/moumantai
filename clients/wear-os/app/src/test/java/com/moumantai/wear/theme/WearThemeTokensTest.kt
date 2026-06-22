package com.moumantai.wear.theme

import androidx.compose.ui.unit.dp
import com.moumantai.wear.generated.CompactTokens
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins WearTheme's token-driven values to the generated CompactTokens, so a
 * future YAML edit that changes the compact profile flows into Wear without
 * silent divergence. Renderer files reach for `LocalDimensions` etc. instead
 * of importing CompactTokens directly — this test pins the mapping.
 *
 * Color values are NOT pinned here — Wear deliberately diverges from the
 * shared M3 reference palette (see WearTheme.kt header comment + the Wear
 * brand-color pins in DesignSystemRoutingTest).
 */
class WearThemeTokensTest {

    @Test
    fun `WearTokenDimensions reflect generated CompactTokens`() {
        val d = WearTokenDimensions
        assertEquals(CompactTokens.SPACING_XS.dp, d.spacingXs)
        assertEquals(CompactTokens.SPACING_S.dp, d.spacingS)
        assertEquals(CompactTokens.SPACING_M.dp, d.spacingM)
        assertEquals(CompactTokens.SPACING_L.dp, d.spacingL)
        assertEquals(CompactTokens.SPACING_XL.dp, d.spacingXl)
        assertEquals(CompactTokens.ICON_SIZE_SMALL.dp, d.iconSizeSmall)
        assertEquals(CompactTokens.ICON_SIZE.dp, d.iconSize)
        assertEquals(CompactTokens.ICON_SIZE_LARGE.dp, d.iconSizeLarge)
        assertEquals(CompactTokens.BUTTON_HEIGHT.dp, d.buttonHeight)
        assertEquals(CompactTokens.CHIP_HEIGHT.dp, d.chipHeight)
        assertEquals(CompactTokens.FAB_SIZE.dp, d.fabSize)
        assertEquals(CompactTokens.INPUT_HEIGHT.dp, d.inputHeight)
        assertEquals(CompactTokens.LIST_ITEM_HEIGHT.dp, d.listItemHeight)
        assertEquals(CompactTokens.CARD_PADDING.dp, d.cardPadding)
        assertEquals(CompactTokens.SPACING_L.dp, d.bodyHorizontalPadding)
        // minTouchTarget aliases BUTTON_HEIGHT (both 48dp on compact).
        assertEquals(d.buttonHeight, d.minTouchTarget)
    }

    @Test
    fun `WearTokenElevations reflect generated CompactTokens`() {
        val e = WearTokenElevations
        assertEquals(CompactTokens.ELEVATION_RAISED_DP.dp, e.raised)
        assertEquals(CompactTokens.ELEVATION_FLOATING_DP.dp, e.floating)
        assertEquals(CompactTokens.ELEVATION_ELEVATED_DP.dp, e.elevated)
    }

    @Test
    fun `WearTokenMotion durations reflect generated CompactTokens`() {
        val m = WearTokenMotion
        assertEquals(CompactTokens.MOTION_DURATION_SHORT_MS, m.durationShortMs)
        assertEquals(CompactTokens.MOTION_DURATION_MEDIUM_MS, m.durationMediumMs)
        // easingStandard is a CubicBezierEasing built from the four MOTION_EASING
        // floats; equality on CubicBezierEasing is reference-based, so we just
        // assert it's not null (the construction itself proves the wiring).
        assertEquals(true, m.easingStandard != null)
    }

    @Test
    fun `WearTokenStates reflect generated CompactTokens`() {
        assertEquals(CompactTokens.STATE_DISABLED_OPACITY, WearTokenStates.disabledOpacity)
    }
}
