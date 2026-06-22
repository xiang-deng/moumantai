import { Children, useEffect, useRef, type ReactNode } from 'react'
import styles from './AppShell.module.css'

export interface AppShellProps {
  activeIndex: number
  onActiveChange: (index: number) => void
  children: ReactNode
}

/**
 * Horizontal scroll-snap pager. Each child becomes one full-viewport page.
 * Active index is reported as the page crosses the centre of the viewport.
 * No dots, no JS animation — native scroll-snap handles momentum and snap.
 */
export function AppShell({ activeIndex, onActiveChange, children }: AppShellProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const pages = Children.toArray(children)
  const isProgrammaticScrollRef = useRef(false)

  // Programmatic scroll when activeIndex changes externally (e.g. server navigate).
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const target = track.children[activeIndex] as HTMLElement | undefined
    if (!target) return
    const targetLeft = target.offsetLeft
    if (Math.abs(track.scrollLeft - targetLeft) < 4) return
    isProgrammaticScrollRef.current = true
    track.scrollTo({ left: targetLeft, behavior: 'smooth' })
    const clear = setTimeout(() => {
      isProgrammaticScrollRef.current = false
    }, 350)
    return () => clearTimeout(clear)
  }, [activeIndex])

  // Track the page closest to the viewport centre.
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
    <div ref={trackRef} className={styles.track}>
      {pages.map((page, i) => (
        <div key={i} data-page-index={i} className={styles.page}>
          {page}
        </div>
      ))}
    </div>
  )
}
