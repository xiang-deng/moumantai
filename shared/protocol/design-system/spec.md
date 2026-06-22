# shared/protocol/design-system

`design-system.yaml` is the single source of truth for every renderer's
component dictionary: variants, kinds, accents, alignments, arrangements,
image fit modes, and layout-default resolution rules. The wire format stays
free-form `string` (per `shared/protocol/spec.md` rule 7) — this directory
is the renderer-side dictionary every platform translates from.

## Where to read the rules

| You are a... | Read |
|---|---|
| Face author (LLM or human) | [authoring.md](authoring.md) — modifier reference, per-component defaults, recipe sheet |
| Renderer implementer | [rendering.md](rendering.md) — algorithm, platform mappings, fallback rules, conformance |
| Both | The catalog YAML is the SSOT; both specs are auto-generated from it |

## Layout

```
shared/protocol/design-system/
├── design-system.yaml      ← SSOT (this directory)
├── authoring.md            ← generated; for face authors
├── rendering.md            ← generated; for renderer implementers
├── spec.md                 ← this file (pointer)
└── generated/              ← codegen outputs of build-design-system.py
    ├── design-system.ts    ← TS module (server + web import)
    ├── DesignSystem.kt     ← Kotlin object (Android + Wear import)
    ├── design_system.{h,c} ← C bindings (ESP32)
    ├── design-system.css   ← CSS variant rules (web)
    └── sdk-types.ts        ← Typed unions for server SDK
```

Run `task design-system:gen` to regenerate every output. Outputs are
deterministic; `task design-system:gen-check` verifies they match the
source-of-truth YAML on every PR.

## Constraints

- **No hand-editing generated files.** All generated outputs (in
  `generated/`, plus `authoring.md` and `rendering.md`) are emitted by
  `scripts/build-design-system.py` and verified clean by gen-check.
- **No new wire schema for styling values.** The catalog is renderer-side
  + author-side only; the proto's `string`-typed style fields keep
  forward-compat for LLM-authored faces.
- **Catalog is alphabetically sorted** for commit stability.
