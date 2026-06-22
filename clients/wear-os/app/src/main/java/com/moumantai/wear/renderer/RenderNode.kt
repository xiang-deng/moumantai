package com.moumantai.wear.renderer

import androidx.compose.runtime.Composable
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.Modifier as WireModifier

/**
 * Recursive renderer for the Moumantai component tree on Wear OS.
 *
 * Looks up [componentId] in [components], dispatches on the non-null variant
 * slot of the Wire-generated [ComponentDef] (`text`, `column`, `button`, …),
 * and calls the appropriate Compose renderer. Variant dispatch is exhaustive
 * over all 23 component types (see `dispatchComponent`).
 */
@Composable
fun RenderNode(
    componentId: String,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>? = null,
    itemScopePath: String? = null,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    parent: RenderParent = RenderParent.ROOT,
) {
    val def = components[componentId] ?: return

    // Visibility gate (carried on every component's modifier slot).
    val visible = def.modifier()?.visible
    if (visible != null && !resolveDynamic(visible, data, itemScope, default = true)) return

    dispatchComponent(def, components, data, surfaceId, itemScope, itemScopePath, dispatch, parent)
}

/** Return the [Modifier] from whichever [ComponentDef] variant is set, or null. */
fun ComponentDef.modifier(): WireModifier? = when {
    text != null -> text.modifier
    icon != null -> icon.modifier
    image != null -> image.modifier
    divider != null -> divider.modifier
    column != null -> column.modifier
    row != null -> row.modifier
    card != null -> card.modifier
    scaffold != null -> scaffold.modifier
    top_bar != null -> top_bar.modifier
    button != null -> button.modifier
    chip != null -> chip.modifier
    fab != null -> fab.modifier
    text_field != null -> text_field.modifier
    check_box != null -> check_box.modifier
    switch_toggle != null -> switch_toggle.modifier
    slider != null -> slider.modifier
    tabs != null -> tabs.modifier
    select != null -> select.modifier
    date_time_input != null -> date_time_input.modifier
    list != null -> list.modifier
    list_item != null -> list_item.modifier
    progress_ring != null -> progress_ring.modifier
    progress_bar != null -> progress_bar.modifier
    modal != null -> modal.modifier
    box != null -> box.modifier
    else -> null
}

/**
 * Catalog component-kind name (PascalCase) for the variant set on this [ComponentDef].
 * Mirrors the phone-side `ComponentDef.componentKind`; fed into the design-system
 * catalog (e.g. `Layout.containerChildGap`).
 */
fun ComponentDef.componentKind(): String? = when {
    text != null -> "Text"
    icon != null -> "Icon"
    image != null -> "Image"
    divider != null -> "Divider"
    column != null -> "Column"
    row != null -> "Row"
    card != null -> "Card"
    scaffold != null -> "Scaffold"
    top_bar != null -> "TopBar"
    button != null -> "Button"
    chip != null -> "Chip"
    fab != null -> "Fab"
    text_field != null -> "TextField"
    check_box != null -> "CheckBox"
    switch_toggle != null -> "Switch"
    slider != null -> "Slider"
    tabs != null -> "Tabs"
    select != null -> "Select"
    date_time_input != null -> "DateTimeInput"
    list != null -> "List"
    list_item != null -> "ListItem"
    progress_ring != null -> "ProgressRing"
    progress_bar != null -> "ProgressBar"
    modal != null -> "Modal"
    box != null -> "Box"
    else -> null
}

/**
 * Exhaustive variant dispatch — each branch calls the typed per-component renderer.
 * `RenderNodeTest.coversEveryComponentVariant` pins the 23-variant exhaustiveness.
 */
@Composable
internal fun dispatchComponent(
    def: ComponentDef,
    components: Map<String, ComponentDef>,
    data: Map<String, Any?>,
    surfaceId: String,
    itemScope: Map<String, Any?>?,
    itemScopePath: String?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
    parent: RenderParent,
) {
    when {
        def.text != null -> TextRenderer(def.id, def.text, parent, data, itemScope)
        def.icon != null -> IconRenderer(def.id, def.icon, parent, surfaceId, data, itemScope, dispatch)
        def.image != null -> ImageRenderer(def.id, def.image, parent, data, itemScope)
        def.divider != null -> DividerRenderer(def.id, def.divider, parent, data, itemScope)
        def.column != null -> ColumnRenderer(
            def.id, def.column, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.row != null -> RowRenderer(
            def.id, def.row, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.card != null -> CardRenderer(
            def.id, def.card, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.scaffold != null -> ScaffoldRenderer(
            def.id, def.scaffold, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.top_bar != null -> TopBarRenderer(
            def.id, def.top_bar, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.button != null -> ButtonRenderer(def.id, def.button, parent, surfaceId, data, itemScope, dispatch)
        def.chip != null -> ChipRenderer(def.id, def.chip, parent, surfaceId, data, itemScope, dispatch)
        def.fab != null -> FabRenderer(def.id, def.fab, parent, surfaceId, data, itemScope, dispatch)
        def.text_field != null -> TextFieldRenderer(def.id, def.text_field, parent, surfaceId, data, itemScope, dispatch)
        def.check_box != null -> CheckBoxRenderer(def.id, def.check_box, parent, surfaceId, data, itemScope, dispatch)
        def.switch_toggle != null -> SwitchRenderer(def.id, def.switch_toggle, parent, surfaceId, data, itemScope, dispatch)
        def.slider != null -> SliderRenderer(def.id, def.slider, parent, surfaceId, data, itemScope, dispatch)
        def.tabs != null -> TabsRenderer(
            def.id, def.tabs, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.select != null -> SelectRenderer(def.id, def.select, parent, surfaceId, data, itemScope, dispatch)
        def.date_time_input != null -> DateTimeInputRenderer(
            def.id,
            def.date_time_input,
            parent,
            surfaceId,
            data,
            itemScope,
            dispatch,
        )
        def.list != null -> ListRenderer(
            def.id, def.list, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.list_item != null -> ListItemRenderer(
            def.id, def.list_item, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.progress_ring != null -> ProgressRingRenderer(def.id, def.progress_ring, parent, data, itemScope)
        def.progress_bar != null -> ProgressBarRenderer(def.id, def.progress_bar, parent, data, itemScope)
        def.modal != null -> ModalRenderer(
            def.id, def.modal, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        def.box != null -> BoxRenderer(
            def.id, def.box, parent, components, data, surfaceId, itemScope, itemScopePath, dispatch,
        )
        // Unknown / unset variant — skip silently (forward-compat with newer
        // proto versions that add a variant this client doesn't know yet).
        else -> Unit
    }
}
