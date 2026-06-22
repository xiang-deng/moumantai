package com.moumantai.wear.renderer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.EdgeButtonSize
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SwitchButton
import androidx.wear.compose.material3.Text
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.BodyKind
import com.moumantai.protocol.v1.ChipComponent
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.ListItemComponent
import com.moumantai.protocol.v1.ScaffoldComponent
import com.moumantai.protocol.v1.SwitchComponent
import com.moumantai.protocol.v1.TopBarComponent
import com.moumantai.wear.theme.LocalDimensions
import androidx.wear.compose.material3.Button as M3Button

// =============================================================================
// 1. ScaffoldRenderer
// =============================================================================
//
// AppScaffold (WearNavigation) owns outer chrome; ScreenScaffold (here) adds
// TimeText, right-bezel ScrollIndicator, and chin-aware padding per face.
//
// `body_kind`:
//   - BODY_KIND_LIST (default): fans body children into a TransformingLazyColumn
//     with chin clearance + rotary scroll.
//   - BODY_KIND_CANVAS: wraps body in a fillMaxSize Box centred on the round
//     screen (hero ring + caption faces).
//
// `topBar` → ListHeader at index 0 so the title scrolls with content (Wear UX:
// top bars do not pin on round screens). Ignored in CANVAS mode.
//
// `fab`: a FabComponent in the fab slot is wired to ScreenScaffold's edgeButton
// (the curved bottom-edge action). Other component types in the slot fall back
// to an inline list item / bottom-anchored box.

@Composable
fun ScaffoldRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ScaffoldComponent,
    @Suppress("UNUSED_PARAMETER") parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val bodyId = c.body
    val topBarId = c.top_bar
    val fabId = c.fab
    val bodyKind = c.body_kind ?: BodyKind.BODY_KIND_UNSPECIFIED

    // If the fab slot references a FabComponent, hand it to ScreenScaffold's
    // edgeButton; otherwise fall back to inline rendering.
    val fabComponent: com.moumantai.protocol.v1.FabComponent? =
        fabId?.let { components[it]?.fab }
    val isFabButton = fabComponent != null

    val dims = LocalDimensions.current

    when (bodyKind) {
        BodyKind.BODY_KIND_CANVAS -> {
            if (fabId != null && isFabButton) {
                ScreenScaffold(
                    scrollState = rememberTransformingLazyColumnState(),
                    edgeButton = {
                        ScaffoldFabEdgeButton(fabComponent, data, itemScope, dispatch)
                    },
                    modifier = Modifier.fillMaxSize(),
                ) { contentPadding ->
                    CanvasBody(bodyId, components, data, surfaceId, itemScope, itemScopePath, dispatch, contentPadding)
                }
            } else {
                ScreenScaffold(
                    modifier = Modifier.fillMaxSize(),
                ) { contentPadding ->
                    CanvasBody(bodyId, components, data, surfaceId, itemScope, itemScopePath, dispatch, contentPadding)
                    // Non-fab variant in the fab slot: anchor at bottom-center
                    // of the canvas (canvas body layout convention).
                    if (fabId != null) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(bottom = dims.spacingM),
                            contentAlignment = Alignment.BottomCenter,
                        ) {
                            RenderNode(
                                fabId,
                                components,
                                data,
                                surfaceId,
                                itemScope,
                                itemScopePath,
                                dispatch,
                                parent = RenderParent(kind = "Scaffold", slotName = "fab"),
                            )
                        }
                    }
                }
            }
        }
        BodyKind.BODY_KIND_LIST, BodyKind.BODY_KIND_UNSPECIFIED -> {
            // TransformingLazyColumn scales edge items and supports rotary input.
            // Its state is consumed by ScreenScaffold for the chin-aware ScrollIndicator.
            val listState = rememberTransformingLazyColumnState()

            val bodyDef = if (bodyId != null) components[bodyId] else null
            val bodyChildIds: List<String> = if (bodyDef != null) {
                when {
                    bodyDef.column != null -> bodyDef.column.children
                    bodyDef.list != null -> listOf(bodyId!!)
                    bodyDef.box != null -> bodyDef.box.children
                    else -> listOf(bodyId!!)
                }
            } else {
                emptyList()
            }
            // Honor `horizontal_alignment` from the body Column on TLC's cross-axis.
            // Default → CenterHorizontally: round watches suit centred content.
            val bodyHorizontalAlignment =
                if (bodyDef?.column?.horizontal_alignment != null) {
                    mapHorizontalAlignment(bodyDef.column.horizontal_alignment)
                } else {
                    Alignment.CenterHorizontally
                }

            // Two call sites: ScreenScaffold's edgeButton slot is mandatory in the
            // overload that accepts it — there's no way to pass null to opt out.
            if (fabId != null && isFabButton) {
                ScreenScaffold(
                    scrollState = listState,
                    edgeButton = {
                        ScaffoldFabEdgeButton(fabComponent, data, itemScope, dispatch)
                    },
                    modifier = Modifier.fillMaxSize(),
                ) { contentPadding ->
                    ListBody(
                        listState, topBarId, bodyChildIds,
                        // edgeButton owns the fab; do NOT also render it as a list item.
                        fabIdAsListItem = null,
                        components, data, surfaceId, itemScope, itemScopePath, dispatch,
                        contentPadding,
                        bodyHorizontalAlignment = bodyHorizontalAlignment,
                    )
                }
            } else {
                ScreenScaffold(
                    scrollState = listState,
                    modifier = Modifier.fillMaxSize(),
                ) { contentPadding ->
                    ListBody(
                        listState, topBarId, bodyChildIds,
                        // Non-fab variant in the slot: render as a trailing
                        // list item so we don't drop user-authored buttons.
                        fabIdAsListItem = fabId,
                        components, data, surfaceId, itemScope, itemScopePath, dispatch,
                        contentPadding,
                        bodyHorizontalAlignment = bodyHorizontalAlignment,
                    )
                }
            }
        }
    }
}

@Composable
private fun CanvasBody(
    bodyId: String?,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    contentPadding: androidx.compose.foundation.layout.PaddingValues,
) {
    val dims = LocalDimensions.current
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .padding(horizontal = dims.bodyHorizontalPadding),
        contentAlignment = Alignment.Center,
    ) {
        if (bodyId != null) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                RenderNode(
                    bodyId,
                    components,
                    data,
                    surfaceId,
                    itemScope,
                    itemScopePath,
                    dispatch,
                    parent = RenderParent(kind = "Scaffold", slotName = "body"),
                )
            }
        }
    }
}

@Composable
private fun ListBody(
    listState: androidx.wear.compose.foundation.lazy.TransformingLazyColumnState,
    topBarId: String?,
    bodyChildIds: List<String>,
    fabIdAsListItem: String?,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    contentPadding: androidx.compose.foundation.layout.PaddingValues,
    bodyHorizontalAlignment: Alignment.Horizontal = Alignment.Start,
) {
    val dims = LocalDimensions.current
    TransformingLazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = dims.bodyHorizontalPadding),
        contentPadding = contentPadding,
        verticalArrangement = Arrangement.spacedBy(dims.spacingS),
        horizontalAlignment = bodyHorizontalAlignment,
    ) {
        if (topBarId != null) {
            item {
                RenderNode(
                    topBarId,
                    components,
                    data,
                    surfaceId,
                    itemScope,
                    itemScopePath,
                    dispatch,
                    parent = RenderParent(kind = "Scaffold", slotName = "topBar"),
                )
            }
        }
        bodyChildIds.forEachIndexed { index, childId ->
            item(key = "body-$index-$childId") {
                RenderNode(
                    childId,
                    components,
                    data,
                    surfaceId,
                    itemScope,
                    itemScopePath,
                    dispatch,
                    parent = RenderParent(kind = "Scaffold", slotName = "body", slotIndex = index),
                )
            }
        }
        if (fabIdAsListItem != null) {
            item(key = "fab") {
                RenderNode(
                    fabIdAsListItem,
                    components,
                    data,
                    surfaceId,
                    itemScope,
                    itemScopePath,
                    dispatch,
                    parent = RenderParent(kind = "Scaffold", slotName = "fab"),
                )
            }
        }
    }
}

/**
 * Render a `button(variant='fab')` payload inside ScreenScaffold's edgeButton
 * slot. The slot lambda receives a `BoxScope`; EdgeButton's own content lambda
 * is `RowScope`, so we lay icon + label inline.
 */
@Composable
private fun ScaffoldFabEdgeButton(
    fab: com.moumantai.protocol.v1.FabComponent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val iconName = resolveDynamic(fab.icon, data, itemScope)
    val label = resolveDynamic(fab.label, data, itemScope)
    val dims = LocalDimensions.current
    EdgeButton(
        onClick = { dispatch(fab.action, itemScope) },
        buttonSize = EdgeButtonSize.Medium,
    ) {
        if (iconName != null) {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = iconName,
                modifier = Modifier.size(dims.iconSize),
            )
            if (!label.isNullOrBlank()) {
                Spacer(modifier = Modifier.size(dims.spacingS))
                Text(text = label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        } else if (!label.isNullOrBlank()) {
            Text(text = label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// =============================================================================
// 2. TopBarRenderer
// =============================================================================
//
// Wear M3 has no pinned top app bar. TopBar renders inline as a ListHeader at
// the start of the LIST body so the title scrolls with content. CANVAS bodies
// skip TopBar. Actions stack in a Column so chips wrap on a round screen.

@Composable
fun TopBarRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: TopBarComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val title = resolveDynamic(c.title, data, itemScope) ?: ""
    val actionIds = c.actions
    val dims = LocalDimensions.current

    ListHeader(
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "TopBar", null),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (actionIds.isNotEmpty()) {
                Spacer(modifier = Modifier.height(dims.spacingXs))
                Row(
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    actionIds.forEachIndexed { index, actionId ->
                        RenderNode(
                            actionId,
                            components,
                            data,
                            surfaceId,
                            itemScope,
                            itemScopePath,
                            dispatch,
                            parent = RenderParent(kind = "TopBar", slotIndex = index),
                        )
                    }
                }
            }
        }
    }
}

// =============================================================================
// 3. ListItemRenderer — M3 FilledTonalButton (label + secondaryLabel + icon)
// =============================================================================
//
// M3 Wear's idiom for "tappable list row with title, subtitle, icon".
// TitleCard is the alternative for a card-like row; FilledTonalButton is tighter.

@Composable
fun ListItemRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ListItemComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    itemScope: Map<String, Any?>?,
    @Suppress("UNUSED_PARAMETER") itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val headline = resolveDynamic(c.headline, data, itemScope) ?: ""
    val supporting = resolveDynamic(c.supporting, data, itemScope)
    val leadingIconName = resolveDynamic(c.leading_icon, data, itemScope)
    val iconSize = LocalDimensions.current.iconSize

    FilledTonalButton(
        onClick = { dispatch(c.action, itemScope) },
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "ListItem", null),
        label = {
            Text(
                text = headline,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        secondaryLabel = if (supporting != null) {
            {
                Text(
                    text = supporting,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        } else {
            null
        },
        icon = if (leadingIconName != null) {
            {
                Icon(
                    imageVector = lookupMaterialIcon(leadingIconName),
                    contentDescription = leadingIconName,
                    modifier = Modifier.size(iconSize),
                )
            }
        } else {
            null
        },
    )
}

// =============================================================================
// 4. ChipRenderer
// =============================================================================
//
// M3 Wear has no `Chip` primitive. Chips map onto Button variants:
//   - selected filter chip → filled Button (primary accent)
//   - unselected / assist → FilledTonalButton
//
// A chip with `selected:` bound renders as filled when selected, tonal otherwise.

@Composable
fun ChipRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ChipComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = resolveDynamic(c.label, data, itemScope) ?: ""
    val selected = resolveDynamic(c.selected, data, itemScope)
    val iconName = resolveDynamic(c.icon, data, itemScope)
    val iconSize = LocalDimensions.current.iconSize

    val onClick: () -> Unit = { dispatch(c.action, itemScope) }
    // Presence of a `selected:` binding implies bistate (filter chip).
    val isFilter = c.selected != null

    val iconSlot: (@Composable androidx.compose.foundation.layout.BoxScope.() -> Unit)? = if (iconName != null) {
        {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = iconName,
                modifier = Modifier.size(iconSize),
            )
        }
    } else {
        null
    }

    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Chip", childVariant = null)
    val labelSlot: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
        Text(
            text = label,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }

    if (isFilter && selected) {
        // Selected filter chip: filled Button (primary accent).
        M3Button(
            onClick = onClick,
            modifier = modifier,
            label = labelSlot,
            icon = iconSlot,
        )
    } else {
        // Unselected filter, assist, or suggestion chip: tonal pill.
        FilledTonalButton(
            onClick = onClick,
            modifier = modifier,
            label = labelSlot,
            icon = iconSlot,
        )
    }
}

// =============================================================================
// 5. SwitchRenderer — M3 SwitchButton
// =============================================================================

@Composable
fun SwitchRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: SwitchComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = resolveDynamic(c.label, data, itemScope) ?: ""
    val checked = resolveDynamic(c.checked, data, itemScope)

    SwitchButton(
        checked = checked,
        onCheckedChange = { dispatch(c.action, itemScope) },
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Switch", null),
        label = {
            Text(
                text = label,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        },
    )
}
