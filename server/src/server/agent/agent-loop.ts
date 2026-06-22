/**
 * Agent Loop — core orchestrator for agentic interaction.
 *
 * Consumes AgentEvent stream from the adapter, executes tool calls
 * sequentially, refreshes faces after each tool, and buffers text
 * for final delivery to the client.
 *
 * Design doc: "Server orchestrates. Adapter just translates wire format."
 */

import type {
  LLMAdapter,
  AgentRequest,
  AgentTodoItem,
  ToolDefinition,
  ToolResult,
  HttpClient,
  StalenessRecord,
} from './types.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { FaceRegistry } from './face-loader.js'
import type { FaceParamsStore } from './face-params-store.js'
import { executeTool } from './tool-executor.js'
import { refreshAllFaces, type SendFaceUpdate } from './face-refresh.js'
import { appIdToScope } from '@moumantai/protocol'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentLoopDeps {
  adapter: LLMAdapter
  toolRegistry: Map<string, ToolDefinition>
  faceRegistry: FaceRegistry
  db: BetterSQLite3Database
  appId: string
  sendFaceUpdate: SendFaceUpdate
  /**
   * Per-conversation view-state store. Reloaded before each face refresh so
   * broadcasts reflect `view_*` calls made during the current turn.
   */
  faceParamsStore?: FaceParamsStore
  /**
   * LLM-visible app preferences. Threaded into face resolves so
   * default-from-preference logic sees the same context the LLM sees.
   * Optional — AgentLoop runs with `{}` when omitted.
   */
  context?: Record<string, unknown>
  /** Per-app HTTP client. Threaded into ToolContext so refresh-aware tools hit upstream. */
  http?: HttpClient
  /** Per-app asset cache. */
  cacheAsset?: (url: string) => Promise<string>
  /** Per-task staleness factory. Forwarded to ToolContext + face resolve. */
  staleness?: (taskId: string) => StalenessRecord
  /** Face-bound staleness lookup. Resolves selfStaleness?() on FaceResolve. */
  faceStaleness?: (faceId: string, params: Record<string, unknown>) => StalenessRecord | null
  /** Typed app config. */
  config?: Record<string, unknown>
  /** Atomic write to context.json. */
  setContext?: (field: string, value: unknown) => Promise<void>
  /**
   * Returns the set of faceIds currently mounted on at least one client
   * in this app's scope. Called right before each post-tool refresh to
   * cap work to faces that actually need to broadcast. Optional — when
   * absent, every face is resolved (legacy behavior).
   */
  getMountedFaceIds?: () => ReadonlySet<string>
  /**
   * Mid-turn progress sink for the edit-agent's `TodoWrite` checklist.
   * The dev-turn path broadcasts a `ChatTodosUpdate` to previewing clients.
   * Omitted by the app-agent — `todosUpdate` events are then a no-op.
   */
  onTodos?: (todos: AgentTodoItem[]) => void
}

export interface AgentLoopResult {
  text: string
  toolCalls: { name: string; args: Record<string, unknown>; result: unknown }[]
  success: boolean
  /**
   * SDK session UUID reported by the adapter's `sessionBound` event. Only
   * set when a fresh session was created on this turn — used by the caller
   * to persist it alongside the conversation row for resume.
   */
  sdkSessionId?: string
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private deps: AgentLoopDeps
  private cancelRequested = false

  constructor(deps: AgentLoopDeps) {
    this.deps = deps
  }

  /**
   * Run a single conversation turn.
   *
   * - Text events are accumulated (buffered, not sent to client)
   * - Tool calls are executed sequentially, faces refreshed after each
   * - Done event triggers return of accumulated text
   * - Error event returns the error message
   * - Cancellation discards buffered text
   */
  async runTurn(request: AgentRequest): Promise<AgentLoopResult> {
    this.cancelRequested = false
    const signal = request.signal
    let accumulatedText = ''
    let sdkSessionId: string | undefined
    const toolCalls: AgentLoopResult['toolCalls'] = []

    // External abort cascades into the internal cancel flag so loop + adapter
    // tear down together.
    const onAbort = () => {
      this.cancelRequested = true
    }
    if (signal) {
      if (signal.aborted) return { text: '', toolCalls, success: false }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for await (const event of this.deps.adapter.run(request)) {
        if (this.cancelRequested) {
          return { text: '', toolCalls, success: false, sdkSessionId }
        }

        switch (event.type) {
          case 'text':
            accumulatedText += event.text
            break

          case 'sessionBound':
            sdkSessionId = event.sdkSessionId
            break

          case 'todosUpdate':
            // No-op when onTodos is omitted (app-agent never emits this).
            this.deps.onTodos?.(event.todos)
            break

          case 'toolCall': {
            const tool = this.deps.toolRegistry.get(event.name)
            let result: ToolResult

            if (tool) {
              // LLM-direct: default isUIInvocation=false so missing required
              // args surface as normal errors rather than escalations.
              result = await executeTool(tool, event.args, {
                db: this.deps.db,
                conversationId: request.conversationId,
                scope: appIdToScope(this.deps.appId),
                originDeviceId: request.originDeviceId,
                context: this.deps.context,
                http: this.deps.http,
                cacheAsset: this.deps.cacheAsset,
                staleness: this.deps.staleness,
                config: this.deps.config,
                setContext: this.deps.setContext,
              })
            } else {
              result = { result: null, error: `Unknown tool: ${event.name}` }
            }

            toolCalls.push({
              name: event.name,
              args: event.args,
              result: result.error ?? result.result,
            })

            this.deps.adapter.submitToolResult(request.conversationId, event.callId, result)

            // Refresh all faces. Reload paramsByFaceId so view_<faceId> calls
            // made during this tool execution are reflected in the broadcast.
            const paramsByFaceId =
              this.deps.faceParamsStore?.validateAndLoad(
                request.conversationId,
                this.deps.appId,
                this.deps.faceRegistry,
              ) ?? {}
            refreshAllFaces(
              this.deps.appId,
              this.deps.faceRegistry,
              {
                db: this.deps.db,
                paramsByFaceId,
                context: this.deps.context,
                staleness: this.deps.staleness,
                faceStaleness: this.deps.faceStaleness,
              },
              this.deps.sendFaceUpdate,
              this.deps.getMountedFaceIds?.(),
            )
            break
          }

          case 'done':
            return { text: accumulatedText.trim(), toolCalls, success: true, sdkSessionId }

          case 'error':
            return { text: event.message, toolCalls, success: false, sdkSessionId }
        }
      }

      // Stream ended without explicit 'done' — treat as done
      return { text: accumulatedText.trim(), toolCalls, success: true, sdkSessionId }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Cancel the current turn. The in-flight tool is allowed to finish (side
   * effects commit); buffered LLM text is discarded.
   */
  cancel(): void {
    this.cancelRequested = true
  }
}
