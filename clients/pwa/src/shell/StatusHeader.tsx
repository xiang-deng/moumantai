import { useConnectionStore } from '../stores/connection-store'
import { useChatStore } from '../stores/chat-store'
import { VoiceStateValue } from '@moumantai/protocol/generated/moumantai/v1'
import styles from './StatusHeader.module.css'

export interface StatusHeaderProps {
  appLabel: string | undefined
  onThemeToggle: () => void
  themeMode: 'light' | 'dark'
  onSettingsOpen: () => void
}

/**
 * M3 small top-app-bar: 64dp height, surface bg, title-large app name.
 *
 * Trailing cluster, left to right:
 *   - agent-dot (signature element): pulses with voice state. IDLE = dim
 *     primary-container; LISTENING = saturated primary + 1.2s pulse;
 *     THINKING = breathe; SPEAKING = waveform-like quick pulse.
 *   - connection indicator (signal icon)
 *   - theme toggle
 *   - settings
 *
 * Icons are Material Symbols Rounded ligatures, sharing the M3 weight with
 * the rest of the type system.
 */
export function StatusHeader({
  appLabel,
  onThemeToggle,
  themeMode,
  onSettingsOpen,
}: StatusHeaderProps) {
  const status = useConnectionStore((s) => s.status)
  const voiceState = useChatStore((s) => s.voiceState)
  return (
    <header className={styles.root}>
      <span className={styles.app}>{appLabel ?? ''}</span>
      <div className={styles.right}>
        <AgentDot voiceState={voiceState} />
        <ConnectionIndicator status={status} />
        <IconButton onClick={onThemeToggle} aria-label="Toggle theme">
          {themeMode === 'dark' ? 'light_mode' : 'dark_mode'}
        </IconButton>
        <IconButton onClick={onSettingsOpen} aria-label="Settings">
          settings
        </IconButton>
      </div>
    </header>
  )
}

function IconButton({
  children,
  onClick,
  ...props
}: {
  children: string
  onClick: () => void
} & React.AriaAttributes) {
  return (
    <button type="button" className={styles.iconButton} onClick={onClick} {...props}>
      <span className="material-symbols-rounded" aria-hidden>
        {children}
      </span>
    </button>
  )
}

function ConnectionIndicator({
  status,
}: {
  status: 'disconnected' | 'connecting' | 'connected' | 'pairing'
}) {
  if (status === 'connected') {
    return (
      <span
        className={`${styles.statusIcon} ${styles.connected} material-symbols-rounded`}
        aria-label="Connected"
      >
        wifi
      </span>
    )
  }
  if (status === 'pairing') {
    return (
      <span
        className={`${styles.statusIcon} ${styles.connecting} material-symbols-rounded`}
        aria-label="Pairing required"
      >
        lock
      </span>
    )
  }
  if (status === 'connecting') {
    return (
      <span
        className={`${styles.statusIcon} ${styles.connecting} material-symbols-rounded`}
        aria-label="Connecting"
      >
        progress_activity
      </span>
    )
  }
  return (
    <span
      className={`${styles.statusIcon} ${styles.disconnected} material-symbols-rounded`}
      aria-label="Disconnected"
    >
      wifi_off
    </span>
  )
}

function AgentDot({ voiceState }: { voiceState: VoiceStateValue }) {
  let cls = styles.agentDotIdle
  if (voiceState === VoiceStateValue.LISTENING) cls = styles.agentDotListening
  else if (voiceState === VoiceStateValue.THINKING) cls = styles.agentDotThinking
  else if (voiceState === VoiceStateValue.SPEAKING) cls = styles.agentDotSpeaking
  return <span className={`${styles.agentDot} ${cls}`} aria-label="Agent state" />
}
