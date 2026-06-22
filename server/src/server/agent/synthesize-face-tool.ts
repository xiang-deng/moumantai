/**
 * Auto-synthesizes a `view_<faceId>` tool from every FaceDefinition,
 * giving both the LLM and the user (via UI tabs / chips / buttons) a
 * uniform navigation primitive. Faces with `params` declared get a
 * parameterized tool whose args persist to the per-conversation
 * `face_params` table; faces without params get a no-arg tool that only
 * fires the navigate broadcast + face refresh.
 */

import type { ToolDefinition, FaceDefinition } from './types.js'
import type { FaceParamsStore } from './face-params-store.js'
import type { BroadcastTransport } from './broadcast.js'
import type { AppEngine } from './app-engine.js'
import { appIdToScope } from '@moumantai/protocol'

export interface SynthesizeFaceToolDeps {
  appId: string
  face: FaceDefinition
  faceParamsStore: FaceParamsStore
  transport: BroadcastTransport
  /**
   * Key under which this face's view-state persists in `face_params`. Defaults
   * to `appId`. Drafts pass a draft-scoped key (e.g. the draftId) so a draft's
   * view-state — and `sweepStaleVersions` — never collide with the live app's,
   * even though an edit draft shares the live app's id. Routing (scope compare,
   * setDeviceFocus) always uses `appId`, so the previewing client still steers
   * the real app scope.
   */
  paramsKey?: string
}

export function viewToolNameFor(faceId: string): string {
  return `view_${faceId}`
}

/**
 * Build a `view_<faceId>` tool for the given face.
 *
 * Every face gets one. `viewToolDescription` is required across the board so
 * the LLM has a stable hint for navigation; throws if missing.
 */
export function synthesizeFaceTool(deps: SynthesizeFaceToolDeps): ToolDefinition {
  const { appId, face, faceParamsStore, transport } = deps
  // Defaults to appId (live path); drafts override to isolate view-state.
  const paramsKey = deps.paramsKey ?? appId

  if (!face.viewToolDescription) {
    throw new Error(`synthesizeFaceTool: face "${face.id}" is missing viewToolDescription`)
  }

  const paramsVersion = face.paramsVersion ?? 1
  const faceScope = appIdToScope(appId)
  const hasParams = !!face.params

  return {
    name: viewToolNameFor(face.id),
    description: face.viewToolDescription,
    parameters: face.params ?? {},
    execute: async (ctx) => {
      const inputParams = ctx.params

      if (!ctx.conversationId) {
        return {
          result: null,
          error: `view_${face.id}: requires an active conversation (no conversationId in context)`,
        }
      }

      // Under merge mode the immediate `face.resolve` must run against the
      // full post-merge bag, not the input delta. `setMerged` returns the
      // merged result for that reason.
      let effectiveParams = inputParams
      if (hasParams) {
        try {
          if ((face.paramsMerge ?? 'replace') === 'merge') {
            effectiveParams = faceParamsStore.setMerged(
              ctx.conversationId,
              paramsKey,
              face.id,
              inputParams,
              paramsVersion,
            )
          } else {
            faceParamsStore.set(ctx.conversationId, paramsKey, face.id, inputParams, paramsVersion)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { result: null, error: `view_${face.id}: failed to persist params: ${message}` }
        }
      }

      // Navigate the originating device only. Suppress on cross-scope (delegated)
      // calls — home→app delegation updates view state without yanking the user.
      if (ctx.scope === faceScope && ctx.originDeviceId && transport.setDeviceFocus) {
        transport.setDeviceFocus(ctx.originDeviceId, appId, face.id)
      }

      // Resolve directly — FaceRegistry.resolveOne swallows errors for broadcast
      // paths; here errors must surface to the LLM.
      let resolved: Record<string, unknown>
      try {
        resolved = face.resolve({ db: ctx.db, params: effectiveParams })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { result: null, error: `view_${face.id}: resolve failed: ${message}` }
      }
      const data = hasParams ? { ...resolved, $params: effectiveParams } : resolved

      return {
        result: { ok: true, faceId: face.id, params: hasParams ? effectiveParams : {}, data },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Wiring entry point — synth tools for every face on this app
// ---------------------------------------------------------------------------

export interface WireSynthFaceToolsDeps {
  appId: string
  appEngine: AppEngine
  faceParamsStore: FaceParamsStore
  transport: BroadcastTransport
}

/**
 * Idempotent: drops every `view_*` tool then re-synthesizes one per face.
 * The prefix-scan is safe because face-validation reserves `view_` for synth
 * tools (rejecting app-authored tools and face ids that would collide).
 * Runs at app boot and on every hot-reload.
 */
export function wireSynthFaceTools(deps: WireSynthFaceToolsDeps): void {
  const { appId, appEngine, faceParamsStore, transport } = deps
  const app = appEngine.getApp(appId)
  if (!app) throw new Error(`wireSynthFaceTools: app "${appId}" is not booted`)

  for (const toolName of [...app.toolRegistry.keys()]) {
    if (toolName.startsWith('view_')) appEngine.removeTool(appId, toolName)
  }

  for (const face of app.faceRegistry.list()) {
    appEngine.addTool(appId, synthesizeFaceTool({ appId, face, faceParamsStore, transport }))
  }

  faceParamsStore.sweepStaleVersions(appId, app.faceRegistry)
}
