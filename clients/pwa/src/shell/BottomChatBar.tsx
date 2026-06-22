import type { WebSocketTransport } from '../transport/ws-transport'
import { ChatScreen } from '../chat/ChatScreen'
import { Sheet } from './Sheet'
import { haptic } from '../hooks/useHaptic'
import { useAppStore } from '../renderer/stores/app-store'
import { useChatStore } from '../stores/chat-store'
import styles from './BottomChatBar.module.css'

export interface BottomChatBarProps {
  appId: string
  transport: WebSocketTransport | null
  /** Forwarded to ChatScreen so the in-Sheet chat can show the Chat|Dev pill. */
  devModeEnabled?: boolean
}

/**
 * M3 small FAB at the bottom-right of mini-app pages. Tap expands the chat
 * into a bottom Sheet. The home app does NOT mount this — its primary
 * content IS the full-screen ChatScreen.
 *
 * Open/closed state lives in the app store (not local React state) so the
 * sheet can be opened from outside this component — e.g. App.tsx flips the
 * store on a `UiActionEscalated` to surface an in-flight LLM clarification.
 * Mirrors the Android client's `openChatForScope` SharedFlow.
 */
export function BottomChatBar({ appId, transport, devModeEnabled }: BottomChatBarProps) {
  const open = useAppStore((s) => s.chatOverlay?.appId === appId && s.chatOverlay.open)
  const setChatOverlay = useAppStore((s) => s.setChatOverlay)
  // New-app draft entries have no live agent chat backing them — hide the FAB.
  const chatDisabled = useAppStore((s) => s.apps.get(appId)?.chatDisabled ?? false)
  // Pulse the FAB while the LLM is mid-turn for this app. The chat-store
  // pending map is the source of truth; both typed sends and UiActionEscalated
  // populate it.
  const isPending = useChatStore((s) => s.isPending(appId))

  if (chatDisabled) return null

  return (
    <>
      <button
        type="button"
        className={styles.fab}
        data-pending={isPending || undefined}
        onClick={() => {
          haptic('light')
          setChatOverlay(appId, true)
        }}
        aria-label={isPending ? 'Open chat (assistant is working)' : 'Open chat'}
      >
        <span className="material-symbols-rounded" aria-hidden>
          {isPending ? 'progress_activity' : 'chat'}
        </span>
      </button>
      <Sheet open={open} onDismiss={() => setChatOverlay(appId, false)} title="Chat">
        <ChatScreen appId={appId} transport={transport} devModeEnabled={devModeEnabled} />
      </Sheet>
    </>
  )
}
