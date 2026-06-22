/**
 * Atom components: Text, Icon, Image, Divider
 *
 * `*Options` types are generated from `components.proto` — see
 * `./generated/options.ts`. The builder functions keep the friendly
 * positional-first signature authors expect.
 */

import type { DynamicValue } from './common.js'
import { component } from './common.js'
import type { ComponentDef } from './common.js'
import type { TextOptions, IconOptions, ImageOptions, DividerOptions } from './generated/options.js'

export type { TextOptions, IconOptions, ImageOptions, DividerOptions }

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function text(
  id: string,
  textContent?: DynamicValue<string>,
  options: TextOptions = {},
): ComponentDef {
  return component(id, 'Text', { text: textContent, ...options })
}

export function icon(
  id: string,
  name?: DynamicValue<string>,
  options: IconOptions = {},
): ComponentDef {
  return component(id, 'Icon', { name, ...options })
}

export function image(
  id: string,
  src?: DynamicValue<string>,
  options: ImageOptions = {},
): ComponentDef {
  return component(id, 'Image', { src, ...options })
}

export function divider(id: string, options: DividerOptions = {}): ComponentDef {
  return component(id, 'Divider', options)
}
