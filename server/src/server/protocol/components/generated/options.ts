/* eslint-disable */
// AUTO-GENERATED from shared/protocol/proto/moumantai/v1/components.proto.
// Run `task protocol:gen` to regenerate. Do not hand-edit.
//
// Per-variant Options interfaces for the SDK component builders. Keys are
// snake_case to match the wire field names (LLM-authored faces use the
// same names). Closed unions imported from sdk-types are authoring-time
// refinements over wire-honest `string` fields.

import type { DynamicValue, Action, SelectOptionsInput, ListChildrenInput, ModifierProps } from '../common.js'
import type { Alignment, Arrangement, ButtonEmphasis, ButtonTone, CardEmphasis, CardTone, ChipTone, FabSize, ImageFit } from '@moumantai/protocol/design-system/sdk-types'
import type { BodyKind } from '@moumantai/protocol/generated/moumantai/v1'

/** Options for the Text component (wire variant `text`). */
export interface TextOptions extends ModifierProps {
  text?: DynamicValue<string>
  typography?: string
  color?: string
  font_weight?: string
  text_align?: string
}

/** Options for the Icon component (wire variant `icon`). */
export interface IconOptions extends ModifierProps {
  name?: DynamicValue<string>
  size?: number
  color?: DynamicValue<string>
  action?: Action
}

/** Options for the Image component (wire variant `image`). */
export interface ImageOptions extends ModifierProps {
  src?: DynamicValue<string>
  alt?: string
  fit?: ImageFit
}

/** Options for the Divider component (wire variant `divider`). */
export interface DividerOptions extends ModifierProps {
  thickness?: number
  color?: string
}

/** Options for the Column component (wire variant `column`). */
export interface ColumnOptions extends ModifierProps {
  children?: string[]
  spacing?: number
  vertical_arrangement?: Arrangement
  horizontal_alignment?: Alignment
}

/** Options for the Row component (wire variant `row`). */
export interface RowOptions extends ModifierProps {
  children?: string[]
  spacing?: number
  horizontal_arrangement?: Arrangement
  vertical_alignment?: Alignment
}

/** Options for the Card component (wire variant `card`). */
export interface CardOptions extends ModifierProps {
  children?: string[]
  action?: Action
  emphasis?: CardEmphasis
  tone?: CardTone
}

/** Options for the Scaffold component (wire variant `scaffold`). */
export interface ScaffoldOptions extends ModifierProps {
  top_bar?: string
  body?: string
  fab?: string
  body_kind?: BodyKind
}

/** Options for the TopBar component (wire variant `topBar`). */
export interface TopBarOptions extends ModifierProps {
  title?: DynamicValue<string>
  navigation_action?: Action
  actions?: string[]
}

/** Options for the Button component (wire variant `button`). */
export interface ButtonOptions extends ModifierProps {
  text?: DynamicValue<string>
  icon?: DynamicValue<string>
  enabled?: DynamicValue<boolean>
  action?: Action
  emphasis?: ButtonEmphasis
  tone?: ButtonTone
}

/** Options for the Chip component (wire variant `chip`). */
export interface ChipOptions extends ModifierProps {
  label?: DynamicValue<string>
  icon?: DynamicValue<string>
  selected?: DynamicValue<boolean>
  action?: Action
  tone?: ChipTone
}

/** Options for the Fab component (wire variant `fab`). */
export interface FabOptions extends ModifierProps {
  icon?: DynamicValue<string>
  label?: DynamicValue<string>
  size?: FabSize
  action?: Action
}

/** Options for the TextField component (wire variant `textField`). */
export interface TextFieldOptions extends ModifierProps {
  value?: DynamicValue<string>
  label?: string
  placeholder?: string
  keyboard_type?: string
  multiline?: boolean
}

/** Options for the CheckBox component (wire variant `checkBox`). */
export interface CheckBoxOptions extends ModifierProps {
  label?: DynamicValue<string>
  checked?: DynamicValue<boolean>
  action?: Action
}

/** Options for the Switch component (wire variant `switchToggle`). */
export interface SwitchOptions extends ModifierProps {
  label?: DynamicValue<string>
  checked?: DynamicValue<boolean>
  action?: Action
}

/** Options for the Slider component (wire variant `slider`). */
export interface SliderOptions extends ModifierProps {
  value?: DynamicValue<number>
  min?: number
  max?: number
  step?: number
  label?: string
  action?: Action
}

/** Options for the Tabs component (wire variant `tabs`). */
export interface TabsOptions extends ModifierProps {
  tab_labels?: string[]
  tab_content?: string[]
  selected?: DynamicValue<number>
  action?: Action
}

/** Options for the Select component (wire variant `select`). */
export interface SelectOptions extends ModifierProps {
  value?: DynamicValue<string>
  label?: string
  options?: SelectOptionsInput
  action?: Action
}

/** Options for the DateTimeInput component (wire variant `dateTimeInput`). */
export interface DateTimeInputOptions extends ModifierProps {
  value?: DynamicValue<string>
  label?: string
  mode?: 'date' | 'time' | 'datetime'
  action?: Action
}

/** Options for the List component (wire variant `list`). */
export interface ListOptions extends ModifierProps {
  children?: ListChildrenInput
}

/** Options for the ListItem component (wire variant `listItem`). */
export interface ListItemOptions extends ModifierProps {
  headline?: DynamicValue<string>
  supporting?: DynamicValue<string>
  leading_icon?: DynamicValue<string>
  trailing_content?: string
  action?: Action
}

/** Options for the ProgressRing component (wire variant `progressRing`). */
export interface ProgressRingOptions extends ModifierProps {
  value?: DynamicValue<number>
  max?: number
  label?: DynamicValue<string>
  sublabel?: DynamicValue<string>
  color?: string
  size?: number
}

/** Options for the ProgressBar component (wire variant `progressBar`). */
export interface ProgressBarOptions extends ModifierProps {
  value?: DynamicValue<number>
  max?: number
  label?: DynamicValue<string>
  color?: string
}

/** Options for the Modal component (wire variant `modal`). */
export interface ModalOptions extends ModifierProps {
  children?: string[]
  open?: DynamicValue<boolean>
  action?: Action
}

/** Options for the Box component (wire variant `box`). */
export interface BoxOptions extends ModifierProps {
  children?: string[]
  content_alignment?: Alignment
  child_alignment?: Alignment[]
}
