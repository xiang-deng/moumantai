/**
 * Session-binding turn primitive.
 *
 * The SDK session lifecycle is "read binding → serialize on the conversation →
 * run the turn → bind the result". `runBoundTurn` owns that protocol for the
 * paths that drive their own turn on a conversation id (direct user chat and
 * home→app delegation). Doing the read AND the bind *inside* the TurnQueue slot
 * is what makes two near-simultaneous first turns converge on one session id
 * rather than each minting its own (the first-turn double-mint).
 *
 * Two paths deliberately do NOT use this wrapper:
 *  - escalation runs inside an existing TurnQueue slot for the same conversation
 *    (a re-entrant enqueue would deadlock on the slot it already holds), and
 *  - the edit-agent path is single-flight per draft.
 * Both call `sdkResumeArgs` directly within their own serialized section.
 */
import type { ConversationStore } from '../conversations/store.js'
import type { TurnQueue } from './turn-queue.js'
import type { AgentLoopResult } from './agent-loop.js'

/** The conversation columns that decide create-vs-resume. */
interface SdkBindingRow {
  sdkSessionId: string | null
  sdkBoundAt: string | null
  sdkBackend: string | null
}

/** Adapter-request fields that select the SDK session for a turn. */
export interface SdkResumeArgs {
  sdkBound: boolean
  sdkSessionId?: string
}

/**
 * Compute the create-vs-resume args for a turn from a conversation row. Resume
 * only when the row is bound to a session for the SAME backend; a mismatched or
 * absent binding falls back to create (the adapter mints a fresh id). This is
 * the single place the rule lives — every turn-runner calls it, so a new caller
 * can't reintroduce the drift that broke delegation.
 */
export function sdkResumeArgs(conv: SdkBindingRow, backend: string): SdkResumeArgs {
  if (conv.sdkSessionId !== null && conv.sdkBoundAt !== null && conv.sdkBackend === backend) {
    return { sdkBound: true, sdkSessionId: conv.sdkSessionId }
  }
  return { sdkBound: false }
}

export interface BoundTurnDeps {
  store: ConversationStore
  turnQueue: TurnQueue
  conversationId: string
  /** Active LLM backend; gates resume and is recorded by `bindSdkSession`. */
  backend: string
}

/**
 * Run one turn under the conversation's TurnQueue slot, reading the session
 * binding and writing it back INSIDE that slot. `build` constructs and runs the
 * actual AgentLoop turn given the resume args and the slot's abort signal.
 *
 * Binds on init (matching the other turn paths): persists whenever the turn
 * reports an `sdkSessionId`, even on a mid-stream failure, so resume survives
 * errors. Propagates `turnQueue.enqueue`'s `SessionBusyError`/`AbortError`
 * when the queue is full or the slot is aborted — callers map those to a
 * user-visible outcome.
 */
export async function runBoundTurn(
  deps: BoundTurnDeps,
  build: (resume: SdkResumeArgs, signal: AbortSignal) => Promise<AgentLoopResult>,
): Promise<AgentLoopResult> {
  return deps.turnQueue.enqueue(deps.conversationId, {
    run: async (signal) => {
      const conv = deps.store.getById(deps.conversationId)
      if (!conv) throw new Error(`runBoundTurn: conversation ${deps.conversationId} not found`)
      const result = await build(sdkResumeArgs(conv, deps.backend), signal)
      if (result.sdkSessionId) {
        deps.store.bindSdkSession(deps.conversationId, result.sdkSessionId, deps.backend)
      }
      return result
    },
  })
}
