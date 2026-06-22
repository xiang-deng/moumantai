package com.moumantai.client.renderer.renderers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.moumantai.client.renderer.RenderNode
import com.moumantai.client.renderer.RenderParent
import com.moumantai.client.renderer.isCompactWidth
import com.moumantai.client.renderer.resolveDynamic
import com.moumantai.client.renderer.resolveModifierWithSize
import com.moumantai.client.renderer.resolveThemeColor
import com.moumantai.client.theme.LocalDimensions
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.ModalComponent
import com.moumantai.protocol.v1.ProgressBarComponent
import com.moumantai.protocol.v1.ProgressRingComponent

// ---------------------------------------------------------------------------
// ProgressRing — circular SVG ring with centered label / sublabel.
// Intrinsic-sized; default 96dp on phone, 80dp on compact.
// ---------------------------------------------------------------------------

@Composable
fun ProgressRingRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ProgressRingComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val value = resolveDynamic(c.value_, data, itemScope).toFloat()
    val max = (c.max ?: 100.0).toFloat()
    val label = resolveDynamic(c.label, data, itemScope)
    val sublabel = resolveDynamic(c.sublabel, data, itemScope)
    val color = resolveThemeColor(c.color) ?: MaterialTheme.colorScheme.primary
    val trackColor = MaterialTheme.colorScheme.surfaceContainerHighest
    val compact = isCompactWidth()

    val progress = (value / max).coerceIn(0f, 1f)

    val baseModifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "ProgressRing",
        null,
    )

    val dim = LocalDimensions.current
    val defaultSize = if (compact) 80 else 96
    val sizeDp = (c.size ?: defaultSize).dp
    val stroke = if (compact) 5.dp else 8.dp

    Box(
        contentAlignment = Alignment.Center,
        modifier = baseModifier.size(sizeDp),
    ) {
        CircularProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxSize(),
            color = color,
            trackColor = trackColor,
            strokeWidth = stroke,
        )
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
            modifier = Modifier.padding(horizontal = dim.spacingS),
        ) {
            if (label != null) {
                Text(
                    text = label,
                    style = if (compact) {
                        MaterialTheme.typography.titleMedium
                    } else {
                        MaterialTheme.typography.titleLarge
                    },
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
            }
            if (sublabel != null) {
                Text(
                    text = sublabel,
                    style = if (compact) {
                        MaterialTheme.typography.labelSmall
                    } else {
                        MaterialTheme.typography.bodyMedium
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ProgressBar — linear, fill-width with rounded ends and optional leading
// label.
// ---------------------------------------------------------------------------

@Composable
fun ProgressBarRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ProgressBarComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val value = resolveDynamic(c.value_, data, itemScope).toFloat()
    val max = (c.max ?: 100.0).toFloat()
    val label = resolveDynamic(c.label, data, itemScope)
    val color = resolveThemeColor(c.color) ?: MaterialTheme.colorScheme.primary
    val trackColor = MaterialTheme.colorScheme.surfaceContainerHighest

    val progress = (value / max).coerceIn(0f, 1f)

    val baseModifier = resolveModifierWithSize(
        c.modifier,
        data,
        itemScope,
        parent,
        "ProgressBar",
        null,
    )

    val dim = LocalDimensions.current
    Column(
        modifier = baseModifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(dim.spacingXs),
    ) {
        if (label != null) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        LinearProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxWidth(),
            color = color,
            trackColor = trackColor,
        )
    }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

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
    if (!open) return

    AlertDialog(
        onDismissRequest = { dispatch(c.action, itemScope) },
        confirmButton = {},
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(LocalDimensions.current.spacingS)) {
                c.children.forEachIndexed { index, childId ->
                    RenderNode(
                        componentId = childId,
                        components = components,
                        data = data,
                        surfaceId = surfaceId,
                        itemScope = itemScope,
                        itemScopePath = itemScopePath,
                        dispatch = dispatch,
                        parent = RenderParent(kind = "Modal", slotIndex = index),
                    )
                }
            }
        },
    )
}
