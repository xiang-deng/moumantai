import React from 'react'
import type {
  TextFieldComponent,
  CheckBoxComponent,
  SwitchComponent,
  SliderComponent,
  TabsComponent,
  SelectComponent,
  SelectOption,
  DateTimeInputComponent,
} from '@moumantai/protocol/generated/moumantai/v1'
import type { RendererProps } from '../RenderNode'
import { resolveDynamic, dynamicPath, RenderNode } from '../RenderNode'
import type { RenderParent } from '../RenderNode'
import { useDispatchArgs, setDataAtPath } from '../renderer-utils'
import { resolvePointer } from '../data-model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Dynamic*-wrapped path to an absolute pointer for the data-model
 * adapter. Returns undefined for literal-only props (can't be written back).
 */
function fullPathFromDynamic(
  pathPart: string | undefined,
  itemScope: string | undefined,
): string | undefined {
  if (!pathPart) return undefined
  return pathPart.startsWith('/') ? pathPart : `${itemScope}/${pathPart}`
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

export function TextFieldRenderer({
  def,
  surfaceId,
  data,
  itemScope,
  modifierStyle,
}: RendererProps<TextFieldComponent>) {
  const label = def.label ?? ''
  const value = (resolveDynamic(def.value, data, itemScope) as string) ?? ''
  const hint = def.placeholder ?? ''
  const valuePath = fullPathFromDynamic(dynamicPath(def.value), itemScope)
  const multiline = def.multiline === true

  const typeMap: Record<string, string> = {
    text: 'text',
    number: 'number',
    email: 'email',
    phone: 'tel',
    decimal: 'number',
  }
  const inputType = def.keyboardType ? (typeMap[def.keyboardType] ?? 'text') : 'text'

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (valuePath) setDataAtPath(surfaceId, valuePath, e.target.value)
  }

  return (
    <div className="moumantai-textfield" style={modifierStyle}>
      {multiline ? (
        <textarea value={value} placeholder=" " rows={3} onChange={onInputChange} />
      ) : (
        <input
          type={inputType}
          value={value}
          placeholder=" "
          onChange={onInputChange}
          step={def.keyboardType === 'decimal' ? '0.01' : undefined}
        />
      )}
      <label>{label}</label>
      {hint && <span className="moumantai-textfield-hint">{hint}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CheckBox
// ---------------------------------------------------------------------------

export function CheckBoxRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<CheckBoxComponent>) {
  const label = resolveDynamic(def.label, data, itemScope) as string | undefined
  const checked = (resolveDynamic(def.checked, data, itemScope) as boolean) ?? false
  const checkedPath = fullPathFromDynamic(dynamicPath(def.checked), itemScope)
  const action = def.action

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (checkedPath) setDataAtPath(surfaceId, checkedPath, e.target.checked)
    if (action) {
      const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
      dispatch(action, surface, componentId, itemScopeData)
    }
  }

  return (
    <label className="moumantai-checkbox" style={modifierStyle}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label && <span className="moumantai-checkbox-label">{label}</span>}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function SwitchRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<SwitchComponent>) {
  const label = resolveDynamic(def.label, data, itemScope) as string | undefined
  const checked = (resolveDynamic(def.checked, data, itemScope) as boolean) ?? false
  const checkedPath = fullPathFromDynamic(dynamicPath(def.checked), itemScope)
  const action = def.action

  const onClick = () => {
    if (checkedPath) setDataAtPath(surfaceId, checkedPath, !checked)
    if (action) {
      const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
      dispatch(action, surface, componentId, itemScopeData)
    }
  }

  return (
    <div
      className={`moumantai-switch ${checked ? 'checked' : ''}`}
      style={modifierStyle}
      onClick={onClick}
    >
      {label && <span className="moumantai-switch-label">{label}</span>}
      <div className="moumantai-switch-track">
        <div className="moumantai-switch-thumb" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export function SliderRenderer({
  def,
  surfaceId,
  data,
  itemScope,
  modifierStyle,
}: RendererProps<SliderComponent>) {
  const value = (resolveDynamic(def.value, data, itemScope) as number) ?? 0
  const min = def.min ?? 0
  const max = def.max ?? 100
  const step = def.step ?? 1
  const label = def.label
  const valuePath = fullPathFromDynamic(dynamicPath(def.value), itemScope)

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (valuePath) setDataAtPath(surfaceId, valuePath, parseFloat(e.target.value))
  }

  return (
    <div className="moumantai-slider" style={modifierStyle}>
      {label && (
        <span
          className="md-typescale-label-medium"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {label}
        </span>
      )}
      <input type="range" min={min} max={max} step={step} value={value} onChange={onInput} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function TabsRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<TabsComponent>) {
  const selected = (resolveDynamic(def.selected, data, itemScope) as number) ?? 0
  const selectedPath = fullPathFromDynamic(dynamicPath(def.selected), itemScope)
  const action = def.action

  const onTabClick = (index: number) => {
    if (selectedPath) setDataAtPath(surfaceId, selectedPath, index)
    if (action) {
      const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
      dispatch(action, surface, componentId, itemScopeData)
    }
  }

  const activeContentId = def.tabContent[selected]

  return (
    <div className="moumantai-tabs" style={modifierStyle}>
      <div className="moumantai-tabs-bar">
        {def.tabLabels.map((label, i) => (
          <button
            key={i}
            className={`moumantai-tab ${i === selected ? 'active' : ''}`}
            onClick={() => onTabClick(i)}
          >
            {label ?? `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      <div className="moumantai-tabs-content">
        {activeContentId && (
          <RenderNode
            componentId={activeContentId}
            surfaceId={surfaceId}
            itemScope={itemScope}
            dispatch={dispatch}
            parent={{ kind: 'Tabs', slotIndex: 0, slotName: null } satisfies RenderParent}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

/**
 * Flatten `SelectOptions` oneof. `literal` uses the inline proto list;
 * `path` resolves at render time against the face data model.
 */
function resolveSelectOptions(
  opts: SelectComponent['options'] | undefined,
  data: Record<string, unknown>,
  itemScope?: string,
): SelectOption[] | Array<{ label: string; value: string }> {
  if (!opts) return []
  const v = opts.value
  if (v.case === 'literal') return v.value.options
  if (v.case === 'path') {
    const resolved =
      (resolvePointer(
        data,
        v.value.startsWith('/') ? v.value : itemScope ? `${itemScope}/${v.value}` : `/${v.value}`,
      ) as Array<{ label: string; value: string }>) ?? []
    return resolved
  }
  return []
}

export function SelectRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<SelectComponent>) {
  const value = (resolveDynamic(def.value, data, itemScope) as string) ?? ''
  const label = def.label ?? ''
  const options = resolveSelectOptions(def.options, data, itemScope)
  const valuePath = fullPathFromDynamic(dynamicPath(def.value), itemScope)
  const action = def.action

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (valuePath) setDataAtPath(surfaceId, valuePath, e.target.value)
    if (action) {
      const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
      dispatch(action, surface, componentId, itemScopeData)
    }
  }

  return (
    <div className="moumantai-select" style={modifierStyle}>
      {label && <label className="moumantai-select-label">{label}</label>}
      <select value={value} onChange={onChange}>
        <option value="" disabled>
          Select...
        </option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DateTimeInput
// ---------------------------------------------------------------------------

export function DateTimeInputRenderer({
  def,
  componentId,
  surfaceId,
  data,
  itemScope,
  dispatch,
  modifierStyle,
}: RendererProps<DateTimeInputComponent>) {
  const value = (resolveDynamic(def.value, data, itemScope) as string) ?? ''
  const label = def.label ?? ''
  const mode = def.mode ?? 'date'
  const valuePath = fullPathFromDynamic(dynamicPath(def.value), itemScope)
  const action = def.action

  const typeMap: Record<string, string> = {
    date: 'date',
    time: 'time',
    datetime: 'datetime-local',
  }
  const inputType = typeMap[mode] ?? 'date'

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (valuePath) setDataAtPath(surfaceId, valuePath, e.target.value)
    if (action) {
      const { surface, itemScopeData } = useDispatchArgs(surfaceId, data, itemScope)
      dispatch(action, surface, componentId, itemScopeData)
    }
  }

  return (
    <div className="moumantai-datetime-input" style={modifierStyle}>
      {label && <label className="moumantai-datetime-label">{label}</label>}
      <input type={inputType} value={value} onChange={onChange} />
    </div>
  )
}
