import type { ChatMessageDisplay } from '../stores/chat-store'
import styles from './ChatBubble.module.css'

export interface ChatBubbleProps {
  message: ChatMessageDisplay
  onPlayAudio?: (text: string) => void
}

export function ChatBubble({ message, onPlayAudio }: ChatBubbleProps) {
  const isUser = message.role === 'user'
  const rowClass = isUser ? styles.rowUser : styles.rowAssistant
  const bubbleClass = isUser ? styles.bubbleUser : styles.bubbleAssistant
  const stateClass =
    message.status === 'sending'
      ? ' ' + styles.sending
      : message.status === 'error'
        ? ' ' + styles.error
        : ''

  return (
    <div className={rowClass}>
      <div className={bubbleClass + stateClass}>
        <div className={styles.text}>{message.text}</div>
        <div className={styles.footer}>
          <span className={styles.time}>{formatTime(message.timestamp)}</span>
          {!isUser && onPlayAudio && message.text && (
            <button
              type="button"
              className={styles.playButton}
              onClick={() => onPlayAudio(message.text)}
              aria-label="Play audio"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden>
                volume_up
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  } catch {
    return ''
  }
}
