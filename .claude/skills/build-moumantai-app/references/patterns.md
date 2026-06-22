# Patterns (`moumantai/ui`)

Patterns are **SDK-only TS helpers** that emit primitive `ComponentDef[]` trees. Authors `import { hero, kpi, emptyState, actionRow } from 'moumantai/ui'` and compose them with primitives inside `<face>.compact.ts` / `<face>.expanded.ts` files. The patterns barrel is re-exported through `moumantai/ui` — there is no separate `moumantai/ui/patterns` entrypoint.

Patterns are **static** — they don't branch on form-factor at call time. The form-factor split happens at the file level (you author different IA per `.compact.ts` and `.expanded.ts`). Renderers translate primitives to native idiom per platform. The catalog's `compact:` blocks (in `shared/protocol/design-system/design-system.yaml`) declare per-form-factor sizing rules the renderers consume.

> **Bar to add a new pattern:** ≥2 apps need it (Brad Frost atomic-design rule). Until then, write inline primitives in the face file.

## Why patterns exist

Without patterns, every face hand-rolls "centered hero", "value + label tile", "empty state with CTA". That fragments the design language — each app's empty state looks slightly different. Patterns absorb the repeated compositions into one source of truth, expressed in TypeScript with typed args.

Patterns are also the right place to encode design choices that aren't about *what* you render but *how* it's composed:
- `hero(child)` centers a single child in a Box — every hero face looks consistent.
- `kpi(value, label)` stacks a large value above a small label with the right typography roles.
- `emptyState(message, { action })` puts the message + optional CTA in a consistent layout.

## Seed set (v1)

### `hero(boxId, child)`

Wrap a single child in a centered, full-bleed Box. Pair with `scaffold('root', { body_kind: BodyKind.CANVAS })` so the body doesn't try to scroll. Use for glance faces (todo today's ring, weather hero temp).

```ts
// today.compact.ts
import { defineFace } from 'moumantai'
import { scaffold, column, progress, text, pathRef, hero, BodyKind } from 'moumantai/ui'

export default defineFace({
  id: 'today',
  label: 'Today',
  kind: 'compact',
  position: 0,
  viewToolDescription: 'Show progress ring + headline',
  resolve: ({ db }) => ({ percent: 80, headline: '2/8 tasks done' }),
  components: [
    scaffold('root', { body: 'content', body_kind: BodyKind.CANVAS }),  // BodyKind enum from 'moumantai/ui' — never a string
    column('content', ['hero_box', 'headline'], { spacing: 8 }),
    ...hero('hero_box', progress('ring', pathRef('/percent'), 100, { variant: 'circular', size: 100 })),
    text('headline', pathRef('/headline')),
  ],
})
```

### `kpi(id, value, label, options?)`

Vertical value+label tile (Polaris MetricCard analog). The renderer's typography scale (display-large value, label-medium label) handles per-platform sizing. Use for primary metrics: monthly spend, remaining tasks, today's calories.

```ts
import { kpi } from 'moumantai/ui'

// In a column:
...kpi('total_kpi', pathRef('/total_display'), 'spent this month'),
```

### `emptyState(id, message, options?)`

Uniform "nothing here" surface. Optional CTA renders as a Button below the message. Pair with a `visible` binding when the empty state shows only on an empty list.

```ts
import { emptyState } from 'moumantai/ui'

// Inside the body's column children list:
...emptyState('empty_msg', 'No tasks yet', {
  visible: pathRef('/empty'),
  action: {
    label: 'Add task',
    action: invokeTool('add_task'),
  },
}),
```

### `actionRow(id, primary, secondary?)`

Primary (optionally + secondary) action anchored to the bottom of a face's body. On Wear, the renderer translates `button(variant='fab')` to M3 `EdgeButton` (edge-hugging) when placed as the last body child. On phone, it renders as a standard FAB-style button row.

```ts
import { actionRow } from 'moumantai/ui'

// As the last body child:
...actionRow('actions', { label: 'Log meal', action: invokeTool('add_meal') }),
```

## Form-factor recipes (which IA on which form-factor)

### Compact face (≤240dp; currently Wear)

- **Glanceable**: ≤3 visible items above the fold; user reads in 1–2 seconds.
- **Body kind**: `'canvas'` for a fixed glance (ring + headline); `'list'` for a scrolling list of items.
- **Patterns to lean on**: `hero` for the primary visual; `kpi` for a single metric; `emptyState` when the list is empty; `actionRow` for the primary action.
- **Avoid**: horizontal `Row` of chips/items (overflows round screens); circular progress > 100dp on a 384dp screen; complex 3-column card layouts.

### Expanded face (phone / tablet / wide web)

- **Information-dense**: header + body + actions; user dwells 10–30 seconds.
- **Body kind**: typically `'list'` (the framework wraps it in a `LazyColumn`).
- **Patterns**: same vocabulary, composed differently — `kpi` row of 3 metrics instead of one stacked KPI, full filter chips in a `Row`, multi-column game cards.
- **TopBar**: declare a `topBar` component on the Scaffold for face titles + actions.

## What's NOT a pattern

- **Domain-specific compositions** (e.g. `gameCard`, `weatherDayRow`): live in `apps/<app>/faces/<face>/parts.ts` as app-local helpers. Promote to the SDK only when ≥2 apps need them.
- **Chrome / layout primitives**: `scaffold`, `column`, `row`, `card`, `box`, `topBar` are primitives, not patterns. Use them directly from `moumantai`.
- **Data binding**: `pathRef('/foo')` is in `moumantai`, not patterns.

## How patterns compose with `body_kind`

`scaffold('root', { body: 'content', body_kind: BodyKind.LIST | BodyKind.CANVAS })` (the `BodyKind` enum from `moumantai/ui` — never a string) tells the renderer what to do with the body:

- **`BodyKind.LIST`** (default): renderer wraps the body component in its native lazy/scrollable container — `LazyColumn` (phone), `TransformingLazyColumn` (Wear M3), `<div overflow-y-auto>` (web), `lv_obj_t` + scrollable flag (ESP32). Each top-level body child becomes one item. Authors don't write `column(scroll: true)` on the body.
- **`BodyKind.CANVAS`**: renderer renders body bounded + centered, no scroll. For glance faces. Use `hero` + a one-line `text` as the typical canvas content.

When `body_kind` is unset, renderers default to `BodyKind.LIST` (safe choice — fits any face that has scrolling content).

## See also

- `shared/protocol/design-system/authoring.md` — auto-generated catalog reference (primitives + their `compact:` policies).
- `shared/protocol/design-system/rendering.md` — renderer-implementer guide (how each platform translates primitives + body_kind).
- `apps/spend-tracker/faces/summary/` — canonical reference face (read end-to-end).
