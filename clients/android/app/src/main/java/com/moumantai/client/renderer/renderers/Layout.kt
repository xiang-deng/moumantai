package com.moumantai.client.renderer.renderers

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.moumantai.client.renderer.LocalScaffoldBodyScope
import com.moumantai.client.renderer.RenderNode
import com.moumantai.client.renderer.RenderParent
import com.moumantai.client.renderer.defaultGroupSpacing
import com.moumantai.client.renderer.defaultRowSpacing
import com.moumantai.client.renderer.isCompactWidth
import com.moumantai.client.renderer.mapHorizontalAlignment
import com.moumantai.client.renderer.mapHorizontalArrangement
import com.moumantai.client.renderer.mapVerticalAlignment
import com.moumantai.client.renderer.mapVerticalArrangement
import com.moumantai.client.renderer.modifier
import com.moumantai.client.renderer.resolveModifierWithSize
import com.moumantai.client.theme.LocalDimensions
import com.moumantai.protocol.designsystem.DesignSystem
import com.moumantai.protocol.designsystem.DesignSystemTreatments
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.BoxComponent
import com.moumantai.protocol.v1.CardComponent
import com.moumantai.protocol.v1.ColumnComponent
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.RowComponent

// ---------------------------------------------------------------------------
// Column — defaults to group-level spacing when the face doesn't specify.
// Cross-axis sizing flows through the catalog; body-top columns auto-center.
// ---------------------------------------------------------------------------

@Composable
fun ColumnRenderer(
    componentId: String,
    c: ColumnComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val spacing = c.spacing ?: defaultGroupSpacing().value.toInt()
    val children = c.children

    val isBodyTop = LocalScaffoldBodyScope.current

    val verticalArrangement = if (c.vertical_arrangement != null) {
        mapVerticalArrangement(c.vertical_arrangement, spacing)
    } else {
        Arrangement.spacedBy(spacing.dp, Alignment.Top)
    }
    // Body-top horizontal centering: text/icon/progress children otherwise
    // cling to the start edge with no visual balance.
    val horizontalAlignment = when {
        c.horizontal_alignment != null -> mapHorizontalAlignment(c.horizontal_alignment)
        isBodyTop -> Alignment.CenterHorizontally
        else -> mapHorizontalAlignment(null)
    }

    val modifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "Column",
        null,
    )

    CompositionLocalProvider(LocalScaffoldBodyScope provides false) {
        Column(
            modifier = modifier,
            verticalArrangement = verticalArrangement,
            horizontalAlignment = horizontalAlignment,
        ) {
            children.forEachIndexed { index, childId ->
                val childWeight = components[childId]?.modifier()?.weight?.toFloat()
                val childRender: @Composable () -> Unit = {
                    RenderNode(
                        componentId = childId,
                        components = components,
                        data = data,
                        surfaceId = surfaceId,
                        itemScope = itemScope,
                        itemScopePath = itemScopePath,
                        dispatch = dispatch,
                        parent = RenderParent(kind = "Column", slotIndex = index),
                    )
                }
                if (childWeight != null && childWeight > 0f) {
                    // propagateMinConstraints=true: WRAP-policy children inherit the
                    // slot's main-axis constraint rather than measuring at intrinsic-zero.
                    Box(
                        modifier = Modifier.weight(childWeight),
                        propagateMinConstraints = true,
                    ) { childRender() }
                } else {
                    childRender()
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Row — default 8dp spacing between items, center-vertically.
// ---------------------------------------------------------------------------

@Composable
fun RowRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: RowComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val spacing = c.spacing ?: defaultRowSpacing().value.toInt()
    val horizontalArrangement = mapHorizontalArrangement(c.horizontal_arrangement, spacing)
    val verticalAlignment = if (c.vertical_alignment == null) {
        Alignment.CenterVertically
    } else {
        mapVerticalAlignment(c.vertical_alignment)
    }

    val modifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "Row",
        null,
    )

    Row(
        modifier = modifier,
        horizontalArrangement = horizontalArrangement,
        verticalAlignment = verticalAlignment,
    ) {
        c.children.forEachIndexed { index, childId ->
            val childWeight = components[childId]?.modifier()?.weight?.toFloat()
            val childRender: @Composable () -> Unit = {
                RenderNode(
                    componentId = childId,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                    parent = RenderParent(kind = "Row", slotIndex = index),
                )
            }
            if (childWeight != null && childWeight > 0f) {
                // propagateMinConstraints=true: WRAP-policy children inherit the
                // slot's main-axis constraint rather than measuring at intrinsic-zero.
                Box(
                    modifier = Modifier.weight(childWeight),
                    propagateMinConstraints = true,
                ) { childRender() }
            } else {
                childRender()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Card — M3 Card / ElevatedCard / OutlinedCard, 16dp inner padding (8dp compact).
// Variant routing via catalog: `kind` picks the Material primitive, `accent`
// picks the container-color role.
// ---------------------------------------------------------------------------

@Composable
fun CardRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: CardComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val spec = DesignSystemTreatments.resolveCard(c.emphasis, c.tone)
    val children = c.children

    val compact = isCompactWidth()
    val dim = LocalDimensions.current
    val innerPad = dim.cardPadding // 8dp compact / 16dp expanded
    val contentSpacing = if (compact) 8.dp else 12.dp // no token for this grouping; hand-tuned
    val modifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "Card",
        childVariant = null,
    ).let { mod ->
        if (c.action != null) {
            mod.clickable { dispatch(c.action, itemScope) }
        } else {
            mod
        }
    }

    val cardContent: @Composable () -> Unit = {
        CompositionLocalProvider(LocalScaffoldBodyScope provides false) {
            Column(
                modifier = Modifier.padding(innerPad),
                verticalArrangement = Arrangement.spacedBy(contentSpacing),
            ) {
                children.forEachIndexed { index, childId ->
                    RenderNode(
                        componentId = childId,
                        components = components,
                        data = data,
                        surfaceId = surfaceId,
                        itemScope = itemScope,
                        itemScopePath = itemScopePath,
                        dispatch = dispatch,
                        parent = RenderParent(kind = "Card", slotIndex = index),
                    )
                }
            }
        }
    }

    val shape = MaterialTheme.shapes.medium

    // Container color from catalog `accent`: neutral → surface roles; others → M3 container roles.
    val filledContainer = when (spec.accent) {
        "secondary" -> MaterialTheme.colorScheme.secondaryContainer
        "tertiary" -> MaterialTheme.colorScheme.tertiaryContainer
        "error" -> MaterialTheme.colorScheme.errorContainer
        "warning" -> MaterialTheme.colorScheme.errorContainer // M3 has no `warning` slot; `warning` maps to error-container (matches web)
        else -> MaterialTheme.colorScheme.surfaceContainerHighest
    }
    val elevatedContainer = when (spec.accent) {
        "secondary" -> MaterialTheme.colorScheme.secondaryContainer
        "tertiary" -> MaterialTheme.colorScheme.tertiaryContainer
        "error" -> MaterialTheme.colorScheme.errorContainer
        "warning" -> MaterialTheme.colorScheme.errorContainer
        else -> MaterialTheme.colorScheme.surfaceContainerLow
    }

    when (spec.kind) {
        "outlined_container" -> OutlinedCard(modifier = modifier, shape = shape) { cardContent() }
        "elevated_container" -> ElevatedCard(
            modifier = modifier,
            shape = shape,
            colors = CardDefaults.elevatedCardColors(containerColor = elevatedContainer),
        ) { cardContent() }
        else -> Card(
            modifier = modifier,
            shape = shape,
            colors = CardDefaults.cardColors(containerColor = filledContainer),
        ) { cardContent() }
    }
}

// ---------------------------------------------------------------------------
// Box — z-stack. Index 0 is the background (fill), index ≥ 1 are overlays
// (wrap). `child_alignment[i]` overrides `content_alignment` per slot index.
// Slot policy is automatic via the slot index in `RenderParent`.
// ---------------------------------------------------------------------------

@Composable
fun BoxRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: BoxComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val contentAlignment = parseAlignment(c.content_alignment ?: DesignSystem.Alignments.default)
    val children = c.children
    val childAlignments = c.child_alignment

    Box(
        modifier = resolveModifierWithSize(
            c.modifier,
            data,
            itemScope,
            parent,
            "Box",
            null,
        ),
        contentAlignment = contentAlignment,
    ) {
        children.forEachIndexed { index, childId ->
            val childParent = RenderParent(kind = "Box", slotIndex = index)
            val raw = childAlignments.getOrNull(index)?.takeIf { it.isNotEmpty() }
            if (raw != null) {
                // Per-child alignment override — inner Box applies `Modifier.align` in this BoxScope.
                Box(modifier = Modifier.align(parseAlignment(raw))) {
                    RenderNode(
                        componentId = childId,
                        components = components,
                        data = data,
                        surfaceId = surfaceId,
                        itemScope = itemScope,
                        itemScopePath = itemScopePath,
                        dispatch = dispatch,
                        parent = childParent,
                    )
                }
            } else {
                RenderNode(
                    componentId = childId,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                    parent = childParent,
                )
            }
        }
    }
}

/**
 * Maps a design-system alignment string to a Compose [Alignment].
 * Unknown values fall back to `topStart` — safe default, matches proto spec.
 * `internal` for testability in [RenderNodeTest].
 */
internal fun parseAlignment(value: String): Alignment = when (value) {
    "topStart" -> Alignment.TopStart
    "topCenter" -> Alignment.TopCenter
    "topEnd" -> Alignment.TopEnd
    "centerStart" -> Alignment.CenterStart
    "center" -> Alignment.Center
    "centerEnd" -> Alignment.CenterEnd
    "bottomStart" -> Alignment.BottomStart
    "bottomCenter" -> Alignment.BottomCenter
    "bottomEnd" -> Alignment.BottomEnd
    else -> Alignment.TopStart
}
