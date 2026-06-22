/**
 * Face Refresh
 *
 * Resolves face data and sends faceUpdate messages to clients.
 * Called after every tool execution and direct action execution.
 */

import type { FaceRegistry, FaceResolveDeps } from './face-loader.js'

/**
 * Callback to broadcast a faceUpdate. The broadcaster selects the correct
 * face variant per client's sizeClass and filters unsupported components.
 */
export type SendFaceUpdate = (
  appId: string,
  faceId: string,
  registry: FaceRegistry,
  data: Record<string, unknown>,
) => void

/**
 * Refresh a single face: resolve data and send faceUpdate.
 *
 * `deps.paramsByFaceId` is the caller's responsibility. For agent-loop /
 * action-handler post-tool refreshes, the caller should reload via
 * `faceParamsStore.validateAndLoad` so the broadcast reflects the params
 * the just-executed tool may have written.
 */
export function refreshFace(
  appId: string,
  faceId: string,
  registry: FaceRegistry,
  deps: FaceResolveDeps,
  sendFaceUpdate: SendFaceUpdate,
): void {
  const face = registry.get(faceId)
  if (!face) return

  const data = registry.resolveOne(faceId, deps)
  sendFaceUpdate(appId, faceId, registry, data)
}

/**
 * Refresh ALL faces for an app: resolve data and send faceUpdate for each.
 * Called after every tool execution per the design doc.
 *
 * `mountedFaceIds` caps the work to the faces currently
 * mounted on at least one client in this app's scope — `wsServer.getMountedSet()`
 * is the source of truth. Skipping unmounted faces avoids running their
 * resolver (which hits Drizzle) for nobody's benefit. When omitted (legacy
 * callers, tests), every face is resolved as before.
 */
export function refreshAllFaces(
  appId: string,
  registry: FaceRegistry,
  deps: FaceResolveDeps,
  sendFaceUpdate: SendFaceUpdate,
  mountedFaceIds?: ReadonlySet<string>,
): void {
  for (const face of registry.list()) {
    if (mountedFaceIds && !mountedFaceIds.has(face.id)) continue
    const data = registry.resolveOne(face.id, deps)
    sendFaceUpdate(appId, face.id, registry, data)
  }
}
