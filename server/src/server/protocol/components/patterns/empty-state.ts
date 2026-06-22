/**
 * `emptyState` — uniform "nothing here" surface.
 *
 * Emits a centered Column with a message text and an optional Button CTA.
 * Pass `visible: pathRef('/empty')` on the outer container to show only
 * when the list is empty.
 *
 * @example
 * ```ts
 * // inbox.expanded.ts
 * column('content', ['task_list', 'empty_msg']),
 * list('task_list', '/tasks', 'task_row'),
 * ...emptyState('empty_msg', 'No tasks yet', {
 *   visible: pathRef('/empty'),
 *   action: { id: 'empty_cta', label: 'Add task', action: invokeTool('add_task') },
 * }),
 * ```
 */

import type { ComponentDef, DynamicValue, Action, ModifierProps } from '../common.js'
import { column } from '../layout.js'
import { text } from '../atoms.js'
import { button } from '../actions.js'

export interface EmptyStateOptions extends ModifierProps {
  /** Optional primary CTA button rendered below the message. */
  action?: {
    label: string
    action: Action
  }
}

export function emptyState(
  id: string,
  message: DynamicValue<string>,
  options: EmptyStateOptions = {},
): ComponentDef[] {
  const { action, ...modifier } = options
  const messageId = `${id}__message`
  const actionId = `${id}__primary`

  const children = action ? [messageId, actionId] : [messageId]
  const trees: ComponentDef[] = [
    column(id, children, {
      spacing: 12,
      horizontal_alignment: 'center',
      ...modifier,
    }),
    text(messageId, message, { typography: 'bodyMedium', text_align: 'center' }),
  ]
  if (action) {
    trees.push(button(actionId, action.label, { action: action.action }))
  }
  return trees
}
