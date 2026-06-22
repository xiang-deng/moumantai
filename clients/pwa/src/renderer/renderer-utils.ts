// Shared renderer utilities.

import type { SurfaceState } from './action-dispatcher'
import { useAppStore } from './stores/app-store'
import { resolvePointer } from './data-model'
import { parseSurfaceId } from './RenderNode'

const FORM_PREFIX = '/$form/'

/**
 * Resolve the surface and item-scope data for dispatch.
 * Called inside event handlers — NOT during render.
 */
export function useDispatchArgs(
  surfaceId: string,
  data: Record<string, unknown>,
  itemScope?: string,
) {
  const { appId, faceId } = parseSurfaceId(surfaceId)
  const face = useAppStore.getState().apps.get(appId)?.faces.get(faceId)
  const surface: SurfaceState = {
    id: surfaceId,
    catalogId: '',
    sendDataModel: false,
    theme: null,
    components: face?.components ?? new Map(),
    data: face?.data ?? {},
  }
  const itemScopeData = itemScope
    ? (resolvePointer(data, itemScope) as Record<string, unknown> | undefined)
    : undefined
  return { surface, itemScopeData }
}

/**
 * Resolve a path against face data + form scope.
 * `/$form/<key>` reads from the form map; everything else uses JSON-Pointer.
 */
export function readDataAtPath(
  surfaceId: string,
  path: string,
  fallbackData?: Record<string, unknown>,
): unknown {
  const { appId, faceId } = parseSurfaceId(surfaceId)
  const face = useAppStore.getState().apps.get(appId)?.faces.get(faceId)
  if (path.startsWith(FORM_PREFIX)) {
    return face?.form[path.slice(FORM_PREFIX.length)]
  }
  return resolvePointer(face?.data ?? fallbackData ?? {}, path)
}

/**
 * Write a value at a path. `/$form/<key>` writes to the per-face form scope
 * (client-only, survives refreshes, cleared on navigation); everything else
 * writes to the face data tree via JSON-Pointer.
 */
export function setDataAtPath(surfaceId: string, path: string, value: unknown): void {
  const { appId, faceId } = parseSurfaceId(surfaceId)
  if (path.startsWith(FORM_PREFIX)) {
    useAppStore.getState().setFormValue(appId, faceId, path.slice(FORM_PREFIX.length), value)
    return
  }
  useAppStore.getState().setFaceDataAtPath(appId, faceId, path, value)
}
