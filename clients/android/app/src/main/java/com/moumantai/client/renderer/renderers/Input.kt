package com.moumantai.client.renderer.renderers

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import com.moumantai.client.renderer.LocalFormSetter
import com.moumantai.client.renderer.RenderNode
import com.moumantai.client.renderer.RenderParent
import com.moumantai.client.renderer.resolveAbsolutePath
import com.moumantai.client.renderer.resolveDynamic
import com.moumantai.client.renderer.resolveModifierWithSize
import com.moumantai.client.theme.LocalDimensions
import com.moumantai.protocol.v1.Action
import com.moumantai.protocol.v1.CheckBoxComponent
import com.moumantai.protocol.v1.ComponentDef
import com.moumantai.protocol.v1.DateTimeInputComponent
import com.moumantai.protocol.v1.SelectComponent
import com.moumantai.protocol.v1.SliderComponent
import com.moumantai.protocol.v1.SwitchComponent
import com.moumantai.protocol.v1.TabsComponent
import com.moumantai.protocol.v1.TextFieldComponent

// ---------------------------------------------------------------------------
// TextField — M3 OutlinedTextField. `multiline` true: grows vertically, accepts \n.
// ---------------------------------------------------------------------------

@Composable
fun TextFieldRenderer(
    componentId: String,
    c: TextFieldComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
) {
    val label = c.label ?: ""
    // Value resolves via `/$form/<id>` — AppPager injects the `$form` projection.
    val value = resolveDynamic(c.value_, data, itemScope) ?: ""
    val placeholder = c.placeholder
    val multiline = c.multiline ?: false
    val setForm = LocalFormSetter.current

    OutlinedTextField(
        value = value,
        // Write to `$form`; server never authors it, cleared on navigation.
        onValueChange = { setForm(componentId, it) },
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        singleLine = !multiline,
        maxLines = if (multiline) Int.MAX_VALUE else 1,
        keyboardOptions = KeyboardOptions(keyboardType = mapKeyboardType(c.keyboard_type)),
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "TextField", null),
    )
}

/** Map wire keyboard_type string → Compose KeyboardType. */
private fun mapKeyboardType(name: String?): KeyboardType = when (name) {
    "number" -> KeyboardType.Number
    "decimal" -> KeyboardType.Decimal
    "email" -> KeyboardType.Email
    "phone" -> KeyboardType.Phone
    "password" -> KeyboardType.Password
    "uri", "url" -> KeyboardType.Uri
    else -> KeyboardType.Text
}

// ---------------------------------------------------------------------------
// CheckBox
// ---------------------------------------------------------------------------

@Composable
fun CheckBoxRenderer(
    componentId: String,
    c: CheckBoxComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = resolveDynamic(c.label, data, itemScope)
    val checked = resolveDynamic(c.checked, data, itemScope)
    val setForm = LocalFormSetter.current
    // With `action`: fire on toggle (settings-style UX). Without: write to
    // /$form/<id> (form-style UX, accumulates until a submit fires).
    val onToggle: (Boolean) -> Unit = if (c.action != null) {
        { dispatch(c.action, itemScope) }
    } else {
        { setForm(componentId, it) }
    }

    // Row wrapper is a renderer primitive (not catalog) — stretches to match the parent policy.
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LocalDimensions.current.spacingS),
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "CheckBox", null),
    ) {
        Checkbox(
            checked = checked,
            onCheckedChange = onToggle,
        )
        if (label != null) {
            Text(text = label, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

@Composable
fun SwitchRenderer(
    componentId: String,
    c: SwitchComponent,
    parent: RenderParent,
    @Suppress("UNUSED_PARAMETER") surfaceId: String,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = resolveDynamic(c.label, data, itemScope)
    val checked = resolveDynamic(c.checked, data, itemScope)
    val setForm = LocalFormSetter.current
    val onToggle: (Boolean) -> Unit = if (c.action != null) {
        { dispatch(c.action, itemScope) }
    } else {
        { setForm(componentId, it) }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Switch", null),
    ) {
        if (label != null) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onToggle,
        )
    }
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

@Composable
fun SliderRenderer(
    componentId: String,
    c: SliderComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val value = resolveDynamic(c.value_, data, itemScope).toFloat()
    val min = (c.min ?: 0.0).toFloat()
    val max = (c.max ?: 100.0).toFloat()
    val step = c.step?.toFloat()
    val label = c.label
    val setForm = LocalFormSetter.current

    val steps = if (step != null && step > 0f) {
        ((max - min) / step).toInt() - 1
    } else {
        0
    }

    // Local state during the drag so the slider visibly tracks the finger;
    // commit happens on release (Slider's onValueChangeFinished).
    var sliderValue by remember(value) { mutableStateOf(value) }

    Column(
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Slider", null),
        verticalArrangement = Arrangement.spacedBy(LocalDimensions.current.spacingXs),
    ) {
        if (label != null) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Slider(
            value = sliderValue,
            onValueChange = { sliderValue = it },
            onValueChangeFinished = {
                // Commit on release: form-mode → `/$form/<id>`; action-mode → dispatch.
                if (c.action != null) {
                    dispatch(c.action, itemScope)
                } else {
                    setForm(componentId, sliderValue.toDouble())
                }
            },
            valueRange = min..max,
            steps = steps,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

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
    val tabLabels = c.tab_labels
    val tabContent = c.tab_content
    if (tabLabels.isEmpty() || tabContent.isEmpty()) return
    val selected = resolveDynamic(c.selected, data, itemScope)

    var selectedIndex by remember(selected) { mutableStateOf(selected) }

    Column(modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Tabs", null)) {
        // TabRow width tracks the outer Column's resolved modifier (catalog width).
        TabRow(
            selectedTabIndex = selectedIndex,
        ) {
            tabLabels.forEachIndexed { index, label ->
                Tab(
                    selected = index == selectedIndex,
                    onClick = {
                        selectedIndex = index
                        dispatch(c.action, itemScope)
                    },
                    text = { Text(text = label) },
                )
            }
        }

        val activeContentId = tabContent.getOrNull(selectedIndex)
        if (activeContentId != null) {
            RenderNode(
                componentId = activeContentId,
                components = components,
                data = data,
                surfaceId = surfaceId,
                itemScope = itemScope,
                itemScopePath = itemScopePath,
                dispatch = dispatch,
                parent = RenderParent(kind = "Tabs", slotIndex = selectedIndex),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Select — ExposedDropdownMenuBox with default M3 typography.
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
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
    val label = c.label ?: ""
    val value = resolveDynamic(c.value_, data, itemScope) ?: ""

    // Options: literal (label/value pairs) or path-resolved (free-form maps from data model).
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

    val displayText = options.firstOrNull { it.second == value }?.first ?: value

    var expanded by remember { mutableStateOf(false) }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "Select", null),
    ) {
        OutlinedTextField(
            value = displayText,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            colors = ExposedDropdownMenuDefaults.outlinedTextFieldColors(),
            modifier = Modifier.menuAnchor().fillMaxWidth(),
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            options.forEach { (optLabel, _) ->
                DropdownMenuItem(
                    text = { Text(text = optLabel) },
                    onClick = {
                        expanded = false
                        dispatch(c.action, itemScope)
                    },
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// DateTimeInput
// ---------------------------------------------------------------------------

@Composable
fun DateTimeInputRenderer(
    @Suppress("UNUSED_PARAMETER") componentId: String,
    c: DateTimeInputComponent,
    parent: RenderParent,
    data: Map<String, Any?>,
    itemScope: Map<String, Any?>?,
    dispatch: (Action?, Map<String, Any?>?) -> Unit,
) {
    val label = c.label ?: ""
    val value = resolveDynamic(c.value_, data, itemScope) ?: ""
    val mode = c.mode ?: "date"

    val placeholder = when (mode) {
        "time" -> "HH:MM"
        "datetime" -> "YYYY-MM-DD HH:MM"
        else -> "YYYY-MM-DD"
    }

    val interactionSource = remember { MutableInteractionSource() }
    LaunchedEffect(interactionSource) {
        interactionSource.interactions.collect { i ->
            if (i is PressInteraction.Release) {
                c.action?.let { dispatch(it, itemScope) }
            }
        }
    }

    OutlinedTextField(
        value = value,
        onValueChange = {},
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        readOnly = true,
        singleLine = true,
        interactionSource = interactionSource,
        modifier = resolveModifierWithSize(c.modifier, data, itemScope, parent, "DateTimeInput", null),
    )
}
