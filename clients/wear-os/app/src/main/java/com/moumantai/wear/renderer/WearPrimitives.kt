package com.moumantai.wear.renderer

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.CardDefaults
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.IconButton
import androidx.wear.compose.material3.LinearProgressIndicator
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.OutlinedButton
import androidx.wear.compose.material3.OutlinedCard
import androidx.wear.compose.material3.Slider
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TextButton
import coil.compose.AsyncImage
import com.moumantai.protocol.designsystem.DesignSystem
import com.moumantai.protocol.designsystem.Layout
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.BoxComponent
import com.moumantai.protocol.v1.ButtonComponent
import com.moumantai.protocol.v1.CardComponent
import com.moumantai.protocol.v1.CheckBoxComponent
import com.moumantai.protocol.v1.ColumnComponent
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.DateTimeInputComponent
import com.moumantai.protocol.v1.DividerComponent
import com.moumantai.protocol.v1.IconComponent
import com.moumantai.protocol.v1.ImageComponent
import com.moumantai.protocol.v1.ListComponent
import com.moumantai.protocol.v1.ModalComponent
import com.moumantai.protocol.v1.RowComponent
import com.moumantai.protocol.v1.SelectComponent
import com.moumantai.protocol.v1.SliderComponent
import com.moumantai.protocol.v1.TabsComponent
import com.moumantai.protocol.v1.TextComponent
import com.moumantai.protocol.v1.TextFieldComponent
import com.moumantai.wear.theme.LocalDimensions
import com.moumantai.wear.theme.WearDimensions
import androidx.wear.compose.material3.Button as M3Button

/**
 * Map a catalog spacing-token name ("spacing.s", "spacing.none", ...) to a
 * Dp value resolved against the current [WearDimensions]. "spacing.none" is
 * the literal-0 sentinel; unknown names also fall back to 0 (defensive).
 */
private fun resolveWearSpacingToken(token: String?, dim: WearDimensions): Dp = when (token) {
    null -> 0.dp
    "spacing.none" -> 0.dp
    "spacing.xs" -> dim.spacingXs
    "spacing.s" -> dim.spacingS
    "spacing.m" -> dim.spacingM
    "spacing.l" -> dim.spacingL
    "spacing.xl" -> dim.spacingXl
    else -> 0.dp
}

// =============================================================================
// 1. TextRenderer
// =============================================================================

@Composable
fun TextRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: TextComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val text = resolveDynamic(c.text, data, itemScope) ?: ""
    val style = mapTypography(c.typography)
    val fontWeight = mapFontWeight(c.font_weight)
    val textAlign = mapTextAlign(c.text_align)
    val color = resolveThemeColor(c.color) ?: MaterialTheme.colorScheme.onSurface

    Text(
        text = text,
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Text", null),
        style = if (fontWeight != null) style.copy(fontWeight = fontWeight) else style,
        textAlign = textAlign,
        overflow = TextOverflow.Ellipsis,
        color = color,
    )
}

// =============================================================================
// 2. IconRenderer
// =============================================================================

@Composable
fun IconRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: IconComponent,
    @Suppress("UNUSED_PARAMETER") parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val name = resolveDynamic(c.name, data, itemScope) ?: return
    // Wire `c.size` is an explicit dp from the server; fallback is the
    // theme's compact iconSizeSmall (16dp on compact, see CompactTokens).
    val sizeDp = c.size?.dp ?: LocalDimensions.current.iconSizeSmall
    val tintName = resolveDynamic(c.color, data, itemScope)
    val color = resolveThemeColor(tintName) ?: MaterialTheme.colorScheme.onSurface

    var modifier: Modifier = resolveModifier(c.modifier, data, itemScope).size(sizeDp)
    if (c.action != null) {
        modifier = modifier.clickable { dispatch(c.action, itemScope) }
    }

    Icon(
        imageVector = lookupMaterialIcon(name),
        contentDescription = name,
        modifier = modifier,
        tint = color,
    )
}

// =============================================================================
// 3. ImageRenderer
// =============================================================================

@Composable
fun ImageRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ImageComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val src = resolveDynamic(c.src, data, itemScope) ?: return
    val alt = c.alt ?: ""
    val fit = DesignSystem.Image.resolve(c.fit)

    val contentScale = when (fit) {
        "crop" -> ContentScale.Crop
        "fill" -> ContentScale.FillBounds
        "fillWidth" -> ContentScale.FillWidth
        "fillHeight" -> ContentScale.FillHeight
        "none" -> ContentScale.None
        else -> ContentScale.Fit // canonical "contain"
    }

    AsyncImage(
        model = src,
        contentDescription = alt,
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Image", null),
        contentScale = contentScale,
    )
}

// =============================================================================
// 4. DividerRenderer
// =============================================================================

@Composable
fun DividerRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: DividerComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val thickness = c.thickness ?: 1
    val color = resolveThemeColor(c.color) ?: MaterialTheme.colorScheme.outlineVariant

    Box(
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Divider", null)
            .height(thickness.dp)
            .background(color),
    )
}

// =============================================================================
// 5. RowRenderer
// =============================================================================

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
    val spacing = c.spacing ?: 0
    val horizontalArrangement = mapHorizontalArrangement(c.horizontal_arrangement, spacing)
    val verticalAlignment = mapVerticalAlignment(c.vertical_alignment)
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Row", null)

    Row(
        modifier = modifier,
        horizontalArrangement = horizontalArrangement,
        verticalAlignment = verticalAlignment,
    ) {
        c.children.forEachIndexed { index, childId ->
            RenderNode(
                childId,
                components,
                data,
                surfaceId,
                itemScope,
                itemScopePath,
                dispatch,
                parent = RenderParent(kind = "Row", slotIndex = index),
            )
        }
    }
}

// =============================================================================
// 6. ColumnRenderer
// =============================================================================
//
// Scrolling is owned by ScaffoldRenderer's TransformingLazyColumn (LIST) or
// the bounded Box+Column (CANVAS); ColumnRenderer is a plain layout container.

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
    val spacing = c.spacing ?: 0
    val childIds = c.children

    val verticalArrangement = mapVerticalArrangement(c.vertical_arrangement, spacing)
    val horizontalAlignment = mapHorizontalAlignment(c.horizontal_alignment)

    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Column", null)

    Column(
        modifier = modifier,
        verticalArrangement = verticalArrangement,
        horizontalAlignment = horizontalAlignment,
    ) {
        childIds.forEachIndexed { index, childId ->
            RenderNode(
                childId,
                components,
                data,
                surfaceId,
                itemScope,
                itemScopePath,
                dispatch,
                parent = RenderParent(kind = "Column", slotIndex = index),
            )
        }
    }
}

// =============================================================================
// 6b. BoxRenderer — z-stack overlay container
// =============================================================================

/**
 * Z-stack overlay container. Children are layered along the z-axis (later
 * children paint on top), each anchored to a position within the box's
 * bounds via either a per-child override or the box's `contentAlignment`.
 *
 * Alignment vocabulary matches the design-system catalog
 * (`alignments.values`): the 9 corner/edge/center positions. Unknown strings
 * fall back to `topStart` (the catalog default).
 */
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
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Box", null)
    val contentAlignment = parseBoxAlignment(c.content_alignment ?: "topStart")
    val childIds = c.children
    val childAlignments = c.child_alignment

    Box(
        modifier = modifier,
        contentAlignment = contentAlignment,
    ) {
        for (i in childIds.indices) {
            val childId = childIds[i]
            val childParent = RenderParent(kind = "Box", slotIndex = i)
            val override = childAlignments.getOrNull(i)?.takeIf { it.isNotEmpty() }
            if (override != null) {
                Box(modifier = Modifier.align(parseBoxAlignment(override))) {
                    RenderNode(
                        childId,
                        components,
                        data,
                        surfaceId,
                        itemScope,
                        itemScopePath,
                        dispatch,
                        parent = childParent,
                    )
                }
            } else {
                RenderNode(
                    childId,
                    components,
                    data,
                    surfaceId,
                    itemScope,
                    itemScopePath,
                    dispatch,
                    parent = childParent,
                )
            }
        }
    }
}

/**
 * Map a design-system alignment string to a Compose [Alignment] (9-value catalog
 * vocabulary). Unknown strings fall back to `Alignment.TopStart` (never throws).
 * Internal so tests can pin the parse table.
 */
internal fun parseBoxAlignment(name: String): Alignment = when (name) {
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

// =============================================================================
// 7. ButtonRenderer
// =============================================================================
//
// M3 Wear Button variants keyed by design-system `spec.kind` + `spec.accent`:
//   Button (filled) · FilledTonalButton · OutlinedButton · TextButton · IconButton
//
// Icon-only buttons → IconButton (round, fixed touch target). Wear has no
// standalone FAB primitive; bottom-edge primary actions use EdgeButton via
// ScaffoldRenderer, not the Button renderer.

@Composable
fun ButtonRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ButtonComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val text = resolveDynamic(c.text, data, itemScope)
    val spec = com.moumantai.protocol.designsystem.DesignSystemTreatments.resolveButton(c.emphasis, c.tone)
    val enabled = resolveDynamic(c.enabled, data, itemScope, default = true)
    val iconName = resolveDynamic(c.icon, data, itemScope)
    val dims = LocalDimensions.current

    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Button", childVariant = null)
    val onClick: () -> Unit = { dispatch(c.action, itemScope) }

    // Icon-only button → round IconButton (fixed touch target).
    if (text.isNullOrBlank() && iconName != null) {
        IconButton(
            onClick = onClick,
            modifier = modifier.size(dims.minTouchTarget),
            enabled = enabled,
        ) {
            if (iconName != null) {
                Icon(
                    imageVector = lookupMaterialIcon(iconName),
                    contentDescription = iconName,
                    modifier = Modifier.size(dims.iconSize),
                )
            } else if (!text.isNullOrBlank()) {
                Text(text = text)
            }
        }
        return
    }

    val label = text ?: ""
    val iconSlot: (@Composable androidx.compose.foundation.layout.BoxScope.() -> Unit)? = if (iconName != null) {
        {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = iconName,
                modifier = Modifier.size(dims.iconSize),
            )
        }
    } else {
        null
    }

    when (spec.kind) {
        "outlined_container" -> OutlinedButton(
            onClick = onClick,
            label = { Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            icon = iconSlot,
            modifier = modifier,
            enabled = enabled,
        )
        "transparent" -> TextButton(
            onClick = onClick,
            modifier = modifier,
            enabled = enabled,
        ) {
            Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        "filled_container" -> if (spec.accent == "secondary") {
            FilledTonalButton(
                onClick = onClick,
                label = { Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                icon = iconSlot,
                modifier = modifier,
                enabled = enabled,
            )
        } else {
            M3Button(
                onClick = onClick,
                label = { Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                icon = iconSlot,
                modifier = modifier,
                enabled = enabled,
            )
        }
        else -> M3Button(
            onClick = onClick,
            label = { Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            icon = iconSlot,
            modifier = modifier,
            enabled = enabled,
        )
    }
}

/**
 * Resolve a Card `accent` to a container background color via M3's
 * `*Container` roles. Internal so tests can pin the routing without a Composable.
 */
internal fun resolveCardAccentColor(
    accent: String,
    primary: Color,
    secondary: Color,
    error: Color,
    surface: Color,
): Color = when (accent) {
    "primary" -> primary
    "secondary" -> secondary.copy(alpha = 0.18f).compositeOver(surface)
    "error" -> error.copy(alpha = 0.15f).compositeOver(surface)
    else -> surface // neutral
}

// =============================================================================
// 8. CardRenderer
// =============================================================================

/**
 * `kind` selects the M3 Card primitive; `accent` picks the container color:
 * - filled_container → Card with `cardColors(containerColor = accent)`
 * - elevated_container → default Card (Wear M3 has no ElevatedCard; surface tint conveys elevation)
 * - outlined_container → OutlinedCard
 */
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
    val onClick: () -> Unit = {
        if (c.action != null) {
            dispatch(c.action, itemScope)
        }
    }

    val spec = com.moumantai.protocol.designsystem.DesignSystemTreatments.resolveCard(c.emphasis, c.tone)
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Card", childVariant = null)
    val childIds = c.children

    val scheme = MaterialTheme.colorScheme
    val accentColor: Color = resolveCardAccentColor(
        accent = spec.accent,
        primary = scheme.primary,
        secondary = scheme.secondary,
        error = scheme.error,
        surface = scheme.surfaceContainer,
    )

    val content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit = {
        childIds.forEachIndexed { index, childId ->
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

    when (spec.kind) {
        "outlined_container" -> OutlinedCard(
            onClick = onClick,
            modifier = modifier,
            content = content,
        )
        "filled_container" -> Card(
            onClick = onClick,
            modifier = modifier,
            colors = CardDefaults.cardColors(containerColor = accentColor),
            content = content,
        )
        else -> {
            Card(
                onClick = onClick,
                modifier = modifier,
                content = content,
            )
        }
    }
}

// =============================================================================
// 9. ListRenderer — plain Column (mirrors the phone renderer).
//
// ScaffoldRenderer's TLC owns lazy scroll; ListRenderer emits a Column whose
// children land as inline rows inside their parent TLC item. Plugin-app lists
// are small enough that virtualization is unnecessary.
// =============================================================================

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
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "List", null)

    val fullPath = if (descriptor.path.startsWith("/")) {
        descriptor.path
    } else if (itemScopePath != null) {
        "$itemScopePath/${descriptor.path}"
    } else {
        "/${descriptor.path}"
    }
    val dataItems = (resolveAbsolutePath(fullPath, data) as? List<*>).orEmpty()
    if (dataItems.isEmpty()) return

    val dim = LocalDimensions.current
    // Gap from the catalog (containers.List.child_gaps): spacing.s (4dp) for
    // most children; spacing.none for ListItem rows (M3 watch divider pattern).
    val templateKind = components[descriptor.component_id]?.componentKind() ?: "default"
    val gapToken = Layout.containerChildGap("List", templateKind)
    val gap = resolveWearSpacingToken(gapToken, dim)
    // Outer breathing room stays at spacing.s regardless of inter-child gap.
    val outerPad = dim.spacingS
    Column(
        modifier = modifier.padding(top = outerPad, bottom = outerPad),
        verticalArrangement = Arrangement.spacedBy(gap),
    ) {
        dataItems.forEachIndexed { index, item ->
            @Suppress("UNCHECKED_CAST")
            val scope = (item as? Map<String, Any?>) ?: mapOf("value" to item)
            RenderNode(
                componentId = descriptor.component_id,
                components = components,
                data = data,
                surfaceId = surfaceId,
                itemScope = scope,
                itemScopePath = "$fullPath/$index",
                dispatch = dispatch,
                parent = RenderParent(kind = "List", slotIndex = index),
            )
        }
    }
}

// =============================================================================
// 10. CheckBoxRenderer — rendered as M3 SwitchButton.
//
// Wear Compose M3 1.6.x stable has no `CheckboxButton`; SwitchButton's
// on/off affordance fits the small round screen. Upgrade to CheckboxButton
// once it's stable on the pinned channel.
// =============================================================================

@Composable
fun CheckBoxRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: CheckBoxComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = resolveDynamic(c.label, data, itemScope) ?: ""
    val checked = resolveDynamic(c.checked, data, itemScope)
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "CheckBox", null)

    androidx.wear.compose.material3.SwitchButton(
        checked = checked,
        onCheckedChange = { dispatch(c.action, itemScope) },
        label = { Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        modifier = modifier,
    )
}

// =============================================================================
// 11. TextFieldRenderer — M3 Wear has no inline text field.
//
// Rendered as a tappable FilledTonalButton for visual parity with the rest of
// the action surface. TextFieldComponent has no action field; tap is a no-op.
// RemoteInput is handled by WearChatScreen, not here.
// =============================================================================

@Composable
fun TextFieldRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: TextFieldComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    @Suppress("UNUSED_PARAMETER") dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = c.label ?: "Input"
    val value = resolveDynamic(c.value_, data, itemScope) ?: ""
    val placeholder = c.placeholder ?: ""
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "TextField", null)

    val displayText = value.ifEmpty { placeholder }
    val textColor = if (value.isEmpty()) {
        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
    } else {
        MaterialTheme.colorScheme.onSurface
    }

    FilledTonalButton(
        onClick = { },
        modifier = modifier,
        label = {
            Text(
                text = displayText,
                color = textColor,
                maxLines = if (c.multiline == true) Int.MAX_VALUE else 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        secondaryLabel = { Text(label, style = MaterialTheme.typography.labelSmall) },
    )
}

// =============================================================================
// 12. SliderRenderer — M3 Wear InlineSlider
// =============================================================================

@Composable
fun SliderRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: SliderComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val value = resolveDynamic(c.value_, data, itemScope).toFloat()
    val min = (c.min ?: 0.0).toFloat()
    val max = (c.max ?: 100.0).toFloat()
    val steps = (c.step ?: 1.0).toInt()
    val label = c.label
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Slider", null)

    val range = max - min
    val segmentCount = if (steps > 0 && range > 0) {
        ((range / steps).toInt() - 1).coerceAtLeast(0)
    } else {
        0
    }

    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (label != null) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(LocalDimensions.current.spacingXs))
        }

        Slider(
            value = value,
            onValueChange = { dispatch(c.action, itemScope) },
            steps = segmentCount,
            valueRange = min..max,
            decreaseIcon = { Text("−") },
            increaseIcon = { Text("+") },
        )
    }
}

// =============================================================================
// 13. TabsRenderer — show only the active tab's content on Wear.
// =============================================================================

@Composable
fun TabsRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: TabsComponent,
    parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val tabContentIds = c.tab_content
    val selected = resolveDynamic(c.selected, data, itemScope)
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Tabs", null)

    Column(modifier = modifier) {
        if (selected in tabContentIds.indices) {
            RenderNode(
                tabContentIds[selected],
                components,
                data,
                surfaceId,
                itemScope,
                itemScopePath,
                dispatch,
                parent = RenderParent(kind = "Tabs", slotIndex = selected),
            )
        }
    }
}

// =============================================================================
// 14. ModalRenderer — full-screen Box overlay.
//
// Wear M3 has no AlertDialog primitive suitable for arbitrary face trees;
// a simple fillMaxSize Box overlay is used for v1.
// =============================================================================

@Composable
fun ModalRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ModalComponent,
    @Suppress("UNUSED_PARAMETER") parent: RenderParent,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val open = resolveDynamic(c.open_, data, itemScope)
    val childIds = c.children

    if (!open) return

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .clickable { dispatch(c.action, itemScope) },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(LocalDimensions.current.spacingM),
        ) {
            childIds.forEachIndexed { index, childId ->
                RenderNode(
                    childId,
                    components,
                    data,
                    surfaceId,
                    itemScope,
                    itemScopePath,
                    dispatch,
                    parent = RenderParent(kind = "Modal", slotIndex = index),
                )
            }
        }
    }
}

// =============================================================================
// 15. SelectRenderer — tappable button showing current value.
// =============================================================================

@Composable
fun SelectRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: SelectComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val value = resolveDynamic(c.value_, data, itemScope) ?: ""
    val label = c.label ?: ""

    val options: List<Pair<String, String>> = run {
        val opts = c.options ?: return@run emptyList()
        opts.literal?.options?.map { it.label to it.value_ }
            ?: opts.path?.let { p -> resolveAbsolutePath(p, data) as? List<*> }?.mapNotNull { item ->
                when (item) {
                    is Map<*, *> -> {
                        val optLabel = item["label"]?.toString() ?: return@mapNotNull null
                        val optValue = item["value"]?.toString() ?: optLabel
                        optLabel to optValue
                    }
                    else -> null
                }
            }
            ?: emptyList()
    }
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Select", null)

    val displayText = options.firstOrNull { it.second == value }?.first ?: value.ifEmpty { label }

    FilledTonalButton(
        onClick = { dispatch(c.action, itemScope) },
        modifier = modifier,
        label = { Text(text = displayText, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        secondaryLabel = { Text(label, style = MaterialTheme.typography.labelSmall) },
    )
}

// =============================================================================
// 16. DateTimeInputRenderer — tappable button.
// =============================================================================

@Composable
fun DateTimeInputRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: DateTimeInputComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val value = resolveDynamic(c.value_, data, itemScope) ?: ""
    val label = c.label ?: ""
    val mode = c.mode ?: "date"
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "DateTimeInput", null)

    val placeholder = when (mode) {
        "time" -> "HH:MM"
        "datetime" -> "Date & Time"
        else -> "YYYY-MM-DD"
    }
    val displayText = value.ifEmpty { placeholder }

    FilledTonalButton(
        onClick = { dispatch(c.action, itemScope) },
        modifier = modifier,
        label = { Text(text = displayText, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        secondaryLabel = { Text(label, style = MaterialTheme.typography.labelSmall) },
    )
}

// =============================================================================
// 17. ProgressRingRenderer + ProgressBarRenderer (Wear M3)
// =============================================================================

/** Wear M3 `CircularProgressIndicator` with centred label/sublabel. Defaults to 80dp. */
@Composable
fun ProgressRingRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: com.moumantai.protocol.v1.ProgressRingComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val value = resolveDynamic(c.value_, data, itemScope).toFloat()
    val max = (c.max ?: 100.0).toFloat()
    val label = resolveDynamic(c.label, data, itemScope)
    val sublabel = resolveDynamic(c.sublabel, data, itemScope)
    val sizeDp = c.size ?: 0

    val progress = if (max > 0f) (value / max).coerceIn(0f, 1f) else 0f
    val dims = LocalDimensions.current

    val baseModifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "ProgressRing",
        null,
    )

    val ringSize = if (sizeDp > 0) sizeDp.dp else 80.dp
    Box(
        modifier = baseModifier.size(ringSize),
        contentAlignment = Alignment.Center,
    ) {
        androidx.wear.compose.material3.CircularProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxSize(),
            strokeWidth = dims.spacingS,
        )

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (label != null) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (sublabel != null) {
                Text(
                    text = sublabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** Wear M3 `LinearProgressIndicator`, fill-width with optional leading label. */
@Composable
fun ProgressBarRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: com.moumantai.protocol.v1.ProgressBarComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val value = resolveDynamic(c.value_, data, itemScope).toFloat()
    val max = (c.max ?: 100.0).toFloat()
    val label = resolveDynamic(c.label, data, itemScope)

    val progress = if (max > 0f) (value / max).coerceIn(0f, 1f) else 0f
    val dims = LocalDimensions.current

    val baseModifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "ProgressBar",
        null,
    )

    Column(
        modifier = baseModifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(dims.spacingXs),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (label != null) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        LinearProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// =============================================================================
// 18. FabRenderer (Wear)
// =============================================================================

/**
 * The Scaffold's `fab` slot uses the M3 EdgeButton (see `ScaffoldFabEdgeButton`).
 * When a FabComponent appears inline (outside that slot), render as a tonal Button
 * so the action remains accessible.
 */
@Composable
fun FabRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: com.moumantai.protocol.v1.FabComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = resolveDynamic(c.label, data, itemScope)
    val iconName = resolveDynamic(c.icon, data, itemScope)
    val dims = LocalDimensions.current
    val modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Fab", childVariant = null)
    val onClick: () -> Unit = { dispatch(c.action, itemScope) }

    FilledTonalButton(
        onClick = onClick,
        modifier = modifier,
    ) {
        if (iconName != null) {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = iconName,
                modifier = Modifier.size(dims.iconSize),
            )
            if (!label.isNullOrBlank()) {
                Spacer(modifier = Modifier.size(dims.spacingS))
            }
        }
        if (!label.isNullOrBlank()) {
            Text(text = label, maxLines = 1)
        }
    }
}
