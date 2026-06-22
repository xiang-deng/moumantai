# shared/protocol/design-system/ — Claude operational rules

The catalog (`design-system.yaml`) is the **single source of truth** for "what does omit-width mean" across all 4 renderers (phone, Wear, PWA, ESP32). Authors don't hand-tune per-platform; the catalog encodes a pure function over `(parent_kind, slot_index, slot_name, child_kind, child_variant, own_keyword)` that every renderer translates to its native idiom.

## Where to read

- **Face authors (humans + LLMs)** → [`authoring.md`](./authoring.md) — modifier reference, per-component default-behavior table, recipe sheet. Generated.
- **Renderer implementers** → [`rendering.md`](./rendering.md) — algorithm, platform mapping, fallback rules. Generated.
- **Closed-set typed unions** → `from '@moumantai/protocol/design-system/sdk-types'`: `SizeValue`, `Alignment`, `Arrangement`, plus per-component variant unions.

## Recipe cheat-sheet (covers ~90% of authoring)

| Author intent | How to write it |
|---|---|
| Full-width card | `card(id, children)` — default |
| Hero card with corner badge | `box(id, [card(...), badge({align: 'topEnd'})])` — first Box child = background automatically |
| List filling remaining vertical space | `list(id, items, { weight: 1 })` |
| Spacer pushing siblings to ends of a Row | child with `{ weight: 1 }` |
| Centered button | `box(id, [button(...)], { content_alignment: 'center' })` |
| Fixed-width sidebar | `column(id, children, { width: 280 })` |
| Force a normally-stretching component to wrap | `card(id, children, { width: 'wrap' })` |
| Image filling its parent | `image(id, src, { width: 'fill' })` |

## Authoring rules

- **Omit `width` / `height` for the catalog default.** Override only when needed.
- Keywords: `'fill' | 'wrap' | 'grow' | <integer dp>`. No `'auto'` (use omit instead).
- Per-platform chrome (Scaffold body padding, top-bar height) lives in **each renderer**, NOT in the catalog. M3 phone uses 16dp body padding; Wear uses round-watch-chin clearance; ESP32 is panel-dependent.

## Drift prevention

- `task design-system:gen-check` — YAML ↔ generated artifacts ↔ docs ↔ fixtures in lockstep.
- `task test-layout-resolution` (root) — 4-leg conformance harness (server + phone + wear + ESP32 host-mode). `task protocol:test-layout-resolution` runs the server vitest + ESP32 C legs.
- `task protocol:lint-layout` — greps every renderer for layout-imposing modifiers outside the resolver helpers. Allowlist documents legitimate chrome exceptions.

## Adding a new component

Add `<Name>: { width: <kind>, height: <kind> }` to `layout.components` in catalog YAML. If it's a container, add a `layout.containers.<Name>` entry. Codegen + `gen-check` fail closed if a proto variant lacks a catalog row. Full process in [`rendering.md`](./rendering.md).
