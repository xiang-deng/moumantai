import { useEffect, useRef, useState, type RefObject } from 'react'

const TRIGGER_DISTANCE_PX = 80
const MAX_PULL_PX = 120

export interface UsePullToRefreshOptions {
  /** Scroll container we listen to. Pull only triggers when scrollTop === 0. */
  containerRef: RefObject<HTMLElement>
  onRefresh: () => void
  /** Disable the gesture (e.g. while a refresh is in flight). */
  disabled?: boolean
}

export interface PullState {
  /** Current visual pull offset in px (0 when idle, snaps back on release). */
  offset: number
  /** True while a refresh is being awaited (caller resets via `setRefreshing(false)`). */
  refreshing: boolean
  /** Caller calls this to signal the refresh has completed. */
  setRefreshing: (v: boolean) => void
}

/**
 * Pull-to-refresh on a scroll container. Returns the current pull offset so
 * the caller can render an indicator. Touch-only (mobile gesture).
 */
export function usePullToRefresh({
  containerRef,
  onRefresh,
  disabled,
}: UsePullToRefreshOptions): PullState {
  const [offset, setOffset] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startYRef = useRef<number | null>(null)
  const refreshingRef = useRef(refreshing)
  refreshingRef.current = refreshing

  useEffect(() => {
    const el = containerRef.current
    if (!el || disabled) return

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current) return
      if (el.scrollTop > 0) return
      const t = e.touches[0]
      if (!t) return
      startYRef.current = t.clientY
    }
    const onTouchMove = (e: TouchEvent) => {
      if (startYRef.current == null) return
      const t = e.touches[0]
      if (!t) return
      const delta = t.clientY - startYRef.current
      if (delta <= 0) {
        setOffset(0)
        return
      }
      // Light rubber-band: cap visual displacement at MAX_PULL_PX.
      setOffset(Math.min(delta, MAX_PULL_PX))
    }
    const onTouchEnd = () => {
      const triggered = offset >= TRIGGER_DISTANCE_PX
      startYRef.current = null
      setOffset(0)
      if (triggered) {
        setRefreshing(true)
        onRefresh()
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [containerRef, onRefresh, disabled, offset])

  return { offset, refreshing, setRefreshing }
}
