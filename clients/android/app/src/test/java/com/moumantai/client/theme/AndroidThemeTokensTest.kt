package com.moumantai.client.theme

import androidx.compose.ui.unit.dp
import com.moumantai.client.generated.CompactTokens
import com.moumantai.client.generated.ExpandedTokens
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins Theme.kt's DimensionProfile instances to the generated tokens, so a
 * YAML edit that changes (e.g.) CARD_PADDING without updating the DimensionProfile
 * wiring in Theme.kt is caught immediately. Renderer files reach dimensions via
 * `LocalDimensions.current` — this test pins the mapping from tokens to profiles.
 *
 * Color values are NOT pinned here — Android uses dynamic M3 color (Android 12+)
 * with a static fallback; see Theme.kt's DarkColorScheme / LightColorScheme.
 */
class AndroidThemeTokensTest {
    @Test
    fun `CompactDimensions reflect generated CompactTokens`() {
        val d = CompactDimensions
        assertEquals(CompactTokens.BUTTON_HEIGHT.dp, d.minTouchTarget)
        assertEquals(CompactTokens.SPACING_XS.dp, d.spacingXs)
        assertEquals(CompactTokens.SPACING_S.dp, d.spacingS)
        assertEquals(CompactTokens.SPACING_M.dp, d.spacingM)
        assertEquals(CompactTokens.SPACING_L.dp, d.spacingL)
        assertEquals(CompactTokens.SPACING_XL.dp, d.spacingXl)
        assertEquals(CompactTokens.SHAPE_SM.dp, d.cornerRadius)
        assertEquals(CompactTokens.ICON_SIZE.dp, d.iconSize)
        assertEquals(CompactTokens.ICON_SIZE_SMALL.dp, d.iconSizeSmall)
        assertEquals(CompactTokens.ICON_SIZE_LARGE.dp, d.iconSizeLarge)
        assertEquals(CompactTokens.BUTTON_HEIGHT.dp, d.buttonHeight)
        assertEquals(CompactTokens.CHIP_HEIGHT.dp, d.chipHeight)
        assertEquals(CompactTokens.FAB_SIZE.dp, d.fabSize)
        assertEquals(CompactTokens.FAB_EXTENDED_HEIGHT.dp, d.fabExtendedHeight)
        assertEquals(CompactTokens.INPUT_HEIGHT.dp, d.inputHeight)
        assertEquals(CompactTokens.DIALOG_PADDING.dp, d.dialogPadding)
        assertEquals(CompactTokens.TOPBAR_HEIGHT.dp, d.topBarHeight)
        assertEquals(CompactTokens.LIST_ITEM_HEIGHT.dp, d.listItemHeight)
        assertEquals(CompactTokens.CARD_PADDING.dp, d.cardPadding)
        assertEquals(true, d.defaultCenter)
    }

    @Test
    fun `StandardDimensions reflect generated ExpandedTokens`() {
        val d = StandardDimensions
        assertEquals(ExpandedTokens.BUTTON_HEIGHT.dp, d.minTouchTarget)
        assertEquals(ExpandedTokens.SPACING_XS.dp, d.spacingXs)
        assertEquals(ExpandedTokens.SPACING_S.dp, d.spacingS)
        assertEquals(ExpandedTokens.SPACING_M.dp, d.spacingM)
        assertEquals(ExpandedTokens.SPACING_L.dp, d.spacingL)
        assertEquals(ExpandedTokens.SPACING_XL.dp, d.spacingXl)
        assertEquals(ExpandedTokens.SHAPE_MD.dp, d.cornerRadius)
        assertEquals(ExpandedTokens.ICON_SIZE.dp, d.iconSize)
        assertEquals(ExpandedTokens.ICON_SIZE_SMALL.dp, d.iconSizeSmall)
        assertEquals(ExpandedTokens.ICON_SIZE_LARGE.dp, d.iconSizeLarge)
        assertEquals(ExpandedTokens.BUTTON_HEIGHT.dp, d.buttonHeight)
        assertEquals(ExpandedTokens.CHIP_HEIGHT.dp, d.chipHeight)
        assertEquals(ExpandedTokens.FAB_SIZE.dp, d.fabSize)
        assertEquals(ExpandedTokens.FAB_EXTENDED_HEIGHT.dp, d.fabExtendedHeight)
        assertEquals(ExpandedTokens.INPUT_HEIGHT.dp, d.inputHeight)
        assertEquals(ExpandedTokens.DIALOG_PADDING.dp, d.dialogPadding)
        assertEquals(ExpandedTokens.TOPBAR_HEIGHT.dp, d.topBarHeight)
        assertEquals(ExpandedTokens.LIST_ITEM_HEIGHT.dp, d.listItemHeight)
        assertEquals(ExpandedTokens.CARD_PADDING.dp, d.cardPadding)
        assertEquals(false, d.defaultCenter)
    }
}
