/**
 * Action components: Button, Chip, Fab.
 *
 * Authors emit semantic intent, not visual variants:
 *   - Button: `emphasis` ('primary' | 'standard' | 'quiet') + `tone`
 *   - Chip:   `tone` + `selected:` binding (present → filter-chip behavior)
 *   - Fab:    `size` ('small' | 'regular' | 'extended')
 *
 * The framework maps intent to a (kind, accent) treatment via the catalog's
 * `resolve<Component>Treatment(...)` (`shared/protocol/design-system/generated/
 * design-system.ts`). `*Options` types are generated from `components.proto` —
 * see `./generated/options.ts`.
 */

import type { DynamicValue } from './common.js'
import { component } from './common.js'
import type { ComponentDef } from './common.js'
import type { ButtonOptions, ChipOptions, FabOptions } from './generated/options.js'

export type { ButtonOptions, ChipOptions, FabOptions }

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function button(
  id: string,
  textContent?: DynamicValue<string>,
  options: ButtonOptions = {},
): ComponentDef {
  return component(id, 'Button', { text: textContent, ...options })
}

export function chip(
  id: string,
  label?: DynamicValue<string>,
  options: ChipOptions = {},
): ComponentDef {
  return component(id, 'Chip', { label, ...options })
}

/**
 * Floating action button — corner-anchored primary action.
 *
 * With `label`: extended (pill-shaped) FAB. Without: icon-only compact FAB.
 * `size`: 'small' (40dp), 'regular' (56dp, default), 'extended' (label + icon).
 */
export function fab(id: string, options: FabOptions = {}): ComponentDef {
  return component(id, 'Fab', { ...options })
}
