import { Children, useEffect, useRef, type ReactNode } from 'react'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import styles from './FacePager.module.css'

export interface FacePagerProps {
  /**
   * Index of the currently-active face in the children array. When this
   * changes externally (e.g. the server sends a NavigateMsg, or the LLM
   * invokes a `view_<faceId>` tool), the pager programmatically scrolls
   * to that page so the new face becomes visible.
   */
  activeIndex: number
  /**
   * Called with the index of the page closest to the viewport centre when
   * the user scrolls manually. Keeps the store's `activeFaceIndex` in sync
   * with what the user actually sees — required so the next tool call /
   * server message references the right "current face".
   */
  onActiveChange: (index: number) => void
  children: ReactNode
  /** Pull-to-refresh callback. Caller resolves the promise when fresh data lands. */
  onRefresh?: () => Promise<void> | void
}

/**
 * Vertical scroll-snap stack of faces inside one app. Native scroll-snap;
 * each direct child is one snap target. Pull-to-refresh on touch — pulls
 * past 80px arm the refresh; gesture is no-op on desktop (mouse wheel).
 *
 * Two-way binding with the store via `activeIndex` / `onActiveChange`:
 *   - prop change (server navigate / LLM `view_<faceId>` tool)
 *     → smoothly scroll to that page
 *   - user scrolls
 *     → IntersectionObserver fires onActiveChange with the most-visible page
 *
 * Mirrors AppShell's horizontal-pager pattern so the two pagers behave
 * identically on the two axes.
 */
export function FacePager({ activeIndex, onActiveChange, children, onRefresh }: FacePagerProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const pages = Children.toArray(children)
  const isProgrammaticScrollRef = useRef(false)
  const { offset, refreshing, setRefreshing } = usePullToRefresh({
    containerRef: trackRef,
    disabled: !onRefresh,
    onRefresh: async () => {
      try {
        await Promise.resolve(onRefresh?.())
      } finally {
        // Brief delay so the indicator is visible even on instant refreshes.
        setTimeout(() => setRefreshing(false), 300)
      }
    },
  })

  // Programmatic scroll when activeIndex changes externally. Depends on
  // `pages.length` too so a navigate that arrives before the face list is
  // populated still snaps once the children render in. The 350ms guard
  // suppresses the IntersectionObserver echo that the scroll would otherwise
  // trigger (a programmatic scrollTo would fire intersection callbacks and
  // call onActiveChange with whatever page the smooth scroll crossed first).
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const target = track.children[activeIndex] as HTMLElement | undefined
    if (!target) return
    const targetTop = target.offsetTop
    if (Math.abs(track.scrollTop - targetTop) < 4) return
    isProgrammaticScrollRef.current = true
    track.scrollTo({ top: targetTop, behavior: 'smooth' })
    const clear = setTimeout(() => {
      isProgrammaticScrollRef.current = false
    }, 350)
    return () => clearTimeout(clear)
  }, [activeIndex, pages.length])

  // Track the page closest to the viewport centre on user scroll.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (isProgrammaticScrollRef.current) return
        let bestRatio = 0
        let bestIndex = activeIndex
        for (const entry of entries) {
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio
            const idx = Number((entry.target as HTMLElement).dataset.pageIndex)
            if (!Number.isNaN(idx)) bestIndex = idx
          }
        }
        if (bestIndex !== activeIndex) onActiveChange(bestIndex)
      },
      { root: track, threshold: [0.55, 0.75, 0.95] },
    )
    for (const child of Array.from(track.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [activeIndex, onActiveChange, pages.length])

  return (
    <div className={styles.wrap}>
      {(offset > 0 || refreshing) && (
        <div
          className={styles.indicator}
          style={{ transform: `translateY(${refreshing ? 12 : Math.min(offset - 16, 12)}px)` }}
          aria-hidden={!refreshing}
        >
          <span
            className={`material-symbols-rounded ${refreshing ? styles.spinning : ''}`}
            aria-hidden
          >
            progress_activity
          </span>
        </div>
      )}
      <div
        ref={trackRef}
        className={styles.track}
        style={{ transform: offset > 0 && !refreshing ? `translateY(${offset / 2}px)` : undefined }}
      >
        {pages.map((page, i) => (
          <div key={i} data-page-index={i}>
            {page}
          </div>
        ))}
      </div>
    </div>
  )
}
