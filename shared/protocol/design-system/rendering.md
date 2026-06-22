# Layout Rendering Spec

> AUTO-GENERATED from `shared/protocol/design-system/design-system.yaml`.
> DO NOT EDIT BY HAND. Run `task design-system:gen` to regenerate.
>
> Audience: **renderer implementers** — engineers adding/maintaining the
> Compose phone, Compose Wear, web (CSS), or LVGL ESP32 renderer.
> Face authors: see `authoring.md` instead.

## What this is

Every renderer must agree byte-identically on what each `(parent_kind,
slot_index, slot_name, child_kind, child_variant, own_keyword)` combination
resolves to. This document specifies the algorithm, the platform mappings,
and the fallback rules. Conformance is enforced by
`task protocol:test-layout-resolution` against
`shared/protocol/fixtures/layout-resolution/spec.json`.

## Resolution algorithm

Pure function: `resolve(parent_kind, slot_index, slot_name, child_kind, child_variant, own_keyword) → SizeResult`
where `SizeResult ∈ { FILL, WRAP, FIXED, GROW }`.

```
1. own_keyword:
     'fill'  -> FILL
     'wrap'  -> WRAP
     'grow'  -> GROW   (renderer falls back to FILL on cross-axis or
                        non-flex parent — see fallback rules below)
     dp(n)   -> FIXED(n)
2. component intrinsic for this axis:
     'wrap'   -> WRAP
     'fixed'  -> FIXED
     'parent' -> step 3
3. parent's container policy:
     plain       -> child_default_<axis>
     slotted Box -> slot_index == 0 ? 'background' : 'overlay'
     Scaffold    -> slot_name in {body, top_bar, fab}
     cross_axis_fill -> FILL ; cross_axis_wrap -> WRAP ; none -> WRAP
4. root or unknown parent: intrinsic 'parent' -> FILL (best-effort)
```

Identical for height. Variant-aware sizing (Progress.linear vs circular)
is encoded via the per-component `variant_overrides:` block in the catalog;
the resolver applies the override after the universal width/height lookup,
and renderers may still honor an explicit `modifier.width` to override both.

## `body_kind` dispatch (Scaffold body container)

`ScaffoldComponent.body_kind` (enum `BodyKind` — `BODY_KIND_UNSPECIFIED = 0`,
`BODY_KIND_LIST = 1`, `BODY_KIND_CANVAS = 2`) tells every renderer how to wrap
the body slot. The framework owns the body container; face authors stop writing
`column(scroll: true)` on a face's body Column.

- **LIST** (default, and `UNSPECIFIED` falls through to LIST on every renderer):
  wrap the body in the platform's native lazy/scrollable container. Top-level
  body children become list items. Chin clearance / safe-area / rotary scroll
  free.
- **CANVAS**: render the body inside a bounded, centered, non-scrollable frame.
  Glance faces (one hero ring + caption; weather glance) use this.

| BodyKind | Phone (M3) | Wear (M3) | ESP32 (LVGL) | Web (CSS) |
|---|---|---|---|---|
| LIST (default) | `LazyColumn` (16dp horizontal padding) | `TransformingLazyColumn` (edge scaling + rotary) | `lv_obj` with `LV_OBJ_FLAG_SCROLLABLE` + vertical flex | `.moumantai-scaffold-body` → `overflow-y: auto` |
| CANVAS | `Box(fillMaxSize, contentAlignment=Center) { Column { … } }` | `Box(fillMaxSize, contentAlignment=Center) { Column { … } }` inside `ScreenScaffold` | `lv_obj` with `LV_FLEX_ALIGN_CENTER` on both axes, scroll flag removed | `.moumantai-scaffold-body--canvas` → `flex; align-items+justify-content: center; overflow: hidden` |

Wear's `Scaffold.fab` slot is special: when the referenced button has
`variant = 'fab'`, the renderer hoists it into `ScreenScaffold.edgeButton`
(curved bottom-edge primary action) instead of rendering it as a list item.
Other slots / variants render in-flow per the LIST/CANVAS rules above.

## Sizing keyword → platform mapping

| Catalog | Compose | LVGL | CSS |
|---|---|---|---|
| FILL | `Modifier.fillMaxWidth()` | `LV_PCT(100)` | `width: 100% / align-self: stretch` |
| WRAP | `Modifier.wrapContentWidth()` | `LV_SIZE_CONTENT` | `width: auto` |
| GROW | no-op marker; the SDK normalizes `'grow'` to `weight: 1` and the parent Row/Column applies the weight via the renderer's outer-modifier hook | `lv_obj_set_flex_grow(obj, 1)` | `flex: 1` |
| FIXED(n) | `Modifier.width(n.dp)` | `lv_obj_set_width(obj, n)` | `width: ${n}px` |

### Numeric `weight` (canonical)

The proto carries an optional numeric `weight` field on `Modifier`. Renderers
extract it inside Row/Column iteration and apply it to the child:

- **Compose (Android, Wear)**: `Modifier.weight(N)` is only callable inside
  RowScope/ColumnScope, but the per-component `*Renderer` builds its own
  modifier from scratch and has no scope access. The Row/ColumnRenderer
  therefore wraps the child in a tiny `Box(Modifier.weight(N), propagateMinConstraints = true) { childRender() }`.
  The Box reads as a transparent slot allocator: the parent Row/Column sees
  the weight parent data and gives the Box its share of the main axis;
  `propagateMinConstraints = true` forwards the slot's minWidth/minHeight to
  the inner child so a WRAP-policy Column (the catalog default for
  Column-in-Row) doesn't collapse to intrinsic-zero. The Box has no padding
  or content alignment of its own, so it adds no visible chrome.
- **CSS (web)**: `style.flex = weight`.
- **LVGL (ESP32)**: `lv_obj_set_flex_grow(obj, weight)`.

Same table for height with axis swapped.

## Component intrinsics

Every component's default sizing when no parent context is available (root or unknown parent).
`parent` intrinsic resolves to FILL at root (best-effort). Sourced from `layout.components`.

| Component | Width intrinsic | Height intrinsic |
|---|---|---|
| Box | `parent` | `parent` |
| Button | `wrap` | `wrap` |
| Card | `parent` | `wrap` |
| CheckBox | `parent` | `wrap` |
| Chip | `wrap` | `wrap` |
| Column | `parent` | `parent` |
| DateTimeInput | `parent` | `wrap` |
| Divider | `parent` | `fixed` |
| Fab | `wrap` | `wrap` |
| Icon | `fixed` | `fixed` |
| Image | `wrap` | `wrap` |
| List | `parent` | `parent` |
| ListItem | `parent` | `wrap` |
| Modal | `parent` | `parent` |
| ProgressBar | `parent` | `wrap` |
| ProgressRing | `wrap` | `wrap` |
| Row | `parent` | `wrap` |
| Scaffold | `parent` | `parent` |
| Select | `parent` | `wrap` |
| Slider | `parent` | `wrap` |
| Switch | `parent` | `wrap` |
| Tabs | `parent` | `wrap` |
| Text | `wrap` | `wrap` |
| TextField | `parent` | `wrap` |
| TopBar | `parent` | `wrap` |

## Container policies

Sourced from `layout.containers`. These apply when a child has `parent` intrinsic
and the parent is a known container.

### Box

Slotted container — slot determines child sizing.

| Slot | Width policy | Height policy |
|---|---|---|
| `background` | `cross_axis_fill` | `cross_axis_wrap` |
| `overlay` | `none` | `none` |

### Card
Child default width: `cross_axis_fill` / height: `cross_axis_wrap`

### Column
Child default width: `cross_axis_fill` / height: `cross_axis_wrap`

### List
Child default width: `cross_axis_fill` / height: `cross_axis_wrap`

Gap between consecutive children (spacing-token names; `none` = literal 0):

| Child variant | Gap token |
|---|---|
| `Card` | `spacing.s` |
| `ListItem` | `spacing.none` |
| _default_ | `spacing.s` |

### Modal
Child default width: `cross_axis_fill` / height: `cross_axis_wrap`

### Row
Child default width: `cross_axis_wrap` / height: `cross_axis_wrap`

### Scaffold

Slotted container — slot determines child sizing.

| Slot | Width policy | Height policy |
|---|---|---|
| `body` | `cross_axis_fill` | `cross_axis_fill` |
| `fab` | `none` | `none` |
| `top_bar` | `cross_axis_fill` | `none` |

### Tabs
Child default width: `cross_axis_fill` / height: `cross_axis_wrap`

### TopBar
Child default width: `cross_axis_wrap` / height: `cross_axis_wrap`

## Fallback rules

- Unknown sizing keyword → treat as omitted (use catalog default).
- Unknown alignment → fall back to `topStart` (catalog default).
- Unknown arrangement → fall back to `start` (catalog default).
- Unknown image fit → look up `fit_aliases`, else fall back to `contain`.
- Unknown variant → use `default_variant` from catalog.

These fallbacks are forward-compat: future SDK could ship a new keyword and
old clients degrade gracefully without crashing.

## Per-platform chrome conventions

The catalog encodes layout *contracts*, not platform values. Each renderer
picks its idiomatic value:

| Convention | Phone (M3) | Wear (M3) | ESP32 (LVGL) | Web (CSS) |
|---|---|---|---|---|
| Scaffold body horizontal padding | 16dp | 4dp | panel-dependent | container-aware |
| Top bar height | 56dp (M3) | wear-default | panel-dependent | platform-default |

Reviewers cross-checking visual consistency: if a value in this table changes,
update both the renderer and this doc.

## Conformance fixture obligation

Every fixture row in `shared/protocol/fixtures/layout-resolution/spec.json`
is binding across all 4 renderers (web + phone + wear + ESP32). Adding a
new component or container to the catalog requires adding fixture rows
covering at minimum:

- Default in Column (cross-axis-stretching parent)
- Default in Row (cross-axis-wrapping parent)
- One explicit-keyword override (e.g., `width: 'fill'` overriding the parent default)

`task protocol:test-layout-resolution` runs the fixture against all legs
and fails closed on any disagreement.

## Renderer coverage lint (drift sentinel)

Beyond layout-resolution, every renderer must reference every proto field on
every `ComponentDef` variant — otherwise a wire-declared field silently drops
on that platform (the silent-drop bug class). The static-analysis script
`shared/protocol/scripts/lint-renderer-coverage.py` scans each renderer's
source and reports:

- **Missing dispatch**: a variant that has no `case`/`when` branch.
- **Dropped fields**: a proto field that doesn't appear in the renderer's
  case body (per-renderer case convention: snake_case for Phone/Wear/ESP32,
  camelCase for Web).

Intentional platform divergences (e.g. Wear has no soft keyboard, so
`TextField.keyboard_type` is moot) live in
`shared/protocol/scripts/coverage-allowlist.yaml` with a documented reason.
Every allowlist entry is reviewed at PR time.

Run via `task protocol:lint-coverage`. Not wired as a hard CI gate; humans
run it before merging proto/renderer changes.

Known limitations of static word-matching: false negatives on context-
sensitive drops (e.g. a field referenced in one variant's branch but not
another). Reviewers compensate; the lint catches the broadly-dropped class.

## Adding a new component

When a new `<Name>Component` variant is added to `ComponentDef.component`:

1. Add `<Name>: { width: <kind>, height: <kind> }` to `layout.components` in
   the catalog YAML.
2. If it's a container, add a `layout.containers.<Name>` entry (plain or
   slotted as appropriate).
3. Add fixture rows.

`build-design-system.py` fails closed if step 1 is skipped — every
proto-side component variant MUST appear in `layout.components`.
