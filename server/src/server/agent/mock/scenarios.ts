/**
 * Mock-adapter scenarios. Patterns here are framework-level only:
 * greeting + home tools (`talk_to_app`, `list_apps`, `navigate`) +
 * `[ui_action]` escalation (the framework's UI-tap-with-missing-args path).
 *
 * App-specific scenarios (e.g. "add expense" → `add_expense`) do NOT belong
 * here — they would couple the framework's mock to a specific plugin app.
 * Tests that need scripted app-tool calls should use ScriptedAdapter
 * (tests/helpers/face-params-fixtures.ts) instead.
 */

import type { AgentEvent } from '../types.js'

export type Scenario = AgentEvent[]

/**
 * Matches `[ui_action] face=<id> tool=<name> missing=[<spec>] provided=<json>`.
 * Captures the missing-spec inner content so the deterministic question
 * we synthesize includes the first param's description (or name) — same
 * UX surface as the Claude-driven path, just deterministic for tests.
 */
const UI_ACTION_RE = /^\[ui_action\]\s+face=\S+\s+tool=\S+\s+missing=\[([^\]]*)\]/

export function matchScenario(message: string, availableTools: string[]): Scenario {
  const trimmed = message.trim()
  const lower = trimmed.toLowerCase()

  // [ui_action] escalation — produce a deterministic single-sentence question
  // for the first missing field. Exercises the escalation branch without
  // requiring a live LLM in tests.
  const uiMatch = trimmed.match(UI_ACTION_RE)
  if (uiMatch) {
    const firstSpec = (uiMatch[1] ?? '').split(',')[0]?.trim() ?? ''
    // firstSpec ≈ `name:type "description"` — pull the description if present,
    // else the name. Mirrors the natural-language surface the system prompt
    // asks the real LLM to produce.
    const descMatch = firstSpec.match(/"([^"]+)"/)
    const nameMatch = firstSpec.match(/^([^:]+):/)
    const subject = descMatch?.[1] ?? nameMatch?.[1] ?? 'value'
    return [{ type: 'text', text: `What's the ${subject}?` }, { type: 'done' }]
  }

  if (/^(hi|hello|hey|good\s*(morning|afternoon|evening))/.test(lower)) {
    return [
      { type: 'text', text: "Hello! I'm your Moumantai assistant. How can I help?" },
      { type: 'done' },
    ]
  }

  // Home delegation: "talk to {app}"
  if (/talk\s+to/.test(lower) && availableTools.includes('talk_to_app')) {
    const appMatch = lower.match(/talk\s+to\s+(\S+)\s*(.*)/)
    if (appMatch) {
      return [
        {
          type: 'toolCall',
          callId: `call-${Date.now()}`,
          name: 'talk_to_app',
          args: { app_id: appMatch[1], message: appMatch[2] || message },
        },
        { type: 'text', text: '' }, // Home composes final reply from delegation result
        { type: 'done' },
      ]
    }
  }

  if (/list\s+apps|what\s+apps/.test(lower) && availableTools.includes('list_apps')) {
    return [
      { type: 'toolCall', callId: `call-${Date.now()}`, name: 'list_apps', args: {} },
      { type: 'text', text: 'Here are your available apps.' },
      { type: 'done' },
    ]
  }

  if (/open|go\s+to|navigate/.test(lower) && availableTools.includes('navigate')) {
    const navMatch = lower.match(/(?:open|go\s+to|navigate)\s+(\S+)/)
    if (navMatch) {
      return [
        {
          type: 'toolCall',
          callId: `call-${Date.now()}`,
          name: 'navigate',
          args: { app_id: navMatch[1] },
        },
        { type: 'text', text: `Opening ${navMatch[1]}.` },
        { type: 'done' },
      ]
    }
  }

  return [
    {
      type: 'text',
      text: "I'm a mock assistant. I respond to greetings and home tools (talk to <app>, list apps, navigate <app>).",
    },
    { type: 'done' },
  ]
}
