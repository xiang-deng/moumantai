package com.moumantai.client.renderer.renderers

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import com.moumantai.client.renderer.RenderParent
import com.moumantai.client.renderer.lookupMaterialIcon
import com.moumantai.client.renderer.resolveDynamic
import com.moumantai.client.renderer.resolveModifierWithSize
import com.moumantai.protocol.designsystem.DesignSystemTreatments
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.ButtonComponent
import com.moumantai.protocol.v1.ChipComponent
import com.moumantai.protocol.v1.FabComponent

// ---------------------------------------------------------------------------
// Button — `resolveButton(emphasis, tone)` returns a (kind, accent) treatment
// that maps to a Material primitive. FAB is a separate component.
// ---------------------------------------------------------------------------

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
    val text = resolveDynamic(c.text, data, itemScope) ?: ""
    val spec = DesignSystemTreatments.resolveButton(c.emphasis, c.tone)
    val enabled = resolveDynamic(c.enabled, data, itemScope, default = true)
    val iconName = resolveDynamic(c.icon, data, itemScope)

    val onClick: () -> Unit = { dispatch(c.action, itemScope) }
    val modifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "Button",
        childVariant = null,
    )

    val content: @Composable () -> Unit = {
        if (iconName != null) {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = null,
                modifier = androidx.compose.ui.Modifier.size(ButtonDefaults.IconSize),
            )
            Spacer(androidx.compose.ui.Modifier.size(ButtonDefaults.IconSpacing))
        }
        Text(text = text, style = MaterialTheme.typography.labelLarge)
    }

    // filled_container: primary → Button, secondary → FilledTonalButton.
    when (spec.kind) {
        "outlined_container" -> OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier) { content() }
        "transparent" -> TextButton(onClick = onClick, enabled = enabled, modifier = modifier) { content() }
        "filled_container" -> if (spec.accent == "secondary") {
            FilledTonalButton(onClick = onClick, enabled = enabled, modifier = modifier) { content() }
        } else {
            Button(onClick = onClick, enabled = enabled, modifier = modifier) { content() }
        }
        else -> Button(onClick = onClick, enabled = enabled, modifier = modifier) { content() }
    }
}

// ---------------------------------------------------------------------------
// Fab — ExtendedFAB when label is set; plain FAB otherwise.
// ---------------------------------------------------------------------------

@Composable
fun FabRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: FabComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = resolveDynamic(c.label, data, itemScope) ?: ""
    val iconName = resolveDynamic(c.icon, data, itemScope)
    val onClick: () -> Unit = { dispatch(c.action, itemScope) }
    val modifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "Fab",
        childVariant = null,
    )

    if (label.isNotBlank()) {
        ExtendedFloatingActionButton(
            onClick = onClick,
            icon = {
                if (iconName != null) {
                    Icon(
                        imageVector = lookupMaterialIcon(iconName),
                        contentDescription = null,
                    )
                }
            },
            text = { Text(label) },
            modifier = modifier,
        )
    } else {
        FloatingActionButton(
            onClick = onClick,
            modifier = modifier,
        ) {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = label.ifBlank { null },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Chip — AssistChip when `selected` is unbound; FilterChip otherwise.
// ---------------------------------------------------------------------------

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
    val iconName = resolveDynamic(c.icon, data, itemScope)
    val selected = resolveDynamic(c.selected, data, itemScope)
    val hasSelectedBinding = c.selected != null

    val onClick: () -> Unit = { dispatch(c.action, itemScope) }

    val leadingIcon: (@Composable () -> Unit)? = if (iconName != null) {
        {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = null,
                modifier = androidx.compose.ui.Modifier.size(AssistChipDefaults.IconSize),
            )
        }
    } else {
        null
    }

    val selectedLeadingIcon: (@Composable () -> Unit)? = if (iconName != null) {
        {
            Icon(
                imageVector = lookupMaterialIcon(iconName),
                contentDescription = null,
                modifier = androidx.compose.ui.Modifier.size(FilterChipDefaults.IconSize),
            )
        }
    } else {
        null
    }

    val modifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "Chip",
        childVariant = null,
    )

    when {
        hasSelectedBinding -> FilterChip(
            selected = selected,
            onClick = onClick,
            label = { Text(text = label) },
            leadingIcon = selectedLeadingIcon,
            modifier = modifier,
        )
        else -> AssistChip(
            onClick = onClick,
            label = { Text(text = label) },
            leadingIcon = leadingIcon,
            modifier = modifier,
        )
    }
}
