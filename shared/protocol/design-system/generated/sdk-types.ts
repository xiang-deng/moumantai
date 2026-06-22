// AUTO-GENERATED FROM design-system.yaml. DO NOT EDIT BY HAND.
// Source: shared/protocol/design-system/design-system.yaml

// Typed unions consumed by the Moumantai server SDK so face-authoring TS gets
// IDE/build errors on typos. The wire format stays free-form `string` (per
// shared/protocol/spec.md rule 7) so LLMs that bypass the typed SDK still
// work; renderers fall back to "omitted" semantics on unknown values.

// Layout sizing — derived from layout.size_keywords in catalog.
export type SizeKeyword = "fill" | "grow" | "wrap"
export type SizeValue = SizeKeyword | number

// 9-value alignment grid — derived from top-level `alignments.values`.
export type Alignment =
  | "bottomCenter" | "bottomEnd" | "bottomStart"
  | "center" | "centerEnd" | "centerStart"
  | "topCenter" | "topEnd" | "topStart"

// Container main-axis distribution — derived from top-level `arrangements.values`.
export type Arrangement =
  | "center" | "end" | "spaceAround" | "spaceBetween" | "spaceEvenly" | "start"

// Per-component intent axis unions — derived from components.<X>.intents.
// Authors write these via the typed SDK; the framework maps them to
// a (kind, accent) treatment via the catalog's resolve<X>Treatment(...).
export type ButtonEmphasis = "primary" | "quiet" | "standard"
export type ButtonTone = "accent" | "default" | "error" | "info" | "warning"
export type CardEmphasis = "elevated" | "standard"
export type CardTone = "accent" | "default" | "error" | "info" | "warning"
export type ChipTone = "accent" | "default" | "error" | "warning"
export type FabSize = "extended" | "regular" | "small"

// Image fit — derived from components.Image.fit_modes.
export type ImageFit = "contain" | "crop" | "fill" | "fillHeight" | "fillWidth" | "none"
