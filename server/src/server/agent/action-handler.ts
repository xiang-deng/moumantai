/**
 * Invoke-tool handler — fast path for client-initiated tool calls.
 *
 * When a face button (or other interactive component) fires its `Action`,
 * the client sends an `InvokeToolMsg` and the server routes it here. Runs
 * through the same `executeTool` path the LLM uses, then refreshes faces.
 *
 * Three guarantees:
 *   1. Persistent dedup on `(conversation_id, client_request_id)` — survives
 *      server restart so Wear's offline-queue replay is safe.
 *   2. Per-conversation serialization — user invocations queue FIFO behind any
 *      in-flight LLM turn, preventing DB races.
 *   3. Errors surface via `ServerMessage.error` (typed wire), not by throwing.
 *
 * Missing-required-arg escalation. When `executeTool` reports `missing`
 * (UI-invocation path only), this handler calls `runEscalationTurn` to drive
 * one agent turn with a `[ui_action] ...` synthetic prompt. Only the
 * assistant's question lands in `conversationStore` — the synthetic prompt is
 * not displayed. The next typed user reply sees the full `[ui_action] ...
 * <answer>` context and calls the mutation tool with typed values.
 */

import type { ToolDefinition, ToolResult, HttpClient, StalenessRecord } from './types.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { FaceRegistry } from './face-loader.js'
import type { FaceParamsStore } from './face-params-store.js'
import type { SendFaceUpdate } from './face-refresh.js'
import type { DedupStore } from './dedup-store.js'
import type { ConversationStore } from '../conversations/store.js'
import type { TurnQueue } from './turn-queue.js'
import { executeTool } from './tool-executor.js'
import { formatUiActionPrompt } from './format-ui-action.js'
import { refreshAllFaces } from './face-refresh.js'
import { appIdToScope } from '@moumantai/protocol'

export type InvokeToolErrorCode = 'tool_not_found' | 'tool_validation' | 'internal'

export interface InvokeToolError {
  code: InvokeToolErrorCode
  message: string
}

export interface InvokeToolOutcome {
  /** The tool result on success; null when the tool returned no payload. */
  result: ToolResult | null
  /** Set when execution failed; client surfaces via ServerMessage.error. */
  error: InvokeToolError | null
  /** True when the request was a duplicate of a prior invocation. */
  deduped: boolean
  /**
   * True when missing required args triggered a chat escalation — the agent
   * asked the user for the values; the mutation tool did NOT run. Transports
   * can use this to auto-focus chat without conflating it with a tool error.
   */
  escalated?: boolean
}

/**
 * One escalation turn driven from inside `handleInvokeTool`. Returns the
 * assistant's question text plus optional tool calls / SDK session id.
 *
 * Built per-request in `main.ts`, keeping action-handler free of wiring
 * details. Accepts an `AbortSignal` so the action-handler can cancel a
 * hung LLM turn (user types a reply, conversation reset, or 60s timeout).
 */
export interface EscalationTurnResult {
  success: boolean
  text: string
  sdkSessionId?: string
  toolCalls: { name: string; args: Record<string, unknown>; result: unknown }[]
}
export type RunEscalationTurn = (
  promptText: string,
  signal?: AbortSignal,
) => Promise<EscalationTurnResult>

export interface HandleInvokeToolDeps {
  toolRegistry: Map<string, ToolDefinition>
  faceRegistry: FaceRegistry
  db: BetterSQLite3Database
  appId: string
  sendFaceUpdate: SendFaceUpdate
  /** Persistent dedup keyed (conversationId, clientRequestId), 24h TTL. */
  dedupStore?: DedupStore
  /**
   * Loads view-state for face refresh. Without this (legacy callers, tests),
   * faces refresh with default params.
   */
  faceParamsStore?: FaceParamsStore
  /**
   * LLM-visible app preferences. Threaded into the post-tool face
   * refresh so default-from-preference logic in resolvers stays in sync
   * with the same `context` populated for the LLM. Optional — refresh runs
   * with `{}` when omitted (tests).
   */
  context?: Record<string, unknown>
  /**
   * Stable deviceId of the originating device. Threaded into
   * ToolContext so navigate-driving tools (synthesized view_<faceId>)
   * target this device — without it, `setDeviceFocus` is a no-op and the
   * device never auto-switches to the requested face.
   */
  originDeviceId?: string
  /** Per-app HTTP client. Threaded into ToolContext. */
  http?: HttpClient
  /** Per-app asset cache. */
  cacheAsset?: (url: string) => Promise<string>
  /** Per-task staleness factory. */
  staleness?: (taskId: string) => StalenessRecord
  /** Face-bound staleness lookup. Resolves selfStaleness?() on FaceResolve. */
  faceStaleness?: (faceId: string, params: Record<string, unknown>) => StalenessRecord | null
  /**
   * Returns the set of faceIds currently mounted on at least one client in
   * this app's scope. Used to cap the post-tool refresh to faces actually
   * being viewed. Optional — when absent, every face is resolved.
   */
  getMountedFaceIds?: () => ReadonlySet<string>
  /** Typed app config. */
  config?: Record<string, unknown>
  /**
   * Active LLM backend ('claude' | 'pi' | …). Passed to `bindSdkSession`
   * so the conversation row records which SDK produced its session id.
   * Optional for legacy tests that don't exercise SDK binding.
   */
  backend?: string
  /** Atomic write to context.json. */
  setContext?: (field: string, value: unknown) => Promise<void>
  /**
   * Conversation id of the active chat. Required for dedup, transcript
   * injection, and per-conversation serialization. When absent, the call
   * runs without those guarantees (mostly relevant in tests).
   */
  conversationId?: string
  /**
   * The store the escalation branch appends the assistant question to;
   * also broadcasts to every socket viewing the conversation's scope via
   * the existing `store.on('append')` pipeline. Optional — when absent,
   * no chat row is appended (suitable for tests that don't exercise chat).
   */
  conversationStore?: ConversationStore
  /** Identifies the originating face — used in the escalation prompt context. */
  sourceFaceId?: string
  /** Client-generated UUID enabling idempotent retry. Required for dedup. */
  clientRequestId?: string
  /**
   * Author-supplied escalation message, forwarded from
   * `Action.escalation_prompt` via `InvokeToolMsg.escalation_prompt`. When
   * set and the tool reports missing-required, the templated branch in
   * `escalateMissing` skips `runEscalationTurn` and posts this string
   * verbatim to chat. The next user reply runs the normal agent loop with
   * the synthetic `[ui_action]` context prepended (see `main.ts:onChatInput`).
   */
  escalationPrompt?: string
  /**
   * Shared per-conversation queue. Routing user invocations through the same
   * primitive the agent loop uses serializes them against any in-flight LLM
   * turn (FIFO), preventing DB races. Omit in tests that don't need it.
   */
  turnQueue?: TurnQueue
  /**
   * Closure that runs ONE escalation turn against the agent SDK. Required
   * for chat escalation on missing-required UI taps; without it, missing
   * args fold into a normal `tool_validation` error. Tests that don't
   * exercise escalation may omit it.
   */
  runEscalationTurn?: RunEscalationTurn
  /**
   * Fires the moment escalation kicks off — BEFORE the LLM closure is
   * awaited — so the originating client can refocus its chat surface and
   * show a thinking indicator within ~50ms instead of after the 1–3s SDK
   * latency. Also fires on the early-block path (a tap that hits the
   * pendingEscalations short-circuit) so a duplicate tap still refocuses
   * chat. Wrapped in try/catch by the caller — a failed `wsServer.send`
   * (disconnected socket) does not abort the escalation flow.
   */
  onEscalationStarted?: (scope: string) => void
}

// ---------------------------------------------------------------------------
// Pending-escalation state
// ---------------------------------------------------------------------------

/** Safety timeout for LLM-path escalations. 60s catches a wedged closure. */
const ESCALATION_TIMEOUT_MS = 60_000

/** Safety timeout for templated escalations (no LLM call to wedge). 30 min
 *  is long enough for a briefly-distracted user but short enough to prevent
 *  abandoned entries from accumulating. */
const TEMPLATED_PENDING_TIMEOUT_MS = 30 * 60_000

export interface PendingEscalation {
  scope: string
  abort: AbortController
  timeoutHandle: ReturnType<typeof setTimeout>
  /**
   * Synthetic `[ui_action] face=X tool=Y missing=[...]` context — set only
   * for templated escalations. `main.ts:onChatInput` prepends this to the
   * user's reply so the SDK sees the same context the LLM path writes via
   * jsonl. Unset for LLM-path entries (written directly by `runEscalationTurn`).
   */
  syntheticPrompt?: string
}

/**
 * Conversations awaiting a user reply to an escalation question. Set when
 * `escalateMissing` starts an LLM turn; cleared on user chat input,
 * conversation reset, escalation failure, or the safety timeout.
 *
 * In-memory — lost on server restart. A re-tap after restart may produce a
 * duplicate question, but the SDK jsonl preserves the [ui_action] line so
 * subsequent typed replies still resolve correctly via session resume.
 */
const pendingEscalations = new Map<string, PendingEscalation>()

/**
 * Test-only: clear all module state. Sister tests can call this between
 * cases to avoid cross-test bleed.
 */
export function _resetPendingEscalationsForTesting(): void {
  for (const entry of pendingEscalations.values()) {
    clearTimeout(entry.timeoutHandle)
    entry.abort.abort()
  }
  pendingEscalations.clear()
}

/**
 * Drop a pending escalation, abort its in-flight LLM turn, and clear the
 * safety timer. Returns the cleared entry so callers can read its
 * `syntheticPrompt` — `main.ts:onChatInput` prepends the `[ui_action]`
 * context to the user's reply on the templated path.
 */
export function clearPendingEscalation(conversationId: string): PendingEscalation | null {
  const entry = pendingEscalations.get(conversationId)
  if (!entry) return null
  clearTimeout(entry.timeoutHandle)
  entry.abort.abort()
  pendingEscalations.delete(conversationId)
  return entry
}

/**
 * Drop pending entries matching a scope. Reset events carry only the new
 * conversationId, so we look up the old entry by its stored scope.
 */
export function clearPendingEscalationsByScope(scope: string): void {
  for (const [convId, entry] of pendingEscalations) {
    if (entry.scope !== scope) continue
    clearTimeout(entry.timeoutHandle)
    entry.abort.abort()
    pendingEscalations.delete(convId)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a client-initiated tool invocation. Looks up the tool, runs it
 * through `executeTool`, refreshes affected faces. On missing required args,
 * escalates to a chat dialog via `deps.runEscalationTurn`. Never throws.
 *
 * Repeat-tap protection: while an escalation question is pending, further
 * taps short-circuit to `{escalated: true, deduped: true}` — the
 * `onEscalationStarted` callback still fires so the client refocuses chat,
 * but no second LLM turn runs.
 */
export async function handleInvokeTool(
  toolName: string,
  args: Record<string, unknown>,
  deps: HandleInvokeToolDeps,
): Promise<InvokeToolOutcome> {
  // Pending-block runs BEFORE dedup-lookup: a retap during a pending
  // escalation must still carry `escalated:true` for the chat-refocus hint.
  if (deps.conversationId) {
    const entry = pendingEscalations.get(deps.conversationId)
    if (entry) {
      if (deps.onEscalationStarted) {
        try {
          deps.onEscalationStarted(entry.scope)
        } catch (err) {
          console.warn('[handleInvokeTool] onEscalationStarted (early-block) failed:', err)
        }
      }
      return { result: null, error: null, deduped: true, escalated: true }
    }
  }

  // Pre-check avoids enqueueing a known retry; re-check inside the queue
  // closes the race if a concurrent retry slips through.
  const dedupHit = lookupDedup(deps)
  if (dedupHit) return dedupHit

  const task = async (): Promise<InvokeToolOutcome> => {
    const inside = lookupDedup(deps)
    if (inside) return inside
    return executeAndRecord(toolName, args, deps)
  }

  if (deps.turnQueue && deps.conversationId) {
    try {
      return await deps.turnQueue.enqueue(deps.conversationId, {
        run: () => task(),
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      const message = QUEUE_ERROR_MESSAGE[e.name] ?? e.message
      return { result: null, deduped: false, error: { code: 'internal', message } }
    }
  }

  return task()
}

const QUEUE_ERROR_MESSAGE: Record<string, string> = {
  SessionBusyError: 'session_busy',
  AbortError: 'aborted',
}

function lookupDedup(deps: HandleInvokeToolDeps): InvokeToolOutcome | null {
  if (!deps.dedupStore || !deps.conversationId || !deps.clientRequestId) return null
  const hit = deps.dedupStore.lookup(deps.conversationId, deps.clientRequestId)
  if (!hit) return null
  return { result: hit.result, error: null, deduped: true }
}

async function executeAndRecord(
  toolName: string,
  args: Record<string, unknown>,
  deps: HandleInvokeToolDeps,
): Promise<InvokeToolOutcome> {
  const tool = deps.toolRegistry.get(toolName)
  if (!tool) {
    return {
      result: null,
      deduped: false,
      error: { code: 'tool_not_found', message: `Tool not found: "${toolName}"` },
    }
  }

  let result: ToolResult
  try {
    result = await executeTool(
      tool,
      args,
      {
        db: deps.db,
        conversationId: deps.conversationId,
        scope: appIdToScope(deps.appId),
        ...(deps.originDeviceId ? { originDeviceId: deps.originDeviceId } : {}),
        context: deps.context,
        http: deps.http,
        cacheAsset: deps.cacheAsset,
        staleness: deps.staleness,
        config: deps.config,
        setContext: deps.setContext,
      },
      { isUIInvocation: true },
    )
  } catch (err) {
    // Hits only on infrastructure failures (timeout etc.); executeTool normally
    // wraps tool throws into ToolResult.error.
    return {
      result: null,
      deduped: false,
      error: {
        code: 'internal',
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }

  // Missing-required UI tap → escalate to chat dialog. The tool does NOT run;
  // the next typed turn calls it with the collected values.
  if (result.missing) {
    return await escalateMissing(tool, result.missing, deps)
  }

  if (result.error) {
    return {
      result,
      deduped: false,
      error: { code: 'tool_validation', message: result.error },
    }
  }

  // Record dedup before the broadcast so a near-instant retry hits the cache.
  if (deps.dedupStore && deps.conversationId && deps.clientRequestId) {
    try {
      deps.dedupStore.record(deps.conversationId, deps.clientRequestId, result)
    } catch (err) {
      console.warn('[handleInvokeTool] dedup record failed:', err)
    }
  }

  const paramsByFaceId =
    deps.faceParamsStore && deps.conversationId
      ? deps.faceParamsStore.validateAndLoad(deps.conversationId, deps.appId, deps.faceRegistry)
      : {}
  refreshAllFaces(
    deps.appId,
    deps.faceRegistry,
    {
      db: deps.db,
      paramsByFaceId,
      context: deps.context,
      staleness: deps.staleness,
      faceStaleness: deps.faceStaleness,
    },
    deps.sendFaceUpdate,
    deps.getMountedFaceIds?.(),
  )

  return { result, error: null, deduped: false }
}

/**
 * Drive one agent turn asking the user for missing args, append the
 * assistant question to chat, and record a dedup row so a retap doesn't
 * re-burn an LLM call.
 *
 * Lifecycle:
 *   1. Fire `onEscalationStarted` before awaiting the LLM so the client
 *      refocuses chat within ~50ms.
 *   2. Set the `pendingEscalations` flag and a safety timer (60s LLM-path,
 *      30min templated) so re-taps short-circuit.
 *   3. Run the LLM with an AbortSignal so external cleanup (user replies,
 *      conversation reset, timeout) can cancel the call.
 *   4. On success: append the question, bind SDK session, record dedup,
 *      leave the pending flag set (cleared by user reply or reset).
 *      On any failure: clear the pending flag so the user can retry.
 */
async function escalateMissing(
  tool: ToolDefinition,
  missing: { fields: string[]; provided: Record<string, unknown> },
  deps: HandleInvokeToolDeps,
): Promise<InvokeToolOutcome> {
  const isTemplated = deps.escalationPrompt !== undefined

  // Without a closure or template, there's no way to ask for the missing
  // values — degrade to a validation error so the failure is observable.
  if (!isTemplated && !deps.runEscalationTurn) {
    const first = missing.fields[0]
    return {
      result: { result: null, error: `Missing required parameter: "${first}"` },
      deduped: false,
      error: { code: 'tool_validation', message: `Missing required parameter: "${first}"` },
    }
  }

  const scope = appIdToScope(deps.appId)
  const syntheticPrompt = formatUiActionPrompt({
    faceId: deps.sourceFaceId ?? 'unknown',
    tool,
    missing: missing.fields,
    provided: missing.provided,
  })

  // Set the pending entry before firing onEscalationStarted so a concurrent
  // tap in the same microtask sees the flag and short-circuits.
  const abort = new AbortController()
  let success = false
  if (deps.conversationId) {
    const convId = deps.conversationId
    const timeoutMs = isTemplated ? TEMPLATED_PENDING_TIMEOUT_MS : ESCALATION_TIMEOUT_MS
    const timeoutHandle = setTimeout(() => {
      clearPendingEscalation(convId)
    }, timeoutMs)
    pendingEscalations.set(convId, {
      scope,
      abort,
      timeoutHandle,
      ...(isTemplated ? { syntheticPrompt } : {}),
    })
  }

  // Fire early so the client can refocus chat within ~50ms. Swallow send
  // errors (disconnected socket) so they don't abort the escalation.
  if (deps.onEscalationStarted) {
    try {
      deps.onEscalationStarted(scope)
    } catch (err) {
      console.warn('[handleInvokeTool] onEscalationStarted failed:', err)
    }
  }

  try {
    // Templated path: post the author's prompt verbatim, record dedup, leave
    // the pending entry set. The SDK session is not touched here —
    // `main.ts:onChatInput` prepends the synthetic context to the user's
    // reply so the LLM sees the `[ui_action]` line and calls the tool.
    if (isTemplated) {
      if (deps.conversationStore && deps.conversationId) {
        try {
          deps.conversationStore.appendTurn(deps.conversationId, {
            role: 'assistant',
            text: deps.escalationPrompt!,
            turnMode: 'direct_user_chat',
          })
        } catch (err) {
          console.warn('[handleInvokeTool] templated escalation appendTurn failed:', err)
        }
      }
      if (deps.dedupStore && deps.conversationId && deps.clientRequestId) {
        try {
          deps.dedupStore.record(deps.conversationId, deps.clientRequestId, null)
        } catch (err) {
          console.warn('[handleInvokeTool] dedup record (templated) failed:', err)
        }
      }
      success = true
      return { result: null, error: null, deduped: false, escalated: true }
    }

    // LLM path: drive one agent turn that produces the assistant question.
    let turn: EscalationTurnResult
    try {
      turn = await deps.runEscalationTurn!(syntheticPrompt, abort.signal)
    } catch (err) {
      return {
        result: null,
        deduped: false,
        error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
      }
    }
    if (!turn.success) {
      return {
        result: null,
        deduped: false,
        error: { code: 'internal', message: turn.text || 'escalation failed' },
      }
    }

    // Append to conversationStore — the store's append event drives the
    // scope-broadcast pipeline so all devices see the question.
    if (deps.conversationStore && deps.conversationId) {
      try {
        deps.conversationStore.appendTurn(deps.conversationId, {
          role: 'assistant',
          text: turn.text,
          // Reuse the existing turn mode — this IS a direct chat exchange
          // with the user, just kicked off by a UI tap rather than typed input.
          turnMode: 'direct_user_chat',
          ...(turn.toolCalls?.length ? { toolCalls: turn.toolCalls } : {}),
        })
      } catch (err) {
        console.warn('[handleInvokeTool] escalation appendTurn failed:', err)
      }
    }

    // First turn binds the SDK session id (mirrors main.ts:runUserTurn pattern).
    if (turn.sdkSessionId && deps.conversationStore && deps.conversationId) {
      // `backend` must be threaded by production callers; warn loudly on
      // omission — defaulting to 'claude' is wrong if another backend is active.
      if (!deps.backend) {
        console.warn(
          '[handleInvokeTool] bindSdkSession called without deps.backend; defaulting to "claude". ' +
            'This is correct only when the server-wide backend is Claude. Wire `backend` through.',
        )
      }
      try {
        deps.conversationStore.bindSdkSession(
          deps.conversationId,
          turn.sdkSessionId,
          deps.backend ?? 'claude',
        )
      } catch (err) {
        console.warn('[handleInvokeTool] bindSdkSession failed:', err)
      }
    }

    // Record dedup so a retap replays the same outcome (no second LLM turn).
    // result_json is null — the mutation tool fires on the user's answer turn.
    if (deps.dedupStore && deps.conversationId && deps.clientRequestId) {
      try {
        deps.dedupStore.record(deps.conversationId, deps.clientRequestId, null)
      } catch (err) {
        console.warn('[handleInvokeTool] dedup record (escalation) failed:', err)
      }
    }

    success = true
    return { result: null, error: null, deduped: false, escalated: true }
  } finally {
    // Clear on any failure so the user can retry. The success path leaves
    // the flag set until the user replies or the conversation is reset.
    if (!success && deps.conversationId) {
      clearPendingEscalation(deps.conversationId)
    }
  }
}
