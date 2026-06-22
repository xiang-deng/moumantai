/**
 * Input components: TextField, CheckBox, Switch, Slider, Tabs, Select, DateTimeInput
 *
 * `*Options` types are generated from `components.proto` — see
 * `./generated/options.ts`. The Switch builder is named `switchToggle()` to
 * avoid the JS reserved-word collision (proto oneof case is `switchToggle`;
 * builder type label is 'Switch'; SDK type is `SwitchOptions`).
 */

import type { DynamicValue } from './common.js'
import { component } from './common.js'
import type { ComponentDef } from './common.js'
import type {
  TextFieldOptions,
  CheckBoxOptions,
  SwitchOptions,
  SliderOptions,
  TabsOptions,
  SelectOptions,
  DateTimeInputOptions,
} from './generated/options.js'

export type {
  TextFieldOptions,
  CheckBoxOptions,
  SwitchOptions,
  SliderOptions,
  TabsOptions,
  SelectOptions,
  DateTimeInputOptions,
}
// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Default `value`/`checked` binding when the author omits one: `pathRef('/$form/<id>')`.
 * Renderers route `/$form/...` through the per-face form scope (preserved
 * across face refreshes; cleared on navigation). See `shared/protocol/FORM_SCOPE.md`.
 * Authors override with an explicit path or non-empty literal.
 */
function defaultFormPath(id: string): { path: string } {
  return { path: `/$form/${id}` }
}

/**
 * For string-typed inputs, treat `null`, `undefined`, and `''` as "no
 * override → fall through to the $form default." A literal empty string is
 * visually indistinguishable from unbound but with plain `??` would defeat
 * the default binding and clobber user keystrokes on every recomposition.
 */
function isBlankStringBinding(v: unknown): boolean {
  return v === null || v === undefined || v === ''
}

export function textField(
  id: string,
  value?: DynamicValue<string>,
  label?: string,
  options: TextFieldOptions = {},
): ComponentDef {
  return component(id, 'TextField', {
    value: isBlankStringBinding(value) ? defaultFormPath(id) : value,
    label,
    ...options,
  })
}

export function checkBox(
  id: string,
  label?: DynamicValue<string>,
  checked?: DynamicValue<boolean>,
  options: CheckBoxOptions = {},
): ComponentDef {
  // Inputs with `action` fire on change — no $form writeback needed.
  // Without `action`, default to `/$form/<id>`.
  const defaultChecked = options.action ? checked : (checked ?? defaultFormPath(id))
  return component(id, 'CheckBox', { label, checked: defaultChecked, ...options })
}

export function switchToggle(
  id: string,
  checked?: DynamicValue<boolean>,
  options: SwitchOptions = {},
): ComponentDef {
  const defaultChecked = options.action ? checked : (checked ?? defaultFormPath(id))
  return component(id, 'Switch', { checked: defaultChecked, ...options })
}

export function slider(
  id: string,
  value?: DynamicValue<number>,
  options: SliderOptions = {},
): ComponentDef {
  const defaultValue = options.action ? value : (value ?? defaultFormPath(id))
  return component(id, 'Slider', { value: defaultValue, ...options })
}

export function tabs(
  id: string,
  tabLabels?: string[],
  tabContent?: string[],
  options: TabsOptions = {},
): ComponentDef {
  const defaultSelected = options.action
    ? options.selected
    : (options.selected ?? defaultFormPath(id))
  return component(id, 'Tabs', {
    tab_labels: tabLabels,
    tab_content: tabContent,
    ...options,
    selected: defaultSelected,
  })
}

export function select(
  id: string,
  value?: DynamicValue<string>,
  label?: string,
  options: SelectOptions = {},
): ComponentDef {
  const defaultValue = options.action
    ? value
    : isBlankStringBinding(value)
      ? defaultFormPath(id)
      : value
  return component(id, 'Select', { value: defaultValue, label, ...options })
}

export function dateTimeInput(
  id: string,
  value?: DynamicValue<string>,
  label?: string,
  options: DateTimeInputOptions = {},
): ComponentDef {
  const defaultValue = options.action
    ? value
    : isBlankStringBinding(value)
      ? defaultFormPath(id)
      : value
  return component(id, 'DateTimeInput', { value: defaultValue, label, ...options })
}
