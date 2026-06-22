# `$form` scope — type contract across clients + server

## Purpose

`$form` is the per-face client-side scope that input components write to when
the user interacts with them. The scope is the only authority for "what value
will be sent when the user fires this face's action" — it shows up as
`pathRef('/$form/<id>')` placeholders inside `Action.args`, which the action
dispatcher resolves at send time and forwards to the server as an
`InvokeToolMsg`.

The contract documented here is what every renderer (PWA, Android, Wear,
ESP32) and the server validator must agree on. It exists because the wire
protocol locks message *shape* but not the *runtime types* a client must
write into `$form` per-widget — and a four-client surface with no pinned
contract drifts silently. This doc + the conformance test in §5 are the lock.

## Lifecycle

- **Per-face.** Each face has its own `$form`. Component IDs are unique within a face.
- **Server never authors `$form`.** Only client-side input renderers and the
  user's interactions write here; `update_face` events do not touch `$form`.
- **Survives face refresh.** When the server pushes an `update_face` for a
  face the user is currently viewing, `$form` is preserved verbatim. This is
  what lets a half-typed value survive a server-side data refresh.
- **Cleared on navigation.** When the user navigates away from a face,
  `$form` for that face is dropped. On return, the face starts with an empty
  `$form` (and inputs read their default-bound values, see §4).

## Component → `$form` value-type matrix

When an input component is authored without an explicit `action`, its
default binding is `pathRef('/$form/<id>')`. The renderer reads/writes that
same path. Each widget writes its **natural** runtime type:

| Component (proto) | Builder (`server/src/server/protocol/components/input.ts`) | `$form` value type |
|---|---|---|
| `text_field` | `textField` (line 78) | `string` |
| `check_box` (no `action`) | `checkBox` (line 91) | `boolean` |
| `switch_toggle` (no `action`) | `switchToggle` (line 103) | `boolean` |
| `slider` (no `action`) | `slider` (line 112) | `number` (double) |
| `tabs` (no `action`) | `tabs` (line 121) | `number` (selected index) |
| `select` (no `action`) | `select` (line 138) | `string` (selected value) |
| `date_time_input` (no `action`) | `dateTimeInput` (line 148) | `string` (renderer is read-only today; binding wired but unused) |

When an input has an `action` set, it fires the action on change and does
**not** write to `$form` (the action carries the value via `itemScope` /
explicit args).

`text_field` writes `string` regardless of `keyboard_type`. The widget
keyboard hint (`'number'`, `'decimal'`, `'email'`, etc.) only changes the
on-screen keyboard layout, **not** the captured value type. Type coercion
happens once at the server validator (see §4), not per-renderer.

## Action dispatch + path resolution

When the user fires an `Action` (e.g. taps a `Button`):

1. The renderer calls the per-client dispatcher with `(Action, itemScope?)`.
2. The dispatcher walks `Action.args` and substitutes every
   `{path: "..."}` placeholder. Path forms:
   - `/$form/<id>` → look up `$form[<id>]` (this scope).
   - `$.field` or bare `field` → look up in `itemScope` (list-row context).
   - `/...` → JSON-Pointer into the face's data model.
3. Substitution is **verbatim**. The dispatcher does not coerce types.
   Whatever `$form` holds is what reaches the wire frame.
4. The dispatcher generates a fresh `client_request_id` (UUID) per
   invocation and sends an `InvokeToolMsg{tool_name, args, source_face_id,
   client_request_id}`.

## Server: type coercion at the validator (the boundary)

The server's `executeTool` (`server/src/server/agent/tool-executor.ts`) is
the **single type-translation boundary**. UI invocations route through
`validateAndCoerceUIArgs`, which coerces strings to the declared tool-param
type using a fixed matrix:

| Tool param `type` | Accepted source types | Coercion |
|---|---|---|
| `number` | `number`, finite numeric string (`Number(s)` is finite) | `Number(s)` |
| `boolean` | `boolean`, `'true'` / `'false'` (literals only) | direct map |
| `string` | `string` only | none |

The validator returns one of three outcomes for UI invocations:

- **`ok`** — every required param is present and well-typed; coerced args proceed to the tool.
- **`missing`** — one or more required params are unset / `null` / empty string. The handler escalates to a chat dialog with the agent (see `action-handler.ts:escalateMissing`) instead of erroring; the user is asked for the values via chat. Empty string counts as missing because `$form` writes `''` when a text field is cleared, and asking-in-chat is the better UX than a "Missing required parameter" toast for a blank form.
- **`error`** — a present param failed type/coercion (NaN, `'twelve'` for number, `'yes'` for boolean, etc.). Surfaces as a normal `ServerMessage.error` with `tool_validation`. The shape was wrong, not absent.

The strict, LLM-direct path (`validateParamsAgainstSchema`, also called via `executeTool` with `isUIInvocation: false`, the default) folds `missing` into `error` so the LLM never accidentally triggers escalation. Only `action-handler` calls `executeTool` with `{ isUIInvocation: true }`.

The pure `validateParamsAgainstSchema` (also in `tool-executor.ts`) stays
strict — no coercion. It is used **only** by paths where args are already
natively typed:

- LLM tool calls via the Anthropic SDK (args arrive as JSON of correct types).
- Persisted face params validated by `face-params-store.ts:116` on schema
  drift.

The split is intentional: UI inputs route through `$form` which can only
produce textual values for some widgets, so coercion is required at the
boundary where the runtime types of `Action.args` first meet the typed tool
schema. Everywhere else, types are guaranteed by construction; staying
strict catches accidental drift.

## Error-UX requirement

A `ServerMessage.error` with `tool_validation` (or any other code) reaching
a client renderer **must** be visibly surfaced to the user — toast,
snackbar, or inline banner. Silent failure is a contract violation, because
it makes the "click does nothing" failure mode indistinguishable from a
broken transport, and it hides the only signal the user has that an
intent didn't land.

| Client | Surface |
|---|---|
| PWA | Toast overlay (auto-dismiss) — see `clients/pwa/src/Toast.tsx` |
| Android | `_transientNotice` SharedFlow → `SnackbarHost` mounted in the top-level Scaffold |
| Wear | `_transientNotice` StateFlow → inline banner overlay, `LaunchedEffect` auto-clears |
| ESP32 | not implemented — documented in `clients/esp32/spec.md` "Known Limitations" |

## Conformance

Any new client renderer (or rewrite of an existing one) must pass the
cross-client conformance harness driven from
`shared/protocol/fixtures/form-semantics/`. Fixtures define
`(face_json, user_input, expected_invoke_tool_msg_json)` triples; each
client's harness drives the fixture's user input through the renderer +
dispatcher and asserts byte-identical wire output. Server-side, the
captured `InvokeToolMsg` is round-tripped through `validateAndCoerceUIArgs`
to assert the coerced tool args match the fixture's expected typed shape.

Run via `task protocol:test-form-semantics`. Drift in either direction
(client renderer or server validator) breaks the test.
