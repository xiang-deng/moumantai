/**
 * AppContext.faces builder + system-prompt formatter for the `faces[]` block.
 * The LLM uses presence of `viewToolName` to detect a steerable face.
 */

import type { BootedApp } from './app-engine.js'
import type { FaceContextEntry } from './types.js'
import type { FaceParamsStore } from './face-params-store.js'
import { viewToolNameFor } from './synthesize-face-tool.js'

/**
 * Render the `context` AppContext field (LLM-visible preferences) as a
 * markdown section. Each persisted field becomes one bullet; the LLM uses
 * these as defaults when the user doesn't specify and steers updates via
 * the synthesized `update_context` tool. Empty/undefined skips the block
 * entirely (caller already gates on this).
 */
export function formatUserPreferencesBlock(context: Record<string, unknown>): string {
  const out: string[] = ['\n## User Preferences']
  out.push(
    "Persisted preferences for this app. Use as defaults when the user doesn't specify; call `update_context` to change them.",
  )
  for (const [name, value] of Object.entries(context)) {
    out.push(`- ${name}: ${JSON.stringify(value)}`)
  }
  return out.join('\n')
}

/** Render the `faces[]` AppContext field as a markdown section. */
export function formatFacesBlock(faces: FaceContextEntry[]): string {
  if (faces.length === 0) return ''
  const out: string[] = ['\n## Faces']
  for (const face of faces) {
    const lines: string[] = [
      `- **${face.label}** (face_id: "${face.id}", position: ${face.position})`,
    ]
    if (face.viewToolName) {
      lines.push(`  - View tool: \`${face.viewToolName}\``)
      if (face.paramsSchema) {
        const paramNames = Object.keys(face.paramsSchema)
        if (paramNames.length > 0) {
          const schema = face.paramsSchema
          lines.push(
            `  - Params: ${paramNames.map((n) => `\`${n}\` (${schema[n]!.type})`).join(', ')}`,
          )
        }
      }
      if (face.currentParams && Object.keys(face.currentParams).length > 0) {
        lines.push(`  - Current view: \`${JSON.stringify(face.currentParams)}\``)
      } else if (face.currentParams) {
        lines.push(`  - Current view: defaults`)
      }
    }
    out.push(lines.join('\n'))
  }
  return out.join('\n')
}

/**
 * Build the AppContext.faces array. Without `faceParamsStore` /
 * `conversationId`, parameterized faces still appear but `currentParams`
 * defaults to empty.
 */
export function buildFaceContext(
  app: BootedApp,
  conversationId: string | undefined,
  faceParamsStore: FaceParamsStore | undefined,
): FaceContextEntry[] {
  const paramsByFaceId =
    faceParamsStore && conversationId
      ? faceParamsStore.validateAndLoad(conversationId, app.manifest.id, app.faceRegistry)
      : {}

  return app.faceRegistry.list().map((face) => {
    const entry: FaceContextEntry = {
      id: face.id,
      label: face.label,
      position: face.position,
    }
    if (face.params) {
      entry.paramsSchema = face.params
      entry.currentParams = paramsByFaceId[face.id] ?? {}
      entry.viewToolName = viewToolNameFor(face.id)
    }
    return entry
  })
}
