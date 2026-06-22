package com.moumantai.client.renderer

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.moumantai.client.theme.LocalDimensions
import com.moumantai.protocol.designsystem.Layout
import com.moumantai.protocol.designsystem.LayoutSizeResult
import com.moumantai.protocol.v1.Dimension
import com.moumantai.protocol.v1.Modifier as WireModifier

// ---------------------------------------------------------------------------
// Typography mapping: Moumantai typography names -> Compose TextStyle
// ---------------------------------------------------------------------------

@Composable
fun mapTypography(name: String?): TextStyle {
    // Wire format uses camelCase (displayLarge) — match both camelCase and kebab-case
    return when (name) {
        "displayLarge", "display-large" -> MaterialTheme.typography.displayLarge
        "displayMedium", "display-medium" -> MaterialTheme.typography.displayMedium
        "displaySmall", "display-small" -> MaterialTheme.typography.displaySmall
        "headlineLarge", "headline-large" -> MaterialTheme.typography.headlineLarge
        "headlineMedium", "headline-medium" -> MaterialTheme.typography.headlineMedium
        "headlineSmall", "headline-small" -> MaterialTheme.typography.headlineSmall
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
}

@Composable
fun mapFontWeight(name: String?): FontWeight? = when (name) {
    "bold" -> FontWeight.Bold
    "medium" -> FontWeight.Medium
    "light" -> FontWeight.Light
    "normal" -> FontWeight.Normal
    else -> null
}

@Composable
fun mapTextAlign(name: String?): TextAlign? {
    val center = LocalDimensions.current.defaultCenter
    return when (name) {
        "center" -> TextAlign.Center
        "end", "right" -> TextAlign.End
        "start", "left" -> TextAlign.Start
        else -> if (center) TextAlign.Center else null
    }
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

// `spacing` and arrangement are independent. Compose's `Arrangement.Center`
// etc. drop `spacedBy`, so we use the 2-arg overload `spacedBy(dp, Alignment)`
// when both are set. The space-distributing arrangements (`spaceBetween` etc.)
// compute their own gaps, so `spacing` is intentionally ignored for those.

fun mapHorizontalArrangement(
    name: String?,
    spacing: Int = 0,
): Arrangement.Horizontal {
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

fun mapVerticalArrangement(
    name: String?,
    spacing: Int = 0,
): Arrangement.Vertical {
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

@Composable
fun mapHorizontalAlignment(name: String?): Alignment.Horizontal {
    val center = LocalDimensions.current.defaultCenter
    return when (name) {
        "start" -> Alignment.Start
        "center" -> Alignment.CenterHorizontally
        "end" -> Alignment.End
        else -> if (center) Alignment.CenterHorizontally else Alignment.Start
    }
}

// ---------------------------------------------------------------------------
// Modifier helpers
// ---------------------------------------------------------------------------

/**
 * Position of a component in the render tree, passed explicitly to every
 * `*Renderer(...)`. [resolveModifierWithSize] reads this for cross-axis sizing.
 *
 * Explicit parameter (not CompositionLocal) keeps the dependency visible at
 * every call site — routing layout scope through CompositionLocals is the
 * hazard noted in shared/protocol/spec.md rule 10.
 */
data class RenderParent(
    /** TypeName of the parent ("Column", "Box", ...) or null at the surface root. */
    val kind: String?,
    /** 0-based index of this child in the parent's children list. */
    val slotIndex: Int = 0,
    /** Scaffold slot identifier ("body" / "top_bar" / "fab"); null for non-Scaffold parents. */
    val slotName: String? = null,
) {
    companion object {
        /** Convenience for surface-root callers (no parent). */
        val ROOT = RenderParent(kind = null)
    }
}

/**
 * Build a Compose [Modifier] from the wire modifier slot (padding + background
 * only). Width/height are intentionally omitted — use [resolveModifierWithSize]
 * for those so cross-renderer behavior stays in lockstep with the catalog.
 * This helper is for the rare renderer that manages its own size (e.g. Modal).
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
    // Background: apply before padding so the fill covers the outer bounds.
    val bgName = resolveDynamic(m.background, data, itemScope)
    if (bgName != null) {
        resolveThemeColor(bgName)?.let { c -> modifier = Modifier.background(c).then(modifier) }
    }
    return modifier
}

/**
 * Canonical modifier chain for renderers — applies padding from the wire
 * modifier and consults the catalog for cross-axis sizing (spec.md rule 10).
 *
 * Explicit `m.width.dp` / `m.height.dp` take precedence. Otherwise the
 * catalog returns FILL → `fillMaxWidth/Height`, WRAP / FIXED → no modifier.
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
        val widthResult =
            Layout.resolveChildWidth(
                parentKind = parent.kind,
                slotIndex = parent.slotIndex,
                slotName = parent.slotName,
                childKind = childKind,
                childVariant = childVariant,
                ownKeyword = m?.width?.keyword,
            )
        modifier =
            when (widthResult) {
                LayoutSizeResult.FILL -> modifier.fillMaxWidth()
                LayoutSizeResult.WRAP -> modifier
                LayoutSizeResult.FIXED -> modifier
                // GROW (`width: 'grow'`): SDK rewrites to `weight: 1` at build
                // time; the parent applies it via the Box-wrap path. Treat as
                // no-op here for older clients that still emit GROW.
                LayoutSizeResult.GROW -> modifier
            }
    }
    if (!heightDpExplicit) {
        val heightResult =
            Layout.resolveChildHeight(
                parentKind = parent.kind,
                slotIndex = parent.slotIndex,
                slotName = parent.slotName,
                childKind = childKind,
                childVariant = childVariant,
                ownKeyword = m?.height?.keyword,
            )
        modifier =
            when (heightResult) {
                LayoutSizeResult.FILL -> modifier.fillMaxHeight()
                LayoutSizeResult.WRAP -> modifier
                LayoutSizeResult.FIXED -> modifier
                LayoutSizeResult.GROW -> modifier // see GROW note on width above
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
// Color helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a theme color name to a Compose [Color].
 *
 * Supports both raw hex colors (e.g. "#FF0000") and Material theme references
 * (e.g. "primary", "onSurface"). Returns null for unknown color names, letting
 * the caller use a default.
 */
@Composable
fun resolveThemeColor(name: String?): Color? {
    if (name == null) return null

    // Hex color
    if (name.startsWith("#")) {
        return try {
            val hex = name.removePrefix("#")
            val argb =
                when (hex.length) {
                    6 -> "FF$hex".toLong(16)
                    8 -> hex.toLong(16)
                    else -> return null
                }
            Color(argb.toInt())
        } catch (_: Exception) {
            null
        }
    }

    // Material theme references
    return when (name) {
        "primary" -> MaterialTheme.colorScheme.primary
        "onPrimary" -> MaterialTheme.colorScheme.onPrimary
        "secondary" -> MaterialTheme.colorScheme.secondary
        "onSecondary" -> MaterialTheme.colorScheme.onSecondary
        "tertiary" -> MaterialTheme.colorScheme.tertiary
        "onTertiary" -> MaterialTheme.colorScheme.onTertiary
        "error" -> MaterialTheme.colorScheme.error
        "onError" -> MaterialTheme.colorScheme.onError
        "surface" -> MaterialTheme.colorScheme.surface
        "onSurface" -> MaterialTheme.colorScheme.onSurface
        "surfaceVariant" -> MaterialTheme.colorScheme.surfaceVariant
        "onSurfaceVariant" -> MaterialTheme.colorScheme.onSurfaceVariant
        "outline" -> MaterialTheme.colorScheme.outline
        "background" -> MaterialTheme.colorScheme.background
        "onBackground" -> MaterialTheme.colorScheme.onBackground
        else -> null
    }
}

// ---------------------------------------------------------------------------
// Compact-width + body-padding plumbing for polished defaults
// ---------------------------------------------------------------------------

/**
 * True when the screen width is ≤ 240dp (watch / iot-small). Lock-stepped with
 * `Theme.kt`'s SizeClass breakpoint and the server's `classifyWidth` so the
 * theme tier and renderer tier agree on which face variant we're rendering.
 */
@Composable
fun isCompactWidth(): Boolean = LocalConfiguration.current.screenWidthDp <= 240

/**
 * Default column spacing when the face didn't set one — `spacing.m` from the
 * active dimension profile (compact: 8dp; expanded: 16dp).
 */
@Composable
fun defaultGroupSpacing(): Dp = LocalDimensions.current.spacingM

/**
 * Default row spacing (items within a line) — `spacing.s` from the active
 * dimension profile (compact: 4dp; expanded: 8dp).
 */
@Composable
fun defaultRowSpacing(): Dp = LocalDimensions.current.spacingS

/**
 * Default icon size inside ListItem/Chip/Button slots — `sizing.iconSize` from
 * the active dimension profile (compact: 20dp; expanded: 24dp).
 */
@Composable
fun defaultIconSize(): Dp = LocalDimensions.current.iconSize

/**
 * True when a Column is the top-level body child of a Scaffold. Used for
 * body-relative alignment defaults (separate from sizing, which flows through
 * the catalog). ScaffoldRenderer sets this to true; the outermost Column
 * consumes and resets it before rendering its own children.
 */
val LocalScaffoldBodyScope = staticCompositionLocalOf { false }
