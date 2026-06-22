/**
 * `actionRow` — primary (optionally + secondary) action anchored to the
 * bottom of a face body. Emits a Row with a FAB and an optional quiet-emphasis
 * Button. On Wear, the renderer may upgrade the last-body FAB to EdgeButton —
 * the wire stays `Fab`.
 *
 * @example
 * ```ts
 * // today.expanded.ts
 * column('content', ['ring', 'meals', 'actions']),
 * ...actionRow('actions', { label: 'Log meal', action: invokeTool('add_meal') }),
 * ```
 */

import type { ComponentDef, Action } from '../common.js'
import { row } from '../layout.js'
import { button, fab } from '../actions.js'

export interface ActionRowSpec {
  label: string
  action: Action
  /** Optional icon name for the button. */
  icon?: string
}

export function actionRow(
  id: string,
  primary: ActionRowSpec,
  secondary?: ActionRowSpec,
): ComponentDef[] {
  const primaryId = `${id}__primary`
  const secondaryId = `${id}__secondary`
  const children = secondary ? [secondaryId, primaryId] : [primaryId]
  const trees: ComponentDef[] = [
    row(id, children, {
      spacing: 8,
      horizontal_arrangement: secondary ? 'spaceBetween' : 'end',
      vertical_alignment: 'center',
    }),
    fab(primaryId, { label: primary.label, icon: primary.icon, action: primary.action }),
  ]
  if (secondary) {
    trees.push(
      button(secondaryId, secondary.label, {
        emphasis: 'quiet',
        icon: secondary.icon,
        action: secondary.action,
      }),
    )
  }
  return trees
}
