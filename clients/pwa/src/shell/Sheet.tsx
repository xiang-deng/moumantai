import { useEffect, useRef, useState, type ReactNode } from 'react'
import { haptic } from '../hooks/useHaptic'
import styles from './Sheet.module.css'

export interface SheetProps {
  open: boolean
  onDismiss: () => void
  title?: string
  children: ReactNode
}

/**
 * Bottom-sheet primitive. Backdrop dims the underlying view; drag handle
 * supports swipe-to-dismiss. Open animation: 240ms ease-out slide-up.
 * `prefers-reduced-motion: reduce` collapses the animation via global rules
 * in theme/reset.css.
 */
export function Sheet({ open, onDismiss, title, children }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const dragStartRef = useRef<number | null>(null)

  // Lock the underlying scroll while the sheet is open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  const onPointerDown = (e: React.PointerEvent) => {
    dragStartRef.current = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragStartRef.current == null) return
    const delta = e.clientY - dragStartRef.current
    if (delta > 0) setDragOffset(delta)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const start = dragStartRef.current
    dragStartRef.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    if (start == null) return
    const delta = e.clientY - start
    if (delta > 80) {
      haptic('light')
      onDismiss()
    }
    setDragOffset(0)
  }

  return (
    <div className={styles.backdrop} onClick={onDismiss}>
      <div
        ref={sheetRef}
        className={styles.sheet}
        style={{ transform: dragOffset ? `translateY(${dragOffset}px)` : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={styles.handle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className={styles.handleBar} aria-hidden />
          {title && <span className={styles.title}>{title}</span>}
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  )
}
