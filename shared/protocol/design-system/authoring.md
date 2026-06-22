# Layout & Component Authoring Reference

> AUTO-GENERATED from `shared/protocol/design-system/design-system.yaml`.
> DO NOT EDIT BY HAND. Run `task design-system:gen` to regenerate.
>
> Audience: **face authors** — LLMs and humans writing `face.tsx` files.
> Renderer implementers: see `rendering.md` instead.

## What this is

The catalog encodes the rules every face author can rely on: per-component
default sizing, valid modifier values, recipe patterns. Face authors use the
typed SDK (`from 'moumantai'`) which consumes these closed sets — typos surface
as TypeScript errors at build time.

## Modifier reference

Every component accepts these optional modifiers. Omit a modifier to use the
catalog default (almost always what you want).

### Sizing

```
width  / height: 'fill' | 'wrap' | <integer dp> | omit (= use default)
weight:           <number>   (numeric flex ratio in a Row/Column)
```

| Value | When to use |
|---|---|
| omit | Default; works for ~90% of cases |
| `'fill'` | Force cross-axis stretch |
| `'wrap'` | Force content-size |
| `<integer>` | Fixed dp size |
| `weight: <N>` | Inside a Row/Column, claim a proportional share of the remaining main-axis space. Two siblings with `weight: 1` split 50/50; `weight: 1` + `weight: 2` splits 1:2. Has no effect outside a Row/Column. |

> The `'grow'` keyword is a shorthand for `weight: 1`. Use numeric `weight`
> directly for non-uniform splits (e.g. a 1:2:1 stat row).

### Alignment

```
align: <one of 9 values> | omit (= 'topStart')
```

| | Start | Center | End |
|---|---|---|---|
| Top | `'topStart'` | `'topCenter'` | `'topEnd'` |
| Center | `'centerStart'` | `'center'` | `'centerEnd'` |
| Bottom | `'bottomStart'` | `'bottomCenter'` | `'bottomEnd'` |

### Arrangement (Row / Column main-axis distribution)

```
vertical_arrangement (Column) / horizontal_arrangement (Row):
  'center' | 'end' | 'spaceAround' | 'spaceBetween' | 'spaceEvenly' | 'start' | omit (= 'start')
```

## Per-component default behavior

The effective default size when the modifier is omitted, per common parent type.
Atom components (intrinsic=wrap/fixed) behave the same in every parent.

### Box
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content (no policy) |
| `Scaffold body` | fill | fill |
| `root` | fill (best-effort) | fill (best-effort) |

### Button
**`emphasis`:** `primary` | `standard` *(default)* | `quiet`
**`tone`:** `default` *(default)* | `accent` | `warning` | `error` | `info`
**Default size:** content-size in every parent (both axes wrap to content)

### Card
**`emphasis`:** `standard` *(default)* | `elevated`
**`tone`:** `default` *(default)* | `accent` | `warning` | `error` | `info`
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### CheckBox
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Chip
**`tone`:** `default` *(default)* | `accent` | `warning` | `error`
**Selected state:** binding `selected:` (regardless of value) switches the chip from assist-chip styling to filter-chip styling on every renderer. No author choice needed — the data shape is the signal.
**Default size:** content-size in every parent (both axes wrap to content)

### Column
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content (no policy) |
| `Scaffold body` | fill | fill |
| `root` | fill (best-effort) | fill (best-effort) |

### DateTimeInput
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Divider
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | fixed (renderer) |
| `Row` | content | fixed (renderer) |
| `Card` | fill | fixed (renderer) |
| `Box (background)` | fill | fixed (renderer) |
| `Box (overlay)` | content (no policy) | fixed (renderer) |
| `Scaffold body` | fill | fixed (renderer) |
| `root` | fill (best-effort) | fixed (renderer) |

### Fab
**`size`:** `small` | `regular` *(default)* | `extended`
**Default size:** content-size in every parent (both axes wrap to content)

### Icon
**Default size:** renderer-defined fixed size in every parent

### Image
**Fit modes:** `contain` *(default)* | `crop` | `fill` | `fillHeight` | `fillWidth` | `none`
**Default size:** content-size in every parent (both axes wrap to content)

### List
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content (no policy) |
| `Scaffold body` | fill | fill |
| `root` | fill (best-effort) | fill (best-effort) |

### ListItem
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Modal
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content (no policy) |
| `Scaffold body` | fill | fill |
| `root` | fill (best-effort) | fill (best-effort) |

### ProgressBar
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### ProgressRing
**Default size:** content-size in every parent (both axes wrap to content)

### Row
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Scaffold
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content (no policy) |
| `Scaffold body` | fill | fill |
| `root` | fill (best-effort) | fill (best-effort) |

### Select
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Slider
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Switch
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Tabs
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### Text
**Default size:** content-size in every parent (both axes wrap to content)

### TextField
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

### TopBar
**Default size per parent:**

| Parent | Width | Height |
|---|---|---|
| `Column` | fill | content |
| `Row` | content | content |
| `Card` | fill | content |
| `Box (background)` | fill | content |
| `Box (overlay)` | content (no policy) | content |
| `Scaffold body` | fill | content |
| `root` | fill (best-effort) | content |

## Recipe sheet

| Author intent | How to write it |
|---|---|
| Full-width card | `card(id, children)` — default |
| Hero card with corner badge | `box(id, [card(...), badge({align: 'topEnd'})])` — first child becomes the background automatically |
| List filling remaining vertical space | `list(id, items, { height: 'fill' })` inside a column body, or `weight: 1` inside another list/column |
| Two-column proportional split (e.g. away \| home) | each column with `weight: 1` |
| Asymmetric split (e.g. label takes 2x the value) | `weight: 1`, `weight: 2`, `weight: 1` on the three children |
| Spacer pushing siblings to ends of a Row | a `box(id, [], { weight: 1 })` between them |
| Centered button | `box(id, [button(...)], { content_alignment: 'center' })` |
| Fixed-width sidebar | `column(id, children, { width: 280 })` |
| Force a normally-stretching component to wrap | `card(id, children, { width: 'wrap' })` |
| Image filling its parent | `image(id, src, { width: 'fill' })` |
| Filter chip with selected highlight | `chip(id, label, { selected: pathRef('/selection/x'), action: invokeTool(...) })` — variant defaults to assist; binding `selected` is what activates filter styling |
| Center a Row's contents when the Row spans the parent's width | `row(id, kids, { horizontal_arrangement: 'center' })` — the Row's `horizontal_arrangement` controls main-axis distribution; the parent Column's `horizontal_alignment` does not affect FILL-shaped Row children |
| Card collection in a list | `list(id, items, 'foo_card')` + `card('foo_card', ['foo_inner'])` + `column('foo_inner', [...])` **without** `padding`. The card's own `--moumantai-card-padding` (16dp expanded / 8dp compact) is the content inset; the list applies the catalog gap (8dp expanded / 4dp compact) between consecutive cards. Adding `padding: N` on the inner column doubles the inset and produces visibly bloated tiles. |

## Pitfalls

- `weight` only takes effect when the immediate parent is a Row or Column.
  A `weight: 1` on a Column child of a Card does nothing — the Card lays out
  its children stacked vertically with each child taking content height.
- Mixing `weight` and explicit `width` / `height` on the same component:
  the explicit dp wins. Pick one.
- A weighted child whose own children all wrap may *visually* be smaller
  than its allocated slot — the weight gives it the slot, but inner content
  decides how to fill it. Use `horizontal_alignment` / `vertical_alignment`
  on the Column/Row to position content within the slot.
- **Wrap-vs-fill alignment.** A Column's `horizontal_alignment` only
  positions WRAP-intrinsic children (a `text`, a `chip`, a `card` with
  `width: 'wrap'`). FILL-intrinsic children (a `row` — defaults to
  `width: parent`; a `card` — defaults to `width: parent`) already span
  the cross-axis, so the Column's alignment has nothing left to do for
  them. To center the *contents* of a FILL Row, set the Row's own
  `horizontal_arrangement: 'center'`. To center a Card's contents,
  use `box(id, [card(...)], { content_alignment: 'center' })` or shrink
  the Card with `width: 'wrap'`.
- **Nested Row inside a weighted, wrap-cross Column.** A Row child of a
  Column defaults to `width: fill` (catalog policy `Row-in-Column = FILL`).
  If that Column is itself a weighted child of an outer Row, the inner Row
  expands to consume the parent's full width — leaving zero for the outer
  Row's other weighted siblings, which then render invisible. Fix: set
  `width: 'wrap'` on the inner Row so it sizes to its content, freeing
  the outer Row to split remaining space across siblings.
