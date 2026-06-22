import { describe, it, expect } from 'vitest'
import { msgChatTodosUpdate } from '../../../src/server/transport/messages.js'
import { ChatKind, TodoStatus } from '@moumantai/protocol/generated/moumantai/v1'

describe('msgChatTodosUpdate', () => {
  it('builds a chatTodosUpdate payload with kind=DEV and status-string → TodoStatus mapping', () => {
    const msg = msgChatTodosUpdate({
      scope: 'app:today',
      conversationId: 'conv-1',
      todos: [
        { content: 'Add face', status: 'pending', activeForm: 'Adding face' },
        { content: 'Wire tool', status: 'in_progress', activeForm: 'Wiring tool' },
        { content: 'Validate', status: 'completed', activeForm: 'Validating' },
      ],
    })

    expect(msg.payload.case).toBe('chatTodosUpdate')
    if (msg.payload.case !== 'chatTodosUpdate') throw new Error('unreachable')
    const value = msg.payload.value
    expect(value.scope).toBe('app:today')
    expect(value.conversationId).toBe('conv-1')
    expect(value.kind).toBe(ChatKind.DEV)
    expect(value.todos.map((t) => t.status)).toEqual([
      TodoStatus.PENDING,
      TodoStatus.IN_PROGRESS,
      TodoStatus.COMPLETED,
    ])
    expect(value.todos.map((t) => t.content)).toEqual(['Add face', 'Wire tool', 'Validate'])
    expect(value.todos.map((t) => t.activeForm)).toEqual([
      'Adding face',
      'Wiring tool',
      'Validating',
    ])
  })

  it('handles an empty checklist', () => {
    const msg = msgChatTodosUpdate({ scope: 'home', conversationId: 'c', todos: [] })
    expect(msg.payload.case).toBe('chatTodosUpdate')
    if (msg.payload.case !== 'chatTodosUpdate') throw new Error('unreachable')
    expect(msg.payload.value.todos).toEqual([])
  })
})
