/**
 * Mock Agent Adapter
 *
 * Implements LLMAdapter for dev/testing. Uses keyword-based scenario
 * matching to emit AgentEvent streams. The generator pauses on toolCall
 * events and resumes when submitToolResult is called.
 */

import type { LLMAdapter, AgentEvent, AgentRequest, BackendConfig, ToolResult } from '../types.js'
import { matchScenario } from './scenarios.js'
import { buildSystemPrompt } from '../system-prompt.js'

/** Per-session conversation history (internal to the adapter). */
interface SessionHistory {
  messages: { role: 'user' | 'assistant'; text: string }[]
}

/**
 * Pending tool result signal. When the generator yields a toolCall,
 * it creates a promise and waits. submitToolResult resolves it.
 */
interface PendingToolResult {
  resolve: (result: ToolResult) => void
  callId: string
}

export class MockAgentAdapter implements LLMAdapter {
  private latencyMs = 0
  private sessions = new Map<string, SessionHistory>()
  private pendingToolResults = new Map<string, PendingToolResult>()

  async connect(config: BackendConfig): Promise<void> {
    this.latencyMs = config.latencyMs ?? 0
  }

  async disconnect(): Promise<void> {
    this.sessions.clear()
    this.pendingToolResults.clear()
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    // Get or create session history
    const session = this.getOrCreateSession(request.conversationId)

    // Mock has no real SDK session — never emit `sessionBound`.
    // `sdk_session_id` + `sdk_backend` stay NULL across mock turns.
    // Switching to a real backend is safe: NULL columns hit case 1 in
    // bindSdkSession, and a backend mismatch triggers case 4 (fresh bind).

    // Record user message
    session.messages.push({ role: 'user', text: request.message })

    // Build system prompt (for completeness — mock doesn't use it for generation)
    buildSystemPrompt(request.context, request.tools)

    // Match scenario based on message keywords and available tools
    const toolNames = request.tools.map((t) => t.name)
    const scenario = matchScenario(request.message, toolNames)

    // Accumulate text for history
    let accumulatedText = ''

    // Honor AbortSignal: resolve any pending tool wait with 'aborted' and stop.
    const onAbort = () => {
      const prefix = `${request.conversationId}:`
      for (const [key, pending] of [...this.pendingToolResults]) {
        if (key.startsWith(prefix)) {
          pending.resolve({ result: null, error: 'aborted' })
          this.pendingToolResults.delete(key)
        }
      }
    }
    if (request.signal) {
      if (request.signal.aborted) return
      request.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for (const event of scenario) {
        if (request.signal?.aborted) return

        if (this.latencyMs > 0) {
          await delay(this.latencyMs)
        }

        if (event.type === 'toolCall') {
          const waitPromise = this.waitForToolResult(request.conversationId, event.callId)
          yield event
          await waitPromise
          continue
        }

        if (event.type === 'text') {
          accumulatedText += event.text
        }

        yield event
      }

      // Record assistant response in session history
      if (accumulatedText) {
        session.messages.push({ role: 'assistant', text: accumulatedText })
      }
    } finally {
      if (request.signal) request.signal.removeEventListener('abort', onAbort)
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
    this.sessions.delete(conversationId)
    const prefix = `${conversationId}:`
    for (const key of [...this.pendingToolResults.keys()]) {
      if (!key.startsWith(prefix)) continue
      const pending = this.pendingToolResults.get(key)
      pending?.resolve({ result: null, error: 'aborted' })
      this.pendingToolResults.delete(key)
    }
  }

  /** Get session history (for testing). */
  getHistory(conversationId: string): { role: string; text: string }[] {
    return [...(this.sessions.get(conversationId)?.messages ?? [])]
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private getOrCreateSession(conversationId: string): SessionHistory {
    let session = this.sessions.get(conversationId)
    if (!session) {
      session = { messages: [] }
      this.sessions.set(conversationId, session)
    }
    return session
  }

  private waitForToolResult(conversationId: string, callId: string): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      this.pendingToolResults.set(`${conversationId}:${callId}`, { resolve, callId })
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Test helper: construct + connect a `MockAgentAdapter` ready to plug into
 * `createAppServer({ adapterOverride: ... })`. Default 0 latency so tests
 * don't wait on synthetic delays.
 */
export async function connectMockAdapter(latencyMs = 0): Promise<MockAgentAdapter> {
  const adapter = new MockAgentAdapter()
  await adapter.connect({ type: 'mock', latencyMs })
  return adapter
}
