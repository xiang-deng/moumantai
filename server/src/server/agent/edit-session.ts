/**
 * Edit-agent session factory.
 *
 * Builds the `AgentRequest` that runs the coding agent inside a draft worktree:
 * SDK built-in file tools + Skill auto-discovery + TodoWrite + our custom MCP
 * tools (validate_face / validate_tool / generate_migration /
 * request_promote_review), gated by an asymmetric read/write path policy.
 *
 * The agent runs against the SAME LLMAdapter instance as the app-agent — this
 * is just a second AgentRequest with the edit-agent's tool surface, cwd (the
 * draft worktree), system prompt, and permission callback. Claude-backed for
 * full functionality (Skill + canUseTool are Claude-SDK features; see the Pi
 * adapter note).
 */

import path from 'node:path'
import type { AgentRequest, AppContext, PermissionCallback, PermissionResult } from './types.js'
import { buildEditMcpTools } from './edit-mcp-tools.js'
import type { DraftKindStr } from '../drafts/types.js'

// ---------------------------------------------------------------------------
// Path policy (canUseTool)
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Edit', 'Write'])

/**
 * Read-only web tools. The edit-agent uses these to verify the ACTUAL external
 * contract it builds on (upstream API shape, doc, status codes) instead of
 * guessing — anchoring changes to reality rather than assumptions. `WebFetch`
 * is gated to public hosts (SSRF guard below); `WebSearch` is read-only and
 * carries no URL to gate, so it is allowed as-is.
 */
const WEB_FETCH = 'WebFetch'
const WEB_SEARCH = 'WebSearch'

/**
 * SSRF guard: this agent runs server-side, so WebFetch must never reach the
 * loopback, private (RFC 1918), link-local, or cloud-metadata ranges — that
 * would let a prompt pivot into internal services or the metadata endpoint.
 * Only public http(s) hosts are allowed through.
 */
function isBlockedFetchHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true // IPv6 link-local / ULA
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 127 || a === 10) return true // unspecified, loopback, private
    if (a === 169 && b === 254) return true // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
  }
  return false
}

// Server-owned paths inside the worktree — agent reads but cannot write (the
// shadow DB, materialized skill, draft metadata).
const WRITE_DENY_INSIDE_DRAFT = ['.meta.json', '.claude', '.shadow']

const BASH_ALLOWLIST: RegExp[] = [
  /^task validate\b/,
  /^task check\b/,
  /^task generate\b/,
  /^sqlite3 -readonly\s/, // query the shadow DB for realistic data
  /^node --version$/,
  /^(ls|cat|head|tail|grep)\s/,
]

/** Pull the filesystem path a tool input refers to (Read/Edit/Write/Glob/Grep). */
function extractPath(input: Record<string, unknown>): string | undefined {
  return (input.file_path as string | undefined) ?? (input.path as string | undefined) ?? undefined
}

function under(p: string, root: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function underAny(p: string, roots: string[]): boolean {
  return roots.some((r) => under(p, r))
}

/**
 * Asymmetric path policy for the edit-agent:
 *  - Read/Glob/Grep: under the draft worktree OR `<home>/apps-src/**` (cross-app
 *    reference, read-only).
 *  - Edit/Write: under the draft worktree only, minus the server-owned paths.
 *  - Bash: allowlist only.
 *  - Everything else (Skill, MCP tools): allowed.
 * The shadow DB lives under the worktree, so reads of it are already covered.
 */
export function makePathPolicy(draftDir: string, appsSrcDir: string): PermissionCallback {
  const readableRoots = [draftDir, appsSrcDir]
  // Bounded, security-relevant signal: log every DENY (rare; the high-value
  // line for "is the sandbox actually enforcing?"). Allows stay quiet — the
  // adapter already logs each tool_use. Skipped under vitest to keep unit
  // output clean.
  const denied = (toolName: string, target: string, message: string): PermissionResult => {
    if (!process.env.VITEST) {
      console.warn(`[edit-policy] DENY tool=${toolName} target=${target} — ${message}`)
    }
    return { behavior: 'deny', message }
  }
  return async (toolName, input): Promise<PermissionResult> => {
    if (READ_TOOLS.has(toolName)) {
      const p = path.resolve(draftDir, extractPath(input) ?? '')
      if (!underAny(p, readableRoots)) {
        return denied(toolName, p, 'path outside readable area (draft + apps-src)')
      }
      return { behavior: 'allow', updatedInput: input }
    }
    if (WRITE_TOOLS.has(toolName)) {
      const p = path.resolve(draftDir, extractPath(input) ?? '')
      if (!under(p, draftDir)) {
        return denied(
          toolName,
          p,
          `Edit/Write only allowed inside your draft worktree (${draftDir})`,
        )
      }
      const rel = path.relative(draftDir, p)
      if (WRITE_DENY_INSIDE_DRAFT.some((d) => rel === d || rel.startsWith(d + path.sep))) {
        return denied(
          toolName,
          p,
          'that path is server-owned / read-only (draft metadata, materialized skill, shadow DB)',
        )
      }
      return { behavior: 'allow', updatedInput: input }
    }
    if (toolName === 'Bash') {
      const cmd = (input.command as string) ?? ''
      if (!BASH_ALLOWLIST.some((re) => re.test(cmd))) {
        return denied(
          toolName,
          cmd.slice(0, 60),
          'Bash command not in allowlist. Allowed: task validate*, task check, task generate, sqlite3 -readonly, node --version, ls, cat, head, tail, grep.',
        )
      }
      return { behavior: 'allow', updatedInput: input }
    }
    if (toolName === WEB_FETCH) {
      const url = (input.url as string) ?? ''
      let host: string
      try {
        const u = new URL(url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return denied(toolName, url.slice(0, 80), 'WebFetch allows only http(s) URLs')
        }
        host = u.hostname
      } catch {
        return denied(toolName, url.slice(0, 80), 'WebFetch: invalid URL')
      }
      if (isBlockedFetchHost(host)) {
        return denied(
          toolName,
          host,
          'WebFetch to loopback / private / link-local / metadata hosts is blocked (SSRF guard)',
        )
      }
      return { behavior: 'allow', updatedInput: input }
    }
    if (toolName === WEB_SEARCH) {
      // Read-only search; no URL to gate.
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

// ---------------------------------------------------------------------------
// PreToolUse hook (the ACTUAL enforcement point)
// ---------------------------------------------------------------------------

/** Decision shape a PreToolUse hook returns to the SDK (subset of the SDK type). */
export interface PreToolUseHookResult {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'allow' | 'deny'
    permissionDecisionReason?: string
  }
}

/**
 * Build the SDK `hooks` object whose `PreToolUse` callback enforces the path
 * policy. We use a hook (not `canUseTool`) because the hook runs FIRST in the
 * permission chain and is NOT bypassed by `allowedTools` — `canUseTool` is a
 * late fallback the SDK skips for auto-approved tools (the original bug). The
 * hook is a thin wrapper over `makePathPolicy`, so the decision logic + its
 * tests stay shared. Returns the value for `Options.hooks`.
 */
export function makePreToolUseHook(draftDir: string, appsSrcDir: string) {
  const policy = makePathPolicy(draftDir, appsSrcDir)
  const callback = async (
    input: { tool_name: string; tool_input?: unknown },
    _toolUseID?: string,
    options?: { signal?: AbortSignal },
  ): Promise<PreToolUseHookResult> => {
    const signal = options?.signal ?? new AbortController().signal
    const result = await policy(
      input.tool_name,
      (input.tool_input ?? {}) as Record<string, unknown>,
      { signal },
    )
    return result.behavior === 'deny'
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: result.message,
          },
        }
      : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
  }
  return { PreToolUse: [{ hooks: [callback] }] }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildEditSystemPrompt(opts: {
  kind: DraftKindStr
  draftDir: string
  appsSrcDir: string
  liveAppId?: string
}): string {
  const { kind, draftDir, appsSrcDir, liveAppId } = opts
  const lines: string[] = [
    `You are the Moumantai edit-agent. Your cwd is a draft worktree at ${draftDir}.`,
    '',
  ]
  if (kind === 'edit') {
    lines.push(
      `Live version of "${liveAppId}" is at ${appsSrcDir}/${liveAppId}/.`,
      `You can READ from there (and from any other app under ${appsSrcDir}) for`,
      'reference patterns. You can only WRITE inside your cwd.',
    )
  } else {
    lines.push(
      'You are scaffolding a NEW app. Pick a kebab-case manifest.id distinct from',
      'all existing apps; "home" is reserved.',
    )
  }
  lines.push(
    '',
    'Available skills are auto-loaded from your cwd via the Skill tool. Read',
    'the skill FIRST; it is your authoritative guide for what to do and how',
    'to do it (including the plan-first rule for non-trivial changes).',
    '',
    'When the draft is ready, call request_promote_review with a one-paragraph',
    'summary. The user — not you — decides Promote or Discard via the PWA.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

export interface BuildEditAgentRequestOpts {
  draftId: string
  conversationId: string
  message: string
  kind: DraftKindStr
  draftDir: string
  appsSrcDir: string
  shadowDbPath: string
  /** Live app id (edit drafts only) — for the prompt + cross-app read hint. */
  liveAppId?: string
  /** Moumantai home + repo root — for validate_types (scratch tsconfig + SDK paths). */
  home: string
  repoRoot: string
  sdkBound: boolean
  sdkSessionId?: string
  signal?: AbortSignal
  /** Called by request_promote_review once all validators pass. */
  markReadyForReview: (summary: string) => void
}

// SDK `tools` = built-ins to ENABLE. NOT auto-approved — the PreToolUse hook
// gates each call (WebFetch is host-gated, WebSearch allowed read-only). 'Skill'
// is omitted because `skills` option auto-enables it.
const EDIT_AGENT_BUILTIN_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
]

// SDK `allowedTools` = tools to AUTO-APPROVE (bypasses permission checks).
// File/Bash built-ins are intentionally absent so they fall to the PreToolUse
// hook — auto-approval would bypass it (the original scoping hole).
const EDIT_AGENT_AUTO_APPROVE = [
  'TodoWrite',
  'mcp__edit__validate_face',
  'mcp__edit__validate_tool',
  'mcp__edit__validate_types',
  'mcp__edit__generate_migration',
  'mcp__edit__request_promote_review',
]

/**
 * Construct the `AgentRequest` for one edit-agent turn. Tool surface, cwd,
 * permission policy, prompt, and SDK knobs (maxTurns 200, heartbeat 5min,
 * settingSources ['project'], mcp server 'edit') are set here; the adapter
 * reads them via the Phase-6 parameterization.
 *
 * Enforcement model: built-ins are ENABLED via `builtinTools` but NOT
 * auto-approved; only `EDIT_AGENT_AUTO_APPROVE` goes in `allowedTools`. The
 * `PreToolUse` hook (`makePreToolUseHook`) is the authoritative path gate, and
 * `permissionMode: 'dontAsk'` denies anything not pre-approved without prompting.
 */
export function buildEditAgentRequest(opts: BuildEditAgentRequestOpts): AgentRequest {
  const context: AppContext = {
    appId: opts.liveAppId ?? opts.draftId,
    manifest: {
      id: opts.liveAppId ?? opts.draftId,
      version: '0.0.0',
      name: opts.kind === 'edit' ? `Editing ${opts.liveAppId}` : 'New app draft',
      icon: 'construction',
      description: 'Moumantai draft edit session',
    },
    turnMode: 'direct_user_chat',
  }

  const customMcpTools = buildEditMcpTools({
    draftId: opts.draftId,
    draftDir: opts.draftDir,
    shadowDbPath: opts.shadowDbPath,
    markReadyForReview: opts.markReadyForReview,
    // validate_types: live baseline for diff-scoping (null for new-app) + paths.
    liveSrcDir: opts.liveAppId ? path.join(opts.appsSrcDir, opts.liveAppId) : null,
    home: opts.home,
    repoRoot: opts.repoRoot,
  })

  return {
    conversationId: opts.conversationId,
    message: opts.message,
    mode: 'direct_user_chat',
    tools: [],
    context,
    cwd: opts.draftDir,
    sdkBound: opts.sdkBound,
    sdkSessionId: opts.sdkSessionId,
    signal: opts.signal,
    builtinTools: EDIT_AGENT_BUILTIN_TOOLS,
    allowedTools: EDIT_AGENT_AUTO_APPROVE,
    settingSources: ['project'],
    skills: 'all',
    // 'dontAsk' = deny-if-not-pre-approved, no prompts.
    permissionMode: 'dontAsk',
    hooks: makePreToolUseHook(opts.draftDir, opts.appsSrcDir),
    mcpServerName: 'edit',
    customMcpTools,
    maxTurns: 200,
    heartbeatMs: 300_000,
    systemPromptOverride: buildEditSystemPrompt({
      kind: opts.kind,
      draftDir: opts.draftDir,
      appsSrcDir: opts.appsSrcDir,
      liveAppId: opts.liveAppId,
    }),
  }
}
