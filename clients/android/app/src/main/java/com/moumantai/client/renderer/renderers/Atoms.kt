package com.moumantai.client.renderer.renderers

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.moumantai.client.renderer.LocalServerHttpBase
import com.moumantai.client.renderer.RenderParent
import com.moumantai.client.renderer.defaultIconSize
import com.moumantai.client.renderer.lookupMaterialIcon
import com.moumantai.client.renderer.mapFontWeight
import com.moumantai.client.renderer.mapTextAlign
import com.moumantai.client.renderer.mapTypography
import com.moumantai.client.renderer.resolveDynamic
import com.moumantai.client.renderer.resolveModifierWithSize
import com.moumantai.client.renderer.resolveThemeColor
import com.moumantai.protocol.designsystem.DesignSystem
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.DividerComponent
import com.moumantai.protocol.v1.IconComponent
import com.moumantai.protocol.v1.ImageComponent
import com.moumantai.protocol.v1.TextComponent

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

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
    val color = resolveThemeColor(c.color)

    Text(
        text = text,
        style = style,
        fontWeight = fontWeight,
        textAlign = textAlign,
        overflow = TextOverflow.Ellipsis,
        color = color ?: Color.Unspecified,
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Text", null),
    )
}

// ---------------------------------------------------------------------------
// Icon — resolves the name to a Material icon. Tint defaults to LocalContentColor.
// ---------------------------------------------------------------------------

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
    val sizeDp = c.size?.dp ?: defaultIconSize()
    val tintName = resolveDynamic(c.color, data, itemScope)
    val tint = resolveThemeColor(tintName) ?: LocalContentColor.current

    var modifier: Modifier = Modifier.size(sizeDp)
    if (c.action != null) {
        modifier = modifier.clickable {
            dispatch(c.action, itemScope)
        }
    }

    Icon(
        imageVector = lookupMaterialIcon(name),
        contentDescription = name,
        tint = tint,
        modifier = modifier,
    )
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

@Composable
fun ImageRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: ImageComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val rawSrc = resolveDynamic(c.src, data, itemScope) ?: return
    if (rawSrc.isEmpty()) return
    // Root-relative asset paths need the server's HTTP base prepended — Coil
    // can't resolve them on its own.
    val httpBase = LocalServerHttpBase.current
    val src = if (rawSrc.startsWith("/") && httpBase.isNotEmpty()) "$httpBase$rawSrc" else rawSrc
    val alt = c.alt ?: ""
    // Catalog normalises fit names and applies the `contain` default when unset.
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
        contentScale = contentScale,
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Image", null),
    )
}

// ---------------------------------------------------------------------------
// Divider — HorizontalDivider with M3 default thickness and outlineVariant color.
// ---------------------------------------------------------------------------

@Composable
fun DividerRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: DividerComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val thicknessDp = c.thickness?.dp ?: 1.dp
    val color = resolveThemeColor(c.color)
        ?: MaterialTheme.colorScheme.outlineVariant

    HorizontalDivider(
        thickness = thicknessDp,
        color = color,
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Divider", null),
    )
}
