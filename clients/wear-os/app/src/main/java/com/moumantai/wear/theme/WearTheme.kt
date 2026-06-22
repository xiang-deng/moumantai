package com.moumantai.wear.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Shapes
import androidx.wear.compose.material3.Typography
import com.moumantai.wear.generated.CompactTokens

// ---------------------------------------------------------------------------
// Color scheme — Wear-specific palette (diverges from shared CompactTokens.COLOR_*)
// ---------------------------------------------------------------------------
//
// Two constraints justify a separate palette:
//   1. OLED-first: near-black surface (`0xFF0F1513`) saves battery on always-on round panels.
//      The shared `COLOR_SURFACE = 0xFF1C1B1F` is too bright.
//   2. Teal accent (`0xFF80CBC4`) is the Moumantai on-watch brand color.
//      `DesignSystemRoutingTest` pins these literals — changing them breaks card-accent tests.
//
// All other tokens (typography, spacing, shapes, elevation, motion, state opacities)
// come from shared CompactTokens to stay in lockstep across device classes.

/** Amber dot shown while the connection is Reconnecting. */
internal val WearColorStatusWarning = Color(0xFFFFB300)

/** Red dot shown while the connection is Offline. */
internal val WearColorStatusError = Color(0xFFE53935)

private val WearColorScheme = ColorScheme(
    primary = Color(0xFF80CBC4), // Teal 200 — brand accent on OLED
    primaryDim = Color(0xFF4FB3A9),
    primaryContainer = Color(0xFF004F46),
    onPrimary = Color(0xFF003731),
    onPrimaryContainer = Color(0xFFB2DFDB),
    secondary = Color(0xFFB1CCC7),
    secondaryDim = Color(0xFF92AEA9),
    secondaryContainer = Color(0xFF334B47),
    onSecondary = Color(0xFF1C3531),
    onSecondaryContainer = Color(0xFFCFE9E4),
    tertiary = Color(0xFFB1CCC7),
    tertiaryDim = Color(0xFF92AEA9),
    tertiaryContainer = Color(0xFF334B47),
    onTertiary = Color(0xFF1C3531),
    onTertiaryContainer = Color(0xFFCFE9E4),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    surfaceContainerLow = Color(0xFF0A0F0D),
    surfaceContainer = Color(0xFF131A18),
    surfaceContainerHigh = Color(0xFF1B2421),
    onSurface = Color(0xFFDFE4E1),
    onSurfaceVariant = Color(0xFFBFC9C5),
    background = Color(0xFF0F1513), // Near-black for OLED
    onBackground = Color(0xFFDFE4E1),
    outline = Color(0xFF8A938F),
    outlineVariant = Color(0xFF3F4744),
)

// ---------------------------------------------------------------------------
// Typography — sourced from CompactTokens (shared/tokens/compact.yaml).
// `arc*` and `numeral*` roles fall through to M3 defaults.
// Run: python scripts/generate-tokens.py
// ---------------------------------------------------------------------------
private val WearTypography = Typography(
    displayLarge = TextStyle(fontSize = CompactTokens.DISPLAY_LARGE.sp, fontWeight = FontWeight.Medium),
    displayMedium = TextStyle(fontSize = CompactTokens.DISPLAY_MEDIUM.sp, fontWeight = FontWeight.Medium),
    displaySmall = TextStyle(fontSize = CompactTokens.DISPLAY_SMALL.sp, fontWeight = FontWeight.Medium),
    titleLarge = TextStyle(fontSize = CompactTokens.TITLE_LARGE.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = CompactTokens.TITLE_MEDIUM.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = CompactTokens.TITLE_SMALL.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = CompactTokens.BODY_LARGE.sp, fontWeight = FontWeight.Normal),
    bodyMedium = TextStyle(fontSize = CompactTokens.BODY_MEDIUM.sp, fontWeight = FontWeight.Normal),
    bodySmall = TextStyle(fontSize = CompactTokens.BODY_SMALL.sp, fontWeight = FontWeight.Normal),
    labelLarge = TextStyle(fontSize = CompactTokens.LABEL_LARGE.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = CompactTokens.LABEL_MEDIUM.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = CompactTokens.LABEL_SMALL.sp, fontWeight = FontWeight.Medium),
)

// ---------------------------------------------------------------------------
// Shapes — driven by CompactTokens shape-primitive scale.
//
// The `full` (pill) primitive is NOT emitted as a numeric constant in
// CompactTokens — consumers wanting a pill use `RoundedCornerShape(percent = 50)`
// directly (9999.dp is not equivalent to a 50%-corner shape at every height).
// ---------------------------------------------------------------------------
private val WearShapes = Shapes(
    extraSmall = RoundedCornerShape(CompactTokens.SHAPE_XS.dp),
    small = RoundedCornerShape(CompactTokens.SHAPE_SM.dp),
    medium = RoundedCornerShape(CompactTokens.SHAPE_MD.dp),
    large = RoundedCornerShape(CompactTokens.SHAPE_LG.dp),
    extraLarge = RoundedCornerShape(CompactTokens.SHAPE_XL.dp),
)

// ---------------------------------------------------------------------------
// Token-driven CompositionLocals — renderers read these instead of importing
// CompactTokens directly, giving tests a single seam to override values.
// Wear is compact-only (no runtime profile switch); types differ from Android's Theme.kt.
// ---------------------------------------------------------------------------

/** Dimension tokens exposed via [LocalDimensions]. Values are `const` (compact-only profile). */
data class WearDimensions(
    val spacingXs: Dp,
    val spacingS: Dp,
    val spacingM: Dp,
    val spacingL: Dp,
    val spacingXl: Dp,
    val iconSizeSmall: Dp,
    val iconSize: Dp,
    val iconSizeLarge: Dp,
    val minTouchTarget: Dp,
    val buttonHeight: Dp,
    val chipHeight: Dp,
    val fabSize: Dp,
    val inputHeight: Dp,
    val listItemHeight: Dp,
    val cardPadding: Dp,
    /**
     * Body-edge horizontal padding for ScreenScaffold. Round watches need
     * chin-clearance because content at the screen's extreme left/right
     * edges falls off the rounded panel. M3's ScreenScaffold owns top/bottom
     * chrome but leaves horizontal padding to the page author — every body
     * container reads this single value.
     */
    val bodyHorizontalPadding: Dp,
)

data class WearElevations(
    val raised: Dp,
    val floating: Dp,
    val elevated: Dp,
)

data class WearMotion(
    val durationShortMs: Int,
    val durationMediumMs: Int,
    val easingStandard: Easing,
)

data class WearStates(
    val disabledOpacity: Float,
)

internal val WearTokenDimensions = WearDimensions(
    spacingXs = CompactTokens.SPACING_XS.dp,
    spacingS = CompactTokens.SPACING_S.dp,
    spacingM = CompactTokens.SPACING_M.dp,
    spacingL = CompactTokens.SPACING_L.dp,
    spacingXl = CompactTokens.SPACING_XL.dp,
    iconSizeSmall = CompactTokens.ICON_SIZE_SMALL.dp,
    iconSize = CompactTokens.ICON_SIZE.dp,
    iconSizeLarge = CompactTokens.ICON_SIZE_LARGE.dp,
    // Min-touch-target == BUTTON_HEIGHT (48dp on compact).
    minTouchTarget = CompactTokens.BUTTON_HEIGHT.dp,
    buttonHeight = CompactTokens.BUTTON_HEIGHT.dp,
    chipHeight = CompactTokens.CHIP_HEIGHT.dp,
    fabSize = CompactTokens.FAB_SIZE.dp,
    inputHeight = CompactTokens.INPUT_HEIGHT.dp,
    listItemHeight = CompactTokens.LIST_ITEM_HEIGHT.dp,
    cardPadding = CompactTokens.CARD_PADDING.dp,
    // Spacing-L (12dp) keeps content inside the round watch chin clearance.
    bodyHorizontalPadding = CompactTokens.SPACING_L.dp,
)

internal val WearTokenElevations = WearElevations(
    raised = CompactTokens.ELEVATION_RAISED_DP.dp,
    floating = CompactTokens.ELEVATION_FLOATING_DP.dp,
    elevated = CompactTokens.ELEVATION_ELEVATED_DP.dp,
)

internal val WearTokenMotion = WearMotion(
    durationShortMs = CompactTokens.MOTION_DURATION_SHORT_MS,
    durationMediumMs = CompactTokens.MOTION_DURATION_MEDIUM_MS,
    easingStandard = CubicBezierEasing(
        CompactTokens.MOTION_EASING_STANDARD_X1,
        CompactTokens.MOTION_EASING_STANDARD_Y1,
        CompactTokens.MOTION_EASING_STANDARD_X2,
        CompactTokens.MOTION_EASING_STANDARD_Y2,
    ),
)

internal val WearTokenStates = WearStates(
    disabledOpacity = CompactTokens.STATE_DISABLED_OPACITY,
)

val LocalDimensions = staticCompositionLocalOf { WearTokenDimensions }

// Elevation / motion / state tokens are `WearToken*` constants (pinned by `WearThemeTokensTest`),
// not CompositionLocals — M3 components own elevation, animation, and disabled-alpha today.
// If a renderer needs to override an M3 default, read `WearToken*` directly; adding a Local then is one line.

@Composable
fun WearAppTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalDimensions provides WearTokenDimensions) {
        MaterialTheme(
            colorScheme = WearColorScheme,
            typography = WearTypography,
            shapes = WearShapes,
            content = content,
        )
    }
}
