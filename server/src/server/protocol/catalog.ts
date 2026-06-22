/**
 * Component Catalog — single source of truth for all Moumantai components.
 *
 * Every component type, category, builder name, device support, and description
 * are defined here. The component guide, client registries, and tests derive
 * from this catalog. Props live in the builder files, not here.
 */

import { DeviceClass } from '@moumantai/protocol/generated/moumantai/v1'
import type { ComponentDef } from '@moumantai/protocol/generated/moumantai/v1'
import { DESIGN_SYSTEM } from '@moumantai/protocol/design-system'

/**
 * Server-internal mapping from DeviceClass to renderer. Never crosses the wire
 * (clients identify themselves via DeviceClass on hello). Plain TS constant,
 * not a proto enum.
 */
export const Platform = {
  WEB: 'web',
  ANDROID: 'android',
  WEAROS: 'wearos',
  ESP32: 'esp32',
} as const
export type Platform = (typeof Platform)[keyof typeof Platform]

/** Map a proto DeviceClass to its rendering Platform. */
export function deviceClassToPlatform(dc: DeviceClass): Platform {
  switch (dc) {
    case DeviceClass.WATCH:
      return Platform.WEAROS
    case DeviceClass.IOT_SMALL:
    case DeviceClass.PHONE:
      return Platform.ANDROID
    case DeviceClass.HMI_PANEL:
      return Platform.ESP32
    case DeviceClass.GLASS:
      return Platform.WEB
    default:
      return Platform.WEB
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Category = 'atoms' | 'layout' | 'chrome' | 'actions' | 'input' | 'data' | 'feedback'

export interface CatalogEntry {
  /** Wire name as it appears in JSON: "Text", "Button", "ProgressRing" */
  type: string
  /** Organizational category */
  category: Category
  /** Builder function name: "text", "button", "progressRing" */
  builder: string
  /** Builder call signature for LLM guide: "scaffold(id, {body, top_bar})" */
  signature: string
  /** Device classes this component supports */
  supportedDevices: DeviceClass[]
  /** One-line description for guide generation */
  description: string
  /** Auto-adaptation notes for small/constrained screens (injected into LLM component guide) */
  smallScreenNotes?: string
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const CATALOG: CatalogEntry[] = [
  // --- atoms ---
  {
    type: 'Text',
    category: 'atoms',
    builder: 'text',
    signature: 'text(id, content, {typography})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
      DeviceClass.GLASS,
    ],
    description: 'Display text with typography styling',
  },
  {
    type: 'Icon',
    category: 'atoms',
    builder: 'icon',
    signature: 'icon(id, name)',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
      DeviceClass.GLASS,
    ],
    description:
      'Material Symbols by name (e.g. "check_circle"); prefix with "fa:" for FontAwesome Free fallback (e.g. "fa:cart-plus")',
  },
  // Image: ESP32 renderer is a placeholder chip (no decode); excluded so authors don't expect a real image.
  {
    type: 'Image',
    category: 'atoms',
    builder: 'image',
    signature: 'image(id, src)',
    supportedDevices: [DeviceClass.PHONE, DeviceClass.WATCH, DeviceClass.IOT_SMALL],
    description: `Image from URL (fit: ${DESIGN_SYSTEM.Image.fitModes.join(', ')})`,
  },
  {
    type: 'Divider',
    category: 'atoms',
    builder: 'divider',
    signature: 'divider(id)',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Visual separator line',
  },

  // --- layout ---
  {
    type: 'Column',
    category: 'layout',
    builder: 'column',
    signature: 'column(id, [children], {spacing, padding})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
      DeviceClass.GLASS,
    ],
    description: 'Vertical flex container',
    smallScreenNotes: 'Watch: auto safe-area inset (28dp) on round screen',
  },
  {
    type: 'Row',
    category: 'layout',
    builder: 'row',
    signature: 'row(id, [children], {spacing})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Horizontal flex container',
    smallScreenNotes: 'Watch: wraps to Column if >2 children',
  },
  {
    type: 'Card',
    category: 'layout',
    builder: 'card',
    signature: 'card(id, [children], {emphasis, tone})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description:
      'Container for grouping content. Pass `emphasis: "standard" | "elevated"` (elevated for hero/standout); `tone: "default" | "accent" | "warning" | "error" | "info"` for semantic color. Default is standard filled.',
    smallScreenNotes: 'Watch: radius 8dp, padding 4-8dp (compact)',
  },
  {
    type: 'Box',
    category: 'layout',
    builder: 'box',
    signature: 'box(id, [children], {content_alignment, child_alignment})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description:
      'Z-stack overlay layout — children paint in order, each anchored within the box. Use for overlay UX: a "LIVE" pill on a card, a badge on an image, a status dot on an avatar. Alignment values: topStart (default), topCenter, topEnd, centerStart, center, centerEnd, bottomStart, bottomCenter, bottomEnd. Per-child override via child_alignment[i].',
    smallScreenNotes:
      'Use sparingly on watch/iot-small — prefer Column/Row when stacking is not essential; over-layering hurts legibility on small screens',
  },

  // --- chrome (app framing) ---
  {
    type: 'Scaffold',
    category: 'chrome',
    builder: 'scaffold',
    signature: 'scaffold(id, {body, top_bar})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Top-level screen container with top bar, body, and FAB slots',
    smallScreenNotes: 'Watch: renders body slot only (TopBar and FAB skipped)',
  },
  {
    type: 'TopBar',
    category: 'chrome',
    builder: 'topBar',
    signature: 'topBar(id, title)',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'App bar with title and navigation',
    smallScreenNotes: 'Watch: skipped entirely to save screen space',
  },

  // --- actions ---
  {
    type: 'Button',
    category: 'actions',
    builder: 'button',
    signature: 'button(id, label, {emphasis, tone, icon, action})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description:
      'Clickable button. Pass `emphasis: "primary" | "standard" | "quiet"` for visual weight (one primary CTA per face); `tone: "default" | "accent" | "warning" | "error" | "info"` for semantic color. Default is standard tonal.',
    smallScreenNotes: 'Watch: icon-only when both icon and text present; 48dp min touch target',
  },
  {
    type: 'Chip',
    category: 'actions',
    builder: 'chip',
    signature: 'chip(id, label, {selected, tone, icon, action})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description:
      'Compact selectable element. Binding `selected:` switches the chip to filter-chip styling (secondary-container fill); without `selected:` it renders as an assist chip (outlined). `tone:` applies a semantic color role.',
    smallScreenNotes: 'Watch/iot-small: renders full-width; primary interactive element on watch',
  },
  // Fab: floating action button — corner-anchored primary action, distinct from inline Button.
  {
    type: 'Fab',
    category: 'actions',
    builder: 'fab',
    signature: 'fab(id, {icon, label, size, action})',
    supportedDevices: [DeviceClass.PHONE, DeviceClass.WATCH, DeviceClass.IOT_SMALL],
    description:
      'Floating action button — corner-anchored. Pass `label` to render an extended FAB; omit for an icon-only compact FAB. `size: "small" | "regular" | "extended"` controls dimensions.',
    smallScreenNotes: 'Watch: renders as M3 EdgeButton when last body child',
  },

  // --- input ---
  {
    type: 'TextField',
    category: 'input',
    builder: 'textField',
    signature: 'textField(id, value, label, {multiline, placeholder, keyboard_type})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description:
      'Text input field. Pass `multiline: true` for a textarea-style multi-line field (larger min-height, Enter inserts a newline).',
    smallScreenNotes: 'Watch/iot-small: opens full-screen input overlay (voice-first)',
  },
  {
    type: 'CheckBox',
    category: 'input',
    builder: 'checkBox',
    signature: 'checkBox(id, label, checked)',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Boolean checkbox toggle',
  },
  {
    type: 'Switch',
    category: 'input',
    builder: 'switchToggle',
    signature: 'switchToggle(id, checked)',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'On/off toggle switch',
  },
  {
    type: 'Slider',
    category: 'input',
    builder: 'slider',
    signature: 'slider(id, value, {min, max})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Numeric range slider',
  },
  {
    type: 'Tabs',
    category: 'input',
    builder: 'tabs',
    signature: 'tabs(id, labels, content)',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Tabbed content switcher',
    smallScreenNotes: 'Watch/iot-small: shows active tab content only, no tab bar',
  },
  {
    type: 'Select',
    category: 'input',
    builder: 'select',
    signature: 'select(id, value, label, {options})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Pick one option from a dropdown list',
    smallScreenNotes: 'Watch/iot-small: full-screen picker overlay',
  },
  // DateTimeInput: ESP32 renderer is a textarea fallback — excluded so authors use Select for time entry.
  {
    type: 'DateTimeInput',
    category: 'input',
    builder: 'dateTimeInput',
    signature: 'dateTimeInput(id, value, label, {mode})',
    supportedDevices: [DeviceClass.PHONE, DeviceClass.WATCH, DeviceClass.IOT_SMALL],
    description: 'Date and/or time picker',
    smallScreenNotes: 'Watch/iot-small: full-screen picker overlay',
  },

  // --- data ---
  {
    type: 'List',
    category: 'data',
    builder: 'list',
    signature: 'list(id, itemsPath, templateId)',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Scrollable data-driven list with template binding',
    smallScreenNotes: 'Watch: 44dp item height; iot-small: 48dp; hmi-panel: 52dp',
  },
  {
    type: 'ListItem',
    category: 'data',
    builder: 'listItem',
    signature: 'listItem(id, headline, {supporting, trailing_content})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'List item with headline, supporting text, and trailing content',
    smallScreenNotes: 'Watch: 44dp item height; iot-small: 48dp; hmi-panel: 52dp',
  },

  // --- feedback ---
  // Modal: ESP32 renderer is an inline column (no real overlay layer); kept stripped so authors
  // don't expect overlay UX on HMI_PANEL.
  {
    type: 'ProgressRing',
    category: 'feedback',
    builder: 'progressRing',
    signature: 'progressRing(id, value, max, {label, sublabel, color, size})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description:
      'Circular progress indicator — SVG ring with centered label/sublabel. Intrinsic-sized; ideal for KPI rings and glance displays.',
    smallScreenNotes:
      'Watch: respects chin clearance (max size 100dp). HMI_PANEL: lv_arc with stroke=diameter/8.',
  },
  {
    type: 'ProgressBar',
    category: 'feedback',
    builder: 'progressBar',
    signature: 'progressBar(id, value, max, {label, color})',
    supportedDevices: [
      DeviceClass.PHONE,
      DeviceClass.WATCH,
      DeviceClass.IOT_SMALL,
      DeviceClass.HMI_PANEL,
    ],
    description: 'Linear progress bar — fill-width horizontal bar with rounded ends.',
    smallScreenNotes: 'Watch: full available width',
  },
  {
    type: 'Modal',
    category: 'feedback',
    builder: 'modal',
    signature: 'modal(id, [children], {open})',
    supportedDevices: [DeviceClass.PHONE, DeviceClass.WATCH, DeviceClass.IOT_SMALL],
    description: 'Overlay dialog',
    smallScreenNotes: 'Watch/iot-small: renders full-screen edge-to-edge',
  },
]

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getCatalogEntry(type: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.type === type)
}

export function getCatalogByCategory(cat: Category): CatalogEntry[] {
  return CATALOG.filter((e) => e.category === cat)
}

export function getCatalogForDevice(device: DeviceClass): CatalogEntry[] {
  return CATALOG.filter((e) => e.supportedDevices.includes(device))
}

export function getAllBuilderNames(): string[] {
  return CATALOG.map((e) => e.builder)
}

export function getAllComponentTypes(): string[] {
  return CATALOG.map((e) => e.type)
}

// ---------------------------------------------------------------------------
// Per-device component filtering
// ---------------------------------------------------------------------------
//
// `CatalogEntry.supportedDevices` is canonical. The broadcaster walks each
// per-client face update through `filterComponentsForDevice`, which drops
// components not listed for the client's DeviceClass.
//
// Why per-device, not per-platform: GLASS uses the web React renderer
// (Platform.WEB) but is a voice-first device with a restricted component set.
// Filtering per Platform would let components like Box reach Glass silently.

/**
 * Map the `ComponentDef.component.case` oneof discriminator
 * (`'text' | 'topBar' | 'switchToggle' | …`) to the PascalCase wire-type
 * names the catalog is keyed by (`'Text'`, `'TopBar'`, `'Switch'`, …).
 */
const CASE_TO_TYPE: Record<string, string> = {
  text: 'Text',
  icon: 'Icon',
  image: 'Image',
  divider: 'Divider',
  column: 'Column',
  row: 'Row',
  card: 'Card',
  box: 'Box',
  scaffold: 'Scaffold',
  topBar: 'TopBar',
  button: 'Button',
  chip: 'Chip',
  fab: 'Fab',
  textField: 'TextField',
  checkBox: 'CheckBox',
  switchToggle: 'Switch',
  slider: 'Slider',
  tabs: 'Tabs',
  select: 'Select',
  dateTimeInput: 'DateTimeInput',
  list: 'List',
  listItem: 'ListItem',
  progressRing: 'ProgressRing',
  progressBar: 'ProgressBar',
  modal: 'Modal',
}

// Per-device support sets, derived once from CATALOG.supportedDevices.
const SUPPORT_BY_DEVICE: Map<DeviceClass, Set<string>> = (() => {
  const map = new Map<DeviceClass, Set<string>>()
  for (const entry of CATALOG) {
    for (const dc of entry.supportedDevices) {
      let set = map.get(dc)
      if (!set) {
        set = new Set()
        map.set(dc, set)
      }
      set.add(entry.type)
    }
  }
  return map
})()

/** Filter a component array to only types supported on a device class. */
export function filterComponentsForDevice(
  components: ComponentDef[],
  deviceClass: DeviceClass,
): ComponentDef[] {
  const supported = SUPPORT_BY_DEVICE.get(deviceClass)
  if (!supported) return []
  return components.filter((c) => {
    const caseName = c.component?.case
    if (!caseName) return false
    const type = CASE_TO_TYPE[caseName]
    return type !== undefined && supported.has(type)
  })
}
