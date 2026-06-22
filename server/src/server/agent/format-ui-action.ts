/**
 * Formats the synthetic prompt that escalates a UI tap with missing
 * required args into a chat dialog with the agent.
 *
 * The output is fed to `agentLoop.runTurn` as a user-role message; the LLM
 * follows the system-prompt rule (`buildSystemPrompt`) to ask one
 * short natural question for the missing fields. The same line lands in
 * SDK jsonl, so when the user answers in chat the next turn sees the full
 * `[ui_action] ... <user answer>` context and calls the named tool with
 * typed values.
 *
 * Format:
 *   [ui_action] face=<faceId> tool=<toolName> missing=[<name>:<type> "<desc>", ...] provided=<json>
 *
 * Missing-spec includes the param `description` when present so the LLM
 * has natural-language context for its question without extra round-trips.
 */

import type { ToolDefinition } from './types.js'

export interface FormatUiActionPromptArgs {
  faceId: string
  tool: ToolDefinition
  missing: string[]
  provided: Record<string, unknown>
}

export function formatUiActionPrompt(args: FormatUiActionPromptArgs): string {
  const missingSpec = args.missing
    .map((name) => {
      const param = args.tool.parameters[name]
      if (!param) return name
      const desc = param.description ? ` "${param.description}"` : ''
      return `${name}:${param.type}${desc}`
    })
    .join(', ')
  const providedJson = (() => {
    try {
      return JSON.stringify(args.provided)
    } catch {
      return '{}'
    }
  })()
  return `[ui_action] face=${args.faceId} tool=${args.tool.name} missing=[${missingSpec}] provided=${providedJson}`
}
