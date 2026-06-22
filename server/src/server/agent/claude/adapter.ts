/**
 * Claude Agent SDK Adapter
 *
 * Implements LLMAdapter using the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
 * Auth via CLAUDE_CODE_OAUTH_TOKEN (primary) or ANTHROPIC_API_KEY (fallback).
 *
 * Session identity: the `conversationId` carried in AgentRequest doubles as
 * the SDK's `session_id`. First turn passes `sessionId: conv.id` to create
 * the SDK session under our UUID; subsequent turns pass `resume: conv.id`
 * to pick up the existing jsonl. The two options are mutually exclusive per
 * SDK contract (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts).
 *
 * The Agent SDK runs its own agent loop via query(). To bridge with the
 * daemon's AgentLoop (which owns tool execution + face refresh), we use an
 * EventQueue that connects two concurrent async flows:
 *
 *   query() background ──push──→ EventQueue ──yield──→ AgentLoop
 *   MCP tool handler ────push──→ EventQueue ──yield──→ AgentLoop
 *   AgentLoop ──submitToolResult──→ MCP handler resumes → SDK continues
 *
 * MCP tool handlers do NOT execute tools — they pause, yield a toolCall
 * event, and wait for the daemon to execute and return the result.
 */

import {
  query,
  tool as sdkTool,
  createSdkMcpServer,
  renameSession,
  tagSession,
} from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlockParam, Base64ImageSource } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import type {
  LLMAdapter,
  AgentEvent,
  AgentRequest,
  AgentTodoItem,
  Attachment,
  BackendConfig,
  ToolResult,
  ToolSchema,
  ToolParameter,
  AppContext,
} from '../types.js'
import { EventQueue } from '../event-queue.js'
import { buildSystemPrompt } from '../system-prompt.js'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingToolResult {
  resolve: (result: ToolResult) => void
  callId: string
}

// ---------------------------------------------------------------------------
// ClaudeAgentAdapter
// ---------------------------------------------------------------------------

export class ClaudeAgentAdapter implements LLMAdapter {
  private connected = false
  /** Keyed `${conversationId}:${callId}`. Resolved when agent-loop submits. */
  private pendingToolResults = new Map<string, PendingToolResult>()

  async connect(config: BackendConfig): Promise<void> {
    if (config.apiKey) {
      process.env.ANTHROPIC_API_KEY = config.apiKey
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('ClaudeAgentAdapter: Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.pendingToolResults.clear()
    this.connected = false
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (!this.connected) {
      yield { type: 'error', message: 'ClaudeAgentAdapter: not connected' }
      return
    }

    const events = new EventQueue<AgentEvent>()

    const mcpServerName = request.mcpServerName ?? 'moumantai'

    // Build MCP tools — handlers bridge to daemon via EventQueue. The edit-agent
    // supplies pre-built SDK MCP tools via `customMcpTools`; the app-agent builds
    // them from `request.tools` schemas as before.
    const mcpTools =
      (request.customMcpTools as ReturnType<ClaudeAgentAdapter['buildMcpTool']>[] | undefined) ??
      request.tools.map((schema) => this.buildMcpTool(schema, request.conversationId, events))

    // Query options — each field falls back to app-agent defaults when unset.
    const systemPrompt =
      request.systemPromptOverride ?? buildSystemPrompt(request.context, request.tools)
    const permissionMode = request.permissionMode ?? 'bypassPermissions'
    const queryOptions: Record<string, unknown> = {
      systemPrompt,
      maxTurns: request.maxTurns ?? 10,
      permissionMode,
      settingSources: request.settingSources ?? [],
      cwd: request.cwd,
    }
    // SDK `tools` = base built-ins to ENABLE (distinct from `allowedTools`, which
    // auto-APPROVES and bypasses the PreToolUse hook). Edit-agent passes
    // `builtinTools` to enable Read/Edit/Write/Bash/… without auto-approving them.
    // App-agent: no builtinTools → `[]` (MCP-only).
    if (request.builtinTools) {
      queryOptions.tools = request.builtinTools
    } else if (request.allowedTools) {
      queryOptions.tools = request.allowedTools.filter((t) => !t.startsWith('mcp__'))
    } else {
      queryOptions.tools = [] as string[]
    }
    // bypassPermissions requires the explicit dangerous-skip flag (SDK contract).
    // 'dontAsk' (edit-agent) does NOT — it denies anything not pre-approved.
    if (permissionMode === 'bypassPermissions') {
      queryOptions.allowDangerouslySkipPermissions = true
    }
    if (request.canUseTool) queryOptions.canUseTool = request.canUseTool
    // PreToolUse hook (edit-agent path policy). Runs FIRST in the permission
    // chain and is NOT bypassed by allowedTools — the authoritative FS gate.
    if (request.hooks) queryOptions.hooks = request.hooks
    // `allowedTools` auto-approves (skips permission checks). Edit-agent sends only
    // its safe subset (TodoWrite + mcp__edit__*) — file/Bash tools fall to the hook.
    if (request.allowedTools) queryOptions.allowedTools = request.allowedTools
    // Skills load from <cwd>/.claude/skills when settingSources includes 'project'.
    if (request.skills) queryOptions.skills = request.skills

    if (mcpTools.length > 0) {
      const server = createSdkMcpServer({ name: mcpServerName, tools: mcpTools })
      queryOptions.mcpServers = { [mcpServerName]: server }
      if (!request.allowedTools) {
        queryOptions.allowedTools = request.tools.map((t) => `mcp__${mcpServerName}__${t.name}`)
      }
    }

    // SDK session binding: `sessionId` (create) and `resume` are mutually exclusive.
    // Our conversationId is decoupled from the SDK's session id — the SDK rejects
    // reuse of a session id it still tracks internally (even after the jsonl is gone).
    // First turn (sdkBound=false): generate a fresh UUID, emit sessionBound so the
    // caller persists it. Subsequent turns (sdkBound=true): resume via sdkSessionId.
    const sdkSessionId =
      request.sdkBound && request.sdkSessionId ? request.sdkSessionId : crypto.randomUUID()
    if (request.sdkBound) {
      queryOptions.resume = sdkSessionId
    } else {
      queryOptions.sessionId = sdkSessionId
    }

    // If caller supplied an AbortSignal, wire it so query() stops and any
    // tool handlers blocked on waitForToolResult resolve with an error.
    let onAbort: (() => void) | undefined
    if (request.signal) {
      if (request.signal.aborted) {
        this.cleanupPendingForConversation(request.conversationId)
        events.end()
        return
      }
      queryOptions.abortController = new AbortController()
      const ac = queryOptions.abortController as AbortController
      onAbort = () => {
        try {
          ac.abort()
        } catch {
          /* ignore */
        }
        this.cleanupPendingForConversation(request.conversationId)
        events.end()
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
    }

    // Launch query() in background — events flow through the queue
    const sessionLabel =
      request.sessionLabel ?? defaultSessionLabel(request.conversationId, request.context)
    // Verbose tool/liveness logging is the edit-agent path only (it's the one
    // that supplies allowedTools). The normal app-agent leaves it unset, so its
    // adapter output is unchanged.
    const logTools = !!request.allowedTools
    const queryDone = this.runQuery(
      request.message,
      queryOptions,
      events,
      request.conversationId,
      sdkSessionId,
      request.sdkBound,
      request.sdkBound ? null : sessionLabel,
      request.attachments,
      request.heartbeatMs ?? 30_000,
      logTools,
    )

    try {
      for await (const event of events) {
        yield event
      }
      await queryDone
    } finally {
      if (request.signal && onAbort) {
        request.signal.removeEventListener('abort', onAbort)
      }
    }
  }

  /**
   * Resolve every pending tool result for a conversation with an aborted
   * marker. Unblocks MCP tool handlers so the SDK can unwind cleanly.
   */
  private cleanupPendingForConversation(conversationId: string): void {
    const prefix = `${conversationId}:`
    for (const [key, pending] of [...this.pendingToolResults]) {
      if (key.startsWith(prefix)) {
        pending.resolve({ result: null, error: 'aborted' })
        this.pendingToolResults.delete(key)
      }
    }
  }

  submitToolResult(conversationId: string, callId: string, result: ToolResult): void {
    const key = `${conversationId}:${callId}`
    const pending = this.pendingToolResults.get(key)
    if (pending) {
      pending.resolve(result)
      this.pendingToolResults.delete(key)
    }
  }

  async resetSession(conversationId: string): Promise<void> {
    // The SDK holds no in-memory cursor for a conversation id — all state
    // lives in the jsonl file. We just drop any pending tool waiters so a
    // mid-turn reset unblocks handlers waiting on submitToolResult.
    this.cleanupPendingForConversation(conversationId)
  }

  // ---------------------------------------------------------------------------
  // Background query runner
  // ---------------------------------------------------------------------------

  private async runQuery(
    message: string,
    options: Record<string, unknown>,
    events: EventQueue<AgentEvent>,
    conversationId: string,
    expectedSdkSessionId: string,
    isResume: boolean,
    labelToApply: string | null,
    attachments: Attachment[] | undefined,
    heartbeatMs: number,
    logTools: boolean,
  ): Promise<void> {
    // Accumulate assistant text silently; push one clean text event at the end.
    // Prefer result.result (final answer only) over accumulated intermediate text.
    let accumulatedText = ''
    let sdkLabelApplied = false
    const tag = `[claude-adapter] conv=${conversationId.slice(0, 8)}`

    // Liveness logging (edit-agent only — see `logTools`): throttled "still running"
    // pulse, not a per-message line. `Date.now()` is fine (no-Date.now rule is
    // Workflow-script-only).
    const PROGRESS_LOG_MS = 30_000
    const startedAt = Date.now()
    let lastProgressLogAt = startedAt
    let msgCount = 0

    // Per-message heartbeat — if the stream stalls for HEARTBEAT_MS, surface an
    // explicit error rather than blocking forever. The edit-agent extends this to
    // 5 min for long Read/Edit chains.
    const HEARTBEAT_MS = heartbeatMs

    try {
      // Multimodal: any image attachment forces the structured-prompt path.
      // Pure-text turns use a bare string (SDK auto-wraps it) unless hooks are
      // present. The SDK only delivers `hooks`/`canUseTool` in streaming-input
      // mode (AsyncIterable<SDKUserMessage>); a bare string silently ignores hooks,
      // so the edit-agent's PreToolUse policy would never fire.
      const multimodal = attachments?.length ? buildMultimodalPrompt(message, attachments) : null
      const needsStreamingInput = !!(options as { hooks?: unknown }).hooks
      const promptArg: string | AsyncIterable<SDKUserMessage> =
        multimodal ?? (needsStreamingInput ? buildTextPrompt(message) : message)
      const iter = query({ prompt: promptArg, options })[Symbol.asyncIterator]()
      const HEARTBEAT_SENTINEL = Symbol('heartbeat_timeout')

      while (true) {
        let timerId: ReturnType<typeof setTimeout> | null = null
        const nextP = iter.next()
        const timeoutP = new Promise<typeof HEARTBEAT_SENTINEL>((resolve) => {
          timerId = setTimeout(() => resolve(HEARTBEAT_SENTINEL), HEARTBEAT_MS)
        })
        const raced = await Promise.race([nextP, timeoutP])
        if (timerId) clearTimeout(timerId)

        if (raced === HEARTBEAT_SENTINEL) {
          console.error(`${tag} heartbeat: no SDK message for ${HEARTBEAT_MS}ms — bailing`)
          events.push({
            type: 'error',
            message: `SDK stream stalled (no messages for ${HEARTBEAT_MS / 1000}s)`,
          })
          events.push({ type: 'done' })
          events.end()
          return
        }

        const { value: msg, done } = raced as IteratorResult<unknown>
        if (done) break

        // Throttled liveness pulse (edit-agent only). One line per ~30s.
        // A true stall (no messages at all) is caught by the heartbeat bail.
        msgCount++
        if (logTools) {
          const now = Date.now()
          if (now - lastProgressLogAt >= PROGRESS_LOG_MS) {
            console.log(
              `${tag} [edit-agent] running elapsed=${Math.round((now - startedAt) / 1000)}s msgs=${msgCount}`,
            )
            lastProgressLogAt = now
          }
        }

        // Capture init — first SystemMessage carries the SDK's session_id.
        // Warn if it diverges from the value we passed (points at SDK misconfiguration).
        if (
          (msg as { type?: string }).type === 'system' &&
          'subtype' in (msg as object) &&
          (msg as { subtype?: string }).subtype === 'init' &&
          'session_id' in (msg as object)
        ) {
          const initMsg = msg as {
            session_id: string
            mcp_servers?: Array<{ name: string; status?: string }>
            tools?: string[]
          }
          const mcpInfo = initMsg.mcp_servers
            ? initMsg.mcp_servers.map((s) => `${s.name}:${s.status ?? '?'}`).join(',')
            : 'none'
          console.log(
            `${tag} sdk init session_id=${initMsg.session_id.slice(0, 8)} mcp=[${mcpInfo}] tools=${initMsg.tools?.length ?? 0}`,
          )
          if (!isResume && initMsg.session_id !== expectedSdkSessionId) {
            console.warn(
              `${tag} SDK session_id (${initMsg.session_id}) differs from generated (${expectedSdkSessionId}) — using SDK's`,
            )
          }
          // Emit the SDK's authoritative id (handles edge cases where it reassigns).
          events.push({ type: 'sessionBound', sdkSessionId: initMsg.session_id })
          // Fire-and-forget rename+tag on first turn; SDK writes the jsonl before
          // the init message, so the metadata APIs land safely here.
          if (labelToApply && !sdkLabelApplied) {
            sdkLabelApplied = true
            void safeLabelSession(initMsg.session_id, labelToApply)
          }
        }

        // Accumulate assistant text. Also inspect tool_use blocks for the activity
        // log and the built-in TodoWrite checklist (forwarded as a progress event).
        if ((msg as { type?: string }).type === 'assistant' && 'message' in (msg as object)) {
          const assistantMsg = (msg as { message: unknown }).message as {
            content: Array<{
              type: string
              text?: string
              name?: string
              input?: Record<string, unknown>
            }>
          }
          for (const block of assistantMsg.content) {
            if (block.type === 'text' && block.text) {
              accumulatedText += block.text
              continue
            }
            if (block.type !== 'tool_use') continue
            const name = block.name ?? '(unknown)'
            // Activity log (edit-agent only): one short line per tool call.
            if (logTools) {
              lastProgressLogAt = Date.now()
              console.log(`${tag} [edit-agent] tool name=${name}${briefToolTarget(block.input)}`)
            }
            // TodoWrite checklist → mid-turn progress event (edit-agent only;
            // app-agent runs with built-ins disabled). MCP tools stay on their own path.
            if (name === 'TodoWrite') {
              const todos = parseTodoWriteTodos(block.input)
              if (todos.length > 0) events.push({ type: 'todosUpdate', todos })
            }
          }
        }

        // Final result — emit one text event then done
        if ((msg as { type?: string }).type === 'result') {
          const result = msg as {
            is_error?: boolean
            errors?: string[]
            result?: string
          }
          if (result.is_error) {
            console.error(
              `${tag} sdk result is_error=true errors=${result.errors?.join(';') ?? '(none)'}`,
            )
            events.push({
              type: 'error',
              message: result.errors?.join('; ') ?? 'Agent error',
            })
          }
          const finalText = result.result || accumulatedText
          if (finalText) {
            events.push({ type: 'text', text: finalText })
          }
          events.push({ type: 'done' })
          events.end()
          return
        }
      }

      // Stream ended without explicit result
      console.log(
        `${tag} sdk stream ended without result (accumulated ${accumulatedText.length} chars)`,
      )
      if (accumulatedText) {
        events.push({ type: 'text', text: accumulatedText })
      }
      events.push({ type: 'done' })
      events.end()
    } catch (err) {
      console.error(`${tag} sdk query threw`, err instanceof Error ? err.message : err)
      events.push({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
      events.end()
    }
  }

  // ---------------------------------------------------------------------------
  // MCP tool builder — creates bridge tools that pause for daemon execution
  // ---------------------------------------------------------------------------

  private buildMcpTool(schema: ToolSchema, conversationId: string, events: EventQueue<AgentEvent>) {
    const zodSchema = buildZodSchema(schema.parameters)

    return sdkTool(
      schema.name,
      schema.description,
      zodSchema,
      async (args: Record<string, unknown>) => {
        const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

        // Register promise BEFORE pushing event — critical ordering.
        const waitPromise = this.waitForToolResult(conversationId, callId)
        events.push({ type: 'toolCall', callId, name: schema.name, args })
        const result = await waitPromise
        return {
          content: [
            {
              type: 'text' as const,
              text: result.error
                ? JSON.stringify({ error: result.error })
                : JSON.stringify(result.result),
            },
          ],
          ...(result.error ? { isError: true } : {}),
        }
      },
    )
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private waitForToolResult(conversationId: string, callId: string): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      this.pendingToolResults.set(`${conversationId}:${callId}`, { resolve, callId })
    })
  }
}

// ---------------------------------------------------------------------------
// Exported helpers (for testing)
// ---------------------------------------------------------------------------

/**
 * One short target hint for the tool-activity log, pulled from common SDK tool
 * input keys. Never dumps the full input. Returns `''` (no hint) when none match.
 */
function briefToolTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['file_path', 'face_id', 'tool_name', 'pattern', 'uri', 'command'] as const) {
    const v = input[key]
    if (typeof v === 'string' && v) {
      const brief = v.length > 80 ? `${v.slice(0, 80)}…` : v
      return ` ${key}=${brief}`
    }
  }
  return ''
}

/**
 * Defensively parse a `TodoWrite` tool input into `AgentTodoItem[]`. Tolerates a
 * missing/non-array `todos` and per-item shape drift so a malformed payload can
 * never throw and abort the turn. Unknown statuses fall back to `'pending'`.
 */
export function parseTodoWriteTodos(input: Record<string, unknown> | undefined): AgentTodoItem[] {
  const raw = input?.todos
  if (!Array.isArray(raw)) return []
  const out: AgentTodoItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content : ''
    if (!content) continue
    const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending'
    const activeForm = typeof o.activeForm === 'string' && o.activeForm ? o.activeForm : content
    out.push({ content, status, activeForm })
  }
  return out
}

/** Convert Moumantai ToolParameter map to Zod raw shape for sdkTool(). */
export function buildZodSchema(
  parameters: Record<string, ToolParameter>,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, param] of Object.entries(parameters)) {
    let zType: z.ZodTypeAny
    switch (param.type) {
      case 'string':
        zType = z.string()
        break
      case 'number':
        zType = z.number()
        break
      case 'boolean':
        zType = z.boolean()
        break
      default:
        throw new Error(
          `buildZodSchema: unsupported type "${(param as { type?: unknown }).type}" on param "${name}"`,
        )
    }
    if (param.description) zType = zType.describe(param.description)
    if (!param.required) zType = zType.optional()
    shape[name] = zType
  }
  return shape
}

/** Default "moumantai:<appId>:<YYYY-MM-DD>" session label for SDK listings. */
function defaultSessionLabel(conversationId: string, ctx: AppContext): string {
  const date = new Date().toISOString().slice(0, 10)
  return `moumantai:${ctx.appId}:${date}:${conversationId.slice(0, 8)}`
}

/**
 * Fire-and-forget rename + tag. Swallows errors — the SDK creates the jsonl
 * file on first query(), so the metadata APIs occasionally race the file
 * creation. Failure here does not affect correctness; it only means the SDK
 * `listSessions` entry is unlabeled.
 */
async function safeLabelSession(conversationId: string, label: string): Promise<void> {
  try {
    await renameSession(conversationId, label)
  } catch (err) {
    console.warn(
      `[claude-adapter] renameSession(${conversationId}) failed:`,
      err instanceof Error ? err.message : err,
    )
  }
  try {
    await tagSession(conversationId, 'moumantai')
  } catch (err) {
    console.warn(
      `[claude-adapter] tagSession(${conversationId}) failed:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * MIME types Anthropic's vision API accepts on `Base64ImageSource.media_type`.
 * Closed union upstream — we re-state it here so wire-boundary code can
 * validate without reaching into the SDK's deep types.
 */
export const ANTHROPIC_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const satisfies readonly Base64ImageSource['media_type'][]
export type AnthropicImageMime = (typeof ANTHROPIC_IMAGE_MIME_TYPES)[number]

/** Type-guard narrowing a free-form MIME string to the Anthropic-supported set. */
export function isAnthropicImageMime(mime: string): mime is AnthropicImageMime {
  return (ANTHROPIC_IMAGE_MIME_TYPES as readonly string[]).includes(mime)
}

/**
 * Wrap a plain-text turn as a single-message AsyncIterable so the SDK runs in
 * streaming-input mode (the prerequisite for `hooks`/`canUseTool` delivery —
 * see the call site). Yields exactly one user message, then completes so the
 * query runs to completion for this turn (same single-shot-via-streaming shape
 * `buildMultimodalPrompt` relies on).
 */
function buildTextPrompt(message: string): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'user',
        message: { role: 'user', content: message },
        parent_tool_use_id: null,
      } as SDKUserMessage
    },
  }
}

/**
 * Build a one-shot async-iterable prompt with the user's caption + image blocks.
 * Returns `null` when filtering produced zero content blocks (empty caption + all
 * attachments skipped) — caller falls back to bare-string so Anthropic doesn't
 * reject an empty content array with a 400.
 */
function buildMultimodalPrompt(
  caption: string,
  attachments: Attachment[],
): AsyncIterable<SDKUserMessage> | null {
  const content: ContentBlockParam[] = []
  if (caption) content.push({ type: 'text', text: caption })
  for (const att of attachments) {
    if (att.type !== 'image') continue
    if (!isAnthropicImageMime(att.mimeType)) continue
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: att.mimeType,
        data: att.data.toString('base64'),
      },
    })
  }
  if (content.length === 0) return null
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      } as SDKUserMessage
    },
  }
}
