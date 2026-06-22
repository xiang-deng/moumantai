/**
 * Transient user-visible feedback for tool-invocation errors and offline
 * send-drops. Auto-dismisses after [TOAST_TTL_MS]; the Toast component drives
 * the timer per item so the store stays passive.
 */

import { create } from 'zustand'

export type ToastKind = 'error' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
}

interface ToastStoreState {
  toasts: Toast[]
  pushToast: (kind: ToastKind, message: string) => string
  dismissToast: (id: string) => void
}

export const TOAST_TTL_MS = 4000

export const useToastStore = create<ToastStoreState>((set) => ({
  toasts: [],
  pushToast: (kind, message) => {
    const id = crypto.randomUUID()
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }))
    return id
  },
  dismissToast: (id) =>
    set((state) => {
      const next = state.toasts.filter((t) => t.id !== id)
      return next.length === state.toasts.length ? state : { toasts: next }
    }),
}))
