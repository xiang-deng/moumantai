import { VoiceStateValue } from '@moumantai/protocol/generated/moumantai/v1'
import styles from './VoiceIndicator.module.css'

export interface VoiceIndicatorProps {
  state: VoiceStateValue
}

const STATE_CLASS: Partial<Record<VoiceStateValue, string>> = {
  [VoiceStateValue.LISTENING]: styles.listening ?? '',
  [VoiceStateValue.THINKING]: styles.thinking ?? '',
  [VoiceStateValue.SPEAKING]: styles.speaking ?? '',
}

const STATE_LABEL: Record<VoiceStateValue, string> = {
  [VoiceStateValue.UNSPECIFIED]: '',
  [VoiceStateValue.IDLE]: '',
  [VoiceStateValue.LISTENING]: 'Listening',
  [VoiceStateValue.THINKING]: 'Thinking',
  [VoiceStateValue.SPEAKING]: 'Speaking',
}

export function VoiceIndicator({ state }: VoiceIndicatorProps) {
  if (state === VoiceStateValue.IDLE || state === VoiceStateValue.UNSPECIFIED) return null
  const stateClass = STATE_CLASS[state]
  if (!stateClass) return null

  return (
    <div className={`${styles.root} ${stateClass}`} role="status" aria-live="polite">
      {state === VoiceStateValue.SPEAKING ? (
        <div className={styles.wave} aria-hidden>
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : (
        <span className={`material-symbols-rounded ${styles.mic}`} aria-hidden>
          mic
        </span>
      )}
      <span className={styles.label}>{STATE_LABEL[state]}</span>
    </div>
  )
}
