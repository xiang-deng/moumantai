import styles from './Skeleton.module.css'

export interface SkeletonProps {
  lines?: number
}

/** Shimmer placeholder shown while a face's first paint is pending. */
export function Skeleton({ lines = 4 }: SkeletonProps) {
  return (
    <div className={styles.root}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={styles.line} style={{ width: `${88 - i * 10}%` }} />
      ))}
    </div>
  )
}
