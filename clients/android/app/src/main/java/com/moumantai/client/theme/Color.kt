package com.moumantai.client.theme

import androidx.compose.ui.graphics.Color
import com.moumantai.client.generated.CompactTokens

// Material 3 color tokens. Dark roles covered by shared/tokens/*.yaml read
// from CompactTokens.COLOR_* (compact + expanded color tokens are identical,
// so just read one). Roles not covered by the token pipeline
// (tertiary / background / inversePrimary / surfaceTint /
// surfaceContainerLowest) use fixed teal-tuned hex values.

// --- Dark ---

val md_theme_dark_primary = Color(CompactTokens.COLOR_PRIMARY)
val md_theme_dark_onPrimary = Color(CompactTokens.COLOR_ON_PRIMARY)
val md_theme_dark_primaryContainer = Color(CompactTokens.COLOR_PRIMARY_CONTAINER)
val md_theme_dark_onPrimaryContainer = Color(CompactTokens.COLOR_ON_PRIMARY_CONTAINER)

val md_theme_dark_secondary = Color(CompactTokens.COLOR_SECONDARY)
val md_theme_dark_onSecondary = Color(CompactTokens.COLOR_ON_SECONDARY)
val md_theme_dark_secondaryContainer = Color(CompactTokens.COLOR_SECONDARY_CONTAINER)
val md_theme_dark_onSecondaryContainer = Color(CompactTokens.COLOR_ON_SECONDARY_CONTAINER)

// tertiary roles aren't in the token surface — fixed tuned teal values.
val md_theme_dark_tertiary = Color(0xFFAECAE5)
val md_theme_dark_onTertiary = Color(0xFF163348)
val md_theme_dark_tertiaryContainer = Color(0xFF2E4A60)
val md_theme_dark_onTertiaryContainer = Color(0xFFCAE6FF)

val md_theme_dark_error = Color(CompactTokens.COLOR_ERROR)
val md_theme_dark_onError = Color(CompactTokens.COLOR_ON_ERROR)
val md_theme_dark_errorContainer = Color(CompactTokens.COLOR_ERROR_CONTAINER)
val md_theme_dark_onErrorContainer = Color(CompactTokens.COLOR_ON_ERROR_CONTAINER)

// background / onBackground / inversePrimary / surfaceTint aren't in the token
// surface — fixed teal-tuned hex values.
val md_theme_dark_background = Color(0xFF0F1513)
val md_theme_dark_onBackground = Color(0xFFDFE4E1)
val md_theme_dark_surface = Color(CompactTokens.COLOR_SURFACE)
val md_theme_dark_onSurface = Color(CompactTokens.COLOR_ON_SURFACE)
val md_theme_dark_surfaceVariant = Color(CompactTokens.COLOR_SURFACE_VARIANT)
val md_theme_dark_onSurfaceVariant = Color(CompactTokens.COLOR_ON_SURFACE_VARIANT)
val md_theme_dark_outline = Color(CompactTokens.COLOR_OUTLINE)
val md_theme_dark_outlineVariant = Color(CompactTokens.COLOR_OUTLINE_VARIANT)
val md_theme_dark_inverseSurface = Color(CompactTokens.COLOR_INVERSE_SURFACE)
val md_theme_dark_inverseOnSurface = Color(CompactTokens.COLOR_INVERSE_ON_SURFACE)
val md_theme_dark_inversePrimary = Color(0xFF006B5E)
val md_theme_dark_surfaceTint = Color(0xFF80CBC4)

// M3 surface-container stops (tonal elevation levels) for dark theme.
// `lowest` isn't in the token surface — fixed teal-tuned hex.
val md_theme_dark_surfaceContainerLowest = Color(0xFF080E0C)
val md_theme_dark_surfaceContainerLow = Color(CompactTokens.COLOR_SURFACE_CONTAINER_LOW)
val md_theme_dark_surfaceContainer = Color(CompactTokens.COLOR_SURFACE_CONTAINER)
val md_theme_dark_surfaceContainerHigh = Color(CompactTokens.COLOR_SURFACE_CONTAINER_HIGH)
val md_theme_dark_surfaceContainerHighest = Color(CompactTokens.COLOR_SURFACE_CONTAINER_HIGHEST)

// --- Light ---

val md_theme_light_primary = Color(0xFF006B5E)
val md_theme_light_onPrimary = Color(0xFFFFFFFF)
val md_theme_light_primaryContainer = Color(0xFFA7F3EC)
val md_theme_light_onPrimaryContainer = Color(0xFF00201B)

val md_theme_light_secondary = Color(0xFF4A635F)
val md_theme_light_onSecondary = Color(0xFFFFFFFF)
val md_theme_light_secondaryContainer = Color(0xFFCDE8E3)
val md_theme_light_onSecondaryContainer = Color(0xFF06201C)

val md_theme_light_tertiary = Color(0xFF456179)
val md_theme_light_onTertiary = Color(0xFFFFFFFF)
val md_theme_light_tertiaryContainer = Color(0xFFCAE6FF)
val md_theme_light_onTertiaryContainer = Color(0xFF001E30)

val md_theme_light_error = Color(0xFFBA1A1A)
val md_theme_light_onError = Color(0xFFFFFFFF)
val md_theme_light_errorContainer = Color(0xFFFFDAD6)
val md_theme_light_onErrorContainer = Color(0xFF410002)

val md_theme_light_background = Color(0xFFFAFDFB)
val md_theme_light_onBackground = Color(0xFF191C1B)
val md_theme_light_surface = Color(0xFFFAFDFB)
val md_theme_light_onSurface = Color(0xFF191C1B)
val md_theme_light_surfaceVariant = Color(0xFFDAE5E1)
val md_theme_light_onSurfaceVariant = Color(0xFF3F4946)
val md_theme_light_outline = Color(0xFF6F7976)
val md_theme_light_outlineVariant = Color(0xFFBFC9C5)
val md_theme_light_inverseSurface = Color(0xFF2D3230)
val md_theme_light_inverseOnSurface = Color(0xFFEFF1EE)
val md_theme_light_inversePrimary = Color(0xFF80CBC4)
val md_theme_light_surfaceTint = Color(0xFF006B5E)

val md_theme_light_surfaceContainerLowest = Color(0xFFFFFFFF)
val md_theme_light_surfaceContainerLow = Color(0xFFF4F7F5)
val md_theme_light_surfaceContainer = Color(0xFFEEF1EF)
val md_theme_light_surfaceContainerHigh = Color(0xFFE8EBE9)
val md_theme_light_surfaceContainerHighest = Color(0xFFE2E5E3)
