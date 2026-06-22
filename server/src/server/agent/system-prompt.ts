/**
 * Provider-neutral system-prompt builder.
 *
 * Shared by every LLMAdapter (Claude, mock, Pi…). The string this returns is
 * the same regardless of backend; how each backend injects it differs
 * (Claude: `systemPrompt` option; Pi: `DefaultResourceLoader.systemPromptOverride`).
 */

import type { AppContext, ToolSchema } from './types.js'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { formatFacesBlock, formatUserPreferencesBlock } from './face-context.js'

/** Build system prompt (app context + skill + schema + optional authoring guide). */
export function buildSystemPrompt(
  context: AppContext,
  // Kept for call-site stability; intentionally unused — the prompt never names
  // tools (see buildSystemPrompt test).
  _tools: ToolSchema[],
): string {
  const parts: string[] = []

  parts.push(`You are an assistant for the "${context.manifest.name}" app.`)
  if (context.manifest.description) {
    parts.push(context.manifest.description)
  }
  if (context.turnMode === 'delegated_from_home') {
    parts.push('This request was delegated from the home assistant. Provide a concise response.')
  }
  if (context.skill) {
    parts.push(`\n## Skill Instructions\n${context.skill}`)
  }
  if (context.schema) {
    parts.push(`\n## Database Schema\n${summarizeSchema(context.schema)}`)
  }
  if (context.availableApps?.length) {
    parts.push(`\n## Available Apps`)
    parts.push('Use talk_to_app to delegate requests to these apps:')
    for (const app of context.availableApps) {
      parts.push(`- **${app.name}** (app_id: "${app.appId}"): ${app.description}`)
    }
  }

  // Faces (parameterized faces expose a `view_<faceId>` tool the LLM uses
  // to steer view-state; format is shared with the mock adapter).
  if (context.faces?.length) {
    parts.push(formatFacesBlock(context.faces))
  }

  // User preferences. Apps with a non-empty context schema expose persisted
  // user preferences here so the LLM defaults from them when the user hasn't
  // specified, and steers updates via the synthesized `update_context` tool.
  if (context.context && Object.keys(context.context).length > 0) {
    parts.push(formatUserPreferencesBlock(context.context))
  }

  // UI escalation protocol — drives the chat dialog when a face affordance fires
  // a tool with required args missing (see action-handler.ts, format-ui-action.ts).
  // Omitted on delegated_from_home turns, which never receive a [ui_action] prompt.
  if (context.turnMode !== 'delegated_from_home') {
    parts.push(`\n## UI Escalation Protocol
When you receive a user message that begins with "[ui_action]":
- The format is "[ui_action] face=<id> tool=<name> missing=[<param>:<type> \\"<desc>\\", ...] provided=<json>".
- If the missing fields don't yet have values in this conversation, ask ONE
  short, natural question to elicit them. Don't restate the action. Don't
  echo the [ui_action] line. Be concise — this is a chat-style prompt, not a
  form description.
- If the user has now answered (a recent reply supplies the missing values),
  call the named tool with the typed values combined with anything in
  "provided", then confirm in one short sentence (e.g. "Done — daily goal is
  now 1800 kcal.").
- If the user's reply doesn't seem to answer the pending question (e.g.
  "never mind"), treat it as a new request — don't call the tool.`)
  }

  return parts.join('\n')
}

function summarizeSchema(schema: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [, table] of Object.entries(schema)) {
    if (!is(table, SQLiteTable)) continue
    const config = getTableConfig(table)
    const cols = config.columns.map((c) => `${c.name}${c.notNull ? '*' : ''}`).join(', ')
    lines.push(`  ${config.name}: [${cols}]`)
  }
  return lines.join('\n')
}
