# shared/tokens — design tokens

Two YAML profiles drive every client's visual constants. `scripts/generate-tokens.py`
emits per-target files into each client's `generated/` dir — never hand-edit them.

## Profiles

| File | Applies when | Drives |
|---|---|---|
| `compact.yaml` | server-classified `SIZE_CLASS_COMPACT` (device width ≤ 240dp) | Wear-OS, future watch-class peripherals |
| `expanded.yaml` | `SIZE_CLASS_EXPANDED` (device width > 240dp) | Android phone, PWA, ESP32 |

ESP32 uses *expanded* despite its small panel: the server classifies by
wire-reported width (320dp > 240dp → EXPANDED), and 240dp is the only
breakpoint. Compact is reserved for true watch-class peripherals (≤ 240dp).

## Token categories

**Scoped** values may differ per profile; **Invariant** values MUST match across
profiles. Enforced by `scripts/test-token-shape.py`.

| Category | Kind | Holds |
|---|---|---|
| `typography` | Scoped | M3 type-scale sizes |
| `spacing` | Scoped | `xs`/`s`/`m`/`l`/`xl` step scale |
| `sizing` | Scoped | per-component dims (`buttonHeight`, `chipHeight`, `iconSize`, …) |
| `typographyLineHeight` | Invariant | per-role line-height ratios (sizes are scoped; ratios are not) |
| `shape` / `shapeAlias` | Invariant | primitive scale + per-component aliases |
| `elevation` | Invariant | M3 elevation levels |
| `motion` | Invariant | `durationShort/Medium`, `easingStandard` |
| `state` | Invariant | state-layer opacities (`disabled`, `hover`, `focus`, …) |
| `color` | Invariant | M3 dark scheme |
| `zIndex` | Invariant | PWA z-layer scale |

## Generator targets

`scripts/generate-tokens.py` emits five files across four targets (Android gets
both Compact and Expanded). Hand-edits are overwritten on every regen.

| Target | File | Format |
|---|---|---|
| PWA | `clients/pwa/src/generated/tokens.css` | `--moumantai-*` CSS custom properties, expanded profile only |
| Android | `clients/android/.../generated/{Compact,Expanded}Tokens.kt` | Kotlin `object` of `const val` ints/floats (sizes unitless dp/sp, colors `0xAARRGGBB`); the theme layer wraps them in `Dp`/`Sp`/`Color` |
| Wear-OS | `clients/wear-os/.../generated/CompactTokens.kt` | Same shape as Android Compact — Wear is compact-only |
| ESP32 | `clients/esp32/components/renderer/include/generated_tokens.h` | `#define` integers; opacities scaled 0-255; elevation as an `extern const` array of 3-tuples (`width, ofs_y, opa`), defined in `style_helpers.c` |

Regenerate after any YAML edit (wraps `scripts/generate-tokens.py`):

```bash
task tokens
```

## Drift guards

| Check | Catches | Run via |
|---|---|---|
| `scripts/test-token-shape.py` | Profile-shape mismatch (compact adds a key without expanded; invariant value diverges) | `task lint:tokens` |
| `task design-system:gen-check` | Component catalog out of sync with proto | pre-merge checklist |
| Per-client tests | Theme wiring missed a new dimension | `task <client>:test` |

`task lint:tokens` is in the pre-merge checklist (`shared/protocol/CLAUDE.md`).
Profile-parity breaks don't surface in `protocol:gen-check` — only here.

## How to add a token

1. Decide scoped vs. invariant: if the value changes between watch and phone, it's scoped; otherwise invariant. (Touch heights = scoped; M3 elevation values = invariant.)
2. Add the key to BOTH `compact.yaml` and `expanded.yaml`. Invariant categories: same value in both.
3. Extend `scripts/generate-tokens.py` to emit to every target (CSS, Kotlin, ESP32 `#define`, Wear).
4. Run `task tokens`.
5. Wire the token in each client's theme (Android `DimensionProfile`, Wear `WearAppTheme`/`WearToken*` in `WearTheme.kt`, ESP32 `style_helpers.h`).
6. `task lint:tokens` + `task <client>:test` to confirm parity + wiring.

## How to add a SizeClass

The proto `SizeClass` enum has two real classes today (`SIZE_CLASS_COMPACT = 1`, `SIZE_CLASS_EXPANDED = 2`; `SIZE_CLASS_UNSPECIFIED = 0`). Adding a third (e.g. `LARGE` for split-pane tablet/desktop):

1. Add `SIZE_CLASS_LARGE = 3;` (next free value) to `enums.proto`.
2. `task protocol:gen`.
3. Update `classifyWidth` in `server/src/server/transport/ws-server.ts`.
4. Add `shared/tokens/large.yaml`; update both other profiles for shape parity.
5. Extend `generate-tokens.py` to emit a third profile per target.
6. Update each client's theme to branch on the new enum.
