import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, type TodoItemDisplay } from '../../src/stores/chat-store'
import { TodoStatus } from '@moumantai/protocol/generated/moumantai/v1'

/**
 * The edit-agent progress checklist is keyed by the dev thread key
 * (`${appId}::dev`) so the DevSurface (which reads `${appId}::dev`) sees it.
 */
function todos(): TodoItemDisplay[] {
  return [
    { content: 'Add face', status: TodoStatus.IN_PROGRESS, activeForm: 'Adding face' },
    { content: 'Wire tool', status: TodoStatus.PENDING, activeForm: 'Wiring tool' },
  ]
}

describe('chat-store todos', () => {
  beforeEach(() => {
    useChatStore.setState({ todosByApp: new Map() })
  })

  it('setTodos stores under the dev thread key (${appId}::dev)', () => {
    useChatStore.getState().setTodos('today', todos())
    expect(useChatStore.getState().todosByApp.get('today::dev')).toHaveLength(2)
    // Not under the bare chat key.
    expect(useChatStore.getState().todosByApp.get('today')).toBeUndefined()
  })

  it('setTodos replaces wholesale', () => {
    const s = useChatStore.getState()
    s.setTodos('today', todos())
    s.setTodos('today', [{ content: 'Done', status: TodoStatus.COMPLETED, activeForm: 'Done' }])
    const stored = useChatStore.getState().todosByApp.get('today::dev')
    expect(stored).toHaveLength(1)
    expect(stored?.[0]?.content).toBe('Done')
  })

  it('clearTodos removes the dev thread checklist', () => {
    const s = useChatStore.getState()
    s.setTodos('home', todos())
    expect(useChatStore.getState().todosByApp.get('home::dev')).toBeDefined()
    s.clearTodos('home')
    expect(useChatStore.getState().todosByApp.get('home::dev')).toBeUndefined()
  })

  it('clearTodos on an absent key is a no-op (keeps map identity stable)', () => {
    const before = useChatStore.getState().todosByApp
    useChatStore.getState().clearTodos('nope')
    expect(useChatStore.getState().todosByApp).toBe(before)
  })
})
