// AUTO-GENERATED FROM design-system.yaml. DO NOT EDIT BY HAND.
// Source: shared/protocol/design-system/design-system.yaml

#ifndef MOUMANTAI_DESIGN_SYSTEM_H
#define MOUMANTAI_DESIGN_SYSTEM_H

#ifdef __cplusplus
extern "C" {
#endif

// Semantic kinds — every renderer translates these to native primitives.
typedef enum {
    DS_KIND_UNKNOWN = 0,
    DS_KIND_ELEVATED_CONTAINER,
    DS_KIND_FILLED_CONTAINER,
    DS_KIND_FLOATING_ACTION,
    DS_KIND_OUTLINED_CONTAINER,
    DS_KIND_PROGRESS_BAR,
    DS_KIND_PROGRESS_RING,
    DS_KIND_TRANSPARENT,
} ds_kind_t;

// Accent token namespaces — map onto theme color roles.
typedef enum {
    DS_ACCENT_UNKNOWN = 0,
    DS_ACCENT_ERROR,
    DS_ACCENT_NEUTRAL,
    DS_ACCENT_PRIMARY,
    DS_ACCENT_SECONDARY,
    DS_ACCENT_TERTIARY,
    DS_ACCENT_WARNING,
} ds_accent_t;

typedef struct {
    ds_kind_t kind;
    ds_accent_t accent;
} ds_variant_spec_t;

typedef enum {
    DS_BUTTON_VARIANT_UNKNOWN = 0,
    DS_BUTTON_VARIANT_FILLED_CONTAINER_ERROR,
    DS_BUTTON_VARIANT_FILLED_CONTAINER_PRIMARY,
    DS_BUTTON_VARIANT_FILLED_CONTAINER_SECONDARY,
    DS_BUTTON_VARIANT_FILLED_CONTAINER_TERTIARY,
    DS_BUTTON_VARIANT_FILLED_CONTAINER_WARNING,
    DS_BUTTON_VARIANT_OUTLINED_CONTAINER_ERROR,
    DS_BUTTON_VARIANT_TRANSPARENT_ERROR,
    DS_BUTTON_VARIANT_TRANSPARENT_PRIMARY,
} ds_button_variant_t;

// Default variant constant (string form matches the wire).
#define DS_BUTTON_VARIANT_DEFAULT "filled_container-secondary"

// Look up a variant string against the catalog. Returns the default's spec if unknown.
ds_variant_spec_t ds_button_resolve(const char* variant);

typedef enum {
    DS_CARD_VARIANT_UNKNOWN = 0,
    DS_CARD_VARIANT_ELEVATED_CONTAINER_NEUTRAL,
    DS_CARD_VARIANT_FILLED_CONTAINER_ERROR,
    DS_CARD_VARIANT_FILLED_CONTAINER_NEUTRAL,
    DS_CARD_VARIANT_FILLED_CONTAINER_SECONDARY,
    DS_CARD_VARIANT_FILLED_CONTAINER_TERTIARY,
    DS_CARD_VARIANT_FILLED_CONTAINER_WARNING,
} ds_card_variant_t;

// Default variant constant (string form matches the wire).
#define DS_CARD_VARIANT_DEFAULT "filled_container-neutral"

// Look up a variant string against the catalog. Returns the default's spec if unknown.
ds_variant_spec_t ds_card_resolve(const char* variant);

typedef enum {
    DS_CHIP_VARIANT_UNKNOWN = 0,
    DS_CHIP_VARIANT_OUTLINED_CONTAINER_ERROR,
    DS_CHIP_VARIANT_OUTLINED_CONTAINER_NEUTRAL,
    DS_CHIP_VARIANT_OUTLINED_CONTAINER_SECONDARY,
    DS_CHIP_VARIANT_OUTLINED_CONTAINER_WARNING,
} ds_chip_variant_t;

// Default variant constant (string form matches the wire).
#define DS_CHIP_VARIANT_DEFAULT "outlined_container-neutral"

// Look up a variant string against the catalog. Returns the default's spec if unknown.
ds_variant_spec_t ds_chip_resolve(const char* variant);

typedef enum {
    DS_FAB_VARIANT_UNKNOWN = 0,
    DS_FAB_VARIANT_FLOATING_ACTION_PRIMARY,
} ds_fab_variant_t;

// Default variant constant (string form matches the wire).
#define DS_FAB_VARIANT_DEFAULT "floating_action-primary"

// Look up a variant string against the catalog. Returns the default's spec if unknown.
ds_variant_spec_t ds_fab_resolve(const char* variant);

typedef enum {
    DS_PROGRESSBAR_VARIANT_UNKNOWN = 0,
    DS_PROGRESSBAR_VARIANT_PROGRESS_BAR_PRIMARY,
} ds_progressbar_variant_t;

// Default variant constant (string form matches the wire).
#define DS_PROGRESSBAR_VARIANT_DEFAULT "progress_bar-primary"

// Look up a variant string against the catalog. Returns the default's spec if unknown.
ds_variant_spec_t ds_progressbar_resolve(const char* variant);

typedef enum {
    DS_PROGRESSRING_VARIANT_UNKNOWN = 0,
    DS_PROGRESSRING_VARIANT_PROGRESS_RING_PRIMARY,
} ds_progressring_variant_t;

// Default variant constant (string form matches the wire).
#define DS_PROGRESSRING_VARIANT_DEFAULT "progress_ring-primary"

// Look up a variant string against the catalog. Returns the default's spec if unknown.
ds_variant_spec_t ds_progressring_resolve(const char* variant);

// Image fit modes (canonical).
typedef enum {
    DS_IMAGE_FIT_UNKNOWN = 0,
    DS_IMAGE_FIT_CONTAIN,
    DS_IMAGE_FIT_CROP,
    DS_IMAGE_FIT_FILL,
    DS_IMAGE_FIT_FILLHEIGHT,
    DS_IMAGE_FIT_FILLWIDTH,
    DS_IMAGE_FIT_NONE,
} ds_image_fit_t;

#define DS_IMAGE_FIT_DEFAULT "contain"

// Resolve a fit string (canonical or alias) to a canonical mode.
// Returns DS_IMAGE_FIT_DEFAULT (string) if input is NULL or unknown.
const char* ds_image_resolve_fit(const char* fit);

// ---------------------------------------------------------------------------
// Layout-default resolution — see shared/protocol/spec.md rule 10.
// Pure function over enums; identical contract across TS / Kotlin / C.
// ---------------------------------------------------------------------------

typedef enum {
    DS_LAYOUT_FILL = 0,
    DS_LAYOUT_WRAP,
    DS_LAYOUT_FIXED,
    DS_LAYOUT_GROW,
} ds_layout_size_t;

// Resolve the cross-axis size policy for a child component.
// Inputs:
//   parent_kind   — TypeName of the parent ("Column", "Box", ...) or NULL for root
//   slot_index    — 0-based index in parent's children list (used by Box)
//   slot_name     — Scaffold slot identifier ("body" / "top_bar" / "fab") or NULL
//   child_kind    — TypeName of the child ("Card", "TextField", ...)
//   child_variant — variant string (e.g. "linear" for Progress) or NULL
//   own_keyword   — explicit Modifier.width keyword ("fill" / "wrap" / "grow") or NULL
// Returns: DS_LAYOUT_FILL / DS_LAYOUT_WRAP / DS_LAYOUT_FIXED / DS_LAYOUT_GROW.
// On DS_LAYOUT_FIXED the renderer reads the explicit dp from the modifier.
ds_layout_size_t ds_layout_resolve_width(
    const char* parent_kind,
    int slot_index,
    const char* slot_name,
    const char* child_kind,
    const char* child_variant,
    const char* own_keyword);

ds_layout_size_t ds_layout_resolve_height(
    const char* parent_kind,
    int slot_index,
    const char* slot_name,
    const char* child_kind,
    const char* child_variant,
    const char* own_keyword);

// Look up the gap a container should apply between consecutive children
// of a given variant. Returns a spacing-token name ("s", "none", ...)
// or NULL if the container has no child_gaps policy. Caller maps the
// name to pixels via generated_tokens.h (e.g. MOUMANTAI_SPACING_S).
// "none" is the sentinel for literal 0.
const char* ds_container_child_gap(const char* parent_kind, const char* child_kind);

#ifdef __cplusplus
}
#endif

#endif  // MOUMANTAI_DESIGN_SYSTEM_H
