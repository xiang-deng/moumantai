/**
 * `hero` — wrap a single child in a centered, full-bleed Box.
 *
 * Use as the primary visual on a glance face (progress ring, weather temp,
 * album art). Pair with `body_kind: BODY_KIND_CANVAS` to prevent scrolling.
 * Renderers adapt to native idiom (chin clearance on watch, etc.).
 *
 * @example
 * ```ts
 * // today.compact.ts (watch glance face)
 * defineFace({
 *   id: 'today',
 *   kind: 'compact',
 *   components: [
 *     scaffold('root', { body: 'content', body_kind: BodyKind.CANVAS }),
 *     column('content', ['hero_box', 'headline']),
 *     ...hero('hero_box', progressRing('ring', pathRef('/percent'), 100, {
 *       size: 100,
 *     })),
 *     text('headline', pathRef('/headline')),
 *   ],
 * })
 * ```
 */

import type { ComponentDef } from '../common.js'
import { box } from '../layout.js'

export function hero(boxId: string, child: ComponentDef): ComponentDef[] {
  return [box(boxId, [child.id], { content_alignment: 'center' }), child]
}
