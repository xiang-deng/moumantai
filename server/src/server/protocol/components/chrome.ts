/**
 * Chrome components: Scaffold, TopBar (phone/web app framing)
 *
 * `*Options` types are generated from `components.proto` — see
 * `./generated/options.ts`.
 */

import type { DynamicValue } from './common.js'
import { component } from './common.js'
import type { ComponentDef } from './common.js'
import type { ScaffoldOptions, TopBarOptions } from './generated/options.js'
import { BodyKind } from '@moumantai/protocol/generated/moumantai/v1'

export type { ScaffoldOptions, TopBarOptions }
export { BodyKind }

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function scaffold(id: string, options: ScaffoldOptions = {}): ComponentDef {
  return component(id, 'Scaffold', options)
}

export function topBar(
  id: string,
  title?: DynamicValue<string>,
  options: TopBarOptions = {},
): ComponentDef {
  return component(id, 'TopBar', { title, ...options })
}
