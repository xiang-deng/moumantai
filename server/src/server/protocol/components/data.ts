/**
 * Data-driven components: List, ListItem
 *
 * `*Options` types are generated from `components.proto` — see
 * `./generated/options.ts`.
 */

import type { DynamicValue } from './common.js'
import { component } from './common.js'
import type { ComponentDef } from './common.js'
import type { ListOptions, ListItemOptions } from './generated/options.js'

export type { ListOptions, ListItemOptions }

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function list(
  id: string,
  itemsPath: string,
  templateId: string,
  options: ListOptions = {},
): ComponentDef {
  return component(id, 'List', {
    children: { path: itemsPath, componentId: templateId },
    ...options,
  })
}

export function listItem(
  id: string,
  headline?: DynamicValue<string>,
  options: ListItemOptions = {},
): ComponentDef {
  return component(id, 'ListItem', { headline, ...options })
}
