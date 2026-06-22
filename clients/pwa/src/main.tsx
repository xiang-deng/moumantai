import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
// CSS import order matters — tokens must be parsed before any component CSS.
// Sequence: PWA identity → canonical tokens → identity overrides → color theme
// → reset → shared base + variants.
import './theme/tokens.css' // PWA identity vocabulary (--accent, --radius, --m-tap, ...)
import './generated/tokens.css' // canonical --moumantai-* values (generated from expanded.yaml)
import './theme/identity.css' // PWA overrides of canonical (no shadows, unified radius, snappier motion)
import './theme/light.css' // light palette + --md-sys-color-* bridge
import './theme/dark.css' // dark palette + --md-sys-color-* bridge
import './theme/reset.css'
import '../../../shared/protocol/design-system/components.base.css' // shared .moumantai-* base + typography
import '../../../shared/protocol/design-system/generated/design-system.css' // generated variant rules
import App from './App'
import { useAppStore } from './renderer/stores/app-store'
import { useChatStore } from './stores/chat-store'
import { useConnectionStore } from './stores/connection-store'
import { bootstrapPalette } from './theme/palette-store'

// Dev-only: expose stores on window for browser console inspection.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__APP_STORE__ = useAppStore
  ;(window as unknown as Record<string, unknown>).__CHAT_STORE__ = useChatStore
  ;(window as unknown as Record<string, unknown>).__CONN_STORE__ = useConnectionStore
}

// Workbox SW: autoUpdate + skipWaiting + clientsClaim — takes over on next load.
if (import.meta.env.PROD) {
  registerSW({ immediate: true })
}

function resolveTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('moumantai.theme')
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

document.documentElement.dataset.theme = resolveTheme()

// Apply the M3 palette and watch theme toggles for light/dark re-derive.
bootstrapPalette()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
