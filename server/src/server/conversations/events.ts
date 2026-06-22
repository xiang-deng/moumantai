/**
 * Typed event bus for ConversationStore. Avoids Node's EventEmitter so
 * handler argument types are enforced at the call site.
 */

import type { Message } from './schema.js'

export interface AppendPayload {
  scope: string
  conversationId: string
  row: Message
}

/**
 * Emitted when a user row's status transitions without a new row being
 * written (e.g. pending → running, running → timed_out). Assistant-row
 * transitions use the normal `append` event.
 */
export interface UpdatePayload {
  scope: string
  conversationId: string
  row: Message
}

export interface ResetPayload {
  scope: string
  newConversationId: string
  /**
   * Thread that was reset. Defaults to 'chat'. The broadcast layer routes the
   * empty-window notice per kind: 'dev' goes only to PHONE sessions viewing the
   * scope (mirroring the dev-append bus), 'chat' broadcasts to the whole scope.
   */
  kind: 'chat' | 'dev'
}

export type ConversationEvents = {
  append: AppendPayload
  update: UpdatePayload
  reset: ResetPayload
}

export type Handler<T> = (payload: T) => void

export class TypedEmitter<E extends Record<string, unknown>> {
  private handlers: { [K in keyof E]?: Set<Handler<E[K]>> } = {}

  on<K extends keyof E>(event: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers[event]
    if (!set) {
      set = new Set()
      this.handlers[event] = set
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  /** Detach a named handler. Returns true if one was removed. */
  off<K extends keyof E>(event: K, handler: Handler<E[K]>): boolean {
    return this.handlers[event]?.delete(handler) ?? false
  }

  /** Remove every handler for an event, or every handler across all events. */
  removeAllListeners<K extends keyof E>(event?: K): void {
    if (event !== undefined) this.handlers[event]?.clear()
    else this.handlers = {}
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.handlers[event]
    if (!set) return
    // Snapshot so a handler calling off() mid-emit doesn't skip siblings.
    for (const h of [...set]) {
      try {
        h(payload)
      } catch (err) {
        console.error(`[conversations] handler for "${String(event)}" threw:`, err)
      }
    }
  }
}
