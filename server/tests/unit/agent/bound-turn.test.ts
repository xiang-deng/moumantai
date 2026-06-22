import { describe, it, expect, vi } from 'vitest'
import { TurnQueue } from '../../../src/server/agent/turn-queue.js'
import { runBoundTurn, sdkResumeArgs } from '../../../src/server/agent/bound-turn.js'
import type { SdkResumeArgs } from '../../../src/server/agent/bound-turn.js'
import type { AgentLoopResult } from '../../../src/server/agent/agent-loop.js'
import type { ConversationStore } from '../../../src/server/conversations/store.js'

const ok = (sdkSessionId?: string): AgentLoopResult => ({
  text: 'ok',
  toolCalls: [],
  success: true,
  ...(sdkSessionId ? { sdkSessionId } : {}),
})

/**
 * Minimal in-memory stand-in for the columns runBoundTurn touches, mirroring
 * bindSdkSession's write-once-per-backend semantics.
 */
function fakeStore(
  initial?: Partial<{ sdkSessionId: string; sdkBoundAt: string; sdkBackend: string }>,
) {
  let row = {
    id: 'c1',
    sdkSessionId: (initial?.sdkSessionId ?? null) as string | null,
    sdkBoundAt: (initial?.sdkBoundAt ?? null) as string | null,
    sdkBackend: (initial?.sdkBackend ?? null) as string | null,
  }
  const bindSdkSession = vi.fn((id: string, sid: string, backend: string) => {
    if (id !== row.id) return
    // write-once for the same backend; overwrite on backend change.
    if (row.sdkSessionId === null || row.sdkBackend !== backend) {
      row = { ...row, sdkSessionId: sid, sdkBoundAt: 'now', sdkBackend: backend }
    }
  })
  const store = {
    getById: (id: string) => (id === row.id ? { ...row } : undefined),
    bindSdkSession,
  } as unknown as ConversationStore
  return { store, bindSdkSession, current: () => row }
}

describe('sdkResumeArgs', () => {
  const bound = { sdkSessionId: 'S1', sdkBoundAt: '2026-01-01', sdkBackend: 'claude' }

  it('resumes when bound to the same backend', () => {
    expect(sdkResumeArgs(bound, 'claude')).toEqual({ sdkBound: true, sdkSessionId: 'S1' })
  })

  it('creates when never bound', () => {
    expect(
      sdkResumeArgs({ sdkSessionId: null, sdkBoundAt: null, sdkBackend: null }, 'claude'),
    ).toEqual({
      sdkBound: false,
    })
  })

  it('creates when the backend differs (id belongs to the other SDK)', () => {
    expect(sdkResumeArgs(bound, 'pi')).toEqual({ sdkBound: false })
  })

  it('creates when bound-at is missing even if an id is present', () => {
    expect(
      sdkResumeArgs({ sdkSessionId: 'S1', sdkBoundAt: null, sdkBackend: 'claude' }, 'claude'),
    ).toEqual({ sdkBound: false })
  })
})

describe('runBoundTurn', () => {
  it('passes the stored session id as a resume (the delegation regression)', async () => {
    const { store } = fakeStore({ sdkSessionId: 'S1', sdkBoundAt: 'x', sdkBackend: 'claude' })
    let seen: SdkResumeArgs | undefined
    await runBoundTurn(
      { store, turnQueue: new TurnQueue(), conversationId: 'c1', backend: 'claude' },
      async (resume) => {
        seen = resume
        return ok()
      },
    )
    expect(seen).toEqual({ sdkBound: true, sdkSessionId: 'S1' })
  })

  it('binds the turn-reported session id inside the slot', async () => {
    const { store, bindSdkSession } = fakeStore()
    await runBoundTurn(
      { store, turnQueue: new TurnQueue(), conversationId: 'c1', backend: 'claude' },
      async () => ok('NEW'),
    )
    expect(bindSdkSession).toHaveBeenCalledWith('c1', 'NEW', 'claude')
  })

  it('binds on init even when the turn fails mid-stream (bind-on-init)', async () => {
    const { bindSdkSession, store } = fakeStore()
    await runBoundTurn(
      { store, turnQueue: new TurnQueue(), conversationId: 'c1', backend: 'claude' },
      async () => ({ text: 'boom', toolCalls: [], success: false, sdkSessionId: 'PARTIAL' }),
    )
    expect(bindSdkSession).toHaveBeenCalledWith('c1', 'PARTIAL', 'claude')
  })

  it('two concurrent first turns converge on one session (no double-mint)', async () => {
    const { store } = fakeStore() // unbound
    const tq = new TurnQueue()
    const seen: SdkResumeArgs[] = []
    let minted = 0
    const build = async (resume: SdkResumeArgs): Promise<AgentLoopResult> => {
      seen.push(resume)
      // CREATE turns mint a fresh id; RESUME turns echo the one they were given.
      return ok(resume.sdkBound ? resume.sdkSessionId : `S${++minted}`)
    }
    const deps = { store, turnQueue: tq, conversationId: 'c1', backend: 'claude' }
    await Promise.all([runBoundTurn(deps, build), runBoundTurn(deps, build)])

    // The queue serializes both on conv.id; the second reads the first's bind
    // IN-LOCK and resumes it rather than minting a second session.
    expect(seen[0]).toEqual({ sdkBound: false })
    expect(seen[1]).toEqual({ sdkBound: true, sdkSessionId: 'S1' })
    expect(minted).toBe(1)
  })
})
