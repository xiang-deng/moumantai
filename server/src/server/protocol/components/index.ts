/**
 * Component builders barrel — the resolution target for 'moumantai/ui'.
 *
 * Re-exports all builders, option interfaces, action helpers, and pathRef
 * so existing `import { ... } from 'moumantai/ui'` continues to work.
 */

// --- Common: types, action helpers, pathRef ---
export { type ModifierProps, type ComponentDef, type Action, type DynamicValue } from './common.js'
export { invokeTool } from './common.js'
export { pathRef } from './common.js'

// --- Atoms ---
export { text, icon, image, divider } from './atoms.js'
export {
  type TextOptions,
  type IconOptions,
  type ImageOptions,
  type DividerOptions,
} from './atoms.js'

// --- Layout ---
export { column, row, card, box } from './layout.js'
export { type ColumnOptions, type RowOptions, type CardOptions, type BoxOptions } from './layout.js'

// --- Chrome ---
export { scaffold, topBar, BodyKind } from './chrome.js'
export { type ScaffoldOptions, type TopBarOptions } from './chrome.js'

// --- Actions ---
export { button, chip, fab } from './actions.js'
export { type ButtonOptions, type ChipOptions, type FabOptions } from './actions.js'

// --- Input ---
export { textField, checkBox, switchToggle, slider, tabs, select, dateTimeInput } from './input.js'
export {
  type TextFieldOptions,
  type CheckBoxOptions,
  type SwitchOptions,
  type SliderOptions,
  type TabsOptions,
  type SelectOptions,
  type DateTimeInputOptions,
} from './input.js'

// --- Data ---
export { list, listItem } from './data.js'
export { type ListOptions, type ListItemOptions } from './data.js'

// --- Feedback ---
export { progressRing, progressBar, modal } from './feedback.js'
export { type ProgressRingOptions, type ProgressBarOptions, type ModalOptions } from './feedback.js'

// --- Patterns (SDK sugar over primitives) ---
// Emit primitive ComponentDef[] trees. Form-factor variance comes from the
// .compact.ts / .expanded.ts file split + renderer-side design-system rules,
// not branching inside the pattern body.
export {
  hero,
  kpi,
  emptyState,
  actionRow,
  detailHeader,
  sectionHeader,
  statusBadge,
  loadMore,
} from './patterns/index.js'
export {
  type KpiOptions,
  type EmptyStateOptions,
  type ActionRowSpec,
  type DetailHeaderOptions,
  type SectionHeaderOptions,
  type StatusBadgeOptions,
  type LoadMoreOptions,
} from './patterns/index.js'
