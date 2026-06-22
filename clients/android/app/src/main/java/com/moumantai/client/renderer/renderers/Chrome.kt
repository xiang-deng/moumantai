package com.moumantai.client.renderer.renderers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.moumantai.client.renderer.LocalScaffoldBodyScope
import com.moumantai.client.renderer.RenderNode
import com.moumantai.client.renderer.RenderParent
import com.moumantai.client.renderer.defaultGroupSpacing
import com.moumantai.client.renderer.isCompactWidth
import com.moumantai.client.renderer.lookupMaterialIcon
import com.moumantai.client.renderer.mapHorizontalAlignment
import com.moumantai.client.renderer.resolveDynamic
import com.moumantai.client.theme.LocalDimensions
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.BodyKind
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.ScaffoldComponent
import com.moumantai.protocol.v1.TopBarComponent

// ---------------------------------------------------------------------------
// Scaffold — per-face chrome.
//
// Window-insets: the outer AppPager Scaffold owns insets; we pass
// contentWindowInsets = WindowInsets(0) to avoid double-padding.
// Top-bar and FAB slots are unpadded; body gets SizeClass-adaptive horizontal
// padding from MoumantaiDimensions.spacingM.
//
// Body scrolling is gated by `body_kind`:
//   - BODY_KIND_LIST (default / UNSPECIFIED): M3 LazyColumn. If the body is a
//     Column, its children are folded in as individual items (LazyColumn IS
//     the column). Any other component renders as a single item.
//   - BODY_KIND_CANVAS: centered Box > Column, no scroll. For glance faces.
//
// LocalScaffoldBodyScope propagates so a body Column can apply body-relative
// alignment defaults (a distinct concern from catalog-driven sizing).
// ---------------------------------------------------------------------------

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
    val topBarId = c.top_bar
    val bodyId = c.body
    val fabId = c.fab
    val compact = isCompactWidth()
    // Null / UNSPECIFIED fall through to LIST; CANVAS is the only diverging branch.
    val bodyKind = c.body_kind ?: BodyKind.BODY_KIND_LIST

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        containerColor = MaterialTheme.colorScheme.surface,
        topBar = {
            // Suppress TopBars on compact screens to preserve the 240×240 vertical budget.
            if (topBarId != null && !compact) {
                RenderNode(
                    componentId = topBarId,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                    parent = RenderParent(kind = "Scaffold", slotName = "top_bar"),
                )
            }
        },
        floatingActionButton = {
            if (fabId != null) {
                RenderNode(
                    componentId = fabId,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                    parent = RenderParent(kind = "Scaffold", slotName = "fab"),
                )
            }
        },
    ) { paddingValues ->
        if (bodyId == null) return@Scaffold

        // Body slot: consume insets + apply SizeClass-adaptive horizontal padding.
        val bodyModifier = Modifier
            .fillMaxSize()
            .padding(paddingValues)
            .consumeWindowInsets(paddingValues)

        CompositionLocalProvider(LocalScaffoldBodyScope provides true) {
            when (bodyKind) {
                BodyKind.BODY_KIND_CANVAS -> ScaffoldBodyCanvas(
                    bodyModifier = bodyModifier,
                    bodyId = bodyId,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                )
                // BODY_KIND_UNSPECIFIED + BODY_KIND_LIST both render as LIST.
                else -> ScaffoldBodyList(
                    bodyModifier = bodyModifier,
                    bodyId = bodyId,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Body: LIST — LazyColumn. If the body is a Column, fold its children in as
// individual items so the LazyColumn IS the column. Otherwise a single item.
// Vertical spacing mirrors defaultGroupSpacing for visual consistency.
// ---------------------------------------------------------------------------

@Composable
private fun ScaffoldBodyList(
    bodyModifier: Modifier,
    bodyId: String,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val bodyDef = components[bodyId]
    val bodyColumn = bodyDef?.column
    val spacing = defaultGroupSpacing()
    val bodyInset = LocalDimensions.current.spacingM
    // Default horizontal alignment is CenterHorizontally — centered bodies
    // look right for the mix of hero rings, chips, forms, and full-width cards
    // typical in SDUI faces. Cards/Lists still fill cross-axis via the catalog;
    // only wrap-shaped children shift visually. Authors can override via
    // `horizontal_alignment` on the body Column.
    val bodyHorizontalAlignment =
        if (bodyColumn?.horizontal_alignment != null) {
            mapHorizontalAlignment(bodyColumn.horizontal_alignment)
        } else {
            Alignment.CenterHorizontally
        }

    LazyColumn(
        modifier = bodyModifier,
        contentPadding = PaddingValues(horizontal = bodyInset),
        verticalArrangement = Arrangement.spacedBy(spacing),
        horizontalAlignment = bodyHorizontalAlignment,
    ) {
        if (bodyColumn != null) {
            // Fold Column children directly — LazyColumn IS the column.
            val children = bodyColumn.children
            children.forEachIndexed { index, childId ->
                item(key = childId) {
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
            }
        } else {
            // Body is a non-Column component (rare); render as a single item.
            item(key = bodyId) {
                RenderNode(
                    componentId = bodyId,
                    components = components,
                    data = data,
                    surfaceId = surfaceId,
                    itemScope = itemScope,
                    itemScopePath = itemScopePath,
                    dispatch = dispatch,
                    parent = RenderParent(kind = "Scaffold", slotName = "body"),
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Body: CANVAS — centered Box > Column, no scroll. For glance faces (single hero).
// ---------------------------------------------------------------------------

@Composable
private fun ScaffoldBodyCanvas(
    bodyModifier: Modifier,
    bodyId: String,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    Box(
        modifier = bodyModifier.padding(horizontal = LocalDimensions.current.spacingM),
        contentAlignment = Alignment.Center,
    ) {
        val bodyDef = components[bodyId]
        val bodyColumn = bodyDef?.column

        if (bodyColumn != null) {
            // Same Column-fold rule as LIST.
            Column(
                verticalArrangement = Arrangement.spacedBy(defaultGroupSpacing()),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                bodyColumn.children.forEachIndexed { index, childId ->
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
            }
        } else {
            RenderNode(
                componentId = bodyId,
                components = components,
                data = data,
                surfaceId = surfaceId,
                itemScope = itemScope,
                itemScopePath = itemScopePath,
                dispatch = dispatch,
                parent = RenderParent(kind = "Scaffold", slotName = "body"),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// TopBar — TopAppBar on phone; CenterAlignedTopAppBar on compact.
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TopBarRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: TopBarComponent,
    @Suppress("UNUSED_PARAMETER") parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val title = resolveDynamic(c.title, data, itemScope) ?: ""
    val hasNavAction = c.navigation_action != null
    val navIconName = "arrow_back"
    val actionIds = c.actions
    val compact = isCompactWidth()

    val titleContent: @Composable () -> Unit = {
        Text(
            text = title,
            style = if (compact) {
                MaterialTheme.typography.titleMedium
            } else {
                MaterialTheme.typography.titleLarge
            },
            maxLines = 1,
        )
    }

    val navIcon: @Composable () -> Unit = {
        if (hasNavAction) {
            IconButton(onClick = {
                dispatch(c.navigation_action, itemScope)
            }) {
                Icon(
                    imageVector = lookupMaterialIcon(navIconName),
                    contentDescription = navIconName,
                )
            }
        }
    }

    val actions: @Composable () -> Unit = {
        actionIds.forEachIndexed { index, actionId ->
            RenderNode(
                componentId = actionId,
                components = components,
                data = data,
                surfaceId = surfaceId,
                itemScope = itemScope,
                itemScopePath = itemScopePath,
                dispatch = dispatch,
                parent = RenderParent(kind = "TopBar", slotIndex = index),
            )
        }
    }

    val colors = TopAppBarDefaults.topAppBarColors(
        containerColor = MaterialTheme.colorScheme.surface,
        titleContentColor = MaterialTheme.colorScheme.onSurface,
        navigationIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        actionIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    if (compact) {
        CenterAlignedTopAppBar(
            title = titleContent,
            navigationIcon = navIcon,
            actions = { actions() },
            colors = colors,
        )
    } else {
        TopAppBar(
            title = titleContent,
            navigationIcon = navIcon,
            actions = { actions() },
            colors = colors,
        )
    }
}
