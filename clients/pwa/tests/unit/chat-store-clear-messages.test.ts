import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../../src/stores/chat-store'

/**
 * `clearMessages(appId, 'dev')` is the primitive behind two flows:
 *   - the dev-thread Reset control (optimistic local clear), and
 *   - the promote/discard local-clear (so a finished draft's thread doesn't
 *     linger and a fresh edit doesn't append onto stale bubbles).
 * It must clear ONLY the `${appId}::dev` thread — never the regular chat — and
 * a new-app draft's thread lives under `home::dev` (NOT the home chat).
 */
function msg(id: string) {
  return {
    id,
    role: 'user' as const,
    text: id,
    timestamp: '2026-01-01T00:00:00Z',
    status: 'sent' as const,
  }
}

describe('chat-store clearMessages(appId, kind)', () => {
  beforeEach(() => {
    useChatStore.setState({ messagesByApp: new Map(), pendingByApp: new Map() })
  })

  it('kind="dev" clears only the dev thread, leaving the chat thread intact', () => {
    const s = useChatStore.getState()
    s.addMessage('home', msg('chat-1'), 'chat')
    s.addMessage('home', msg('dev-1'), 'dev')
    s.setPending('home', true, 'dev')

    s.clearMessages('home', 'dev')

    const st = useChatStore.getState()
    expect(st.messagesByApp.get('home::dev')).toBeUndefined()
    expect(st.pendingByApp.get('home::dev')).toBeUndefined()
    // The home chat thread (the new-app scope collision risk) is untouched.
    expect(st.messagesByApp.get('home')).toHaveLength(1)
  })

  it('kind="dev" on an edit app clears <appId>::dev, not the app chat', () => {
    const s = useChatStore.getState()
    s.addMessage('spend-tracker', msg('chat-1'), 'chat')
    s.addMessage('spend-tracker', msg('dev-1'), 'dev')

    s.clearMessages('spend-tracker', 'dev')

    const st = useChatStore.getState()
    expect(st.messagesByApp.get('spend-tracker::dev')).toBeUndefined()
    expect(st.messagesByApp.get('spend-tracker')).toHaveLength(1)
  })
})
