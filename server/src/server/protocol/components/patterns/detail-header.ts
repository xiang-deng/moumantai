/**
 * `detailHeader` — Scaffold top-bar with optional navigation and trailing
 * actions. Pairs with `scaffold('root', { top_bar: <id>, body: ... })`.
 * Do NOT use in compact face files (`*.compact.ts`); compact layouts omit
 * TopBar to preserve the limited content area.
 *
 * @example
 * ```ts
 * // scoreboard.expanded.ts
 * defineFace({
 *   id: 'scoreboard',
 *   kind: 'expanded',
 *   components: [
 *     scaffold('root', { body: 'content', top_bar: 'header' }),
 *     ...detailHeader('header', 'Sports'),
 *     column('content', [...]),
 *   ],
 * })
 * ```
 */

import type { ComponentDef, DynamicValue } from '../common.js'
import { topBar, type TopBarOptions } from '../chrome.js'

// `navigation_action` and `actions` come from TopBarOptions.
export type DetailHeaderOptions = TopBarOptions

export function detailHeader(
  id: string,
  title: DynamicValue<string>,
  options: DetailHeaderOptions = {},
): ComponentDef[] {
  return [topBar(id, title, options)]
}
