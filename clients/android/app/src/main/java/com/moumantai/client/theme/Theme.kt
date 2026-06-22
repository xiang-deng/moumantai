package com.moumantai.client.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.moumantai.client.generated.CompactTokens
import com.moumantai.client.generated.ExpandedTokens

// ---------------------------------------------------------------------------
// Color schemes — fallback used when dynamicColor isn't available (< Android 12)
// or when the caller explicitly opts out.
// ---------------------------------------------------------------------------

private val DarkColorScheme = darkColorScheme(
    primary = md_theme_dark_primary,
    onPrimary = md_theme_dark_onPrimary,
    primaryContainer = md_theme_dark_primaryContainer,
    onPrimaryContainer = md_theme_dark_onPrimaryContainer,
    secondary = md_theme_dark_secondary,
    onSecondary = md_theme_dark_onSecondary,
    secondaryContainer = md_theme_dark_secondaryContainer,
    onSecondaryContainer = md_theme_dark_onSecondaryContainer,
    tertiary = md_theme_dark_tertiary,
    onTertiary = md_theme_dark_onTertiary,
    tertiaryContainer = md_theme_dark_tertiaryContainer,
    onTertiaryContainer = md_theme_dark_onTertiaryContainer,
    error = md_theme_dark_error,
    onError = md_theme_dark_onError,
    errorContainer = md_theme_dark_errorContainer,
    onErrorContainer = md_theme_dark_onErrorContainer,
    background = md_theme_dark_background,
    onBackground = md_theme_dark_onBackground,
    surface = md_theme_dark_surface,
    onSurface = md_theme_dark_onSurface,
    surfaceVariant = md_theme_dark_surfaceVariant,
    onSurfaceVariant = md_theme_dark_onSurfaceVariant,
    outline = md_theme_dark_outline,
    outlineVariant = md_theme_dark_outlineVariant,
    inverseSurface = md_theme_dark_inverseSurface,
    inverseOnSurface = md_theme_dark_inverseOnSurface,
    inversePrimary = md_theme_dark_inversePrimary,
    surfaceTint = md_theme_dark_surfaceTint,
    surfaceContainerLowest = md_theme_dark_surfaceContainerLowest,
    surfaceContainerLow = md_theme_dark_surfaceContainerLow,
    surfaceContainer = md_theme_dark_surfaceContainer,
    surfaceContainerHigh = md_theme_dark_surfaceContainerHigh,
    surfaceContainerHighest = md_theme_dark_surfaceContainerHighest,
)

private val LightColorScheme = lightColorScheme(
    primary = md_theme_light_primary,
    onPrimary = md_theme_light_onPrimary,
    primaryContainer = md_theme_light_primaryContainer,
    onPrimaryContainer = md_theme_light_onPrimaryContainer,
    secondary = md_theme_light_secondary,
    onSecondary = md_theme_light_onSecondary,
    secondaryContainer = md_theme_light_secondaryContainer,
    onSecondaryContainer = md_theme_light_onSecondaryContainer,
    tertiary = md_theme_light_tertiary,
    onTertiary = md_theme_light_onTertiary,
    tertiaryContainer = md_theme_light_tertiaryContainer,
    onTertiaryContainer = md_theme_light_onTertiaryContainer,
    error = md_theme_light_error,
    onError = md_theme_light_onError,
    errorContainer = md_theme_light_errorContainer,
    onErrorContainer = md_theme_light_onErrorContainer,
    background = md_theme_light_background,
    onBackground = md_theme_light_onBackground,
    surface = md_theme_light_surface,
    onSurface = md_theme_light_onSurface,
    surfaceVariant = md_theme_light_surfaceVariant,
    onSurfaceVariant = md_theme_light_onSurfaceVariant,
    outline = md_theme_light_outline,
    outlineVariant = md_theme_light_outlineVariant,
    inverseSurface = md_theme_light_inverseSurface,
    inverseOnSurface = md_theme_light_inverseOnSurface,
    inversePrimary = md_theme_light_inversePrimary,
    surfaceTint = md_theme_light_surfaceTint,
    surfaceContainerLowest = md_theme_light_surfaceContainerLowest,
    surfaceContainerLow = md_theme_light_surfaceContainerLow,
    surfaceContainer = md_theme_light_surfaceContainer,
    surfaceContainerHigh = md_theme_light_surfaceContainerHigh,
    surfaceContainerHighest = md_theme_light_surfaceContainerHighest,
)

// ---------------------------------------------------------------------------
// Shapes — M3 5-stop scale. Cards default to medium (12dp), chips/text fields
// to small, FABs to large.
// ---------------------------------------------------------------------------

private val MoumantaiShapes = Shapes(
    extraSmall = RoundedCornerShape(CompactTokens.SHAPE_XS.dp),
    small = RoundedCornerShape(CompactTokens.SHAPE_SM.dp),
    medium = RoundedCornerShape(CompactTokens.SHAPE_MD.dp),
    large = RoundedCornerShape(CompactTokens.SHAPE_LG.dp),
    extraLarge = RoundedCornerShape(CompactTokens.SHAPE_XL.dp),
)

/**
 * Map a primitive key (e.g. `"md"`, `"full"`) emitted by the design-token
 * pipeline into a Compose [Shape]. `"full"` is the pill sentinel — the
 * generator deliberately doesn't emit a numeric `SHAPE_FULL`, since a
 * `RoundedCornerShape(9999.dp)` is not equivalent to a percentage-based pill
 * at every height. Unknown keys fall back to [RectangleShape].
 */
fun resolveShapeFromPrimitive(key: String): Shape = when (key.lowercase()) {
    "none" -> RectangleShape
    "xs" -> RoundedCornerShape(CompactTokens.SHAPE_XS.dp)
    "sm" -> RoundedCornerShape(CompactTokens.SHAPE_SM.dp)
    "md" -> RoundedCornerShape(CompactTokens.SHAPE_MD.dp)
    "lg" -> RoundedCornerShape(CompactTokens.SHAPE_LG.dp)
    "xl" -> RoundedCornerShape(CompactTokens.SHAPE_XL.dp)
    "full" -> RoundedCornerShape(percent = 50)
    else -> RectangleShape
}

// Elevation / motion / state tokens live in CompactTokens / ExpandedTokens.
// M3 components handle these internally; no CompositionLocal wrappers needed.

// ---------------------------------------------------------------------------
// Adaptive dimensions — two profiles selected by screen width.
// ---------------------------------------------------------------------------

data class DimensionProfile(
    val minTouchTarget: Dp,
    val spacingXs: Dp,
    val spacingS: Dp,
    val spacingM: Dp,
    val spacingL: Dp,
    val spacingXl: Dp,
    val cornerRadius: Dp,
    val iconSize: Dp,
    val iconSizeSmall: Dp,
    val iconSizeLarge: Dp,
    val buttonHeight: Dp,
    val chipHeight: Dp,
    val fabSize: Dp,
    val fabExtendedHeight: Dp,
    val inputHeight: Dp,
    val dialogPadding: Dp,
    val topBarHeight: Dp,
    val listItemHeight: Dp,
    val cardPadding: Dp,
    val defaultCenter: Boolean = false,
)

val CompactDimensions = DimensionProfile(
    minTouchTarget = CompactTokens.BUTTON_HEIGHT.dp,
    spacingXs = CompactTokens.SPACING_XS.dp,
    spacingS = CompactTokens.SPACING_S.dp,
    spacingM = CompactTokens.SPACING_M.dp,
    spacingL = CompactTokens.SPACING_L.dp,
    spacingXl = CompactTokens.SPACING_XL.dp,
    cornerRadius = CompactTokens.SHAPE_SM.dp,
    iconSize = CompactTokens.ICON_SIZE.dp,
    iconSizeSmall = CompactTokens.ICON_SIZE_SMALL.dp,
    iconSizeLarge = CompactTokens.ICON_SIZE_LARGE.dp,
    buttonHeight = CompactTokens.BUTTON_HEIGHT.dp,
    chipHeight = CompactTokens.CHIP_HEIGHT.dp,
    fabSize = CompactTokens.FAB_SIZE.dp,
    fabExtendedHeight = CompactTokens.FAB_EXTENDED_HEIGHT.dp,
    inputHeight = CompactTokens.INPUT_HEIGHT.dp,
    dialogPadding = CompactTokens.DIALOG_PADDING.dp,
    topBarHeight = CompactTokens.TOPBAR_HEIGHT.dp,
    listItemHeight = CompactTokens.LIST_ITEM_HEIGHT.dp,
    cardPadding = CompactTokens.CARD_PADDING.dp,
    defaultCenter = true,
)

val StandardDimensions = DimensionProfile(
    minTouchTarget = ExpandedTokens.BUTTON_HEIGHT.dp,
    spacingXs = ExpandedTokens.SPACING_XS.dp,
    spacingS = ExpandedTokens.SPACING_S.dp,
    spacingM = ExpandedTokens.SPACING_M.dp,
    spacingL = ExpandedTokens.SPACING_L.dp,
    spacingXl = ExpandedTokens.SPACING_XL.dp,
    cornerRadius = ExpandedTokens.SHAPE_MD.dp,
    iconSize = ExpandedTokens.ICON_SIZE.dp,
    iconSizeSmall = ExpandedTokens.ICON_SIZE_SMALL.dp,
    iconSizeLarge = ExpandedTokens.ICON_SIZE_LARGE.dp,
    buttonHeight = ExpandedTokens.BUTTON_HEIGHT.dp,
    chipHeight = ExpandedTokens.CHIP_HEIGHT.dp,
    fabSize = ExpandedTokens.FAB_SIZE.dp,
    fabExtendedHeight = ExpandedTokens.FAB_EXTENDED_HEIGHT.dp,
    inputHeight = ExpandedTokens.INPUT_HEIGHT.dp,
    dialogPadding = ExpandedTokens.DIALOG_PADDING.dp,
    topBarHeight = ExpandedTokens.TOPBAR_HEIGHT.dp,
    listItemHeight = ExpandedTokens.LIST_ITEM_HEIGHT.dp,
    cardPadding = ExpandedTokens.CARD_PADDING.dp,
)

val LocalDimensions = staticCompositionLocalOf { StandardDimensions }

// ---------------------------------------------------------------------------
// MoumantaiTheme — Material 3 with dynamic color on Android 12+ and a tuned
// teal fallback for earlier versions or when dynamicColor is disabled. Light
// and dark schemes gated by the system setting.
// ---------------------------------------------------------------------------

@Composable
fun MoumantaiTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    // SizeClass breakpoint lock-stepped with server's `classifyWidth`
    // (`server/src/server/transport/ws-server.ts`): width ≤ 240 dp → COMPACT,
    // anything wider → EXPANDED. Server delivers the matching face variant.
    val screenWidthDp = LocalConfiguration.current.screenWidthDp
    val isCompact = screenWidthDp <= 240
    val dimensions = if (isCompact) CompactDimensions else StandardDimensions
    val typography = if (isCompact) CompactTypography else StandardTypography

    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    CompositionLocalProvider(LocalDimensions provides dimensions) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = typography,
            shapes = MoumantaiShapes,
            content = content,
        )
    }
}
