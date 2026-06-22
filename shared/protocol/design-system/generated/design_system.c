// AUTO-GENERATED FROM design-system.yaml. DO NOT EDIT BY HAND.
// Source: shared/protocol/design-system/design-system.yaml
// Implementations of ds_*_resolve declared in design_system.h. Externally linked.

#include "design_system.h"

#include <string.h>

ds_variant_spec_t ds_button_resolve(const char* variant) {
    if (variant == NULL) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_SECONDARY };
    if (strcmp(variant, "filled_container-error") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_ERROR };
    if (strcmp(variant, "filled_container-primary") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_PRIMARY };
    if (strcmp(variant, "filled_container-tertiary") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_TERTIARY };
    if (strcmp(variant, "filled_container-warning") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_WARNING };
    if (strcmp(variant, "outlined_container-error") == 0) return (ds_variant_spec_t){ DS_KIND_OUTLINED_CONTAINER, DS_ACCENT_ERROR };
    if (strcmp(variant, "transparent-error") == 0) return (ds_variant_spec_t){ DS_KIND_TRANSPARENT, DS_ACCENT_ERROR };
    if (strcmp(variant, "transparent-primary") == 0) return (ds_variant_spec_t){ DS_KIND_TRANSPARENT, DS_ACCENT_PRIMARY };
    return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_SECONDARY };
}

ds_variant_spec_t ds_card_resolve(const char* variant) {
    if (variant == NULL) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_NEUTRAL };
    if (strcmp(variant, "elevated_container-neutral") == 0) return (ds_variant_spec_t){ DS_KIND_ELEVATED_CONTAINER, DS_ACCENT_NEUTRAL };
    if (strcmp(variant, "filled_container-error") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_ERROR };
    if (strcmp(variant, "filled_container-secondary") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_SECONDARY };
    if (strcmp(variant, "filled_container-tertiary") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_TERTIARY };
    if (strcmp(variant, "filled_container-warning") == 0) return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_WARNING };
    return (ds_variant_spec_t){ DS_KIND_FILLED_CONTAINER, DS_ACCENT_NEUTRAL };
}

ds_variant_spec_t ds_chip_resolve(const char* variant) {
    if (variant == NULL) return (ds_variant_spec_t){ DS_KIND_OUTLINED_CONTAINER, DS_ACCENT_NEUTRAL };
    if (strcmp(variant, "outlined_container-error") == 0) return (ds_variant_spec_t){ DS_KIND_OUTLINED_CONTAINER, DS_ACCENT_ERROR };
    if (strcmp(variant, "outlined_container-secondary") == 0) return (ds_variant_spec_t){ DS_KIND_OUTLINED_CONTAINER, DS_ACCENT_SECONDARY };
    if (strcmp(variant, "outlined_container-warning") == 0) return (ds_variant_spec_t){ DS_KIND_OUTLINED_CONTAINER, DS_ACCENT_WARNING };
    return (ds_variant_spec_t){ DS_KIND_OUTLINED_CONTAINER, DS_ACCENT_NEUTRAL };
}

ds_variant_spec_t ds_fab_resolve(const char* variant) {
    if (variant == NULL) return (ds_variant_spec_t){ DS_KIND_FLOATING_ACTION, DS_ACCENT_PRIMARY };
    return (ds_variant_spec_t){ DS_KIND_FLOATING_ACTION, DS_ACCENT_PRIMARY };
}

ds_variant_spec_t ds_progressbar_resolve(const char* variant) {
    if (variant == NULL) return (ds_variant_spec_t){ DS_KIND_PROGRESS_BAR, DS_ACCENT_PRIMARY };
    return (ds_variant_spec_t){ DS_KIND_PROGRESS_BAR, DS_ACCENT_PRIMARY };
}

ds_variant_spec_t ds_progressring_resolve(const char* variant) {
    if (variant == NULL) return (ds_variant_spec_t){ DS_KIND_PROGRESS_RING, DS_ACCENT_PRIMARY };
    return (ds_variant_spec_t){ DS_KIND_PROGRESS_RING, DS_ACCENT_PRIMARY };
}

const char* ds_image_resolve_fit(const char* fit) {
    if (fit == NULL) return "contain";
    if (strcmp(fit, "cover") == 0) return "crop";
    if (strcmp(fit, "fillBounds") == 0) return "fill";
    if (strcmp(fit, "fit") == 0) return "contain";
    if (strcmp(fit, "inside") == 0) return "contain";
    if (strcmp(fit, "contain") == 0) return "contain";
    if (strcmp(fit, "crop") == 0) return "crop";
    if (strcmp(fit, "fill") == 0) return "fill";
    if (strcmp(fit, "fillHeight") == 0) return "fillHeight";
    if (strcmp(fit, "fillWidth") == 0) return "fillWidth";
    if (strcmp(fit, "none") == 0) return "none";
    return "contain";
}

// ---------------------------------------------------------------------------
// Layout-default resolution — see shared/protocol/spec.md rule 10.
// ---------------------------------------------------------------------------

// Internal stretch-policy enum (intermediate value before mapping to ds_layout_size_t).
// Negative return = no policy known (caller falls through to next step).
static int ds_layout_container_policy(
    const char* parent_kind,
    int slot_index,
    const char* slot_name,
    int is_width) {
    if (parent_kind == NULL) return -1;
    if (strcmp(parent_kind, "Box") == 0) {
        if (slot_index == 0) {
            return is_width ? 0 : 1;
        }
        return is_width ? 2 : 2;
    }
    if (strcmp(parent_kind, "Card") == 0) return is_width ? 0 : 1;
    if (strcmp(parent_kind, "Column") == 0) return is_width ? 0 : 1;
    if (strcmp(parent_kind, "List") == 0) return is_width ? 0 : 1;
    if (strcmp(parent_kind, "Modal") == 0) return is_width ? 0 : 1;
    if (strcmp(parent_kind, "Row") == 0) return is_width ? 1 : 1;
    if (strcmp(parent_kind, "Scaffold") == 0) {
        if (slot_name == NULL) return -1;
        if (strcmp(slot_name, "body") == 0) return is_width ? 0 : 0;
        if (strcmp(slot_name, "fab") == 0) return is_width ? 2 : 2;
        if (strcmp(slot_name, "top_bar") == 0) return is_width ? 0 : 2;
        return -1;
    }
    if (strcmp(parent_kind, "Tabs") == 0) return is_width ? 0 : 1;
    if (strcmp(parent_kind, "TopBar") == 0) return is_width ? 1 : 1;
    return -1;
}

// Per-component intrinsic size; returns 0=parent, 1=wrap, 2=fixed.
static int ds_layout_intrinsic(const char* child_kind, int is_width) {
    if (child_kind == NULL) return 1;  // unknown -> wrap
    if (strcmp(child_kind, "Box") == 0) return is_width ? 0 : 0;
    if (strcmp(child_kind, "Button") == 0) return is_width ? 1 : 1;
    if (strcmp(child_kind, "Card") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "CheckBox") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Chip") == 0) return is_width ? 1 : 1;
    if (strcmp(child_kind, "Column") == 0) return is_width ? 0 : 0;
    if (strcmp(child_kind, "DateTimeInput") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Divider") == 0) return is_width ? 0 : 2;
    if (strcmp(child_kind, "Fab") == 0) return is_width ? 1 : 1;
    if (strcmp(child_kind, "Icon") == 0) return is_width ? 2 : 2;
    if (strcmp(child_kind, "Image") == 0) return is_width ? 1 : 1;
    if (strcmp(child_kind, "List") == 0) return is_width ? 0 : 0;
    if (strcmp(child_kind, "ListItem") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Modal") == 0) return is_width ? 0 : 0;
    if (strcmp(child_kind, "ProgressBar") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "ProgressRing") == 0) return is_width ? 1 : 1;
    if (strcmp(child_kind, "Row") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Scaffold") == 0) return is_width ? 0 : 0;
    if (strcmp(child_kind, "Select") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Slider") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Switch") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Tabs") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "Text") == 0) return is_width ? 1 : 1;
    if (strcmp(child_kind, "TextField") == 0) return is_width ? 0 : 1;
    if (strcmp(child_kind, "TopBar") == 0) return is_width ? 0 : 1;
    return 1;
}

// Variant override; returns -1 if no override applies.
static int ds_layout_variant_override(const char* child_kind, const char* child_variant, int is_width) {
    if (child_kind == NULL || child_variant == NULL) return -1;
    return -1;
}

static ds_layout_size_t ds_layout_resolve_axis(
    const char* parent_kind, int slot_index, const char* slot_name,
    const char* child_kind, const char* child_variant,
    const char* own_keyword, int is_width) {
    // Step 1: explicit own keyword wins.
    if (own_keyword != NULL) {
        if (strcmp(own_keyword, "fill") == 0) return DS_LAYOUT_FILL;
        if (strcmp(own_keyword, "wrap") == 0) return DS_LAYOUT_WRAP;
        if (strcmp(own_keyword, "grow") == 0) return DS_LAYOUT_GROW;
        // unknown keyword -> fall through.
    }
    // Step 2: component intrinsic (with variant override applied).
    // Effective intrinsic: variant override wins over base intrinsic.
    int intrinsic = ds_layout_variant_override(child_kind, child_variant, is_width);
    if (intrinsic < 0) intrinsic = ds_layout_intrinsic(child_kind, is_width);
    if (intrinsic == 1) return DS_LAYOUT_WRAP;
    if (intrinsic == 2) return DS_LAYOUT_FIXED;
    // intrinsic == 0 ('parent') — consult parent's container policy.
    int policy = ds_layout_container_policy(parent_kind, slot_index, slot_name, is_width);
    if (policy >= 0) {
        return (policy == 0) ? DS_LAYOUT_FILL : DS_LAYOUT_WRAP;
    }
    // Root or unknown parent — best-effort FILL for 'parent'.
    return DS_LAYOUT_FILL;
}

ds_layout_size_t ds_layout_resolve_width(
    const char* parent_kind, int slot_index, const char* slot_name,
    const char* child_kind, const char* child_variant, const char* own_keyword) {
    return ds_layout_resolve_axis(parent_kind, slot_index, slot_name,
        child_kind, child_variant, own_keyword, 1);
}

ds_layout_size_t ds_layout_resolve_height(
    const char* parent_kind, int slot_index, const char* slot_name,
    const char* child_kind, const char* child_variant, const char* own_keyword) {
    return ds_layout_resolve_axis(parent_kind, slot_index, slot_name,
        child_kind, child_variant, own_keyword, 0);
}

// Container child-gap lookup. See header for contract.
const char* ds_container_child_gap(const char* parent_kind, const char* child_kind) {
    if (parent_kind == NULL) return NULL;
    if (child_kind == NULL) child_kind = "default";
    if (strcmp(parent_kind, "List") == 0) {
        if (strcmp(child_kind, "Card") == 0) return "spacing.s";
        if (strcmp(child_kind, "ListItem") == 0) return "spacing.none";
        return "spacing.s";
    }
    return NULL;
}
