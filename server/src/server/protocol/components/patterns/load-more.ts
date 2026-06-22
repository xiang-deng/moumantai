/**
 * `loadMore` — trailing "load more" affordance below a list.
 *
 * Emits a quiet-emphasis button with a default `expand_more` icon. Bind
 * `enabled` to a "has more" flag; the `action` fires the pagination tool.
 * On Wear, the renderer may upgrade the last-body button to EdgeButton —
 * the wire stays a plain button.
 *
 * @example
 * ```ts
 * // inbox.expanded.ts
 * column('content', ['inbox_list', 'more_btn']),
 * list('inbox_list', '/tasks', 'task_row'),
 * ...loadMore('more_btn', 'Load more', invokeTool('list_more', { offset: pathRef('/next_offset') }), {
 *   enabled: pathRef('/has_more'),
 * }),
 * ```
 */

import type { ComponentDef, DynamicValue, Action, ModifierProps } from '../common.js'
import { button } from '../actions.js'

export interface LoadMoreOptions extends ModifierProps {
  /** Bind to a "has more" flag; renderer disables when false. */
  enabled?: DynamicValue<boolean>
  /** Override the default trailing icon (`expand_more`). */
  icon?: DynamicValue<string>
}

export function loadMore(
  id: string,
  label: DynamicValue<string>,
  action: Action,
  options: LoadMoreOptions = {},
): ComponentDef[] {
  const { enabled, icon, ...modifier } = options
  return [
    button(id, label, {
      emphasis: 'quiet',
      enabled,
      icon: icon ?? 'expand_more',
      action,
      ...modifier,
    }),
  ]
}
