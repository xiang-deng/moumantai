import { create } from 'zustand'

// 'pairing' = device not yet approved; surface the pairing code and keep retrying.
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'pairing'

interface ConnectionStoreState {
  status: ConnectionStatus
  /** Last connection error message (e.g. "Failed to reach ws://..."). null when healthy. */
  error: string | null
  /** Short pairing code to show while status === 'pairing'. null otherwise. */
  pairingCode: string | null
  /** True once the foreground polling burst elapsed — show an explicit Retry. */
  pairingExhausted: boolean
  /** Wallclock ms of last successful connection. null until we've ever connected. */
  lastConnectedAt: number | null
  setStatus: (status: ConnectionStatus) => void
  setError: (error: string | null) => void
  setPairingCode: (code: string | null) => void
  setPairingExhausted: (v: boolean) => void
}

export const useConnectionStore = create<ConnectionStoreState>((set) => ({
  status: 'disconnected',
  error: null,
  pairingCode: null,
  pairingExhausted: false,
  lastConnectedAt: null,
  setStatus: (status) =>
    set((s) => ({
      status,
      // Clear error when healthy or pairing (not a fault). Drop pairing state on exit.
      error: status === 'connected' || status === 'pairing' ? null : s.error,
      pairingCode: status === 'pairing' ? s.pairingCode : null,
      pairingExhausted: status === 'pairing' ? s.pairingExhausted : false,
      lastConnectedAt: status === 'connected' ? Date.now() : s.lastConnectedAt,
    })),
  setError: (error) => set({ error }),
  setPairingCode: (pairingCode) => set({ pairingCode }),
  setPairingExhausted: (pairingExhausted) => set({ pairingExhausted }),
}))
