import { useEffect, useState } from 'react'
import { useConnectionStore } from '../stores/connection-store'
import styles from './ConnectionBanner.module.css'

/**
 * Persistent banner shown when the WebSocket can't connect within a short
 * grace period. Offers a CTA that opens Settings so the user can change the
 * server URL — no silent retries with no recourse.
 */
export interface ConnectionBannerProps {
  onOpenSettings: () => void
  /** Explicit "try pairing again" — wired to the transport's retryPairing(). */
  onRetryPairing?: () => void
}

const GRACE_PERIOD_MS = 4000

export function ConnectionBanner({ onOpenSettings, onRetryPairing }: ConnectionBannerProps) {
  const status = useConnectionStore((s) => s.status)
  const lastConnectedAt = useConnectionStore((s) => s.lastConnectedAt)
  const pairingCode = useConnectionStore((s) => s.pairingCode)
  const pairingExhausted = useConnectionStore((s) => s.pairingExhausted)
  const [graced, setGraced] = useState(false)

  // Hide the banner during the first few seconds of a fresh attempt — we
  // don't want to startle the user with a "Can't connect" alert in the
  // ~200ms before the handshake completes on a healthy server.
  useEffect(() => {
    if (status === 'connected') {
      setGraced(false)
      return
    }
    setGraced(false)
    const handle = setTimeout(() => setGraced(true), GRACE_PERIOD_MS)
    return () => clearTimeout(handle)
  }, [status])

  // All hooks above run unconditionally; conditional returns only below.

  // Pairing isn't a fault — show it immediately (no grace) with the code and the
  // exact command to approve this device on the server.
  if (status === 'pairing') {
    return (
      <div className={styles.root} role="alert">
        <span className={`material-symbols-rounded ${styles.icon}`} aria-hidden>
          lock
        </span>
        <div className={styles.content}>
          <span className={styles.title}>Pairing required — code {pairingCode ?? '—'}</span>
          <span className={styles.detail}>
            {pairingExhausted
              ? 'Still not approved. Approve it on the server, then tap Retry.'
              : `On the server run: task server:cli -- device approve ${pairingCode ?? '<code>'}`}
          </span>
        </div>
        {pairingExhausted && onRetryPairing && (
          <button type="button" className={styles.cta} onClick={onRetryPairing}>
            Retry
          </button>
        )}
      </div>
    )
  }

  if (status === 'connected') return null
  if (!graced) return null
  // Never connected: prompt to configure. Previously connected: brief outage.
  const neverConnected = lastConnectedAt === null

  return (
    <div className={styles.root} role="alert">
      <span className={`material-symbols-rounded ${styles.icon}`} aria-hidden>
        warning
      </span>
      <div className={styles.content}>
        <span className={styles.title}>
          {neverConnected ? "Can't reach Moumantai server" : 'Reconnecting…'}
        </span>
        {neverConnected && <span className={styles.detail}>Check the server URL in Settings.</span>}
      </div>
      {neverConnected && (
        <button type="button" className={styles.cta} onClick={onOpenSettings}>
          Configure
        </button>
      )}
    </div>
  )
}
