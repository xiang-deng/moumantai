/**
 * Tool Executor
 *
 * Validates parameters against a ToolDefinition, executes the tool,
 * and wraps the result. Errors are caught and returned as ToolResult
 * (never thrown) so the LLM can decide how to handle them.
 *
 * This module owns the type-translation boundary between client `$form`
 * scope (which renderers populate with widget-natural runtime types) and
 * the typed tool-param schema. See `shared/protocol/FORM_SCOPE.md` for the
 * full contract; the short version is:
 *   - UI invocation path → `validateAndCoerceUIArgs` (coerces strings to
 *     declared number/boolean types).
 *   - LLM / persisted-params path → `validateParamsAgainstSchema` (strict;
 *     no coercion; args are already native JSON types).
 *
 * UI vs LLM-direct outcomes diverge on the missing-required case. UI taps
 * with empty / unset required fields surface as a `missing` outcome so the
 * caller can escalate to a chat dialog; LLM-direct calls fold the same
 * condition into a normal error so the LLM observes today's behavior.
 * The `{ isUIInvocation }` option on `executeTool` selects between them.
 */

import type {
  ToolDefinition,
  ToolParameter,
  ToolResult,
  HttpClient,
  StalenessRecord,
} from './types.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

/** Default timeout for tool execution (ms). */
const DEFAULT_TIMEOUT_MS = 120_000

export interface ExecuteToolDeps {
  db: BetterSQLite3Database
  /** Conversation id forwarded to ToolContext.conversationId. Optional. */
  conversationId?: string
  /**
   * Active scope string ('home' or 'app:<id>'). Forwarded to ToolContext.scope
   * so synthesized view tools can gate the navigate-message side effect.
   */
  scope?: string
  /**
   * Stable deviceId of the originating device. Forwarded to
   * ToolContext.originDeviceId so navigate-driving tools target only the
   * originating device, not all connected devices.
   */
  originDeviceId?: string
  /**
   * LLM-visible app preferences. Forwarded to `ToolContext.context`
   * so tools can read user defaults / steer behavior. Optional — tools
   * tolerate omission via the same `?? fallback()` pattern as resolvers.
   */
  context?: Record<string, unknown>
  /** Per-app HTTP client. Refresh-aware tools use it for upstream calls. */
  http?: HttpClient
  /** Per-app asset cache. Tools that fetch images / logos hit this. */
  cacheAsset?: (url: string) => Promise<string>
  /** Per-task staleness factory. Manual `refresh_*` tools and the
   *  `staleness().refresh()` accessor route through this. */
  staleness?: (taskId: string) => StalenessRecord
  /** Typed app config. Loaded from config.json + .env at boot. */
  config?: Record<string, unknown>
  /** Atomic write to context.json. Synthesized `update_context` uses this. */
  setContext?: (field: string, value: unknown) => Promise<void>
}

export interface ExecuteToolOptions {
  /**
   * True when invoked from a client UI tap (action-handler). On a missing-
   * required outcome, propagates `ToolResult.missing` so the caller can
   * escalate. False (default; LLM-direct path) folds the same condition
   * into `ToolResult.error` to preserve strict behavior for the LLM.
   */
  isUIInvocation?: boolean
  /** Override the default 120s tool execution timeout. */
  timeoutMs?: number
}

/**
 * Execute a tool with validated parameters.
 *
 * - Validates required params and basic types
 * - Wraps execution in try/catch + timeout
 * - Always returns a ToolResult (never throws)
 */
export async function executeTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  deps: ExecuteToolDeps,
  options: ExecuteToolOptions = {},
): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const isUIInvocation = options.isUIInvocation ?? false

  // 1. Validate + coerce. UI `$form` produces strings even for numeric params;
  // coerce to declared types here. See `shared/protocol/FORM_SCOPE.md`.
  const outcome = validateAndCoerceUIArgs(tool.parameters, args)
  if (outcome.kind === 'missing') {
    if (isUIInvocation) {
      return {
        result: null,
        missing: { fields: outcome.missing, provided: outcome.provided },
      }
    }
    // LLM-direct: fold into a normal error (no accidental escalation).
    const first = outcome.missing[0]
    return { result: null, error: `Missing required parameter: "${first}"` }
  }
  if (outcome.kind === 'error') {
    return { result: null, error: outcome.error }
  }

  // 2. Execute with timeout
  try {
    const result = await withTimeout(
      tool.execute({
        params: outcome.args,
        db: deps.db,
        conversationId: deps.conversationId,
        scope: deps.scope,
        originDeviceId: deps.originDeviceId,
        context: deps.context,
        http: deps.http,
        cacheAsset: deps.cacheAsset,
        staleness: deps.staleness,
        config: deps.config,
        setContext: deps.setContext,
      }),
      timeoutMs,
      `Tool "${tool.name}" timed out after ${timeoutMs}ms`,
    )
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { result: null, error: message }
  }
}

// ---------------------------------------------------------------------------
// Param validation + coercion
// ---------------------------------------------------------------------------

/**
 * Strict validator: returns null on success or a human-readable error
 * string. Used by paths where args are guaranteed to arrive with native
 * JSON types — LLM tool calls (Anthropic SDK delivers typed args) and
 * `face-params-store` schema-drift checks against persisted view-state.
 *
 * UI invocations DO NOT use this — they go through `validateAndCoerceUIArgs`
 * because `$form` produces string values for text-typed widgets. See
 * `shared/protocol/FORM_SCOPE.md` for the full split.
 */
export function validateParamsAgainstSchema(
  schema: Record<string, ToolParameter>,
  args: Record<string, unknown>,
): string | null {
  for (const [name, param] of Object.entries(schema)) {
    const value = args[name]

    if (param.required && (value === undefined || value === null)) {
      return `Missing required parameter: "${name}"`
    }
    if (value === undefined || value === null) continue

    const actualType = typeof value
    if (param.type === 'number' && actualType !== 'number') {
      return `Parameter "${name}" must be a number, got ${actualType}`
    }
    if (param.type === 'string' && actualType !== 'string') {
      return `Parameter "${name}" must be a string, got ${actualType}`
    }
    if (param.type === 'boolean' && actualType !== 'boolean') {
      return `Parameter "${name}" must be a boolean, got ${actualType}`
    }
  }
  return null
}

/**
 * Three-state outcome of UI-invocation arg validation.
 *
 * - `ok`      : all params present and well-typed; `args` are coerced.
 * - `missing` : one or more required params are unset / null / empty-string
 *               (the empty-string case is what makes a UI tap with an
 *               un-filled text field land here rather than in `error`).
 * - `error`   : a present param failed type/coercion (NaN, "abc" for number,
 *               "yes" for boolean, etc.). The shape was wrong, not absent.
 */
type ValidationOutcome =
  | { kind: 'ok'; args: Record<string, unknown> }
  | { kind: 'missing'; missing: string[]; provided: Record<string, unknown> }
  | { kind: 'error'; error: string }

/**
 * UI-invocation validator: coerces `$form`-sourced strings to the declared
 * tool-param type and splits absence (missing-required) from shape error.
 *
 * Why the split: a UI tap with an empty text field looks like a missing
 * required arg, not a malformed one — escalating to a chat dialog asks the
 * user for the value rather than surfacing a confusing toast. A wrongly
 * typed value (free-text `keyboard_type` on a numeric param, e.g.) is a
 * shape error and stays an error.
 *
 * Coercion matrix (mirrored in `shared/protocol/FORM_SCOPE.md`):
 *   - `number`  ← `number` | finite numeric string (`Number(s)` finite)
 *   - `boolean` ← `boolean` | the literals `'true'` / `'false'`
 *   - `string`  ← `string` only (no coercion)
 *
 * Empty string for ANY required param is treated as missing — text fields
 * write `''` when the user clears them, and the UX gain of asking-in-chat
 * outweighs the loss of "user explicitly typed nothing" semantics.
 */
function validateAndCoerceUIArgs(
  schema: Record<string, ToolParameter>,
  args: Record<string, unknown>,
): ValidationOutcome {
  const out: Record<string, unknown> = { ...args }
  const missing: string[] = []

  // First pass: gather all missing-required fields (ask for all at once).
  for (const [name, param] of Object.entries(schema)) {
    if (!param.required) continue
    const value = out[name]
    if (value === undefined || value === null) {
      missing.push(name)
      continue
    }
    if (typeof value === 'string' && value === '') missing.push(name)
  }
  if (missing.length > 0) {
    const provided: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out)) {
      if (missing.includes(k)) continue
      if (v === undefined || v === null) continue
      if (typeof v === 'string' && v === '') continue
      provided[k] = v
    }
    return { kind: 'missing', missing, provided }
  }

  // Second pass: coerce / shape-check what's present.
  for (const [name, param] of Object.entries(schema)) {
    const value = out[name]
    if (value === undefined || value === null) continue

    if (param.type === 'number') {
      if (typeof value === 'number') continue
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        if (Number.isFinite(n)) {
          out[name] = n
          continue
        }
      }
      return { kind: 'error', error: `Parameter "${name}" must be a number, got ${typeof value}` }
    }
    if (param.type === 'boolean') {
      if (typeof value === 'boolean') continue
      if (typeof value === 'string') {
        if (value === 'true') {
          out[name] = true
          continue
        }
        if (value === 'false') {
          out[name] = false
          continue
        }
      }
      return { kind: 'error', error: `Parameter "${name}" must be a boolean, got ${typeof value}` }
    }
    if (param.type === 'string' && typeof value !== 'string') {
      return { kind: 'error', error: `Parameter "${name}" must be a string, got ${typeof value}` }
    }
  }
  return { kind: 'ok', args: out }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise
      .then((val) => {
        clearTimeout(timer)
        resolve(val)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}
