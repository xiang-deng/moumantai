package com.moumantai.client.renderer.renderers

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.moumantai.client.renderer.RenderNode
import com.moumantai.client.renderer.RenderParent
import com.moumantai.client.renderer.componentKind
import com.moumantai.client.renderer.defaultIconSize
import com.moumantai.client.renderer.isCompactWidth
import com.moumantai.client.renderer.lookupMaterialIcon
import com.moumantai.client.renderer.resolveAbsolutePath
import com.moumantai.client.renderer.resolveDynamic
import com.moumantai.client.renderer.resolveModifierWithSize
import com.moumantai.client.theme.DimensionProfile
import com.moumantai.client.theme.LocalDimensions
import com.moumantai.protocol.designsystem.Layout
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.ListComponent
import com.moumantai.protocol.v1.ListItemComponent

/**
 * Map a catalog spacing-token name ("spacing.s", "spacing.none", ...) to a
 * Dp value resolved against the current [DimensionProfile]. "spacing.none"
 * is the literal-0 sentinel; unknown names also fall back to 0 (defensive).
 */
private fun resolveSpacingToken(token: String?, dim: DimensionProfile): Dp = when (token) {
    null -> 0.dp
    "spacing.none" -> 0.dp
    "spacing.xs" -> dim.spacingXs
    "spacing.s" -> dim.spacingS
    "spacing.m" -> dim.spacingM
    "spacing.l" -> dim.spacingL
    "spacing.xl" -> dim.spacingXl
    else -> 0.dp
}

// ---------------------------------------------------------------------------
// List — non-lazy Column. LazyColumn under a verticalScroll parent crashes
// Compose with "infinity maximum height constraints", so we use a plain
// Column instead. Plugin-app lists are well under the ~100-item threshold
// where virtualization matters; a `lazy: true` flag can be added if needed.
// ---------------------------------------------------------------------------

@Composable
fun ListRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ListComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val descriptor = c.children ?: return

    val fullPath = if (descriptor.path.startsWith("/")) {
        descriptor.path
    } else {
        if (itemScopePath != null) "$itemScopePath/${descriptor.path}" else "/${descriptor.path}"
    }

    val items = resolveAbsolutePath(fullPath, data) as? List<*> ?: return
    if (items.isEmpty()) return

    val compact = isCompactWidth()
    val dim = LocalDimensions.current
    // Gap per child kind: Card → spacing.s; ListItem → spacing.none (M3 divider); else catalog default.
    val templateKind = components[descriptor.component_id]?.componentKind() ?: "default"
    val gapToken = Layout.containerChildGap("List", templateKind)
    val arrangement = Arrangement.spacedBy(resolveSpacingToken(gapToken, dim))
    val outerPad = if (compact) {
        PaddingValues(horizontal = 0.dp, vertical = dim.spacingS) // body inset covers horizontal
    } else {
        PaddingValues(horizontal = dim.spacingS, vertical = dim.spacingS)
    }

    Column(
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "List", null)
            .padding(outerPad),
        verticalArrangement = arrangement,
    ) {
        items.forEachIndexed { index, item ->
            val childItemScope = if (item is Map<*, *>) {
                @Suppress("UNCHECKED_CAST")
                item as Map<String, Any?>
            } else {
                mapOf("value" to item)
            }
            val childScopePath = "$fullPath/$index"

            RenderNode(
                componentId = descriptor.component_id,
                components = components,
                data = data,
                surfaceId = surfaceId,
                itemScope = childItemScope,
                itemScopePath = childScopePath,
                dispatch = dispatch,
                parent = RenderParent(kind = "List", slotIndex = index),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// ListItem — M3 ListItem with default typography roles and heights.
// ---------------------------------------------------------------------------

@Composable
fun ListItemRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ListItemComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val headline = resolveDynamic(c.headline, data, itemScope) ?: ""
    val supporting = resolveDynamic(c.supporting, data, itemScope)
    val leadingIcon = resolveDynamic(c.leading_icon, data, itemScope)
    val trailingContent = c.trailing_content

    val iconSize = defaultIconSize()

    var modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "ListItem", null)
    if (c.action != null) {
        modifier = modifier.clickable {
            dispatch(c.action, itemScope)
        }
    }

    ListItem(
        headlineContent = { androidx.compose.material3.Text(text = headline, maxLines = 2) },
        supportingContent = supporting?.let {
            { androidx.compose.material3.Text(text = it, maxLines = 1) }
        },
        leadingContent = leadingIcon?.let {
            {
                Icon(
                    imageVector = lookupMaterialIcon(it),
                    contentDescription = null,
                    modifier = Modifier.size(iconSize),
                )
            }
        },
        trailingContent = trailingContent?.let {
            {
                RenderNode(
                    componentId = it,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                    parent = RenderParent(kind = "ListItem", slotName = "trailing"),
                )
            }
        },
        colors = ListItemDefaults.colors(
            containerColor = androidx.compose.material3.MaterialTheme.colorScheme.surface,
        ),
        modifier = modifier,
    )
}
