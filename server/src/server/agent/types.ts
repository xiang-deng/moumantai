/**
 * Moumantai Agent Types
 *
 * Core type system for the tool-based agentic model.
 * Every module in the agent/ tree imports from here.
 */

import type { ComponentDef } from '@moumantai/protocol/generated/moumantai/v1'
import { DeviceClass } from '@moumantai/protocol/generated/moumantai/v1'
import type { AppManifest } from '../framework/app-types.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

// ---------------------------------------------------------------------------
// Agent Events
// ---------------------------------------------------------------------------

/** Natural-language text fragment (accumulated, buffered until done). */
export interface AgentTextEvent {
  type: 'text'
  text: string
}

/** LLM requests a tool call. Server executes and submits result. */
export interface AgentToolCallEvent {
  type: 'toolCall'
  callId: string
  name: string
  args: Record<string, unknown>
}

/** Turn completed successfully. */
export interface AgentDoneEvent {
  type: 'done'
}

/** Turn terminated with an error. */
export interface AgentErrorEvent {
  type: 'error'
  message: string
}

/**
 * Emitted once per turn when the SDK session has been created (or resumed).
 * Carries the SDK-side session UUID for the caller to persist for future resumes.
 * Decoupled from conversationId — the SDK rejects reuse of ids whose jsonl is gone.
 */
export interface AgentSessionBoundEvent {
  type: 'sessionBound'
  sdkSessionId: string
}

/** One todo item, mirroring the SDK's built-in `TodoWrite` tool input shape. */
export interface AgentTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/**
 * The agent updated its checklist via the built-in `TodoWrite` tool (edit-agent
 * only; app-agent runs with built-ins disabled). Forwarded by AgentLoop to
 * `onTodos`, which broadcasts a `ChatTodosUpdate` progress card. No-op when
 * `onTodos` is omitted.
 */
export interface AgentTodosUpdateEvent {
  type: 'todosUpdate'
  todos: AgentTodoItem[]
}

/**
 * Events emitted by the adapter during a conversation turn.
 *
 * Discriminated union — switch on `type` to narrow:
 * ```ts
 * switch (event.type) {
 *   case 'text':     event.text     // string
 *   case 'toolCall': event.callId   // string
 *   case 'done':     // no fields
 *   case 'error':    event.message  // string
 * }
 * ```
 */
export type AgentEvent =
  | AgentTextEvent
  | AgentToolCallEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | AgentSessionBoundEvent
  | AgentTodosUpdateEvent

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

/** Parameter type for a tool. */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
}

/**
 * HTTP client for refresh tasks and tools. Provides timeout, retry/backoff,
 * per-host circuit breaker, and per-app budget enforcement. Resolvers must NOT
 * use this.
 */
export interface HttpClient {
  fetch(url: string, opts?: HttpFetchOptions): Promise<Response>
}

export interface HttpFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** Override per-call timeout; defaults to 10s. */
  timeoutMs?: number
  /** Override per-call retry count; defaults to 3 with exponential backoff. */
  retries?: number
  signal?: AbortSignal
}

/**
 * Per-task staleness record from `ctx.staleness(taskId)`. Authors use it for
 * UI affordances (e.g. "updated 4s ago"). `taskId` is validated; typos throw
 * at call time rather than silently returning empty.
 */
export interface StalenessRecord {
  /** Unix epoch (seconds) of the last successful task run; null if never run. */
  fetchedAt: number | null
  /** True after N consecutive failures (default N=3). */
  isFailing: boolean
  /** Most recent error message; null if last run succeeded. */
  lastError: string | null
  /** Trigger a manual run of this task (subject to per-app budget). */
  refresh: () => Promise<void>
}

/** Context passed to a tool's execute function. */
export interface ToolContext {
  params: Record<string, unknown>
  db: BetterSQLite3Database
  /**
   * UUID of the conversation driving this turn. Optional because
   * action-handler (non-agent) invocations have no conversation. Tools that
   * need to spawn sub-turns / delegate should use it as-is; it is the same
   * id the SDK stores as `session_id` in the jsonl file.
   */
  conversationId?: string
  /**
   * Active scope string for the current turn (e.g. 'home' or 'app:<id>').
   * Synthesized view tools use this to gate the navigate-message side effect:
   * they only navigate when the calling scope matches the face's app, so a
   * delegated home→app call updates view state without yanking the user.
   */
  scope?: string
  /**
   * Stable deviceId of the device that originated this turn. Tools that
   * drive cross-device UI focus changes (navigate, view_<faceId>) target
   * ONLY this device — multi-device-different-focus is a feature, not a bug.
   * Optional because non-turn tool paths (action-handler from direct UI tap)
   * may not always know originDeviceId. When undefined, navigate-driving
   * tools fall back to skipping the focus change.
   */
  originDeviceId?: string
  // External-data primitives — production always populates these; tests may omit.
  /** Upstream HTTP — for refresh tasks and tools, never resolvers. */
  http?: HttpClient
  /** Cache an upstream asset (logo, image) and return its local /apps/<id>/assets/... URL. */
  cacheAsset?: (url: string) => Promise<string>
  /** Per-task staleness record (taskId from defineRefreshTask or face.refresh). */
  staleness?: (taskId: string) => StalenessRecord
  /** Typed app config (technical setup; populated from config.json + .env). */
  config?: Record<string, unknown>
  /** Typed app context (LLM-visible preferences; populated from context.json). */
  context?: Record<string, unknown>
  /** Atomic write to context.json with Zod validation. Triggers re-resolve. */
  setContext?: (field: string, value: unknown) => Promise<void>
}

/** Result of a tool execution. */
export interface ToolResult {
  result: unknown
  error?: string
  /**
   * Set only when `isUIInvocation: true` and required params were unset/null/empty.
   * The caller (action-handler) escalates to a chat dialog instead of erroring.
   * LLM-direct path leaves this unset; missing-required folds into a normal `error`.
   */
  missing?: { fields: string[]; provided: Record<string, unknown> }
}

/** Wire-safe tool schema sent to the adapter. Does NOT include `execute`. */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, ToolParameter>
}

/** Full tool definition. `execute` stays server-side; only `ToolSchema` is sent to the adapter. */
export interface ToolDefinition extends ToolSchema {
  execute: (ctx: ToolContext) => Promise<ToolResult>
}

/** Extract wire-safe ToolSchema from a ToolDefinition. */
export function toToolSchema(tool: ToolDefinition): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

// ---------------------------------------------------------------------------
// Face Definitions
// ---------------------------------------------------------------------------

/**
 * Resolve function for a face — returns the nested data object components bind
 * to via pathRef. Faces without `params` receive `params: {}`.
 *
 * Resolvers must NOT block on network. The optional `staleness`/`context`
 * fields are read-only; mutations go through tools or refresh tasks.
 */
export type FaceResolve = (ctx: {
  db: BetterSQLite3Database
  params: Record<string, unknown>
  /** Per-task staleness for composing UI freshness affordances. */
  staleness?: (taskId: string) => StalenessRecord
  /**
   * Staleness for this face's bound refresh worker. Abstracts the scheduler's
   * internal task-id format. Returns null when no `refresh` is declared or the
   * worker is not yet alive (pre-mount).
   */
  selfStaleness?: () => StalenessRecord | null
  /** LLM-visible app preferences (read-only in resolve). */
  context?: Record<string, unknown>
}) => Record<string, unknown>

/**
 * A full-screen read-only view of app data.
 * Components define the layout; resolve() produces the data they bind to.
 *
 * Optional `params` declares typed view-state the agent can steer via the
 * auto-synthesized `view_<faceId>` tool. All face params must be optional
 * (resolver fills defaults). When `params` is declared, `viewToolDescription`
 * is required (becomes the synth tool's description).
 */
export interface FaceDefinition {
  id: string
  label: string
  position: number
  components: ComponentDef[] // default = small-device-first universal layout
  resolve: FaceResolve
  /**
   * Size class this face is authored for. `'compact'` = ≤240dp;
   * `'expanded'` = >240dp. The file-name
   * suffix (`<id>.compact.ts` / `<id>.expanded.ts`) is the loader's source
   * of truth; this field exists for in-code declaration + future compact-
   * discipline guards. Required when the explicit-suffix convention is used.
   */
  kind?: 'compact' | 'expanded'
  /** Typed view-state schema. Framework synthesizes `view_<id>` from this. All params must be optional. */
  params?: Record<string, ToolParameter>
  /** Bumped on breaking schema changes — sweeps stale `face_params` rows at boot. Defaults to 1. */
  paramsVersion?: number
  /**
   * How `view_<faceId>` tool calls update persisted params:
   * - `'replace'` (default): each call overwrites the entire params bag.
   *   `{}` resets to defaults.
   * - `'merge'`: each call shallow-merges into the existing params. `{}` is
   *   a no-op. Reset must be expressed as explicit field updates by the
   *   author (e.g. `{day: null}`) — the resolver's nullish-defaulting
   *   handles the fall-back.
   *
   * `paramsVersion` bumps invalidate the merge target — stale rows are
   * dropped before merge so a schema change can't silently merge into
   * incompatible state. Requires `params` to be declared.
   */
  paramsMerge?: 'replace' | 'merge'
  /**
   * Synthesized view tool's description. Required when `params` is declared.
   */
  viewToolDescription?: string
  /**
   * Optional face-bound refresh task. The framework spawns one worker per
   * distinct (faceId, params) mount across all clients (deduped). The worker
   * runs `run` with the mount's params, ticks at `every` (or `nextRun` if
   * returned), and is killed on unmount or params change.
   *
   * Use for per-instance external data: a stock detail face with `ticker`
   * params, a game face with `game_id` params, etc.
   */
  refresh?: FaceBoundRefresh
}

/**
 * Face-bound refresh task spec. Lifecycle is tied to the face mount —
 * scheduler kills the worker on unmount and re-spawns on params change.
 */
export interface FaceBoundRefresh {
  /** Default interval (e.g. '5s', '30s', '5m'). `run`'s `nextRun` overrides per tick. */
  every: string
  /**
   * Whether to run once immediately on mount, before first interval. Defaults
   * to true — face data is usually expected fresh on open.
   */
  warmup?: boolean
  run: (ctx: RefreshContext) => Promise<RefreshResult | void>
}

/**
 * Per-face entry in AppContext.faces. Faces without `params` present uniformly
 * without the optional fields; the LLM uses presence of `viewToolName` to
 * detect that a face is steerable.
 */
export interface FaceContextEntry {
  id: string
  label: string
  position: number
  paramsSchema?: Record<string, ToolParameter>
  currentParams?: Record<string, unknown>
  viewToolName?: string
}

// ---------------------------------------------------------------------------
// Backend Configuration
// ---------------------------------------------------------------------------

/** Configuration for connecting to an LLM backend. */
export interface BackendConfig {
  type: 'claude' | 'mock' | 'pi'
  gatewayUrl?: string
  authToken?: string
  apiKey?: string
  model?: string
  latencyMs?: number
  /**
   * Moumantai Home root. Required for the `pi` backend to anchor
   * `<home>/pi-agent/` (agentDir + auth.json) and `<home>/pi-sessions/`
   * (per-conversation jsonl). Other backends ignore.
   */
  home?: string
  /**
   * Pi provider id (e.g. 'anthropic' | 'openai' | 'google' | …). Selects
   * which family the model belongs to. See
   * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md
   */
  piProvider?: string
  /**
   * Pi model id within the provider catalog (e.g. 'claude-opus-4-5',
   * 'gpt-4o'). Looked up via Pi's `ModelRegistry.find(provider, model)`;
   * the adapter throws at connect-time on miss.
   */
  piModel?: string
  /**
   * Pi reasoning effort knob — passed through to providers that honor it
   * (Anthropic extended thinking, OpenAI o-series, …).
   */
  piThinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

// ---------------------------------------------------------------------------
// Attachments & Audio
// ---------------------------------------------------------------------------

/** A file attached to a user message (image or audio). */
export interface Attachment {
  type: 'image' | 'audio'
  data: Buffer
  mimeType: string
}

/**
 * Internal codec spec for `AudioService.transcribe()`. Distinct from the
 * proto `AudioFormat` enum, which encodes the *wire* format; this struct
 * names the encoding the OpenAI adapter (or mock) needs to consume the
 * buffer in hand.
 */
export interface AudioCodec {
  format: 'pcm16' | 'opus' | 'mp3'
  sampleRate: number
}

// ---------------------------------------------------------------------------
// App Context (passed in AgentRequest, adapter formats into system prompt)
// ---------------------------------------------------------------------------

/**
 * Contextual information for an LLM conversation turn.
 * The adapter receives this and formats it per backend conventions.
 */
export interface AppContext {
  appId: string
  manifest: AppManifest
  schema?: Record<string, unknown>
  skill?: string
  turnMode: 'direct_user_chat' | 'delegated_from_home'
  availableApps?: { appId: string; name: string; description: string }[]
  deviceClass?: DeviceClass
  /**
   * Faces visible to the LLM for this app. Each entry pairs a face's static
   * metadata (id, label) with its dynamic view-state (currentParams) and the
   * synth tool name (viewToolName) when the face is parameterized.
   */
  faces?: FaceContextEntry[]
  /**
   * LLM-visible app preferences (from context.json). Populated by app-engine
   * at boot from `appDef.context` Zod schema. Adapter formats into system
   * prompt as a small "User preferences for this app: ..." block. Secrets
   * never appear here (they live in .env).
   */
  context?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Agent Request
// ---------------------------------------------------------------------------

/** Request to start a conversation turn. */
export interface AgentRequest {
  /**
   * UUID of the conversation this turn belongs to — the same id the Claude
   * Agent SDK stores as `session_id`. First turn creates the SDK session via
   * `sessionId`; subsequent turns resume via `resume`.
   */
  conversationId: string
  message: string
  mode: 'direct_user_chat' | 'delegated_from_home'
  attachments?: Attachment[]
  tools: ToolSchema[]
  context: AppContext
  /**
   * Absolute path the adapter passes to the SDK as `cwd`. Purely a bucket
   * key for the SDK's `~/.claude/projects/<encoded-cwd>/` storage; the
   * adapter registers only MCP tools (no file tools), so `cwd` has no
   * effect beyond routing SDK jsonl writes. Caller is responsible for
   * mkdir-ing this path before the call.
   */
  cwd: string
  /**
   * True if the conversation has already been bound to the SDK (i.e. an
   * assistant turn has successfully committed). Drives `sessionId` (create)
   * vs `resume` — the two options are mutually exclusive per SDK contract.
   */
  sdkBound: boolean
  /**
   * SDK-side session UUID for resume. Set iff `sdkBound` is true. When
   * `sdkBound` is false the adapter generates a fresh one and emits it as
   * an `AgentSessionBoundEvent` so the caller can persist it.
   */
  sdkSessionId?: string
  /**
   * Optional label applied to the SDK session on first turn (via
   * `renameSession`). If omitted the adapter derives one from conversationId
   * and turnMode.
   */
  sessionLabel?: string
  /**
   * Optional cancellation signal. When aborted, the adapter must stop pulling
   * from the underlying LLM stream and end its event iterable promptly so that
   * the agent loop can return to the caller without further tool execution.
   * An in-flight tool is allowed to finish (side effects commit).
   */
  signal?: AbortSignal
  /**
   * Stable deviceId of the user-facing device that initiated this turn.
   * Forwarded to ToolContext so navigate-driving tools target only the
   * originating device. Optional — only set on direct_user_chat turns; nested
   * delegations from home → app inherit, while purely server-internal turns
   * (e.g. background sweeps) leave it unset.
   */
  originDeviceId?: string

  // ---- Edit-agent parameterization ----------------------------------------
  // All optional; adapters fall back to app-agent defaults when unset.

  /** SDK `allowedTools`. Unset → adapter derives `mcp__<mcpServerName>__*` from `tools`. */
  allowedTools?: string[]
  /** SDK `settingSources` (e.g. `['project']` to load skills). Unset → `[]`. */
  settingSources?: string[]
  /** SDK `skills` — which discovered skills to enable ('all' | names). Unset → adapter omits it. */
  skills?: string[] | 'all'
  /**
   * SDK permission mode. Unset → `'bypassPermissions'` (current app-agent).
   * `'dontAsk'` = deny-if-not-pre-approved with no prompts — used by the
   * edit-agent so its `PreToolUse` hook is the authoritative gate.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'
  /**
   * SDK `tools` — built-ins to ENABLE (distinct from `allowedTools`, which
   * auto-approves and bypasses permission checks). Unset → all built-ins disabled.
   */
  builtinTools?: string[]
  /**
   * SDK `hooks` (e.g. `PreToolUse` path-policy hook). Typed loosely to avoid
   * coupling to the SDK's hook types — edit-session builds the concrete shape.
   */
  hooks?: unknown
  /** SDK `canUseTool` callback (path policy). Unset → no filtering. */
  canUseTool?: PermissionCallback
  /** MCP server name. Unset → `'moumantai'`. */
  mcpServerName?: string
  /** Pre-built MCP tools (edit-agent's validate_face etc.). Unset → adapter builds from `tools`. */
  customMcpTools?: unknown[]
  /** SDK `maxTurns`. Unset → `10` (current app-agent). */
  maxTurns?: number
  /** Silence-watchdog window (LOCAL, not an SDK option). Unset → `30_000`. */
  heartbeatMs?: number
  /** System-prompt override. Unset → adapter builds via `buildSystemPrompt`. */
  systemPromptOverride?: string
}

/** SDK `canUseTool` permission callback. Edit-agent uses it for path policy. */
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

export type PermissionCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: unknown[] },
) => Promise<PermissionResult>

// ---------------------------------------------------------------------------
// LLM Adapter
// ---------------------------------------------------------------------------

/**
 * Translates between Moumantai and the LLM agent's wire format.
 * Tool calls are sequential — the adapter must not yield a second `toolCall`
 * before the prior one's result is submitted via `submitToolResult`.
 */
export interface LLMAdapter {
  connect(config: BackendConfig): Promise<void>
  disconnect(): Promise<void>

  /** Start a conversation turn. Returns an async iterable of events. */
  run(request: AgentRequest): AsyncIterable<AgentEvent>

  /** Submit a tool execution result. The adapter forwards to the LLM. */
  submitToolResult(conversationId: string, callId: string, result: ToolResult): void

  /**
   * Drop any in-memory state tied to this conversation (e.g. pending
   * tool-result waiters). Safe to call on an unknown id.
   */
  resetSession(conversationId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

/** Result of a talk_to_app delegation. Returned to home session as tool result. */
export interface DelegationResult {
  text: string
  status: 'success' | 'error'
  toolCalls: {
    name: string
    args: Record<string, unknown>
    result: unknown
  }[]
}

// ---------------------------------------------------------------------------
// Platform History
// ---------------------------------------------------------------------------

/** Turn mode for platform history entries. */
export type TurnMode = 'direct_user_chat' | 'delegated_from_home'

/** A single entry in Moumantai platform conversation history. */
export interface PlatformHistoryEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  status: 'sending' | 'sent' | 'error'
  turnMode?: TurnMode
  /** Source of delegated entries. Present when entry was created via talk_to_app. */
  source?: 'user' | 'home'
  /** Tool calls executed during this turn (assistant entries only). */
  toolCalls?: { name: string; args: Record<string, unknown>; result: unknown }[]
}

// ---------------------------------------------------------------------------
// App Definition
// ---------------------------------------------------------------------------

/** Complete app definition — tools (LLM-callable) and faces (full-screen data views). */
export interface AppDefinition {
  manifest: AppManifest
  schema?: Record<string, unknown>
  migrationsFolder?: string
  tools: ToolDefinition[]
  faces: FaceDefinition[]
  skill?: string
  /** App-level refresh tasks. Per-face refresh lives on FaceDefinition.refresh. */
  refreshTasks?: RefreshTaskDefinition[]
  /**
   * Technical setup config (Zod schema). Server-only — fields with `secretField()`
   * brand route to .env, the rest to config.json. NOT visible to the LLM.
   * Typed at consumer (`unknown` here to keep types.ts framework-pure).
   */
  config?: unknown
  /**
   * LLM-visible behavioral preferences (Zod schema). Stored in context.json.
   * Populates `AppContext.context` for every turn. Updatable via the
   * synthesized `update_context` tool.
   */
  context?: unknown
  /** Per-app upstream API rate budget. Refresh tasks + tool fetches share. */
  upstream?: AppUpstreamConfig
}

export interface AppUpstreamConfig {
  /** Token-bucket budget. Hard cap (no bypass): exceeders queue (bound 10) then drop. */
  maxRequestsPerMinute: number
}

// ---------------------------------------------------------------------------
// Refresh Task Definitions
// ---------------------------------------------------------------------------

/**
 * Context passed to a refresh task's `run` function. App-level tasks omit
 * `params`; face-bound tasks receive the mount instance's params.
 */
export interface RefreshContext {
  db: BetterSQLite3Database
  http: HttpClient
  cacheAsset: (url: string) => Promise<string>
  config: Record<string, unknown>
  /** Read-only view of context.json. To mutate, use setContext. */
  context: Record<string, unknown>
  /** Atomic write to context.json with Zod validation. */
  setContext: (field: string, value: unknown) => Promise<void>
  /** Present iff this task is face-bound (per-mount worker). */
  params?: Record<string, unknown>
}

/**
 * Optional return value from a refresh task's `run`. `nextRun` overrides
 * the default `every` for the next tick only — adaptive cadence.
 *
 * Forms accepted: '5s' | '30s' | '5m' | '1h' (interval form, not cron expr).
 */
export interface RefreshResult {
  nextRun?: string
  /**
   * Optional stable hash of the fetched data's rendering-relevant fields.
   * When the framework sees the same fingerprint two ticks in a row, it
   * skips the post-task face refresh + broadcast — the upsert ran (cheap
   * when unchanged) but no client sees a redundant faceUpdate. Computed
   * by the task body (sha1, JSON, whatever); the framework only compares
   * for equality. Omit if the task has nothing meaningful to fingerprint.
   */
  fingerprint?: string
}

/**
 * App-level refresh task definition. The framework runs these on a
 * schedule (`every` or `nextRun`-driven), gated by `mountedOnly`. Boot-time
 * warmup runs each task once at app boot when `warmup` is true.
 */
export interface RefreshTaskDefinition {
  id: string
  /** Default interval (e.g. '15m', '30s'). `run`'s `nextRun` overrides per tick. */
  every: string
  /**
   * Whether to gate ticks on at least one client mounted in this app's scope.
   * Defaults to true — viewer-app data is usually only fresh-when-watched.
   */
  mountedOnly?: boolean
  /**
   * Whether to run once at app boot regardless of mounted state. Idempotent
   * upserts make this safe across reboots and `cache-clear`. Defaults to
   * true when `mountedOnly` is true (fresh-on-first-open guarantee).
   */
  warmup?: boolean
  run: (ctx: RefreshContext) => Promise<RefreshResult | void>
}
