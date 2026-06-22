// AUTO-GENERATED FROM design-system.yaml. DO NOT EDIT BY HAND.
// Source: shared/protocol/design-system/design-system.yaml

package com.moumantai.protocol.designsystem

data class VariantSpec(val kind: String, val accent: String)

data class ComponentSpec(
    val defaultVariant: String,
    val variants: Map<String, VariantSpec>,
) {
    fun resolve(variant: String?): VariantSpec {
        val key = variant ?: defaultVariant
        return variants[key] ?: variants.getValue(defaultVariant)
    }
}

data class ImageSpec(
    val defaultFit: String,
    val fitModes: List<String>,
    val fitAliases: Map<String, String>,
) {
    fun resolve(fit: String?): String {
        if (fit == null) return defaultFit
        fitAliases[fit]?.let { return it }
        if (fit in fitModes) return fit
        return defaultFit
    }
}

data class AlignmentsSpec(val default: String, val values: List<String>)

data class ArrangementsSpec(val default: String, val values: List<String>)

object DesignSystem {
    val Button = ComponentSpec(
        defaultVariant = "filled_container-secondary",
        variants = mapOf(
            "filled_container-error" to VariantSpec(kind = "filled_container", accent = "error"),
            "filled_container-primary" to VariantSpec(kind = "filled_container", accent = "primary"),
            "filled_container-secondary" to VariantSpec(kind = "filled_container", accent = "secondary"),
            "filled_container-tertiary" to VariantSpec(kind = "filled_container", accent = "tertiary"),
            "filled_container-warning" to VariantSpec(kind = "filled_container", accent = "warning"),
            "outlined_container-error" to VariantSpec(kind = "outlined_container", accent = "error"),
            "transparent-error" to VariantSpec(kind = "transparent", accent = "error"),
            "transparent-primary" to VariantSpec(kind = "transparent", accent = "primary"),
        ),
    )

    val Card = ComponentSpec(
        defaultVariant = "filled_container-neutral",
        variants = mapOf(
            "elevated_container-neutral" to VariantSpec(kind = "elevated_container", accent = "neutral"),
            "filled_container-error" to VariantSpec(kind = "filled_container", accent = "error"),
            "filled_container-neutral" to VariantSpec(kind = "filled_container", accent = "neutral"),
            "filled_container-secondary" to VariantSpec(kind = "filled_container", accent = "secondary"),
            "filled_container-tertiary" to VariantSpec(kind = "filled_container", accent = "tertiary"),
            "filled_container-warning" to VariantSpec(kind = "filled_container", accent = "warning"),
        ),
    )

    val Chip = ComponentSpec(
        defaultVariant = "outlined_container-neutral",
        variants = mapOf(
            "outlined_container-error" to VariantSpec(kind = "outlined_container", accent = "error"),
            "outlined_container-neutral" to VariantSpec(kind = "outlined_container", accent = "neutral"),
            "outlined_container-secondary" to VariantSpec(kind = "outlined_container", accent = "secondary"),
            "outlined_container-warning" to VariantSpec(kind = "outlined_container", accent = "warning"),
        ),
    )

    val Fab = ComponentSpec(
        defaultVariant = "floating_action-primary",
        variants = mapOf(
            "floating_action-primary" to VariantSpec(kind = "floating_action", accent = "primary"),
        ),
    )

    val ProgressBar = ComponentSpec(
        defaultVariant = "progress_bar-primary",
        variants = mapOf(
            "progress_bar-primary" to VariantSpec(kind = "progress_bar", accent = "primary"),
        ),
    )

    val ProgressRing = ComponentSpec(
        defaultVariant = "progress_ring-primary",
        variants = mapOf(
            "progress_ring-primary" to VariantSpec(kind = "progress_ring", accent = "primary"),
        ),
    )

    val Image = ImageSpec(
        defaultFit = "contain",
        fitModes = listOf("contain", "crop", "fill", "fillHeight", "fillWidth", "none"),
        fitAliases = mapOf(
            "cover" to "crop",
            "fillBounds" to "fill",
            "fit" to "contain",
            "inside" to "contain",
        ),
    )

    val Alignments = AlignmentsSpec(
        default = "topStart",
        values = listOf("bottomCenter", "bottomEnd", "bottomStart", "center", "centerEnd", "centerStart", "topCenter", "topEnd", "topStart"),
    )
    val Arrangements = ArrangementsSpec(
        default = "start",
        values = listOf("start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly"),
    )
}

// ---------------------------------------------------------------------------
// Treatment resolvers — author intent → renderer (kind, accent) pair.
// Mirrors the TS resolve<X>Treatment functions; the catalog's treatments
// table is the single source of truth for all renderers.
// ---------------------------------------------------------------------------

object DesignSystemTreatments {
    fun resolveButton(emphasis: String? = null, tone: String? = null): VariantSpec {
        val _emphasis = emphasis ?: "standard"
        val _tone = tone ?: "default"
        if (_emphasis == "primary" && _tone == "error") return VariantSpec(kind = "filled_container", accent = "error")
        if (_emphasis == "primary" && _tone == "warning") return VariantSpec(kind = "filled_container", accent = "warning")
        if (_emphasis == "primary") return VariantSpec(kind = "filled_container", accent = "primary")
        if (_emphasis == "quiet" && _tone == "error") return VariantSpec(kind = "transparent", accent = "error")
        if (_emphasis == "quiet") return VariantSpec(kind = "transparent", accent = "primary")
        if (_tone == "error") return VariantSpec(kind = "outlined_container", accent = "error")
        if (_tone == "warning") return VariantSpec(kind = "filled_container", accent = "warning")
        if (_tone == "accent") return VariantSpec(kind = "filled_container", accent = "secondary")
        if (_tone == "info") return VariantSpec(kind = "filled_container", accent = "tertiary")
        return VariantSpec(kind = "filled_container", accent = "secondary")
    }

    fun resolveCard(emphasis: String? = null, tone: String? = null): VariantSpec {
        val _emphasis = emphasis ?: "standard"
        val _tone = tone ?: "default"
        if (_tone == "error") return VariantSpec(kind = "filled_container", accent = "error")
        if (_tone == "warning") return VariantSpec(kind = "filled_container", accent = "warning")
        if (_tone == "accent") return VariantSpec(kind = "filled_container", accent = "secondary")
        if (_tone == "info") return VariantSpec(kind = "filled_container", accent = "tertiary")
        if (_emphasis == "elevated") return VariantSpec(kind = "elevated_container", accent = "neutral")
        return VariantSpec(kind = "filled_container", accent = "neutral")
    }

    fun resolveChip(tone: String? = null): VariantSpec {
        val _tone = tone ?: "default"
        if (_tone == "error") return VariantSpec(kind = "outlined_container", accent = "error")
        if (_tone == "warning") return VariantSpec(kind = "outlined_container", accent = "warning")
        if (_tone == "accent") return VariantSpec(kind = "outlined_container", accent = "secondary")
        return VariantSpec(kind = "outlined_container", accent = "neutral")
    }

    val CHIP_SELECTED_TREATMENT: VariantSpec = VariantSpec(kind = "filled_container", accent = "secondary")

    fun resolveFab(size: String? = null): VariantSpec {
        @Suppress("UNUSED_PARAMETER") val _unused_size = size
        return VariantSpec(kind = "floating_action", accent = "primary")
    }

    fun resolveProgressBar(): VariantSpec {
        return VariantSpec(kind = "progress_bar", accent = "primary")
    }

    fun resolveProgressRing(): VariantSpec {
        return VariantSpec(kind = "progress_ring", accent = "primary")
    }

}

// ---------------------------------------------------------------------------
// Layout-default resolution — see shared/protocol/spec.md rule 10.
// Pure function over enums; identical contract across TS / Kotlin / C.
// ---------------------------------------------------------------------------

enum class LayoutSizeResult { FILL, WRAP, FIXED, GROW }

object Layout {
    private data class SlotPolicy(
        val width: String,
        val height: String,
    )
    private sealed interface Container {
        data class Plain(
            val crossWidth: String,
            val crossHeight: String,
            // Gap between consecutive children, keyed by child component
            // variant. Values are spacing-token names (e.g. "s", "none");
            // "none" is the literal-0 sentinel. Renderer maps the name to
            // dp via its LocalDimensions table. Empty = no policy.
            val childGaps: Map<String, String> = emptyMap(),
        ) : Container
        data class Slotted(val slots: Map<String, SlotPolicy>) : Container
    }
    private data class IntrinsicSize(val width: String, val height: String)
    private data class VariantOverride(val width: String? = null, val height: String? = null)

    private val CONTAINERS: Map<String, Container> = mapOf(
        "Box" to Container.Slotted(mapOf(
            "background" to SlotPolicy(width = "cross_axis_fill", height = "cross_axis_wrap"),
            "overlay" to SlotPolicy(width = "none", height = "none"),
        )),
        "Card" to Container.Plain(crossWidth = "cross_axis_fill", crossHeight = "cross_axis_wrap"),
        "Column" to Container.Plain(crossWidth = "cross_axis_fill", crossHeight = "cross_axis_wrap"),
        "List" to Container.Plain(crossWidth = "cross_axis_fill", crossHeight = "cross_axis_wrap", childGaps = mapOf("Card" to "spacing.s", "ListItem" to "spacing.none", "default" to "spacing.s")),
        "Modal" to Container.Plain(crossWidth = "cross_axis_fill", crossHeight = "cross_axis_wrap"),
        "Row" to Container.Plain(crossWidth = "cross_axis_wrap", crossHeight = "cross_axis_wrap"),
        "Scaffold" to Container.Slotted(mapOf(
            "body" to SlotPolicy(width = "cross_axis_fill", height = "cross_axis_fill"),
            "fab" to SlotPolicy(width = "none", height = "none"),
            "top_bar" to SlotPolicy(width = "cross_axis_fill", height = "none"),
        )),
        "Tabs" to Container.Plain(crossWidth = "cross_axis_fill", crossHeight = "cross_axis_wrap"),
        "TopBar" to Container.Plain(crossWidth = "cross_axis_wrap", crossHeight = "cross_axis_wrap"),
    )

    private val COMPONENTS: Map<String, IntrinsicSize> = mapOf(
        "Box" to IntrinsicSize(width = "parent", height = "parent"),
        "Button" to IntrinsicSize(width = "wrap", height = "wrap"),
        "Card" to IntrinsicSize(width = "parent", height = "wrap"),
        "CheckBox" to IntrinsicSize(width = "parent", height = "wrap"),
        "Chip" to IntrinsicSize(width = "wrap", height = "wrap"),
        "Column" to IntrinsicSize(width = "parent", height = "parent"),
        "DateTimeInput" to IntrinsicSize(width = "parent", height = "wrap"),
        "Divider" to IntrinsicSize(width = "parent", height = "fixed"),
        "Fab" to IntrinsicSize(width = "wrap", height = "wrap"),
        "Icon" to IntrinsicSize(width = "fixed", height = "fixed"),
        "Image" to IntrinsicSize(width = "wrap", height = "wrap"),
        "List" to IntrinsicSize(width = "parent", height = "parent"),
        "ListItem" to IntrinsicSize(width = "parent", height = "wrap"),
        "Modal" to IntrinsicSize(width = "parent", height = "parent"),
        "ProgressBar" to IntrinsicSize(width = "parent", height = "wrap"),
        "ProgressRing" to IntrinsicSize(width = "wrap", height = "wrap"),
        "Row" to IntrinsicSize(width = "parent", height = "wrap"),
        "Scaffold" to IntrinsicSize(width = "parent", height = "parent"),
        "Select" to IntrinsicSize(width = "parent", height = "wrap"),
        "Slider" to IntrinsicSize(width = "parent", height = "wrap"),
        "Switch" to IntrinsicSize(width = "parent", height = "wrap"),
        "Tabs" to IntrinsicSize(width = "parent", height = "wrap"),
        "Text" to IntrinsicSize(width = "wrap", height = "wrap"),
        "TextField" to IntrinsicSize(width = "parent", height = "wrap"),
        "TopBar" to IntrinsicSize(width = "parent", height = "wrap"),
    )

    private val VARIANT_OVERRIDES: Map<String, Map<String, VariantOverride>> = mapOf(
    )

    fun resolveChildWidth(
        parentKind: String?,
        slotIndex: Int,
        slotName: String?,
        childKind: String,
        childVariant: String?,
        ownKeyword: String?,
    ): LayoutSizeResult = resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, isWidth = true)

    fun resolveChildHeight(
        parentKind: String?,
        slotIndex: Int,
        slotName: String?,
        childKind: String,
        childVariant: String?,
        ownKeyword: String?,
    ): LayoutSizeResult = resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, isWidth = false)

    private fun effectiveIntrinsic(
        childKind: String,
        childVariant: String?,
        isWidth: Boolean,
    ): String {
        if (childVariant != null) {
            val o = VARIANT_OVERRIDES[childKind]?.get(childVariant)
            val v = if (o == null) null else if (isWidth) o.width else o.height
            if (v != null) return v
        }
        return COMPONENTS[childKind]?.let { if (isWidth) it.width else it.height } ?: "wrap"
    }

    private fun resolveAxis(
        parentKind: String?,
        slotIndex: Int,
        slotName: String?,
        childKind: String,
        childVariant: String?,
        ownKeyword: String?,
        isWidth: Boolean,
    ): LayoutSizeResult {
        // Step 1: explicit keyword wins over catalog defaults.
        if (ownKeyword == "fill") return LayoutSizeResult.FILL
        if (ownKeyword == "wrap") return LayoutSizeResult.WRAP
        if (ownKeyword == "grow") return LayoutSizeResult.GROW
        // Step 2: component intrinsic decides on its own when possible.
        // 'wrap' / 'fixed' return immediately. Only 'parent' (the explicit
        // 'I follow my parent' marker) consults the parent slot policy.
        // This is what makes Button + Chip wrap content even in a Column
        // whose other children (Card, TextField, ...) fill cross-axis.
        val intrinsic = effectiveIntrinsic(childKind, childVariant, isWidth)
        if (intrinsic == "wrap") return LayoutSizeResult.WRAP
        if (intrinsic == "fixed") return LayoutSizeResult.FIXED
        // intrinsic == "parent" — consult parent's container policy.
        if (parentKind != null) {
            val policy = resolveContainerPolicy(parentKind, slotIndex, slotName, isWidth)
            if (policy != null) return stretchToResult(policy)
        }
        // Root or unknown parent — best-effort FILL for 'parent'.
        return LayoutSizeResult.FILL
    }

    private fun resolveContainerPolicy(
        parentKind: String,
        slotIndex: Int,
        slotName: String?,
        isWidth: Boolean,
    ): String? {
        val c = CONTAINERS[parentKind] ?: return null
        return when (c) {
            is Container.Plain -> if (isWidth) c.crossWidth else c.crossHeight
            is Container.Slotted -> {
                val key = when (parentKind) {
                    "Box" -> if (slotIndex == 0) "background" else "overlay"
                    "Scaffold" -> slotName
                    else -> null
                } ?: return null
                val slot = c.slots[key] ?: return null
                if (isWidth) slot.width else slot.height
            }
        }
    }

    private fun stretchToResult(policy: String): LayoutSizeResult =
        if (policy == "cross_axis_fill") LayoutSizeResult.FILL else LayoutSizeResult.WRAP

    // Look up the gap a container should apply between consecutive children
    // of a given variant. Returns a spacing-token name (e.g. "s") or
    // "none" (literal-0 sentinel). null = container has no child_gaps
    // policy. Callers map the name to dp via LocalDimensions.
    fun containerChildGap(parentKind: String, childKind: String): String? {
        val c = CONTAINERS[parentKind] as? Container.Plain ?: return null
        if (c.childGaps.isEmpty()) return null
        return c.childGaps[childKind] ?: c.childGaps["default"]
    }
}
