// Active-seed store — owns the seed driving the M3 palette.
// `setActiveSeed` is called on app change; `reapply` is wired to
// `data-theme` mutations so light/dark toggles re-derive the palette.

import { create } from 'zustand'

import { applyPalette, isDarkTheme } from './dynamic-palette'

// Default seed (Moumantai indigo): used at first paint and for apps with no `themeSeed`.
export const MOUMANTAI_SEED = '#5B6CFF'

interface PaletteStore {
  activeSeed: string
  setActiveSeed: (seed: string) => void
  /** Re-apply the current seed against the current theme. */
  reapply: () => void
}

export const usePaletteStore = create<PaletteStore>((set, get) => ({
  activeSeed: MOUMANTAI_SEED,
  setActiveSeed: (seed) => {
    if (seed === get().activeSeed) return
    set({ activeSeed: seed })
    applyPalette(seed, isDarkTheme())
  },
  reapply: () => {
    applyPalette(get().activeSeed, isDarkTheme())
  },
}))

/**
 * Apply the default palette and start watching `data-theme` changes.
 * Call once from main.tsx after the theme attribute is set.
 */
export function bootstrapPalette(): void {
  usePaletteStore.getState().reapply()
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'data-theme') {
        usePaletteStore.getState().reapply()
        return
      }
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}
