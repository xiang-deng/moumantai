import { create } from 'zustand'
import {
  ChatKind,
  ChatRole,
  VoiceStateValue,
  type ChatHistoryMsg,
  type ComponentDef,
  type TodoStatus,
} from '@moumantai/protocol/generated/moumantai/v1'
import { scopeToChatKey } from '@moumantai/protocol'
import type { WebSocketTransport } from '../transport/ws-transport'

/**
 * UI-display chat row. The wire `ChatMessage` proto shape is server-authored
 * and immutable; the renderer additionally tracks a delivery `status` (e.g.
 * `'sending'` → `'sent'`) for optimistic-UI bubbles. Lives client-side only.
 */
export interface ChatMessageDisplay {
  /** Unique message identifier. */
  id: string
  /** Who sent this message. */
  role: 'user' | 'assistant' | 'system'
  /** Message text content. */
  text: string
  /** ISO 8601 timestamp. */
  timestamp: string
  /** Inline Moumantai UI components rendered within the message bubble. */
  uiBlocks?: ComponentDef[]
  /** Delivery/processing status. */
  status: 'sending' | 'sent' | 'error'
  /** Material icon name for the role (e.g. 'person', 'smart_toy'). */
  role_icon?: string
  /** Background color for the message bubble (e.g. '#1a1a2e'). */
  role_background?: string
}

/**
 * One row of the edit-agent's TodoWrite checklist, rendered as a pinned
 * progress card in the dev thread. Mirrors the wire `TodoItem`.
 */
export interface TodoItemDisplay {
  content: string
  status: TodoStatus
  activeForm: string
}

/**
 * Per-scope pagination state for "load older" paging.
 *
 * - `idle`: ready to fetch the next older page.
 * - `loading`: a FetchOlderMsg is in flight; additional scroll events are no-ops.
 * - `exhausted`: server confirmed no older entries exist; stop triggering.
 */
export type LoadOlderState = 'idle' | 'loading' | 'exhausted'

/** Full per-scope load-older state. */
export interface LoadOlder {
  state: LoadOlderState
  /** conversationId of the in-flight request, used to discard stale responses after a reset. */
  inflightConvId: string | null
  /** Set from ChatHistoryMsg.hasMore; once false the state transitions to 'exhausted'. */
  hasMore: boolean
}

const LOAD_OLDER_DEFAULT: LoadOlder = { state: 'idle', inflightConvId: null, hasMore: true }

/**
 * Thread kind for separating the regular user chat from the developer
 * (draft-editing) chat thread within the same app scope.
 */
export type ChatThreadKind = 'chat' | 'dev'

/**
 * Storage key for `messagesByApp`, `inputTextByApp`, and `pendingByApp`.
 * `kind='chat'` → bare `appId` (components can do `messagesByApp.get(appId)` directly);
 * `kind='dev'`  → `${appId}::dev`.
 */
function threadKey(appId: string, kind: ChatThreadKind): string {
  return kind === 'dev' ? `${appId}::dev` : appId
}

/**
 * Map a wire `ChatKind` value to the local `ChatThreadKind`.
 * UNSPECIFIED and CHAT both map to `'chat'`; DEV maps to `'dev'`.
 */
function wireKindToThread(kind: ChatKind | undefined): ChatThreadKind {
  return kind === ChatKind.DEV ? 'dev' : 'chat'
}

interface ChatStoreState {
  /** Per-app message lists, keyed by `threadKey(appId, kind)`. */
  messagesByApp: Map<string, ChatMessageDisplay[]>
  voiceState: VoiceStateValue
  /** Per-app input text drafts, keyed by `threadKey(appId, kind)`. */
  inputTextByApp: Map<string, string>
  /** Per-app pending-response flag (true while waiting for assistant reply), keyed by `threadKey(appId, kind)`. */
  pendingByApp: Map<string, boolean>
  /**
   * Per-scope conversation UUID (from latest ChatWindowMsg).
   * Used by `handleChatHistory` to discard stale responses after a reset.
   * Keyed by `${scope}::${kind}`.
   */
  conversationIdByScope: Map<string, string>
  /**
   * Minimum seq seen in the local log — used as `beforeSeq` cursor for
   * "load older" paging. Updated on ChatWindowMsg and ChatHistoryMsg.
   * Keyed by `${scope}::${kind}`.
   */
  minSeqByScope: Map<string, bigint>
  /** Per-scope pagination state machine for "load older" paging. Keyed by `${scope}::${kind}`. */
  loadOlderByScope: Map<string, LoadOlder>
  /**
   * Edit-agent progress checklist, keyed by the dev `threadKey` (`${appId}::dev`).
   * Replaced wholesale on each `ChatTodosUpdate`; cleared when the draft ends.
   */
  todosByApp: Map<string, TodoItemDisplay[]>

  addMessage: (appId: string, msg: ChatMessageDisplay, kind?: ChatThreadKind) => void
  updateMessage: (id: string, updates: Partial<ChatMessageDisplay>) => void
  getMessages: (appId: string, kind?: ChatThreadKind) => ChatMessageDisplay[]
  setVoiceState: (state: VoiceStateValue) => void
  setInputText: (appId: string, text: string, kind?: ChatThreadKind) => void
  getInputText: (appId: string, kind?: ChatThreadKind) => string
  setPending: (appId: string, pending: boolean, kind?: ChatThreadKind) => void
  isPending: (appId: string, kind?: ChatThreadKind) => boolean
  clearMessages: (appId?: string, kind?: ChatThreadKind) => void
  /**
   * Record the authoritative conversationId for a scope+kind (called on ChatWindowMsg).
   * Also resets the LoadOlder state machine so paging can start fresh.
   */
  setConversationId: (scope: string, conversationId: string, kind?: ChatThreadKind) => void
  /**
   * Trigger a FetchOlderMsg for `scope`+`kind`. No-op if state is `loading` or
   * `exhausted`. Passes the current minimum seq as the cursor.
   */
  loadOlder: (scope: string, transport: WebSocketTransport, kind?: ChatThreadKind) => void
  /**
   * Handle a ChatHistoryMsg from the server. Prepends entries (deduped by id),
   * advances minSeq, and transitions the LoadOlder state machine.
   * Discards the response if the conversationId mismatches (post-reset stale).
   * Routes to the correct thread by reading `msg.kind`.
   */
  handleChatHistory: (msg: ChatHistoryMsg) => void
  /** Replace the dev-thread progress checklist for `appId`. */
  setTodos: (appId: string, todos: TodoItemDisplay[]) => void
  /** Clear the dev-thread progress checklist for `appId` (draft ended). */
  clearTodos: (appId: string) => void
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  messagesByApp: new Map(),
  voiceState: VoiceStateValue.IDLE,
  inputTextByApp: new Map(),
  pendingByApp: new Map(),
  conversationIdByScope: new Map(),
  minSeqByScope: new Map(),
  loadOlderByScope: new Map(),
  todosByApp: new Map(),

  addMessage: (appId, msg, kind = 'chat') => {
    const key = threadKey(appId, kind)
    set((state) => {
      const byApp = new Map(state.messagesByApp)
      const existing = byApp.get(key) ?? []
      byApp.set(key, [...existing, msg])
      return { messagesByApp: byApp }
    })
  },

  updateMessage: (id, updates) =>
    set((state) => {
      const byApp = new Map(state.messagesByApp)
      for (const [key, msgs] of byApp) {
        byApp.set(
          key,
          msgs.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        )
      }
      return { messagesByApp: byApp }
    }),

  getMessages: (appId, kind = 'chat') => {
    return get().messagesByApp.get(threadKey(appId, kind)) ?? []
  },

  setVoiceState: (voiceState) => set({ voiceState }),

  setInputText: (appId, text, kind = 'chat') => {
    const key = threadKey(appId, kind)
    set((state) => {
      const byApp = new Map(state.inputTextByApp)
      byApp.set(key, text)
      return { inputTextByApp: byApp }
    })
  },

  getInputText: (appId, kind = 'chat') => {
    return get().inputTextByApp.get(threadKey(appId, kind)) ?? ''
  },

  setPending: (appId, pending, kind = 'chat') => {
    const key = threadKey(appId, kind)
    set((state) => {
      const byApp = new Map(state.pendingByApp)
      if (pending) byApp.set(key, true)
      else byApp.delete(key)
      return { pendingByApp: byApp }
    })
  },

  isPending: (appId, kind = 'chat') => get().pendingByApp.get(threadKey(appId, kind)) ?? false,

  clearMessages: (appId?, kind?) => {
    if (appId) {
      if (kind !== undefined) {
        const key = threadKey(appId, kind)
        set((state) => {
          const msgs = new Map(state.messagesByApp)
          msgs.delete(key)
          const pending = new Map(state.pendingByApp)
          pending.delete(key)
          return { messagesByApp: msgs, pendingByApp: pending }
        })
      } else {
        // Clear all threads for this appId (chat + dev).
        set((state) => {
          const msgs = new Map(state.messagesByApp)
          msgs.delete(threadKey(appId, 'chat'))
          msgs.delete(threadKey(appId, 'dev'))
          const pending = new Map(state.pendingByApp)
          pending.delete(threadKey(appId, 'chat'))
          pending.delete(threadKey(appId, 'dev'))
          return { messagesByApp: msgs, pendingByApp: pending }
        })
      }
    } else {
      set({ messagesByApp: new Map(), inputTextByApp: new Map(), pendingByApp: new Map() })
    }
  },

  setConversationId: (scope, conversationId, kind = 'chat') => {
    const scopeKey = `${scope}::${kind}`
    set((state) => {
      const convMap = new Map(state.conversationIdByScope)
      convMap.set(scopeKey, conversationId)
      // Fresh conversation → reset load-older state and min-seq cursor.
      const loadMap = new Map(state.loadOlderByScope)
      loadMap.set(scopeKey, { ...LOAD_OLDER_DEFAULT })
      const seqMap = new Map(state.minSeqByScope)
      seqMap.delete(scopeKey)
      return { conversationIdByScope: convMap, loadOlderByScope: loadMap, minSeqByScope: seqMap }
    })
  },

  loadOlder: (scope, transport, kind = 'chat') => {
    const scopeKey = `${scope}::${kind}`
    const state = get()
    const current = state.loadOlderByScope.get(scopeKey) ?? { ...LOAD_OLDER_DEFAULT }
    if (current.state !== 'idle') return

    const convId = state.conversationIdByScope.get(scopeKey) ?? ''
    const beforeSeq = state.minSeqByScope.get(scopeKey) ?? 0n

    set((s) => {
      const loadMap = new Map(s.loadOlderByScope)
      loadMap.set(scopeKey, { state: 'loading', inflightConvId: convId, hasMore: current.hasMore })
      return { loadOlderByScope: loadMap }
    })

    transport.sendFetchOlder(scope, beforeSeq, 50)
  },

  handleChatHistory: (msg) => {
    const state = get()
    const scope = msg.scope
    const thread = wireKindToThread(msg.kind)
    const scopeKey = `${scope}::${thread}`
    const currentConvId = state.conversationIdByScope.get(scopeKey)

    // Discard stale response if the conversation was reset mid-flight.
    if (msg.conversationId !== currentConvId) {
      set((s) => {
        const loadMap = new Map(s.loadOlderByScope)
        loadMap.set(scopeKey, { ...LOAD_OLDER_DEFAULT })
        return { loadOlderByScope: loadMap }
      })
      return
    }

    const appId = scopeToChatKey(scope)
    const appKey = threadKey(appId, thread)

    set((s) => {
      // Prepend entries, deduping by id (existing entries may have a newer status).
      const byApp = new Map(s.messagesByApp)
      const existing = byApp.get(appKey) ?? []
      const existingIds = new Set(existing.map((m) => m.id))

      const toAdd: ChatMessageDisplay[] = msg.entries
        .filter((e) => !existingIds.has(e.id))
        .map((e) => ({
          id: e.id,
          role: (e.role === ChatRole.USER
            ? 'user'
            : e.role === ChatRole.ASSISTANT
              ? 'assistant'
              : 'system') as ChatMessageDisplay['role'],
          text: e.text,
          timestamp: e.createdAt,
          status: 'sent' as const,
        }))

      byApp.set(appKey, [...toAdd, ...existing])

      const seqMap = new Map(s.minSeqByScope)
      if (msg.entries.length > 0) {
        const newMin = msg.entries.reduce(
          (min, e) => (e.seq < min ? e.seq : min),
          msg.entries[0]!.seq,
        )
        const prev = seqMap.get(scopeKey)
        if (prev === undefined || newMin < prev) seqMap.set(scopeKey, newMin)
      }

      const hasMore = msg.hasMore
      const loadMap = new Map(s.loadOlderByScope)
      loadMap.set(scopeKey, {
        state: hasMore ? 'idle' : 'exhausted',
        inflightConvId: null,
        hasMore,
      })

      return { messagesByApp: byApp, minSeqByScope: seqMap, loadOlderByScope: loadMap }
    })
  },

  setTodos: (appId, todos) => {
    const key = threadKey(appId, 'dev')
    set((state) => {
      const next = new Map(state.todosByApp)
      next.set(key, todos)
      return { todosByApp: next }
    })
  },

  clearTodos: (appId) => {
    const key = threadKey(appId, 'dev')
    set((state) => {
      if (!state.todosByApp.has(key)) return state
      const next = new Map(state.todosByApp)
      next.delete(key)
      return { todosByApp: next }
    })
  },
}))
