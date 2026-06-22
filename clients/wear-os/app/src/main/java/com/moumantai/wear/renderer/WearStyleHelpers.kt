package com.moumantai.wear.renderer

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.MaterialTheme
import com.moumantai.protocol.designsystem.Layout
import com.moumantai.protocol.designsystem.LayoutSizeResult
import com.moumantai.protocol.v1.Dimension
import com.moumantai.protocol.v1.Modifier as WireModifier

// ---------------------------------------------------------------------------
// Typography mapping: Moumantai names → Wear Compose M3 typography roles
// ---------------------------------------------------------------------------
//
// Maps the catalog vocabulary 1:1 to M3 role names. Do not invent new role
// names here — keep in lockstep with the catalog's typography list.

@Composable
fun mapTypography(name: String?): TextStyle = when (name) {
    "displayLarge", "display-large" -> MaterialTheme.typography.displayLarge
    "displayMedium", "display-medium" -> MaterialTheme.typography.displayMedium
    "displaySmall", "display-small" -> MaterialTheme.typography.displaySmall
    "headlineLarge", "headline-large" -> MaterialTheme.typography.titleLarge
    "headlineMedium", "headline-medium" -> MaterialTheme.typography.titleLarge
    "headlineSmall", "headline-small" -> MaterialTheme.typography.titleMedium
    "titleLarge", "title-large" -> MaterialTheme.typography.titleLarge
    "titleMedium", "title-medium" -> MaterialTheme.typography.titleMedium
    "titleSmall", "title-small" -> MaterialTheme.typography.titleSmall
    "bodyLarge", "body-large" -> MaterialTheme.typography.bodyLarge
    "bodyMedium", "body-medium" -> MaterialTheme.typography.bodyMedium
    "bodySmall", "body-small" -> MaterialTheme.typography.bodySmall
    "labelLarge", "label-large" -> MaterialTheme.typography.labelLarge
    "labelMedium", "label-medium" -> MaterialTheme.typography.labelMedium
    "labelSmall", "label-small" -> MaterialTheme.typography.labelSmall
    else -> MaterialTheme.typography.bodyMedium
}

fun mapFontWeight(name: String?): FontWeight? = when (name) {
    "bold" -> FontWeight.Bold
    "medium" -> FontWeight.Medium
    "light" -> FontWeight.Light
    "normal" -> FontWeight.Normal
    else -> null
}

fun mapTextAlign(name: String?): TextAlign? = when (name) {
    "center" -> TextAlign.Center
    "end", "right" -> TextAlign.End
    "start", "left" -> TextAlign.Start
    else -> TextAlign.Center // Watch: center by default on round screens
}

// ---------------------------------------------------------------------------
// Layout arrangement/alignment helpers
// ---------------------------------------------------------------------------
//
// `spacing` and `*_arrangement` are independent (Web: gap + justify-content;
// ESP32: pad_gap + flex alignment). Compose singletons like `Arrangement.Center`
// drop `spacedBy`, so the 2-arg `spacedBy(dp, Alignment)` overload is required
// when both are set. Distribution arrangements (spaceBetween/Around/Evenly)
// compute their own gaps — explicit `spacing` is intentionally dropped.

fun mapHorizontalArrangement(name: String?, spacing: Int = 0): Arrangement.Horizontal {
    val gap = if (spacing > 0) spacing.dp else 0.dp
    return when (name) {
        "center" -> if (spacing > 0) Arrangement.spacedBy(gap, Alignment.CenterHorizontally) else Arrangement.Center
        "end" -> if (spacing > 0) Arrangement.spacedBy(gap, Alignment.End) else Arrangement.End
        "start" -> if (spacing > 0) Arrangement.spacedBy(gap, Alignment.Start) else Arrangement.Start
        "spaceBetween" -> Arrangement.SpaceBetween
        "spaceAround" -> Arrangement.SpaceAround
        "spaceEvenly" -> Arrangement.SpaceEvenly
        else -> if (spacing > 0) Arrangement.spacedBy(gap) else Arrangement.Start
    }
}

fun mapVerticalArrangement(name: String?, spacing: Int = 0): Arrangement.Vertical {
    val gap = if (spacing > 0) spacing.dp else 0.dp
    return when (name) {
        "center" -> if (spacing > 0) Arrangement.spacedBy(gap, Alignment.CenterVertically) else Arrangement.Center
        "bottom" -> if (spacing > 0) Arrangement.spacedBy(gap, Alignment.Bottom) else Arrangement.Bottom
        "top" -> if (spacing > 0) Arrangement.spacedBy(gap, Alignment.Top) else Arrangement.Top
        "spaceBetween" -> Arrangement.SpaceBetween
        "spaceAround" -> Arrangement.SpaceAround
        "spaceEvenly" -> Arrangement.SpaceEvenly
        else -> if (spacing > 0) Arrangement.spacedBy(gap) else Arrangement.Top
    }
}

fun mapVerticalAlignment(name: String?): Alignment.Vertical = when (name) {
    "center" -> Alignment.CenterVertically
    "bottom" -> Alignment.Bottom
    else -> Alignment.Top
}

fun mapHorizontalAlignment(name: String?): Alignment.Horizontal = when (name) {
    "start" -> Alignment.Start
    "end" -> Alignment.End
    else -> Alignment.CenterHorizontally // Watch: center by default on round screens
}

// ---------------------------------------------------------------------------
// Modifier helpers (adapted for round screen)
// ---------------------------------------------------------------------------

/**
 * Position of a component in the render tree (mirrors Android's `RenderParent`;
 * kept separate because Wear can't depend on the client module).
 */
data class RenderParent(
    val kind: String?,
    val slotIndex: Int = 0,
    val slotName: String? = null,
) {
    companion object {
        val ROOT = RenderParent(kind = null)
    }
}

/**
 * Build a [Modifier] from the wire modifier slot (padding, fixed width/height,
 * background). Width/height keywords flow through [resolveModifierWithSize].
 */
@Composable
fun resolveModifier(
    m: WireModifier?,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
): Modifier {
    if (m == null) return Modifier
    var modifier: Modifier = Modifier
    m.padding?.let { dim -> modifier = modifier.applyPadding(dim) }
    m.width?.dp?.let { dp -> modifier = modifier.width(dp.dp) }
    m.height?.dp?.let { dp -> modifier = modifier.height(dp.dp) }
    // Background: apply before padding so the fill extends to outer bounds.
    val bgName = resolveDynamic(m.background, data, itemScope)
    if (bgName != null) {
        resolveThemeColor(bgName)?.let { c -> modifier = Modifier.background(c).then(modifier) }
    }
    return modifier
}

/**
 * Apply padding from the wire modifier and catalog-driven layout size resolution.
 * Mirrors the phone's `StyleHelpers.kt` (see `shared/protocol/spec.md` rule 10).
 */
@Composable
fun resolveModifierWithSize(
    m: WireModifier?,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    parent: RenderParent,
    childKind: String,
    childVariant: String?,
): Modifier {
    var modifier = resolveModifier(m, data, itemScope)
    val widthDpExplicit = m?.width?.dp != null
    val heightDpExplicit = m?.height?.dp != null

    if (!widthDpExplicit) {
        val widthResult = Layout.resolveChildWidth(
            parentKind = parent.kind,
            slotIndex = parent.slotIndex,
            slotName = parent.slotName,
            childKind = childKind,
            childVariant = childVariant,
            ownKeyword = m?.width?.keyword,
        )
        modifier = when (widthResult) {
            LayoutSizeResult.FILL -> modifier.fillMaxWidth()
            LayoutSizeResult.WRAP -> modifier
            LayoutSizeResult.FIXED -> modifier
            // GROW: no-op here — the SDK normalizes `width: 'grow'` to
            // `weight: 1` applied by the parent container's `Modifier.weight`.
            LayoutSizeResult.GROW -> modifier
        }
    }
    if (!heightDpExplicit) {
        val heightResult = Layout.resolveChildHeight(
            parentKind = parent.kind,
            slotIndex = parent.slotIndex,
            slotName = parent.slotName,
            childKind = childKind,
            childVariant = childVariant,
            ownKeyword = m?.height?.keyword,
        )
        modifier = when (heightResult) {
            LayoutSizeResult.FILL -> modifier.fillMaxHeight()
            LayoutSizeResult.WRAP -> modifier
            LayoutSizeResult.FIXED -> modifier
            LayoutSizeResult.GROW -> modifier // see GROW comment above
        }
    }
    return modifier
}

private fun Modifier.applyPadding(dim: Dimension): Modifier {
    val edges = dim.edges
    if (edges != null) {
        val top = edges.top ?: edges.vertical ?: 0
        val bottom = edges.bottom ?: edges.vertical ?: 0
        val start = edges.start ?: edges.horizontal ?: 0
        val end = edges.end ?: edges.horizontal ?: 0
        return this.padding(start = start.dp, top = top.dp, end = end.dp, bottom = bottom.dp)
    }
    val v = dim.dp ?: return this
    return this.padding(v.dp)
}

// ---------------------------------------------------------------------------
// Color helpers — maps wire protocol color names onto M3 colorScheme roles.
// ---------------------------------------------------------------------------

@Composable
fun resolveThemeColor(name: String?): Color? {
    if (name == null) return null

    if (name.startsWith("#")) {
        return try {
            val hex = name.removePrefix("#")
            val argb = when (hex.length) {
                6 -> "FF$hex".toLong(16)
                8 -> hex.toLong(16)
                else -> return null
            }
            Color(argb.toInt())
        } catch (_: Exception) {
            null
        }
    }

    val scheme = MaterialTheme.colorScheme
    return when (name) {
        "primary" -> scheme.primary
        "onPrimary" -> scheme.onPrimary
        "primaryContainer" -> scheme.primaryContainer
        "onPrimaryContainer" -> scheme.onPrimaryContainer
        "secondary" -> scheme.secondary
        "onSecondary" -> scheme.onSecondary
        "secondaryContainer" -> scheme.secondaryContainer
        "onSecondaryContainer" -> scheme.onSecondaryContainer
        "tertiary" -> scheme.tertiary
        "onTertiary" -> scheme.onTertiary
        "tertiaryContainer" -> scheme.tertiaryContainer
        "onTertiaryContainer" -> scheme.onTertiaryContainer
        "error" -> scheme.error
        "onError" -> scheme.onError
        "errorContainer" -> scheme.errorContainer
        "onErrorContainer" -> scheme.onErrorContainer
        // M3 Wear has no single `surface`; surfaceContainer is the closest equivalent.
        "surface" -> scheme.surfaceContainer
        "onSurface" -> scheme.onSurface
        "surfaceVariant" -> scheme.surfaceContainerHigh
        "onSurfaceVariant" -> scheme.onSurfaceVariant
        "background" -> scheme.background
        "onBackground" -> scheme.onBackground
        "outline" -> scheme.outline
        else -> null
    }
}

// Sizing tokens are read via `LocalDimensions.current.<field>`, not imported
// directly from CompactTokens — the theme is the single seam for consumption.
