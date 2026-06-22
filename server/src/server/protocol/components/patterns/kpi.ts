/**
 * `kpi` — labeled number tile (large value above, smaller label below).
 *
 * Emits a vertically stacked Column. Renderer typography roles handle
 * per-form-factor sizing automatically (display-large on phone, scaled on
 * watch). Use for primary metrics: totals, counts, temperatures, etc.
 *
 * @example
 * ```ts
 * // summary.compact.ts
 * ...kpi('total_kpi', pathRef('/total_display'), 'spent this month'),
 * ```
 */

import type { ComponentDef, DynamicValue } from '../common.js'
import { column } from '../layout.js'
import { text } from '../atoms.js'

export interface KpiOptions {
  /** Typography role for the value. Default `'displayMedium'`. */
  valueTypography?: string
  /** Typography role for the label. Default `'labelMedium'`. */
  labelTypography?: string
}

export function kpi(
  id: string,
  value: DynamicValue<string>,
  label: DynamicValue<string>,
  options: KpiOptions = {},
): ComponentDef[] {
  const valueId = `${id}__value`
  const labelId = `${id}__label`
  return [
    column(id, [valueId, labelId], { spacing: 2, horizontal_alignment: 'center' }),
    text(valueId, value, { typography: options.valueTypography ?? 'displayMedium' }),
    text(labelId, label, { typography: options.labelTypography ?? 'labelMedium' }),
  ]
}
