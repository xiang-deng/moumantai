import { useEffect, useState } from 'react'
import styles from './SettingsFace.module.css'

const SERVER_URL_KEY = 'moumantai.serverUrl'
const DEVICE_ID_KEY = 'moumantai.deviceId'
const THEME_KEY = 'moumantai.theme'
const DEV_MODE_OPT_IN_KEY = 'moumantai.devModeOptIn'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** True for a plaintext ws:// URL to a non-loopback host (deviceId in cleartext). */
function isInsecureWs(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'ws:' && !LOOPBACK_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

export interface SettingsFaceProps {
  onReconnect: (newUrl: string | null) => void
  /** When false the server capability (MOUMANTAI_DEV_MODE) is off — render the toggle disabled. Defaults to true. */
  devModeAvailable?: boolean
}

/**
 * Client-side settings panel. Three things only:
 *   - WebSocket server URL override (overrides same-origin default).
 *   - Device ID (read-only — generated once, used by the server to attribute
 *     messages and persist per-device viewing state).
 *   - Theme toggle (light / dark).
 *
 * Rendered inside a Sheet, opened from the StatusHeader's settings icon.
 */
export function SettingsFace({ onReconnect, devModeAvailable = true }: SettingsFaceProps) {
  const [serverUrl, setServerUrl] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [copied, setCopied] = useState(false)
  const [devModeOptIn, setDevModeOptIn] = useState(false)

  useEffect(() => {
    setServerUrl(localStorage.getItem(SERVER_URL_KEY) ?? '')
    setDeviceId(localStorage.getItem(DEVICE_ID_KEY) ?? '')
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
    setDevModeOptIn(localStorage.getItem(DEV_MODE_OPT_IN_KEY) === 'true')
  }, [])

  const onCopyDeviceId = () => {
    if (!deviceId) return
    void navigator.clipboard?.writeText(deviceId)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const onThemeChange = (next: 'light' | 'dark') => {
    document.documentElement.dataset.theme = next
    localStorage.setItem(THEME_KEY, next)
    setTheme(next)
  }

  const onDevModeToggle = () => {
    const next = !devModeOptIn
    localStorage.setItem(DEV_MODE_OPT_IN_KEY, next ? 'true' : 'false')
    setDevModeOptIn(next)
    // Notify same-tab listeners (ChatScreen) so the Dev pill updates live
    // without a remount. The 'storage' event only fires in OTHER tabs.
    window.dispatchEvent(new Event('moumantai:devmodeoptin'))
  }

  const [error, setError] = useState<string | null>(null)

  const onSave = () => {
    setError(null)
    const trimmed = serverUrl.trim()
    if (!trimmed) {
      localStorage.removeItem(SERVER_URL_KEY)
      onReconnect(null)
      return
    }
    // Be lenient — auto-prepend ws:// if the user typed a bare hostname.
    // Then assert the result is parseable as a WS URL before saving.
    const normalized = /^wss?:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`
    try {
      const u = new URL(normalized)
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
        throw new Error('protocol')
      }
    } catch {
      setError(`"${trimmed}" isn't a valid WebSocket URL. Try ws://host:port or wss://host.`)
      return
    }
    localStorage.setItem(SERVER_URL_KEY, normalized)
    setServerUrl(normalized)
    onReconnect(normalized)
  }

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <label className={styles.label} htmlFor="settings-server-url">
          Server URL
        </label>
        <input
          id="settings-server-url"
          className={styles.input}
          type="url"
          placeholder="wss://moumantai.your-tailnet.ts.net"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <p className={styles.hint}>
          Defaults to the page's origin. Override only if your server lives elsewhere on your
          tailnet.
        </p>
        {isInsecureWs(serverUrl) && (
          <p className={`${styles.hint} ${styles.errorHint}`}>
            ⚠ Plaintext ws:// — your device ID is sent unencrypted. Use wss:// (your tailnet
            provides a cert) unless this is a trusted local network.
          </p>
        )}
        {error && <p className={`${styles.hint} ${styles.errorHint}`}>{error}</p>}
      </section>

      <section className={styles.section}>
        <span className={styles.label}>Theme</span>
        <div className={styles.segmented}>
          <button
            type="button"
            className={`${styles.segment} ${theme === 'light' ? styles.segmentActive : ''}`}
            onClick={() => onThemeChange('light')}
          >
            Light
          </button>
          <button
            type="button"
            className={`${styles.segment} ${theme === 'dark' ? styles.segmentActive : ''}`}
            onClick={() => onThemeChange('dark')}
          >
            Dark
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <span className={styles.label}>Developer Mode</span>
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>Enable developer mode</span>
          <button
            type="button"
            role="switch"
            aria-checked={devModeOptIn}
            className={`${styles.toggle} ${devModeOptIn ? styles.toggleOn : ''}`}
            onClick={onDevModeToggle}
            disabled={!devModeAvailable}
            aria-label="Enable developer mode"
          />
        </div>
        {!devModeAvailable && (
          <p className={styles.hint}>
            Developer mode is not enabled on this server (MOUMANTAI_DEV_MODE).
          </p>
        )}
      </section>

      <section className={styles.section}>
        <span className={styles.label}>Device ID</span>
        <div className={styles.deviceIdRow}>
          <code className={styles.deviceId}>{deviceId || 'not yet generated'}</code>
          <button
            type="button"
            className={styles.copyButton}
            onClick={onCopyDeviceId}
            disabled={!deviceId}
            aria-label="Copy device ID"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden>
              content_copy
            </span>
          </button>
        </div>
        {copied && <p className={styles.hint}>Copied to clipboard.</p>}
      </section>

      <button type="button" className={styles.saveButton} onClick={onSave}>
        Save & reconnect
      </button>
    </div>
  )
}
