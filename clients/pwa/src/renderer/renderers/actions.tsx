import React from 'react'
import type {
  ButtonComponent,
  ChipComponent,
  FabComponent,
} from '@moumantai/protocol/generated/moumantai/v1'
import {
  resolveButtonTreatment,
  resolveChipTreatment,
  CHIP_SELECTED_TREATMENT,
} from '@moumantai/protocol/design-system'
import type { RendererProps } from '../RenderNode'
import { resolveDynamic } from '../RenderNode'
import { useDispatchArgs } from '../renderer-utils'
import { treatmentClass } from '../variants'
import { IconGlyph } from './icon-glyph'

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export function ButtonRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<ButtonComponent>) {
  const text = resolveDynamic(def.text, data, itemScope) as string | undefined
  const enabled =
    def.enabled != null ? (resolveDynamic(def.enabled, data, itemScope) as boolean) : true
  const treatment = resolveButtonTreatment(def.emphasis, def.tone)
  const iconName = def.icon ? (resolveDynamic(def.icon, data, itemScope) as string) : null
  const action = def.action

  const onClick = action
    ? (e: React.MouseEvent) => {
        e.stopPropagation()
        const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
        dispatch(action, surface, componentId, itemScopeData)
      }
    : undefined

  return (
    <button
      className={`moumantai-button moumantai-button--${treatmentClass(treatment)}`}
      style={modifierStyle}
      disabled={!enabled}
      onClick={onClick}
    >
      <IconGlyph name={iconName} style={{ fontSize: 'var(--moumantai-icon-size-small)' }} />
      {text ?? ''}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Fab
// ---------------------------------------------------------------------------

export function FabRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
}: RendererProps<FabComponent>) {
  const label = def.label ? (resolveDynamic(def.label, data, itemScope) as string) : undefined
  const iconName = def.icon ? (resolveDynamic(def.icon, data, itemScope) as string) : null
  const action = def.action
  // `extended` when a label is present; otherwise use the size hint.
  const declaredSize = def.size && def.size.length > 0 ? def.size : 'regular'
  const size = label ? 'extended' : declaredSize

  const onClick = action
    ? (e: React.MouseEvent) => {
        e.stopPropagation()
        const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
        dispatch(action, surface, componentId, itemScopeData)
      }
    : undefined

  return (
    <button
      className={`moumantai-fab moumantai-fab--${size}`}
      onClick={onClick}
      aria-label={label ?? 'Action'}
    >
      <IconGlyph name={iconName} style={{ fontSize: 'var(--moumantai-icon-size)' }} />
      {label ?? ''}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Chip — filter behavior when `selected:` is present; selected-true applies
// the catalog's `selected_treatment`; selected-false uses the base treatment.
// ---------------------------------------------------------------------------

export function ChipRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<ChipComponent>) {
  const label = (resolveDynamic(def.label, data, itemScope) as string) ?? ''
  const iconName = resolveDynamic(def.icon, data, itemScope) as string | undefined
  const hasSelectedBinding = def.selected !== undefined
  const isSelected = hasSelectedBinding
    ? ((resolveDynamic(def.selected, data, itemScope) as boolean) ?? false)
    : false
  const baseTreatment = resolveChipTreatment(def.tone)
  const effectiveTreatment = isSelected ? CHIP_SELECTED_TREATMENT : baseTreatment
  const action = def.action

  const onClick = action
    ? (e: React.MouseEvent) => {
        e.stopPropagation()
        const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
        dispatch(action, surface, componentId, itemScopeData)
      }
    : undefined

  // `.moumantai-chip.selected` drives state-layer CSS; treatment class drives the rest.
  return (
    <button
      className={`moumantai-chip moumantai-chip--${treatmentClass(effectiveTreatment)} ${isSelected ? 'selected' : ''}`}
      style={modifierStyle}
      onClick={onClick}
    >
      <IconGlyph name={iconName} />
      {label}
    </button>
  )
}
