import { useEffect } from 'react'
import { useToastStore, TOAST_TTL_MS } from './stores/toast-store'
import styles from './Toast.module.css'

export function Toast() {
  const toasts = useToastStore((s) => s.toasts)
  const dismissToast = useToastStore((s) => s.dismissToast)

  return (
    <div className={styles.container} aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastItem
          key={t.id}
          id={t.id}
          kind={t.kind}
          message={t.message}
          onDismiss={dismissToast}
        />
      ))}
    </div>
  )
}

function ToastItem({
  id,
  kind,
  message,
  onDismiss,
}: {
  id: string
  kind: 'error' | 'info'
  message: string
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    const handle = setTimeout(() => onDismiss(id), TOAST_TTL_MS)
    return () => clearTimeout(handle)
  }, [id, onDismiss])

  return (
    <div
      className={`${styles.toast} ${kind === 'error' ? styles.error : styles.info}`}
      role={kind === 'error' ? 'alert' : 'status'}
      onClick={() => onDismiss(id)}
    >
      {message}
    </div>
  )
}
