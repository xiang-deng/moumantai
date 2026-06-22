/**
 * Layout components: Column, Row, Card, Box.
 *
 * Card accepts intent fields — `emphasis` ('standard' | 'elevated') and
 * `tone` ('default' | 'accent' | 'warning' | 'error' | 'info'). The framework
 * maps these to a (kind, accent) treatment via the catalog's
 * `resolveCardTreatment(...)`. Card with `action:` set becomes interactive
 * (state-layer on hover/press); without `action:` it is decorative.
 *
 * `*Options` types are generated from `components.proto` — see
 * `./generated/options.ts`.
 */

import { component } from './common.js'
import type { ComponentDef } from './common.js'
import type { ColumnOptions, RowOptions, CardOptions, BoxOptions } from './generated/options.js'

export type { ColumnOptions, RowOptions, CardOptions, BoxOptions }

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function column(id: string, children?: string[], options: ColumnOptions = {}): ComponentDef {
  return component(id, 'Column', { children, ...options })
}

export function row(id: string, children?: string[], options: RowOptions = {}): ComponentDef {
  return component(id, 'Row', { children, ...options })
}

export function card(id: string, children?: string[], options: CardOptions = {}): ComponentDef {
  return component(id, 'Card', { children, ...options })
}

/**
 * Z-stack overlay container — children paint in array order (later entries
 * stack on top), each anchored to a position within the box.
 *
 * Canonical use: a `card` with an error-tone overlay (e.g. "LIVE" badge as
 * `card('live', ['live_label'], { tone: 'error' })` pinned bottom-end on
 * a thumbnail).
 */
export function box(id: string, children?: string[], options: BoxOptions = {}): ComponentDef {
  return component(id, 'Box', { children, ...options })
}
