import { useRef, type ChangeEvent } from 'react'
import styles from './ImagePicker.module.css'

const MAX_LONG_EDGE = 1568 // Anthropic vision API compliance — mirrors Android CameraCapture.kt.
const JPEG_QUALITY = 0.85

export interface ImagePickerProps {
  disabled?: boolean
  onImage: (data: Uint8Array, mimeType: string) => void
}

/**
 * Hidden file input + camera-icon button. On selection, downscales to a 1568px
 * long edge (canvas resize) and hands raw bytes to the caller. The pure-math
 * `computeScaledDimensions` is unit-tested separately, avoiding a real canvas
 * in jsdom.
 */
export function ImagePicker({ disabled, onImage }: ImagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    const out = await downscaleImage(file, MAX_LONG_EDGE)
    if (out) onImage(out.bytes, out.mimeType)
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className={styles.hidden}
        onChange={onChange}
        disabled={disabled}
      />
      <button
        type="button"
        className={styles.button}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="Attach image"
      >
        <span className="material-symbols-rounded" style={{ fontSize: 22 }} aria-hidden>
          photo_camera
        </span>
      </button>
    </>
  )
}

/**
 * Pure-math dimension computation. Returns the target (width, height) after
 * scaling so the long edge is at most `maxEdge`. Returns the source dims
 * unchanged when both are already within the budget.
 */
export function computeScaledDimensions(
  srcW: number,
  srcH: number,
  maxEdge: number,
): {
  width: number
  height: number
} {
  const longEdge = Math.max(srcW, srcH)
  if (longEdge <= maxEdge) return { width: srcW, height: srcH }
  const ratio = maxEdge / longEdge
  return { width: Math.round(srcW * ratio), height: Math.round(srcH * ratio) }
}

interface DownscaleResult {
  bytes: Uint8Array
  mimeType: string
}

async function downscaleImage(file: File, maxEdge: number): Promise<DownscaleResult | null> {
  const bitmap = await createBitmap(file)
  if (!bitmap) return null
  try {
    const { width, height } = computeScaledDimensions(bitmap.width, bitmap.height, maxEdge)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)

    // Prefer the source mime when it's a common type; default to JPEG (smaller
    // than PNG for photos).
    const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mimeType, JPEG_QUALITY),
    )
    if (!blob) return null
    const arrayBuffer = await blob.arrayBuffer()
    return { bytes: new Uint8Array(arrayBuffer), mimeType }
  } finally {
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()
  }
}

async function createBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to <img> fallback (Safari can be picky with HEIC).
    }
  }
  return await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = URL.createObjectURL(file)
  })
}
