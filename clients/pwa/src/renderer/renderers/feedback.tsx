import type {
  ProgressRingComponent,
  ProgressBarComponent,
  ModalComponent,
} from '@moumantai/protocol/generated/moumantai/v1'
import type { RendererProps } from '../RenderNode'
import { resolveDynamic, dynamicPath, RenderNode } from '../RenderNode'
import type { RenderParent } from '../RenderNode'
import { resolveColor } from '../theme'
import { setDataAtPath } from '../renderer-utils'

// ---------------------------------------------------------------------------
// ProgressRing — SVG ring, intrinsic-sized, centered label/sublabel.
// ---------------------------------------------------------------------------

export function ProgressRingRenderer({
  def,
  data,
  itemScope,
  modifierStyle,
}: RendererProps<ProgressRingComponent>) {
  const value = (resolveDynamic(def.value, data, itemScope) as number) ?? 0
  const max = def.max ?? 100
  const label = resolveDynamic(def.label, data, itemScope) as string | undefined
  const sublabel = resolveDynamic(def.sublabel, data, itemScope) as string | undefined
  const color = def.color ? resolveColor(def.color) : 'var(--md-sys-color-primary)'

  const progress = Math.min(value / max, 1)
  const size = def.size && def.size > 0 ? def.size : 120
  const radius = (size - 12) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - progress)

  return (
    <div
      className="moumantai-progress-ring"
      style={{ ...modifierStyle, width: `${size}px`, height: `${size}px` }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="moumantai-progress-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth="8"
        />
        <circle
          className="moumantai-progress-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth="8"
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="moumantai-progress-ring-center">
        {label != null && (
          <span className="md-typescale-title-large" style={{ color }}>
            {label}
          </span>
        )}
        {sublabel && (
          <span
            className="md-typescale-body-small"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          >
            {sublabel}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProgressBar — fill-width linear bar with rounded ends.
// ---------------------------------------------------------------------------

export function ProgressBarRenderer({
  def,
  data,
  itemScope,
  modifierStyle,
}: RendererProps<ProgressBarComponent>) {
  const value = (resolveDynamic(def.value, data, itemScope) as number) ?? 0
  const max = def.max ?? 100
  const label = resolveDynamic(def.label, data, itemScope) as string | undefined
  const color = def.color ? resolveColor(def.color) : 'var(--md-sys-color-primary)'

  const progress = Math.min(value / max, 1)
  const linearStyle: React.CSSProperties = { ...modifierStyle, width: '100%' }

  return (
    <div className="moumantai-progress-linear" style={linearStyle}>
      {label && (
        <span
          className="md-typescale-label-medium"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {label}
        </span>
      )}
      <div className="moumantai-progress-linear-track">
        <div
          className="moumantai-progress-linear-fill"
          style={{ width: `${progress * 100}%`, backgroundColor: color }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function ModalRenderer({
  def,
  surfaceId,
  data,
  itemScope,
  dispatch,
}: RendererProps<ModalComponent>) {
  const open = resolveDynamic(def.open, data, itemScope) as boolean | undefined
  if (!open) return null

  const openPath = dynamicPath(def.open)
  const onBackdropClick = () => {
    if (!openPath) return
    const fullPath = openPath.startsWith('/') ? openPath : `${itemScope}/${openPath}`
    setDataAtPath(surfaceId, fullPath, false)
  }

  // Rendered as bottom-sheet style on phone.
  return (
    <div className="moumantai-modal-backdrop" onClick={onBackdropClick}>
      <div
        className="moumantai-modal-card moumantai-modal-card--fullscreen"
        onClick={(e) => e.stopPropagation()}
      >
        {def.children.map((childId, i) => (
          <RenderNode
            key={childId}
            componentId={childId}
            surfaceId={surfaceId}
            itemScope={itemScope}
            dispatch={dispatch}
            parent={{ kind: 'Modal', slotIndex: i, slotName: null } satisfies RenderParent}
          />
        ))}
      </div>
    </div>
  )
}
