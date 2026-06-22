/**
 * Feedback components: ProgressRing (intrinsic SVG ring), ProgressBar
 * (fill-width linear bar), Modal.
 *
 * Ring and Bar are distinct rendering primitives (intrinsic-sized vs
 * fill-width), not variants of a single component. `*Options` types are
 * generated from `components.proto` — see `./generated/options.ts`.
 */

import type { DynamicValue } from './common.js'
import { component } from './common.js'
import type { ComponentDef } from './common.js'
import type { ProgressRingOptions, ProgressBarOptions, ModalOptions } from './generated/options.js'

export type { ProgressRingOptions, ProgressBarOptions, ModalOptions }

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function progressRing(
  id: string,
  value?: DynamicValue<number>,
  max?: number,
  options: ProgressRingOptions = {},
): ComponentDef {
  return component(id, 'ProgressRing', { value, max, ...options })
}

export function progressBar(
  id: string,
  value?: DynamicValue<number>,
  max?: number,
  options: ProgressBarOptions = {},
): ComponentDef {
  return component(id, 'ProgressBar', { value, max, ...options })
}

export function modal(id: string, children?: string[], options: ModalOptions = {}): ComponentDef {
  return component(id, 'Modal', { children, ...options })
}
