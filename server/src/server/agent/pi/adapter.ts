/**
 * Pi Coding Agent Adapter
 *
 * Implements LLMAdapter via @earendil-works/pi-coding-agent. Provider + model
 * selected by `config.piProvider` + `config.piModel`; auth order:
 *   1. `config.apiKey` (setRuntimeApiKey)
 *   2. `<home>/pi-agent/auth.json` (OAuth tokens from interactive `/login`)
 *   3. provider env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, …)
 *
 * Pi's harness emits events via `session.subscribe`; we bridge them into
 * Moumantai's AgentEvent stream via EventQueue (same pattern as Claude adapter).
 *
 * Image attachments: not supported. The adapter emits an `error` event rather
 * than silently dropping the image (which would let the LLM hallucinate).
 *
 * Session binding: implicit via `<home>/pi-sessions/<conversationId>/`.
 * First turn (sdkBound=false): `SessionManager.create` + emit `sessionBound`.
 * Subsequent turns (sdkBound=true): `SessionManager.continueRecent`.
 *
 * IMPORTANT: Pi emits `turn_end` after EVERY assistant message, including ones
 * with tool calls. Only `agent_end` is terminal — see `mapEvent()`. Conflating
 * the two silently truncates tool-calling conversations.
 */

import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  defineTool,
  type ToolDefinition,
  type AgentSession,
  type AgentSessionEvent,
  type AgentToolResult,
} from '@earendil-works/pi-coding-agent'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type {
  LLMAdapter,
  AgentEvent,
  AgentRequest,
  BackendConfig,
  ToolResult,
  ToolSchema,
} from '../types.js'
import { EventQueue } from '../event-queue.js'
import { buildSystemPrompt } from '../system-prompt.js'
import { buildTypeBoxSchema } from './typebox-schema.js'
import { piPaths } from '../../workspace/pi-layout.js'

interface PendingToolResult {
  resolve: (result: ToolResult) => void
  callId: string
}

/**
 * Stable per-call id. Pi gives us a `toolCallId` in `execute()`; we use that
 * directly as our `callId` so submitToolResult matches without translation.
 */
function makeKey(conversationId: string, callId: string): string {
  return `${conversationId}:${callId}`
}

export class PiAgentAdapter implements LLMAdapter {
  private home!: string
  private authStorage!: AuthStorage
  private registry!: ModelRegistry
  // ModelRegistry.find returns Model<Api> | undefined; we narrowed away
  // undefined in connect(). Storing the registry's exact return type via
  // ReturnType keeps us decoupled from the deeply-nested pi-ai package.
  private model!: NonNullable<ReturnType<ModelRegistry['find']>>
  private piThinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  private pendingToolResults = new Map<string, PendingToolResult>()
  private connected = false

  async connect(config: BackendConfig): Promise<void> {
    if (config.type !== 'pi') {
      throw new Error(`PiAgentAdapter: wrong backend type "${config.type}"`)
    }
    if (!config.home) {
      throw new Error('PiAgentAdapter: config.home is required')
    }
    if (!config.piProvider) {
      throw new Error('PiAgentAdapter: config.piProvider is required (e.g. "anthropic")')
    }
    if (!config.piModel) {
      throw new Error('PiAgentAdapter: config.piModel is required (e.g. "claude-opus-4-5")')
    }

    this.home = config.home
    this.piThinkingLevel = config.piThinkingLevel

    const paths = piPaths(this.home)
    mkdirSync(paths.agentDir, { recursive: true })
    mkdirSync(paths.sessionDirRoot, { recursive: true })

    this.authStorage = AuthStorage.create(paths.authFile)
    if (config.apiKey) {
      this.authStorage.setRuntimeApiKey(config.piProvider, config.apiKey)
    }
    this.registry = ModelRegistry.create(this.authStorage)

    const m = this.registry.find(config.piProvider, config.piModel)
    if (!m) {
      throw new Error(
        `Pi: provider="${config.piProvider}" model="${config.piModel}" not in registry. ` +
          `For OAuth subscription providers, run \`pi\` interactively and use \`/login\`. ` +
          `For API-key providers, set the appropriate env var (e.g. ANTHROPIC_API_KEY) in <home>/.env.`,
      )
    }
    this.model = m
    this.connected = true
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (!this.connected) {
      yield { type: 'error', message: 'PiAgentAdapter: not connected' }
      yield { type: 'done' }
      return
    }

    // Image attachments are not supported by the Pi adapter. Pi's
    // PromptOptions exposes `images?: ImageContent[]` but Moumantai's
    // Attachment shape (raw Buffer + mimeType) hasn't been validated
    // end-to-end. Emit error rather than silently dropping the image.
    const hasImage = request.attachments?.some((a) => a.type === 'image')
    if (hasImage) {
      yield {
        type: 'error',
        message: 'image attachments are not supported on the pi backend',
      }
      yield { type: 'done' }
      return
    }

    const events = new EventQueue<AgentEvent>()
    const customTools = request.tools.map((s) => this.toPiTool(s, request.conversationId, events))

    const paths = piPaths(this.home)
    const sessionDir = join(paths.sessionDirRoot, request.conversationId)
    mkdirSync(sessionDir, { recursive: true })

    // sdkBound=false (first turn or backend-flip) forces a fresh session even when
    // an older jsonl exists; sdkBound=true opens the newest jsonl by mtime.
    const sessionManager = request.sdkBound
      ? SessionManager.continueRecent(request.cwd, sessionDir)
      : SessionManager.create(request.cwd, sessionDir)

    const resourceLoader = new DefaultResourceLoader({
      cwd: request.cwd,
      agentDir: paths.agentDir,
      // Replace Pi's default prompt with ours. The edit-agent's `systemPromptOverride`
      // takes precedence. Other edit-agent knobs (allowedTools, path policy, skills,
      // customMcpTools, maxTurns, heartbeatMs) are Claude-SDK-specific and not
      // honored here — the edit-agent is effectively Claude-backed.
      systemPromptOverride: () =>
        request.systemPromptOverride ?? buildSystemPrompt(request.context, request.tools),
    })
    await resourceLoader.reload()

    let session: AgentSession
    try {
      const created = await createAgentSession({
        model: this.model,
        ...(this.piThinkingLevel ? { thinkingLevel: this.piThinkingLevel } : {}),
        noTools: 'builtin',
        customTools,
        authStorage: this.authStorage,
        modelRegistry: this.registry,
        sessionManager,
        resourceLoader,
        cwd: request.cwd,
        agentDir: paths.agentDir,
      })
      session = created.session
    } catch (err) {
      yield {
        type: 'error',
        message: `Pi: failed to create agent session — ${err instanceof Error ? err.message : String(err)}`,
      }
      yield { type: 'done' }
      return
    }

    // Emit sessionBound on first turn only — on resume, the id already matches the DB.
    if (!request.sdkBound) {
      events.push({ type: 'sessionBound', sdkSessionId: sessionManager.getSessionId() })
    }

    // Buffer deltas; emit one `text` event at turn end (matching Claude adapter's contract).
    let accumulatedText = ''
    let doneEmitted = false
    const ensureDone = (): void => {
      if (doneEmitted) return
      doneEmitted = true
      events.push({ type: 'done' })
      events.end()
    }

    const unsub = session.subscribe((e: AgentSessionEvent) => {
      this.mapEvent(e, {
        appendText: (s) => {
          accumulatedText += s
        },
        flushAndDone: () => {
          if (doneEmitted) return
          if (accumulatedText) {
            events.push({ type: 'text', text: accumulatedText })
          }
          ensureDone()
        },
      })
    })

    const onAbort = () => {
      void session.abort()
      this.cleanupPendingForConversation(request.conversationId)
      ensureDone()
    }
    if (request.signal) {
      if (request.signal.aborted) {
        onAbort()
        unsub()
        // Created session must be released here — the `finally` block at
        // line ~280 that normally calls dispose() is bypassed by this return.
        session.dispose()
        return
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
    }

    // Start the turn. `prompt()` resolves on completion; the events drive `done`.
    session.prompt(request.message).catch((err) => {
      events.push({
        type: 'error',
        message: `Pi: prompt failed — ${err instanceof Error ? err.message : String(err)}`,
      })
      ensureDone()
    })

    try {
      for await (const e of events) yield e
    } finally {
      unsub()
      if (request.signal) request.signal.removeEventListener('abort', onAbort)
      session.dispose()
    }
  }

  submitToolResult(conversationId: string, callId: string, result: ToolResult): void {
    const key = makeKey(conversationId, callId)
    const pending = this.pendingToolResults.get(key)
    if (pending) {
      pending.resolve(result)
      this.pendingToolResults.delete(key)
    }
  }

  async resetSession(conversationId: string): Promise<void> {
    this.cleanupPendingForConversation(conversationId)
  }

  async disconnect(): Promise<void> {
    this.pendingToolResults.clear()
    this.connected = false
  }

  /**
   * Map Pi's `AgentSessionEvent` union onto Moumantai's `AgentEvent` stream.
   *
   * Events handled:
   *   - `message_update` with nested `assistantMessageEvent.type === 'text_delta'`
   *     → accumulate text (no per-delta emit; AgentLoop wants one final `text`).
   *   - `turn_end` → no-op. Fires after EVERY assistant message; the harness
   *     may keep looping (e.g. synthesis turn after a tool call). Conflating
   *     this with `agent_end` truncates tool-calling conversations.
   *   - `agent_end` → flush accumulated text, emit `done`, end queue. Terminal.
   *   - `tool_execution_start` → no-op; the `toolCall` event was already pushed
   *     from inside the tool's `execute()` callback.
   *   - `compaction_start` / `compaction_end` / `auto_retry_start` / `auto_retry_end`
   *     → log only; these don't surface to the UI.
   */
  private mapEvent(
    e: AgentSessionEvent,
    cb: { appendText: (s: string) => void; flushAndDone: () => void },
  ): void {
    switch (e.type) {
      case 'message_update': {
        const inner = e.assistantMessageEvent
        if (inner.type === 'text_delta') {
          cb.appendText(inner.delta)
        }
        return
      }
      case 'turn_end':
        // Per-assistant-message marker; the harness may continue with another
        // turn (e.g. synthesis after a tool call). Keep accumulating text until
        // the terminal `agent_end`.
        return
      case 'agent_end': {
        cb.flushAndDone()
        return
      }
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end': {
        console.log(`[pi-adapter] ${e.type}`)
        return
      }
      // tool_execution_start / _update / _end: ignored — toolCall is
      // already emitted from execute() entry, and submitToolResult drives
      // the result back via the pending-promise dance.
      default:
        return
    }
  }

  private cleanupPendingForConversation(conversationId: string): void {
    const prefix = `${conversationId}:`
    for (const [key, pending] of [...this.pendingToolResults]) {
      if (!key.startsWith(prefix)) continue
      pending.resolve({ result: null, error: 'aborted' })
      this.pendingToolResults.delete(key)
    }
  }

  /**
   * Wrap a Moumantai `ToolSchema` as a Pi `ToolDefinition`. The `execute`
   * callback is the pivot point: when Pi invokes a tool, we push a `toolCall`
   * event into the queue and `await` a pending promise; AgentLoop drains the
   * queue, runs the tool, and calls `submitToolResult` which resolves the
   * promise — at which point execute() returns and Pi continues the turn.
   */
  private toPiTool(
    schema: ToolSchema,
    conversationId: string,
    events: EventQueue<AgentEvent>,
  ): ToolDefinition {
    const params = buildTypeBoxSchema(schema.parameters)
    return defineTool({
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters: params,
      execute: async (
        toolCallId,
        toolParams,
        _signal,
        _onUpdate,
        _ctx,
      ): Promise<AgentToolResult<Record<string, never>>> => {
        const callId = toolCallId
        const wait = new Promise<ToolResult>((resolve) => {
          this.pendingToolResults.set(makeKey(conversationId, callId), { resolve, callId })
        })
        events.push({
          type: 'toolCall',
          callId,
          name: schema.name,
          args: toolParams as Record<string, unknown>,
        })
        const result = await wait
        const text = result.error
          ? JSON.stringify({ error: result.error })
          : JSON.stringify(result.result)
        return {
          content: [{ type: 'text', text }],
          details: {},
        }
      },
    })
  }
}
