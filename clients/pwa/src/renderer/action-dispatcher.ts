/**
 * Action dispatcher.
 *
 * Walks an `Action`, resolves `{path: "..."}` placeholders in `args` against
 * face data + itemScope + `$form`, generates a `client_request_id`, and sends
 * an `InvokeToolMsg`. Errors are surfaced via `ServerMessage.error`.
 */

import type { Action, ComponentDef } from '@moumantai/protocol/generated/moumantai/v1'
import { useAppStore } from './stores/app-store'
import { resolvePointer } from './data-model'
import { parseSurfaceId } from './RenderNode'

export interface SurfaceState {
  id: string
  catalogId: string
  sendDataModel: boolean
  theme: Record<string, string> | null
  components: Map<string, ComponentDef>
  data: Record<string, unknown>
}

/**
 * Send hook — typed wrapper around the transport's `sendInvokeTool`.
 * Decoupling the transport keeps the dispatcher testable in isolation.
 */
export type SendInvokeTool = (
  toolName: string,
  args: Record<string, unknown> | undefined,
  sourceFaceId: string,
  clientRequestId: string,
  /**
   * Forwarded verbatim from `Action.escalationPrompt`. When the tool reports
   * missing-required, the server posts this string to chat instead of
   * burning an LLM turn to phrase the question. Absent → server runs the
   * normal LLM-driven escalation.
   */
  escalationPrompt?: string,
) => void

/**
 * Walk a Struct-shaped value and substitute every `{path: "..."}` placeholder.
 * Path flavors: `/$form/<key>` (form scope), `$.<field>` / `<field>` (relative
 * to itemScope), `/...` (absolute JSON-Pointer into face data).
 */
function resolveArgs(
  value: unknown,
  data: Record<string, unknown>,
  form: Record<string, unknown>,
  itemScope?: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, data, form, itemScope))

  const v = value as Record<string, unknown>
  // Placeholder: object with exactly `{path: "..."}`.
  if ('path' in v && typeof v['path'] === 'string' && Object.keys(v).length === 1) {
    return resolvePath(v['path'] as string, data, form, itemScope)
  }
  // Generic object — recurse into each entry.
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v)) {
    out[k] = resolveArgs(val, data, form, itemScope)
  }
  return out
}

function resolvePath(
  path: string,
  data: Record<string, unknown>,
  form: Record<string, unknown>,
  itemScope?: Record<string, unknown>,
): unknown {
  if (path.startsWith('/$form/')) {
    return form[path.slice('/$form/'.length)]
  }
  if (path.startsWith('/')) {
    return resolvePointer(data, path)
  }
  // Relative path → resolved against the current item scope (list row).
  if (itemScope) {
    const key = path.startsWith('$.') ? path.slice(2) : path
    return itemScope[key]
  }
  return undefined
}

export type DispatchFn = (
  action: Action,
  surface: SurfaceState,
  sourceComponentId: string,
  itemScope?: Record<string, unknown>,
) => void

/**
 * Build the dispatcher. The returned function is what every interactive
 * renderer (`button`, `chip`, `switchToggle` with `action`, etc.) calls
 * on user interaction.
 */
export function createDispatcher(send: SendInvokeTool): DispatchFn {
  return function dispatch(
    action: Action,
    surface: SurfaceState,
    _sourceComponentId: string,
    itemScope?: Record<string, unknown>,
  ): void {
    if (!action || !action.tool) return

    const { appId, faceId } = parseSurfaceId(surface.id)

    // Pull the per-face form scope. No inputs yet → empty object;
    // `$form` placeholders resolve to undefined and the server rejects clearly.
    const face = useAppStore.getState().apps.get(appId)?.faces.get(faceId)
    const form = face?.form ?? {}

    const resolvedArgs = action.args
      ? (resolveArgs(action.args, surface.data, form, itemScope) as Record<string, unknown>)
      : undefined

    const clientRequestId = generateClientRequestId()
    send(action.tool, resolvedArgs, faceId, clientRequestId, action.escalationPrompt)
  }
}

function generateClientRequestId(): string {
  return crypto.randomUUID()
}
