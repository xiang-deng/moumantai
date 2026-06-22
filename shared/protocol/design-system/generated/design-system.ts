// AUTO-GENERATED FROM design-system.yaml. DO NOT EDIT BY HAND.
// Source: shared/protocol/design-system/design-system.yaml

export interface VariantSpec {
  readonly kind: string
  readonly accent: string
}

export interface ComponentSpec {
  readonly defaultVariant: string
  readonly variants: Readonly<Record<string, VariantSpec>>
}

export interface ImageSpec {
  readonly defaultFit: string
  readonly fitModes: readonly string[]
  readonly fitAliases: Readonly<Record<string, string>>
}

export interface AlignmentsSpec {
  readonly default: string
  readonly values: readonly string[]
}

export interface ArrangementsSpec {
  readonly default: string
  readonly values: readonly string[]
}

export const DESIGN_SYSTEM = {
  Button: {
    defaultVariant: "filled_container-secondary",
    variants: {
      "filled_container-error": { kind: "filled_container", accent: "error" },
      "filled_container-primary": { kind: "filled_container", accent: "primary" },
      "filled_container-secondary": { kind: "filled_container", accent: "secondary" },
      "filled_container-tertiary": { kind: "filled_container", accent: "tertiary" },
      "filled_container-warning": { kind: "filled_container", accent: "warning" },
      "outlined_container-error": { kind: "outlined_container", accent: "error" },
      "transparent-error": { kind: "transparent", accent: "error" },
      "transparent-primary": { kind: "transparent", accent: "primary" },
    },
  },
  Card: {
    defaultVariant: "filled_container-neutral",
    variants: {
      "elevated_container-neutral": { kind: "elevated_container", accent: "neutral" },
      "filled_container-error": { kind: "filled_container", accent: "error" },
      "filled_container-neutral": { kind: "filled_container", accent: "neutral" },
      "filled_container-secondary": { kind: "filled_container", accent: "secondary" },
      "filled_container-tertiary": { kind: "filled_container", accent: "tertiary" },
      "filled_container-warning": { kind: "filled_container", accent: "warning" },
    },
  },
  Chip: {
    defaultVariant: "outlined_container-neutral",
    variants: {
      "outlined_container-error": { kind: "outlined_container", accent: "error" },
      "outlined_container-neutral": { kind: "outlined_container", accent: "neutral" },
      "outlined_container-secondary": { kind: "outlined_container", accent: "secondary" },
      "outlined_container-warning": { kind: "outlined_container", accent: "warning" },
    },
  },
  Fab: {
    defaultVariant: "floating_action-primary",
    variants: {
      "floating_action-primary": { kind: "floating_action", accent: "primary" },
    },
  },
  ProgressBar: {
    defaultVariant: "progress_bar-primary",
    variants: {
      "progress_bar-primary": { kind: "progress_bar", accent: "primary" },
    },
  },
  ProgressRing: {
    defaultVariant: "progress_ring-primary",
    variants: {
      "progress_ring-primary": { kind: "progress_ring", accent: "primary" },
    },
  },
  Image: {
    defaultFit: "contain",
    fitModes: ["contain", "crop", "fill", "fillHeight", "fillWidth", "none"] as const,
    fitAliases: {
      cover: "crop",
      fillBounds: "fill",
      fit: "contain",
      inside: "contain",
    },
  },
} as const

export const ALIGNMENTS: AlignmentsSpec = {
  default: "topStart",
  values: ["bottomCenter", "bottomEnd", "bottomStart", "center", "centerEnd", "centerStart", "topCenter", "topEnd", "topStart"],
}

export const ARRANGEMENTS: ArrangementsSpec = {
  default: "start",
  values: ["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly"],
}

export const IMAGE_FIT_ALIASES: Readonly<Record<string, string>> =
  DESIGN_SYSTEM.Image.fitAliases

// ---------------------------------------------------------------------------
// Resolve helpers — return the VariantSpec for a wire string, falling back
// to the component's defaultVariant when unset or unknown.
// ---------------------------------------------------------------------------

export function resolveButtonVariant(variant: string | undefined | null): VariantSpec {
  const c = DESIGN_SYSTEM.Button
  const key = (variant ?? c.defaultVariant) as keyof typeof c.variants
  return c.variants[key] ?? c.variants[c.defaultVariant as keyof typeof c.variants]
}

export function buttonVariants(): readonly string[] {
  return Object.keys(DESIGN_SYSTEM.Button.variants).sort()
}

export function resolveCardVariant(variant: string | undefined | null): VariantSpec {
  const c = DESIGN_SYSTEM.Card
  const key = (variant ?? c.defaultVariant) as keyof typeof c.variants
  return c.variants[key] ?? c.variants[c.defaultVariant as keyof typeof c.variants]
}

export function cardVariants(): readonly string[] {
  return Object.keys(DESIGN_SYSTEM.Card.variants).sort()
}

export function resolveChipVariant(variant: string | undefined | null): VariantSpec {
  const c = DESIGN_SYSTEM.Chip
  const key = (variant ?? c.defaultVariant) as keyof typeof c.variants
  return c.variants[key] ?? c.variants[c.defaultVariant as keyof typeof c.variants]
}

export function chipVariants(): readonly string[] {
  return Object.keys(DESIGN_SYSTEM.Chip.variants).sort()
}

export function resolveFabVariant(variant: string | undefined | null): VariantSpec {
  const c = DESIGN_SYSTEM.Fab
  const key = (variant ?? c.defaultVariant) as keyof typeof c.variants
  return c.variants[key] ?? c.variants[c.defaultVariant as keyof typeof c.variants]
}

export function fabVariants(): readonly string[] {
  return Object.keys(DESIGN_SYSTEM.Fab.variants).sort()
}

export function resolveProgressBarVariant(variant: string | undefined | null): VariantSpec {
  const c = DESIGN_SYSTEM.ProgressBar
  const key = (variant ?? c.defaultVariant) as keyof typeof c.variants
  return c.variants[key] ?? c.variants[c.defaultVariant as keyof typeof c.variants]
}

export function progressbarVariants(): readonly string[] {
  return Object.keys(DESIGN_SYSTEM.ProgressBar.variants).sort()
}

export function resolveProgressRingVariant(variant: string | undefined | null): VariantSpec {
  const c = DESIGN_SYSTEM.ProgressRing
  const key = (variant ?? c.defaultVariant) as keyof typeof c.variants
  return c.variants[key] ?? c.variants[c.defaultVariant as keyof typeof c.variants]
}

export function progressringVariants(): readonly string[] {
  return Object.keys(DESIGN_SYSTEM.ProgressRing.variants).sort()
}

export function resolveImageFit(fit: string | undefined | null): string {
  if (!fit) return DESIGN_SYSTEM.Image.defaultFit
  const aliased = IMAGE_FIT_ALIASES[fit]
  if (aliased) return aliased
  if ((DESIGN_SYSTEM.Image.fitModes as readonly string[]).includes(fit)) return fit
  return DESIGN_SYSTEM.Image.defaultFit
}

// ---------------------------------------------------------------------------
// Treatment resolvers — author intent → renderer (kind, accent) pair.
// Each component's treatments table is the single source of truth;
// authoring helpers + renderers consume these resolvers so the mapping
// stays catalog-driven.
// ---------------------------------------------------------------------------

export function resolveButtonTreatment(emphasis?: string, tone?: string): VariantSpec {
  const _emphasis = emphasis ?? "standard"
  const _tone = tone ?? "default"
  if (_emphasis === "primary" && _tone === "error") return { kind: "filled_container", accent: "error" }
  if (_emphasis === "primary" && _tone === "warning") return { kind: "filled_container", accent: "warning" }
  if (_emphasis === "primary") return { kind: "filled_container", accent: "primary" }
  if (_emphasis === "quiet" && _tone === "error") return { kind: "transparent", accent: "error" }
  if (_emphasis === "quiet") return { kind: "transparent", accent: "primary" }
  if (_tone === "error") return { kind: "outlined_container", accent: "error" }
  if (_tone === "warning") return { kind: "filled_container", accent: "warning" }
  if (_tone === "accent") return { kind: "filled_container", accent: "secondary" }
  if (_tone === "info") return { kind: "filled_container", accent: "tertiary" }
  return { kind: "filled_container", accent: "secondary" }
}

export function resolveCardTreatment(emphasis?: string, tone?: string): VariantSpec {
  const _emphasis = emphasis ?? "standard"
  const _tone = tone ?? "default"
  if (_tone === "error") return { kind: "filled_container", accent: "error" }
  if (_tone === "warning") return { kind: "filled_container", accent: "warning" }
  if (_tone === "accent") return { kind: "filled_container", accent: "secondary" }
  if (_tone === "info") return { kind: "filled_container", accent: "tertiary" }
  if (_emphasis === "elevated") return { kind: "elevated_container", accent: "neutral" }
  return { kind: "filled_container", accent: "neutral" }
}

export function resolveChipTreatment(tone?: string): VariantSpec {
  const _tone = tone ?? "default"
  if (_tone === "error") return { kind: "outlined_container", accent: "error" }
  if (_tone === "warning") return { kind: "outlined_container", accent: "warning" }
  if (_tone === "accent") return { kind: "outlined_container", accent: "secondary" }
  return { kind: "outlined_container", accent: "neutral" }
}

export const CHIP_SELECTED_TREATMENT: VariantSpec = { kind: "filled_container", accent: "secondary" }

export function resolveFabTreatment(size?: string): VariantSpec {
  void size;  // axis present in API but no rule consults it
  return { kind: "floating_action", accent: "primary" }
}

export function resolveProgressBarTreatment(): VariantSpec {
  return { kind: "progress_bar", accent: "primary" }
}

export function resolveProgressRingTreatment(): VariantSpec {
  return { kind: "progress_ring", accent: "primary" }
}

// ---------------------------------------------------------------------------
// Layout-default resolution — see shared/protocol/spec.md rule 10.
// Pure function over enums; identical contract across TS / Kotlin / C.
// ---------------------------------------------------------------------------

export type LayoutSizeResult = "fill" | "wrap" | "fixed" | "grow"

interface LayoutContainerPlain {
  readonly child_default_width: string
  readonly child_default_height: string
  // Gap between consecutive children, keyed by child component variant.
  // Values are spacing-token names (e.g. "s", "none") resolved by each
  // renderer at runtime against its own size-class-resolved token table.
  // `"none"` is the sentinel for literal 0. Look up via resolveListChildGap.
  readonly child_gaps?: Readonly<Record<string, string>>
}
interface LayoutSlotPolicy {
  readonly width: string
  readonly height: string
}
interface LayoutContainerSlotted {
  readonly slot_policies: Readonly<Record<string, LayoutSlotPolicy>>
}
type LayoutContainer = LayoutContainerPlain | LayoutContainerSlotted
interface LayoutComponentIntrinsic {
  readonly width: string
  readonly height: string
}
interface LayoutVariantOverride {
  readonly width?: string
  readonly height?: string
}

export const LAYOUT = {
  containers: {
    Box: {
      slot_policies: {
        background: { width: "cross_axis_fill", height: "cross_axis_wrap" },
        overlay: { width: "none", height: "none" },
      },
    },
    Card: { child_default_width: "cross_axis_fill", child_default_height: "cross_axis_wrap" },
    Column: { child_default_width: "cross_axis_fill", child_default_height: "cross_axis_wrap" },
    List: { child_default_width: "cross_axis_fill", child_default_height: "cross_axis_wrap", child_gaps: { Card: "spacing.s", ListItem: "spacing.none", default: "spacing.s" } },
    Modal: { child_default_width: "cross_axis_fill", child_default_height: "cross_axis_wrap" },
    Row: { child_default_width: "cross_axis_wrap", child_default_height: "cross_axis_wrap" },
    Scaffold: {
      slot_policies: {
        body: { width: "cross_axis_fill", height: "cross_axis_fill" },
        fab: { width: "none", height: "none" },
        top_bar: { width: "cross_axis_fill", height: "none" },
      },
    },
    Tabs: { child_default_width: "cross_axis_fill", child_default_height: "cross_axis_wrap" },
    TopBar: { child_default_width: "cross_axis_wrap", child_default_height: "cross_axis_wrap" },
  } as Readonly<Record<string, LayoutContainer>>,
  components: {
    Box: { width: "parent", height: "parent" },
    Button: { width: "wrap", height: "wrap" },
    Card: { width: "parent", height: "wrap" },
    CheckBox: { width: "parent", height: "wrap" },
    Chip: { width: "wrap", height: "wrap" },
    Column: { width: "parent", height: "parent" },
    DateTimeInput: { width: "parent", height: "wrap" },
    Divider: { width: "parent", height: "fixed" },
    Fab: { width: "wrap", height: "wrap" },
    Icon: { width: "fixed", height: "fixed" },
    Image: { width: "wrap", height: "wrap" },
    List: { width: "parent", height: "parent" },
    ListItem: { width: "parent", height: "wrap" },
    Modal: { width: "parent", height: "parent" },
    ProgressBar: { width: "parent", height: "wrap" },
    ProgressRing: { width: "wrap", height: "wrap" },
    Row: { width: "parent", height: "wrap" },
    Scaffold: { width: "parent", height: "parent" },
    Select: { width: "parent", height: "wrap" },
    Slider: { width: "parent", height: "wrap" },
    Switch: { width: "parent", height: "wrap" },
    Tabs: { width: "parent", height: "wrap" },
    Text: { width: "wrap", height: "wrap" },
    TextField: { width: "parent", height: "wrap" },
    TopBar: { width: "parent", height: "wrap" },
  } as Readonly<Record<string, LayoutComponentIntrinsic>>,
  variant_overrides: {
  } as Readonly<Record<string, Readonly<Record<string, LayoutVariantOverride>>>>,
} as const

function stretchToResult(policy: string): LayoutSizeResult {
  return policy === "cross_axis_fill" ? "fill" : "wrap"
}

function resolveContainerPolicy(
  parentKind: string,
  slotIndex: number,
  slotName: string | null,
  axis: "width" | "height",
): string | null {
  const c = LAYOUT.containers[parentKind]
  if (!c) return null
  if ("child_default_width" in c) {
    return axis === "width" ? c.child_default_width : c.child_default_height
  }
  let key: string | null
  if (parentKind === "Box") {
    key = slotIndex === 0 ? "background" : "overlay"
  } else if (parentKind === "Scaffold") {
    key = slotName
  } else {
    key = null
  }
  if (key === null) return null
  const slot = c.slot_policies[key]
  if (!slot) return null
  return axis === "width" ? slot.width : slot.height
}

function effectiveIntrinsic(
  childKind: string,
  childVariant: string | null,
  axis: "width" | "height",
): string {
  if (childVariant) {
    const o = LAYOUT.variant_overrides[childKind]?.[childVariant]
    const v = o && (axis === "width" ? o.width : o.height)
    if (v) return v
  }
  return LAYOUT.components[childKind]?.[axis] ?? "wrap"
}

function resolveAxis(
  parentKind: string | null,
  slotIndex: number,
  slotName: string | null,
  childKind: string,
  childVariant: string | null,
  ownKeyword: string | null,
  axis: "width" | "height",
): LayoutSizeResult {
  // Step 1: explicit own keyword wins over catalog defaults.
  if (ownKeyword === "fill") return "fill"
  if (ownKeyword === "wrap") return "wrap"
  if (ownKeyword === "grow") return "grow"
  // Step 2: component intrinsic decides on its own when possible.
  // 'wrap' / 'fixed' return immediately. Only 'parent' (the explicit
  // 'I follow my parent' marker) consults the parent slot policy.
  // This is what makes Button + Chip wrap content even in a Column
  // whose other children (Card, TextField, ...) fill cross-axis.
  const intrinsic = effectiveIntrinsic(childKind, childVariant, axis)
  if (intrinsic === "wrap") return "wrap"
  if (intrinsic === "fixed") return "fixed"
  // intrinsic === 'parent' — consult parent's container policy.
  if (parentKind) {
    const policy = resolveContainerPolicy(parentKind, slotIndex, slotName, axis)
    if (policy !== null) return stretchToResult(policy)
  }
  // Root or unknown parent — best-effort FILL for 'parent'.
  return "fill"
}

export function resolveChildWidth(
  parentKind: string | null,
  slotIndex: number,
  slotName: string | null,
  childKind: string,
  childVariant: string | null,
  ownKeyword: string | null,
): LayoutSizeResult {
  return resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, "width")
}

export function resolveChildHeight(
  parentKind: string | null,
  slotIndex: number,
  slotName: string | null,
  childKind: string,
  childVariant: string | null,
  ownKeyword: string | null,
): LayoutSizeResult {
  return resolveAxis(parentKind, slotIndex, slotName, childKind, childVariant, ownKeyword, "height")
}

// Look up the gap a container should apply between consecutive children
// of a given variant. Returns a spacing-token name (e.g. "s") or
// "none" (sentinel for 0). Returns null if the container has no
// child_gaps policy. Callers map the token name to their renderer's
// native unit via shared/tokens/{compact,expanded}.yaml.
export function resolveContainerChildGap(
  parentKind: string,
  childKind: string,
): string | null {
  const c = LAYOUT.containers[parentKind]
  if (!c || !("child_gaps" in c) || !c.child_gaps) return null
  return c.child_gaps[childKind] ?? c.child_gaps["default"] ?? null
}

// ---------------------------------------------------------------------------
// Compact-class authoring hints — consumed by TS-side compact-discipline
// guards (server/src/server/agent/define-face.ts). Non-TS renderers do not
// read this surface today; the source of truth for compact behavior on
// Wear / ESP32 / web-narrow lives in each renderer's translation layer.
// ---------------------------------------------------------------------------

export interface CompactHints {
  readonly max_circular_size_dp?: number
  readonly orientation_hint?: string
  readonly max_selected_chips?: number
  readonly max_body_children?: number
}

export const COMPACT_HINTS: Readonly<Record<string, CompactHints>> = {
  ProgressRing: { max_circular_size_dp: 100 },
  Row: { max_selected_chips: 2, orientation_hint: "collapse_to_column" },
}
