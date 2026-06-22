/**
 * `statusBadge` — small inline status label for transient state on rows/cards
 * ("LIVE", "FINAL", "OFFLINE", "OVERDUE"). Emits a `chip`; without `selected:`
 * it renders as an assist chip. Pass `selected` to light up an active state,
 * `tone: 'error'` / `'warning'` for semantic urgency.
 *
 * @example
 * ```ts
 * // game_card.parts.ts (or any list item)
 * ...statusBadge('live_pill', 'LIVE', { selected: pathRef('$.is_live') }),
 * ```
 */

import type { ComponentDef, DynamicValue, ModifierProps } from '../common.js'
import type { ChipTone } from '@moumantai/protocol/design-system/sdk-types'
import { chip } from '../actions.js'

export interface StatusBadgeOptions extends ModifierProps {
  /** Optional leading icon (Material name; `fa:` prefix for FontAwesome). */
  icon?: DynamicValue<string>
  /** Optional emphasis flag (e.g. live = true, scheduled = false). */
  selected?: DynamicValue<boolean>
  /** Semantic color role for the badge. */
  tone?: ChipTone
}

export function statusBadge(
  id: string,
  label: DynamicValue<string>,
  options: StatusBadgeOptions = {},
): ComponentDef[] {
  const { icon, selected, tone, ...modifier } = options
  return [
    chip(id, label, {
      icon,
      selected,
      tone,
      ...modifier,
    }),
  ]
}
