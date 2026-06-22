/* eslint-disable */
// AUTO-GENERATED from shared/protocol/proto/moumantai/v1/components.proto.
// Run `task protocol:gen` to regenerate. Do not hand-edit.
//
// Per-variant builder functions + dispatch table. The factory in common.ts
// delegates to this table, so adding a proto field automatically threads
// through both the Options interface and the ComponentDef construction
// without any hand-written sync code.

import { create } from '@bufbuild/protobuf'
import { ComponentDefSchema, BoxComponentSchema, ButtonComponentSchema, CardComponentSchema, CheckBoxComponentSchema, ChipComponentSchema, ColumnComponentSchema, DateTimeInputComponentSchema, DividerComponentSchema, FabComponentSchema, IconComponentSchema, ImageComponentSchema, ListComponentSchema, ListItemComponentSchema, ModalComponentSchema, ProgressBarComponentSchema, ProgressRingComponentSchema, RowComponentSchema, ScaffoldComponentSchema, SelectComponentSchema, SliderComponentSchema, SwitchComponentSchema, TabsComponentSchema, TextComponentSchema, TextFieldComponentSchema, TopBarComponentSchema } from '@moumantai/protocol/generated/moumantai/v1'
import type { ComponentDef, Action } from '../common.js'
import { dynString, dynBool, dynInt32, dynDouble, selectOptions, listChildren, buildModifier } from '../common.js'
import type { BoxOptions, ButtonOptions, CardOptions, CheckBoxOptions, ChipOptions, ColumnOptions, DateTimeInputOptions, DividerOptions, FabOptions, IconOptions, ImageOptions, ListItemOptions, ListOptions, ModalOptions, ProgressBarOptions, ProgressRingOptions, RowOptions, ScaffoldOptions, SelectOptions, SliderOptions, SwitchOptions, TabsOptions, TextFieldOptions, TextOptions, TopBarOptions } from './options.js'

function buildText(id: string, props: TextOptions): ComponentDef {
  const value = create(TextComponentSchema, {
    text: dynString(props.text),
    typography: props.typography,
    color: props.color,
    fontWeight: props.font_weight,
    textAlign: props.text_align,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'text', value } })
}

function buildIcon(id: string, props: IconOptions): ComponentDef {
  const value = create(IconComponentSchema, {
    name: dynString(props.name),
    size: props.size,
    color: dynString(props.color),
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'icon', value } })
}

function buildImage(id: string, props: ImageOptions): ComponentDef {
  const value = create(ImageComponentSchema, {
    src: dynString(props.src),
    alt: props.alt,
    fit: props.fit,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'image', value } })
}

function buildDivider(id: string, props: DividerOptions): ComponentDef {
  const value = create(DividerComponentSchema, {
    thickness: props.thickness,
    color: props.color,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'divider', value } })
}

function buildColumn(id: string, props: ColumnOptions): ComponentDef {
  const value = create(ColumnComponentSchema, {
    children: props.children ?? [],
    spacing: props.spacing,
    verticalArrangement: props.vertical_arrangement,
    horizontalAlignment: props.horizontal_alignment,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'column', value } })
}

function buildRow(id: string, props: RowOptions): ComponentDef {
  const value = create(RowComponentSchema, {
    children: props.children ?? [],
    spacing: props.spacing,
    horizontalArrangement: props.horizontal_arrangement,
    verticalAlignment: props.vertical_alignment,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'row', value } })
}

function buildCard(id: string, props: CardOptions): ComponentDef {
  const value = create(CardComponentSchema, {
    children: props.children ?? [],
    action: props.action as Action | undefined,
    emphasis: props.emphasis,
    tone: props.tone,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'card', value } })
}

function buildScaffold(id: string, props: ScaffoldOptions): ComponentDef {
  const value = create(ScaffoldComponentSchema, {
    topBar: props.top_bar,
    body: props.body,
    fab: props.fab,
    bodyKind: props.body_kind,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'scaffold', value } })
}

function buildTopBar(id: string, props: TopBarOptions): ComponentDef {
  const value = create(TopBarComponentSchema, {
    title: dynString(props.title),
    navigationAction: props.navigation_action as Action | undefined,
    actions: props.actions ?? [],
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'topBar', value } })
}

function buildButton(id: string, props: ButtonOptions): ComponentDef {
  const value = create(ButtonComponentSchema, {
    text: dynString(props.text),
    icon: dynString(props.icon),
    enabled: dynBool(props.enabled),
    action: props.action as Action | undefined,
    emphasis: props.emphasis,
    tone: props.tone,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'button', value } })
}

function buildChip(id: string, props: ChipOptions): ComponentDef {
  const value = create(ChipComponentSchema, {
    label: dynString(props.label),
    icon: dynString(props.icon),
    selected: dynBool(props.selected),
    action: props.action as Action | undefined,
    tone: props.tone,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'chip', value } })
}

function buildFab(id: string, props: FabOptions): ComponentDef {
  const value = create(FabComponentSchema, {
    icon: dynString(props.icon),
    label: dynString(props.label),
    size: props.size,
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'fab', value } })
}

function buildTextField(id: string, props: TextFieldOptions): ComponentDef {
  const value = create(TextFieldComponentSchema, {
    value: dynString(props.value),
    label: props.label,
    placeholder: props.placeholder,
    keyboardType: props.keyboard_type,
    multiline: props.multiline,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'textField', value } })
}

function buildCheckBox(id: string, props: CheckBoxOptions): ComponentDef {
  const value = create(CheckBoxComponentSchema, {
    label: dynString(props.label),
    checked: dynBool(props.checked),
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'checkBox', value } })
}

function buildSwitch(id: string, props: SwitchOptions): ComponentDef {
  const value = create(SwitchComponentSchema, {
    label: dynString(props.label),
    checked: dynBool(props.checked),
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'switchToggle', value } })
}

function buildSlider(id: string, props: SliderOptions): ComponentDef {
  const value = create(SliderComponentSchema, {
    value: dynDouble(props.value),
    min: props.min,
    max: props.max,
    step: props.step,
    label: props.label,
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'slider', value } })
}

function buildTabs(id: string, props: TabsOptions): ComponentDef {
  const value = create(TabsComponentSchema, {
    tabLabels: props.tab_labels ?? [],
    tabContent: props.tab_content ?? [],
    selected: dynInt32(props.selected),
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'tabs', value } })
}

function buildSelect(id: string, props: SelectOptions): ComponentDef {
  const value = create(SelectComponentSchema, {
    value: dynString(props.value),
    label: props.label,
    options: selectOptions(props.options),
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'select', value } })
}

function buildDateTimeInput(id: string, props: DateTimeInputOptions): ComponentDef {
  const value = create(DateTimeInputComponentSchema, {
    value: dynString(props.value),
    label: props.label,
    mode: props.mode,
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'dateTimeInput', value } })
}

function buildList(id: string, props: ListOptions): ComponentDef {
  const value = create(ListComponentSchema, {
    children: listChildren(props.children),
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'list', value } })
}

function buildListItem(id: string, props: ListItemOptions): ComponentDef {
  const value = create(ListItemComponentSchema, {
    headline: dynString(props.headline),
    supporting: dynString(props.supporting),
    leadingIcon: dynString(props.leading_icon),
    trailingContent: props.trailing_content,
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'listItem', value } })
}

function buildProgressRing(id: string, props: ProgressRingOptions): ComponentDef {
  const value = create(ProgressRingComponentSchema, {
    value: dynDouble(props.value),
    max: props.max,
    label: dynString(props.label),
    sublabel: dynString(props.sublabel),
    color: props.color,
    size: props.size,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'progressRing', value } })
}

function buildProgressBar(id: string, props: ProgressBarOptions): ComponentDef {
  const value = create(ProgressBarComponentSchema, {
    value: dynDouble(props.value),
    max: props.max,
    label: dynString(props.label),
    color: props.color,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'progressBar', value } })
}

function buildModal(id: string, props: ModalOptions): ComponentDef {
  const value = create(ModalComponentSchema, {
    children: props.children ?? [],
    open: dynBool(props.open),
    action: props.action as Action | undefined,
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'modal', value } })
}

function buildBox(id: string, props: BoxOptions): ComponentDef {
  const value = create(BoxComponentSchema, {
    children: props.children ?? [],
    contentAlignment: props.content_alignment,
    childAlignment: props.child_alignment ?? [],
    modifier: buildModifier(props),
  })
  return create(ComponentDefSchema, { id, component: { case: 'box', value } })
}

/**
 * Dispatch table keyed by the PascalCase type label used in
 * `component(id, type, props)`. Switch is keyed as 'Switch' even though
 * the oneof case is 'switchToggle' (cf. SwitchComponent message name).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const factoryDispatch: Record<string, (id: string, props: any) => ComponentDef> = {
  Text: buildText,
  Icon: buildIcon,
  Image: buildImage,
  Divider: buildDivider,
  Column: buildColumn,
  Row: buildRow,
  Card: buildCard,
  Scaffold: buildScaffold,
  TopBar: buildTopBar,
  Button: buildButton,
  Chip: buildChip,
  Fab: buildFab,
  TextField: buildTextField,
  CheckBox: buildCheckBox,
  Switch: buildSwitch,
  Slider: buildSlider,
  Tabs: buildTabs,
  Select: buildSelect,
  DateTimeInput: buildDateTimeInput,
  List: buildList,
  ListItem: buildListItem,
  ProgressRing: buildProgressRing,
  ProgressBar: buildProgressBar,
  Modal: buildModal,
  Box: buildBox,
}
