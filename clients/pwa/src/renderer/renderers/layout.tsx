import React from 'react'
import type {
  ColumnComponent,
  RowComponent,
  CardComponent,
  BoxComponent,
} from '@moumantai/protocol/generated/moumantai/v1'
import { ALIGNMENTS, resolveCardTreatment } from '@moumantai/protocol/design-system'
import type { RendererProps } from '../RenderNode'
import { RenderNode } from '../RenderNode'
import type { RenderParent } from '../RenderNode'
import { useDispatchArgs } from '../renderer-utils'
import { treatmentClass } from '../variants'
import { isBodyTopColumn } from '../parent-utils'

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

export function ColumnRenderer({
  def,
  surfaceId,
  itemScope,
  dispatch,
  modifierStyle,
  parent,
}: RendererProps<ColumnComponent>) {
  const arrangementMap: Record<string, string> = {
    top: 'flex-start',
    center: 'center',
    bottom: 'flex-end',
    spaceBetween: 'space-between',
    spaceAround: 'space-around',
    spaceEvenly: 'space-evenly',
  }
  const alignMap: Record<string, string> = {
    start: 'flex-start',
    center: 'center',
    end: 'flex-end',
  }

  const style: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    ...modifierStyle,
  }
  if (def.verticalArrangement) {
    style.justifyContent = arrangementMap[def.verticalArrangement] ?? def.verticalArrangement
  }
  if (def.horizontalAlignment) {
    style.alignItems = alignMap[def.horizontalAlignment] ?? def.horizontalAlignment
  } else if (isBodyTopColumn(parent)) {
    style.alignItems = 'center'
  } else {
    style.alignItems = 'stretch'
  }
  if (def.spacing) style.gap = `${def.spacing}px`

  return (
    <div style={style}>
      {def.children.map((childId, i) => (
        <RenderNode
          key={childId}
          componentId={childId}
          surfaceId={surfaceId}
          itemScope={itemScope}
          dispatch={dispatch}
          parent={{ kind: 'Column', slotIndex: i, slotName: null } satisfies RenderParent}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export function RowRenderer({
  def,
  surfaceId,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<RowComponent>) {
  const arrangementMap: Record<string, string> = {
    start: 'flex-start',
    center: 'center',
    end: 'flex-end',
    spaceBetween: 'space-between',
    spaceAround: 'space-around',
    spaceEvenly: 'space-evenly',
  }
  const alignMap: Record<string, string> = {
    top: 'flex-start',
    center: 'center',
    bottom: 'flex-end',
  }

  const style: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    ...modifierStyle,
  }
  if (def.horizontalArrangement) {
    style.justifyContent = arrangementMap[def.horizontalArrangement] ?? def.horizontalArrangement
  }
  if (def.verticalAlignment) {
    style.alignItems = alignMap[def.verticalAlignment] ?? def.verticalAlignment
  }
  if (def.spacing) style.gap = `${def.spacing}px`

  return (
    <div style={style}>
      {def.children.map((childId, i) => (
        <RenderNode
          key={childId}
          componentId={childId}
          surfaceId={surfaceId}
          itemScope={itemScope}
          dispatch={dispatch}
          parent={{ kind: 'Row', slotIndex: i, slotName: null } satisfies RenderParent}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function CardRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<CardComponent>) {
  const treatment = resolveCardTreatment(def.emphasis, def.tone)
  const action = def.action

  const onClick = action
    ? (e: React.MouseEvent) => {
        e.stopPropagation()
        const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
        dispatch(action, surface, componentId, itemScopeData)
      }
    : undefined

  return (
    <div
      className={`moumantai-card moumantai-card--${treatmentClass(treatment)}`}
      style={modifierStyle}
      data-clickable={!!action}
      onClick={onClick}
    >
      {def.children.map((childId, i) => (
        <RenderNode
          key={childId}
          componentId={childId}
          surfaceId={surfaceId}
          itemScope={itemScope}
          dispatch={dispatch}
          parent={{ kind: 'Card', slotIndex: i, slotName: null } satisfies RenderParent}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Box (z-stack)
// ---------------------------------------------------------------------------
//
// Box uses CSS Grid with every child at `grid-area: 1/1`, matching Compose
// Box semantics: children stack in DOM order (later = on top), Box sizes to
// its largest child.
//
// Per-child alignment: childAlignment[i] → contentAlignment → ALIGNMENTS.default.

interface FlexAlign {
  readonly alignItems: string
  readonly justifyContent: string
}

const FLEX_ALIGN: Readonly<Record<string, FlexAlign>> = {
  topStart: { alignItems: 'flex-start', justifyContent: 'flex-start' },
  topCenter: { alignItems: 'flex-start', justifyContent: 'center' },
  topEnd: { alignItems: 'flex-start', justifyContent: 'flex-end' },
  centerStart: { alignItems: 'center', justifyContent: 'flex-start' },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerEnd: { alignItems: 'center', justifyContent: 'flex-end' },
  bottomStart: { alignItems: 'flex-end', justifyContent: 'flex-start' },
  bottomCenter: { alignItems: 'flex-end', justifyContent: 'center' },
  bottomEnd: { alignItems: 'flex-end', justifyContent: 'flex-end' },
}

/**
 * Resolve a Box child's alignment to flex alignItems/justifyContent.
 * Falls back to ALIGNMENTS.default for empty/unknown values.
 *
 * Why flex (not `place-self`): the wrapper fills the grid cell via
 * `place-self: stretch`. Using `place-self: start` would collapse it to
 * max-content, making width:100% children resolve circularly. Full-cell flex
 * lets both fill-width (Card) and intrinsic-width (Progress ring) children
 * coexist in the same Box.
 */
export function boxChildFlexAlign(alignment: string | undefined): FlexAlign {
  const key = alignment && alignment in FLEX_ALIGN ? alignment : ALIGNMENTS.default
  return FLEX_ALIGN[key] ?? FLEX_ALIGN[ALIGNMENTS.default]!
}

export function BoxRenderer({
  def,
  surfaceId,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<BoxComponent>) {
  const fallbackAlign = def.contentAlignment

  return (
    <div className="moumantai-box" style={modifierStyle}>
      {def.children.map((childId, i) => {
        const perChild = def.childAlignment[i]
        const align = perChild && perChild.length > 0 ? perChild : fallbackAlign
        const flex = boxChildFlexAlign(align)
        return (
          <div
            key={childId}
            className="moumantai-box__child"
            style={{ alignItems: flex.alignItems, justifyContent: flex.justifyContent }}
          >
            <RenderNode
              componentId={childId}
              surfaceId={surfaceId}
              itemScope={itemScope}
              dispatch={dispatch}
              parent={{ kind: 'Box', slotIndex: i, slotName: null } satisfies RenderParent}
            />
          </div>
        )
      })}
    </div>
  )
}
