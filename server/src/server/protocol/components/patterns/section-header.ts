/**
 * `sectionHeader` — section title within a face body.
 *
 * Emits a `labelLarge` Text with an optional supporting subtitle. Renderers
 * translate the typography role to their native scale (watch gets a smaller
 * header automatically). Use the same pattern for compact and expanded faces.
 *
 * @example
 * ```ts
 * // today.expanded.ts
 * column('content', ['hdr_pending', 'pending_list', 'hdr_done', 'done_list']),
 * ...sectionHeader('hdr_pending', 'Today'),
 * list('pending_list', '/pending', 'task_row'),
 * ...sectionHeader('hdr_done', 'Completed', { supporting: pathRef('/done_count') }),
 * list('done_list', '/done', 'task_row'),
 * ```
 */

import type { ComponentDef, DynamicValue } from '../common.js'
import { column } from '../layout.js'
import { text } from '../atoms.js'

export interface SectionHeaderOptions {
  /** Optional supporting subtitle rendered below the title in `labelSmall`. */
  supporting?: DynamicValue<string>
  /**
   * Visibility gate path. When set, the pattern's outermost component carries
   * `visible: pathRef(visiblePath)` so the section collapses cleanly when the
   * resolver flips it false.
   */
  visible?: DynamicValue<boolean>
}

export function sectionHeader(
  id: string,
  title: DynamicValue<string>,
  options: SectionHeaderOptions = {},
): ComponentDef[] {
  const { supporting, visible } = options
  if (supporting === undefined) {
    return [
      text(id, title, {
        typography: 'labelLarge',
        font_weight: 'bold',
        visible,
      }),
    ]
  }
  const titleId = `${id}__title`
  const supportingId = `${id}__supporting`
  return [
    column(id, [titleId, supportingId], { spacing: 2, visible }),
    text(titleId, title, { typography: 'labelLarge', font_weight: 'bold' }),
    text(supportingId, supporting, { typography: 'labelSmall' }),
  ]
}
