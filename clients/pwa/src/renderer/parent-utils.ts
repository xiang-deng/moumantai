import type { RenderParent } from './RenderNode'

/**
 * A Column that is the immediate child of `Scaffold.body` auto-centers
 * horizontally when no explicit `horizontalAlignment` is set.
 *
 * Convention shared with Android (`clients/android/.../Layout.kt:101-105`)
 * and Wear (`clients/wear-os/.../WearComposites.kt:155-163`). The catalog
 * deliberately does NOT encode this — alignment is authoring-time only.
 * This helper is the named home for the cross-renderer rule so future
 * readers find it by grep, not by squinting at a one-off inline branch.
 */
export function isBodyTopColumn(parent: RenderParent): boolean {
  return parent.kind === 'Scaffold' && parent.slotName === 'body'
}
