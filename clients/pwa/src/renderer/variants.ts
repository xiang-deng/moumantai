import React from 'react'
import { BodyKind } from '@moumantai/protocol/generated/moumantai/v1'
import { DESIGN_SYSTEM, type VariantSpec } from '@moumantai/protocol/design-system'

/**
 * Treatment + variant dispatch helpers for the PWA renderers.
 *
 * `resolve<Component>Treatment(emphasis, tone)` maps semantic intent to a
 * `(kind, accent)` pair; `treatmentClass` turns that into the CSS class suffix
 * (e.g. `filled_container-primary`). `design-system.css` emits a matching rule
 * per unique treatment. Drift-guarded by `tests/unit/renderer/variant-class.test.ts`.
 */

/** Treatment → CSS class suffix. Stable identifier `<kind>-<accent>`. */
export function treatmentClass(treatment: VariantSpec): string {
  return `${treatment.kind}-${treatment.accent}`
}

/**
 * Body container class name from `Scaffold.bodyKind`.
 *
 * LIST (default): vertically scrollable — `overflow-y: auto`.
 * CANVAS: bounded, centered, no scroll — for hero-style faces that must not overflow.
 */
export function scaffoldBodyClass(bodyKind: BodyKind | undefined): string {
  return bodyKind === BodyKind.CANVAS
    ? 'moumantai-scaffold-body moumantai-scaffold-body--canvas'
    : 'moumantai-scaffold-body'
}

/**
 * Map a catalog Image fit kind to `object-fit`. The catalog uses `crop` for
 * what CSS calls `cover`; `fillHeight`/`fillWidth` have no CSS equivalent and
 * fall back to `cover`.
 */
export function fitKindToObjectFit(kind: string): React.CSSProperties['objectFit'] {
  switch (kind) {
    case 'crop':
    case 'fillHeight':
    case 'fillWidth':
      return 'cover'
    case 'fill':
      return 'fill'
    case 'none':
      return 'none'
    case 'contain':
    default:
      return 'contain'
  }
}

// Keep DESIGN_SYSTEM referenced so tests that rely on this module's side-effect
// import continue to compile.
void DESIGN_SYSTEM
