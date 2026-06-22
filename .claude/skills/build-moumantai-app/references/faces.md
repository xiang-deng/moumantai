# Faces (`defineFace`)

A face is a full-screen, read-only view of app data. It has a **resolver** that produces a nested object and a **component tree** that binds to it via `pathRef(...)`.

Canonical examples in the repo:
- `apps/diet-tracker/faces/today/` — 3-face app, per-face subdir, compact + expanded variants, shared parts
- `apps/spend-tracker/faces/summary/` — 2-face app (summary + categories), same per-face subdir pattern

Read one of them end-to-end before writing a face. This file states the rules; the apps show the shape.

## Signature

From `server/src/server/agent/types.ts`:

```ts
type FaceResolve = (ctx: {
  db: BetterSQLite3Database
  params: Record<string, unknown>
}) => Record<string, unknown>

interface FaceDefinition {
  id: string                                    // singular, stable ('today', 'history')
  label: string                                 // user-facing ('Today', 'This week')
  position: number                              // 0 = landing face
  kind?: 'compact' | 'expanded'                 // form-factor this face is authored for
  components: ComponentDef[]
  resolve: FaceResolve
  params?: Record<string, ToolParameter>        // optional: typed view-state schema (ToolParameter shape from tools)
  paramsVersion?: number                        // optional: bump on breaking schema change (defaults to 1)
  viewToolDescription?: string                  // required when `params` is declared
}
```

The `kind` field declares the form-factor in code; the file-name suffix is the loader's source of truth.

## Parameterized faces (steerable views)

A face can declare `params` to expose typed view-state the agent can change via chat. The framework auto-registers a tool named `view_<faceId>` with the same parameter schema; the LLM calls it to update which slice the face shows ("show February", "filter to food", "diet for past Tuesday"). Reset = `view_<faceId>({})`.

Rules:
- All params must be **optional** (`required: true` is rejected). The resolver fills defaults via `params.x ?? fallback()`. This keeps `view_<faceId>({})` a clean reset path.
- `paramsVersion` defaults to 1; bump it whenever you make a breaking schema change so stale persisted rows are dropped at app boot.
- The face `id` cannot start with `view_` — and the `view_` prefix is reserved framework-wide, so app-authored tools can't use it either.
- Params describe **how** data is shown, not **what** data exists. Mutations stay in tools; don't smuggle writes through params.

Components can read current view-state from the data tree at `pathRef('/$params/<key>')` — the framework auto-injects validated params under `$params` after the resolver returns. So you can render "Showing April 2026" as a header without any extra plumbing.

Example (spend-tracker summary):

```ts
defineFace({
  id: 'summary',
  label: 'Summary',
  position: 0,
  params: {
    month:    { type: 'string', description: 'YYYY-MM. Defaults to current.' },
    category: { type: 'string', description: 'Category id. Defaults to all.' },
  },
  viewToolDescription:
    'Show monthly spend. Pass `month` (YYYY-MM) and/or `category` (id), or omit either for defaults.',
  resolve: ({ db, params }) => {
    const month = params.month ?? currentMonth()
    const category = params.category ?? null
    // ... query with month + optional category filter
  },
  components: [...],
})
```

Persistence: view-state is keyed on `(conversation_id, app_id, face_id)` in `platform.db`. Each conversation has its own view-state; new conversations start with defaults. Overwrite semantics — the synth tool replaces the row whole, so the LLM sends the full intended state every time.

## Four files per face, one subdirectory

```
faces/today/
  today.resolve.ts     # pure ({db}) => object
  today.parts.ts       # components shared by variants (optional)
  today.compact.ts     # compact variant (≤240dp); mandatory
  today.expanded.ts    # expanded variant — phone / tablet / wide web; mandatory
```

`scanSupplementalFaces` in `app-loader.ts` walks one level into each `faces/<face-id>/` subdir. `parseFaceFile` skips `.resolve.ts` / `.parts.ts`, and maps `<face-id>.<size>.ts` (suffix `compact` | `expanded`) to size-class variants.

Both `<face-id>.compact.ts` and `<face-id>.expanded.ts` are required for every face. Each declares its `kind` explicitly in `defineFace({ kind: 'compact' | 'expanded', ... })`. Authoring two files (not one with branching) forces the author to think about each form-factor's information architecture — watch wants ≤3 visible items / glance-shaped; phone wants density / list-shaped. The framework's renderers translate primitives to native idiom per platform; authors write the IA each form-factor deserves.

The flat layout (`faces/today.ts` at top level) is not supported. Use per-face subdirs.

## Critical rules — canonical home for these

### 1. Root component id MUST be `"root"`

The renderer hard-codes `"root"`:

```ts
scaffold('root', { body: 'content' })   // correct
scaffold('main', ...)                    // renders nothing
```

### 2. Prop keys are `snake_case`

`scaffold`, `topBar`, `listItem`, `list`, and other component builders accept option keys in snake_case: `top_bar`, `trailing_content`, `leading_icon`, `navigation_action`, `horizontal_alignment`. NOT camelCase. The options field is loosely typed so TypeScript does not catch the typo — the slot silently fails to render.

```ts
// Right
scaffold('root', { body: 'content', top_bar: 'top' })
listItem('row', 'headline', { supporting: 'sub', trailing_content: 'icon_right' })

// Wrong — silent failure
scaffold('root', { body: 'content', topBar: 'top' })
listItem('row', 'headline', { trailingContent: 'icon_right' })
```

Builder **function names** are camelCase (`topBar`, `switchToggle`, `dateTimeInput`); only the **option keys inside the second argument** are snake_case.

### 3. Children reference siblings by id string

Every component has a unique id within the face. Parents reference children by those ids:

```ts
column('content', ['total_label', 'total_value', 'recent_list'], { spacing: 8 })

// list: the third arg is the template id — another component in the same array
list('recent_list', '/recent_expenses', 'expense_item'),
listItem('expense_item', pathRef('$.description'), { ... }),
```

The template is instantiated once per row with `$` scoped to that row.

### 4. `pathRef` has two forms

Absolute (resolver output) — starts with `/`:
```ts
pathRef('/summary/total')   // reads resolver.summary.total
pathRef('/recent_expenses') // reads resolver.recent_expenses (array)
```

Template-scoped (current list row) — starts with `$`:
```ts
pathRef('$.description')    // row.description inside a list item template
```

Never use `$.foo` outside a list template — no scope. Never use `/foo` inside a list template to reference row fields — use `$`. Mixing them is the #1 cause of silent empty renders.

### 5. Resolver shape ↔ `pathRef` paths are one contract

If the resolver returns `{ summary: { total: '$10' } }`, a component can use `pathRef('/summary/total')`. Rename the field to `total_display` and every `pathRef` referencing it is silently empty — no error, just blank render. The design doc declares the shape; `validate_face` loads the resolver against your shadow DB and `validate_types` checks the code statically.

### 6. Variants share the resolver

All variant files import from the same `<face-id>.resolve.ts`. Layouts differ; data does not.

## CRITICAL: register only the default in `index.ts`

`AppDefinition.faces: [...]` must contain **only the default face file**. Variants are discovered by the framework's file scan and registered via `registerVariant`. Pushing `.expanded.ts` into the array silently overwrites the compact default (last-wins in `AppEngine.register`) — watches get phone UI.

```ts
// index.ts — RIGHT
import todayFace from './faces/today/today.js'        // default only
faces: [todayFace]

// index.ts — WRONG — phone UI silently wins on watch
import todayFace from './faces/today/today.js'
import todayFaceExpanded from './faces/today/today.expanded.js'
faces: [todayFace, todayFaceExpanded]
```

Variant files still `export default defineFace(...)` with the **same `id`** — the scan keys on the filename suffix, not the code.

The validator flags this. It is the #1 footgun this skill exists to prevent.

## Size-class dispatch

The renderer picks the variant whose sizeClass matches the device, falling back to default:

| File | Treated as |
|---|---|
| `today.ts` | default (serves compact if no `.compact.ts`) |
| `today.compact.ts` | compact (≤240dp; currently Wear) |
| `today.expanded.ts` | expanded (>240dp; phone, PWA, current ESP32 panel) |

Typical app: `today.compact.ts` + `today.expanded.ts`. Both variants are mandatory for every face (see SKILL.md).

## Compact-first (≤240dp constraints)

Default variant must work at widths from a 192dp watch through a 240dp small peripheral:

- No TopBar — `scaffold('root', { body: 'content' })`, body slot only.
- Tight spacing: `column(..., { spacing: 8 })`.
- Prefer `progress(..., { variant: 'circular' })` over linear.
- Avoid wide `row`s — watch auto-wraps >2 children to a column.

The expanded variant for phones adds TopBar + wider spacing. Don't invert — phone-first → watch subtraction breaks.

## `position` ordering

Faces on an app are sorted by `position` ascending. Start at 0. 0 is where the user lands.

## What NOT to put in a face

- Mutations. Faces are read-only; actions fire server events that invoke tools.
- Business logic beyond shaping data. Extract domain math into helpers; keep resolvers thin.
- `await`. `FaceResolve` is sync; Drizzle `.get()` / `.all()` / `.run()` are sync.

## Validation

`validate_face({ face_id })` fresh-loads the face, walks its component graph, and runs the resolver against your shadow DB — call it after every face edit. `validate_types` then checks the code statically. (Runnable integration/E2E tests are not authored in the draft in v1.)

## Source of truth

- `server/src/server/agent/types.ts` — `FaceDefinition`, `FaceResolve`.
- `server/src/server/agent/app-loader.ts` — `scanSupplementalFaces`, `parseFaceFile`.
- `server/src/server/agent/app-engine.ts` — `register` vs `registerVariant` semantics.
- The `validate_face` / `validate_types` MCP tools — the rules above are enforced at validation time.
- `apps/diet-tracker/faces/today/` — canonical per-face subdir with shared resolver and parts.
- `apps/spend-tracker/faces/summary/` — canonical per-face subdir with compact + expanded + shared parts.
