# shared/protocol — Wire protocol SSOT

## Purpose

`shared/protocol/proto/moumantai/v1/*.proto` is the single source of truth for
the Moumantai WebSocket wire protocol: lifecycle messages, the 25-component UI
vocabulary, action dispatch primitives, and every shared enum. Language bindings
for TypeScript / Kotlin / C are generated and committed to git. Two small
hand-written modules sit alongside the generated bindings: `scope.ts` (three
scope-string helpers for internal keys that never cross the wire) and
`binary-frame.ts` (parse/encode helpers for the binary-frame envelope).

## Layout

```
shared/protocol/
├── proto/                          ← .proto SSOT
│   ├── buf.yaml
│   ├── buf.gen.yaml
│   └── moumantai/v1/
│       ├── envelope.proto          ClientMessage / ServerMessage oneofs
│       ├── lifecycle.proto         hello / hello-ok / ack / error / reset
│       ├── chat.proto              ChatMessage / ChatWindow / VoiceState / Audio + Image chunk headers
│       ├── apps.proto              AppList / FaceList / FaceUpdate / Navigate / Viewing
│       ├── drafts.proto            DraftSummary / DraftStateChanged + preview / reload / promote / discard / turn-cancel requests
│       ├── components.proto        ComponentDef oneof + 25 typed components
│       ├── actions.proto           ActionDef + LocalOp variants + Condition + RepeatConfig
│       ├── dynamic.proto           DynamicString / DynamicBool / DynamicInt32 / DynamicDouble
│       ├── enums.proto             every shared enum
│       └── nanopb.options          per-field max_size constraints for ESP32
├── src/
│   ├── scope.ts                    ← three scope-string helpers
│   ├── binary-frame.ts             ← parse/encode binary frames (proto headers)
│   ├── index.ts                    ← re-exports above; `./generated/moumantai/v1` via package exports
│   └── generated/moumantai/v1/        ← protobuf-es output (committed)
├── fixtures/
│   ├── fixtures.spec.json          (dir, message-type) corpus index
│   └── <message_dir>/<variant>.json
└── scripts/
    └── fixture-roundtrip.ts        TS leg of the cross-language test
```

Generated outputs in **other workspaces**:

| Path | Generator |
|---|---|
| `shared/protocol/src/generated/moumantai/v1/*.ts` | `buf generate` (protobuf-es); package = `moumantai.v1` |
| `clients/android/app/src/main/java/com/moumantai/protocol/v1/*.kt` | Wire Gradle plugin; package = `com.moumantai.protocol.v1` (via `option java_package`) |
| `clients/wear-os/app/src/main/java/com/moumantai/protocol/v1/*.kt` | Wire Gradle plugin; package = `com.moumantai.protocol.v1` |
| `clients/esp32/components/transport/generated/proto/moumantai/v1/*.{pb.h,pb.c}` | `nanopb_generator.py`; types prefixed `moumantai_v1_*` |

**Per-language package naming:** every `.proto` declares `package moumantai.v1;` (TS + C) and `option java_package = "com.moumantai.protocol.v1";` (Kotlin, consumed by Wire). Standard protobuf multi-language pattern.

Every generated file carries the leading line
`// AUTO-GENERATED from shared/protocol/proto/ — do not hand-edit`.

## Workflow

```
1. Edit a .proto file under shared/protocol/proto/moumantai/v1/
2. task protocol:gen           ← regenerate all 4 language outputs
3. Review the diff             ← TS / Kotlin / C should all change in lockstep
4. task protocol:lint          ← STANDARD-rules enforcement
5. task protocol:test-cross-language   ← TS + Kotlin byte-equality
6. task <client>:build / typecheck     ← consumers compile cleanly
7. Commit .proto + generated files together
```

`task protocol:gen-check` (run from CI) re-runs codegen and diffs against the
working tree; nonzero exit on any drift.

## Available tasks

| Task | Effect |
|---|---|
| `task protocol:gen` | Regenerate every language binding (TS + ESP32 C + Android Kotlin + Wear Kotlin) |
| `task protocol:gen-fast` | TS + C only (skip Wire/Gradle for fast iteration) |
| `task protocol:gen-check` | Fail if any committed generated output is stale |
| `task protocol:lint` | `buf lint` over `proto/` (STANDARD rules) |
| `task protocol:format` | `buf format -w` (canonical .proto formatting) |
| `task protocol:format-check` | Fail if any .proto is non-canonical |
| `task protocol:breaking` | `buf breaking` against master (additive-only enforcement) |
| `task protocol:test-cross-language` | TS / Android Kotlin / Wear Kotlin all round-trip every fixture; assert byte-identical |
| `task protocol:test-form-semantics` | Cross-client conformance for `$form` ↔ tool-param contract — see [`FORM_SCOPE.md`](./FORM_SCOPE.md) |
| `task protocol:typecheck` | TypeScript no-emit check over the protocol workspace |

## `$form` scope contract

The cross-client runtime type contract for input components (what each
renderer writes into `$form`, how the server coerces it to typed tool
params) lives in [`FORM_SCOPE.md`](./FORM_SCOPE.md). Conformance:
`task protocol:test-form-semantics`.

## Schema-evolution rules

1. **Additive only.** Never remove a field or change its number; never repurpose a tag. `buf breaking` enforces.
2. **One canonical definition per shared type.** Every type is declared once under `proto/moumantai/v1/`. Don't duplicate enum values to avoid an import.
3. **Use `optional` for every nullable scalar.** Distinguishes "unset" from "default-zero" in proto3.
4. **`oneof` discipline:**
   - The 25-component `ComponentDef.component` oneof is locked — no new variants without a coordinated update of every renderer (TS / Android / Wear / ESP32).
   - `ClientMessage.payload` and `ServerMessage.payload` may grow with new message types; existing tags must never change.
5. **Field naming on the wire is `snake_case`.** Codegen translates per-language (protobuf-es → lowerCamelCase JSON, Wire → auto jsonName, nanopb → proto3 JSON). **No manual `[json_name = ...]` overrides** — all four languages align automatically.
6. **Enums use proto-style `SCREAMING_SNAKE_CASE` values prefixed with the enum name** (`TURN_STATUS_COMPLETED`, `CHAT_ROLE_ASSISTANT`). The `0` value is always the explicit `*_UNSPECIFIED` sentinel.
7. **No enum for LLM-authored values.** Closed enums only for protocol-controlled values: DeviceClass, DeviceShape, SizeClass, TurnStatus, ChatRole, VoiceStateValue, AudioFormat, ProtocolErrorCode, CloseCode, BinaryFrameType, BodyKind. Styling values (typography, font_weight, text_align, variant, image fit, alignments, keyboard_type, picker mode, progress variant, color, spacing) and MIME types are free-form `string` so plugin apps + LLM-authored faces can use bespoke values without a schema bump.
8. **`repeated` of scalars / enums must be marked `[packed = true]`.** Wire's Kotlin codegen defaults to non-packed; protobuf-es follows the proto3 default of packed. Forcing `[packed = true]` keeps the wire form identical across all four languages. `buf lint` does not catch this; cross-language fixture round-trip does.
9. **Kotlin reverse-domain via `option java_package`.** Every `.proto` declares `option java_package = "com.moumantai.protocol.v1";`. Wire emits Kotlin at that package; protobuf-es and nanopb ignore it.
10. **Layout-default resolution is catalog-driven, not heuristic.** When a component's `Modifier.width` / `Modifier.height` is unset, the renderer MUST resolve the size by calling the generated `resolveChildWidth` / `resolveChildHeight` from the design-system catalog (`shared/protocol/design-system/design-system.yaml`'s `layout:` block). Renderers MUST NOT pattern-match face structure or invent width-fill rules in component code. Conformance: `task test-layout-resolution`. Adding a new component to `ComponentDef.component` requires a `layout.components.<Name>` row; codegen fails closed if missing.

## Cross-language test orchestration

`scripts/test-cross-language.py` drives the round-trip:

1. **TS leg** (`shared/protocol/scripts/fixture-roundtrip.ts`): `fromJson` → `toBinary` → write `<fixture>.ts.bin`.
2. **Android Kotlin leg** (`clients/android/.../FixtureRoundTripTest.kt`): read `.ts.bin`, decode via Wire's `ProtoAdapter`, re-encode, assert match, write `.kotlin.bin`.
3. **Wear-OS Kotlin leg**: same shape as Android, against the wear-os Wire classes.
4. **C leg**: host-mode nanopb runner. Skipped with a warning when no host C compiler is on PATH.

The orchestrator byte-compares every `.ts.bin` against every `.kotlin.bin` (and `.c.bin`); divergence fails the run.

## Adding a fixture

1. Pick the right `<message_dir>` (or create one and add it to `fixtures.spec.json`).
2. Author a `.json` file using the **lowerCamelCase** JSON form (matches `protobuf-es`'s `toJson()`). Closed-enum values (DeviceClass, ChatRole, TurnStatus, etc.) are `SCREAMING_SNAKE_CASE`. Component-styling values are lowercase strings matching the existing TS builders (e.g. `"typography": "headlineMedium"`, `"variant": "filled"`). `int64` fields are strings (per proto3 JSON spec).
3. Run `task protocol:test-cross-language` to verify TS + Kotlin agree.

## Constraints

- All schema files use `syntax = "proto3"`.
- `package moumantai.v1` everywhere.
- `optional` is required on every nullable scalar (proto3.15+).
- The 25-component `ComponentDef.component` oneof is locked. Adding a new component requires a coordinated `.proto` PR + codegen + every-renderer update across 4 clients.
- Plugin apps under `apps/` author their UI via the server's `protocol/components/` builders, which already construct typed `ComponentDef` messages.
- Free-form data (face data model, plugin-app DBs, LLM tool params) remains `google.protobuf.Struct` — same flexibility as today's `additionalProperties: true` JSON shape.
- `nanopb.options` is required at `proto/moumantai/v1/nanopb.options` — controls per-field `max_size` for ESP32 static allocation. Use proto-path syntax (`moumantai.v1.ChatMessage.text max_size:1024`); the `*` glob form does not work.

## Example

```proto
// proto/moumantai/v1/lifecycle.proto excerpt
message ClientHello {
  DeviceClass device_class = 1;
  DeviceProfile device_profile = 2;
  optional string current_app_id = 3;
  optional string current_face_id = 4;
  optional string device_id = 5;
}
```

```typescript
// TypeScript consumer
import { fromJson, toBinary } from '@bufbuild/protobuf'
import { ClientHelloSchema } from '@moumantai/protocol/generated/moumantai/v1'

const hello = fromJson(ClientHelloSchema, {
  deviceClass: 'DEVICE_CLASS_PHONE',
  deviceProfile: { width: 390, height: 844, shape: 'DEVICE_SHAPE_RECT' },
})
const wire = toBinary(ClientHelloSchema, hello)
```

```kotlin
// Kotlin consumer (Android / Wear)
import moumantai.v1.ClientHello
import moumantai.v1.DeviceClass
import moumantai.v1.DeviceProfile
import moumantai.v1.DeviceShape

val hello = ClientHello(
  device_class = DeviceClass.DEVICE_CLASS_PHONE,
  device_profile = DeviceProfile(390, 844, DeviceShape.DEVICE_SHAPE_RECT),
)
val wire = ClientHello.ADAPTER.encode(hello)
```

## Debug tooling

### `scripts/wscat-protobuf.ts`

Interactive WebSocket debug tool (`Sec-WebSocket-Protocol: moumantai.v1.proto`).
Decodes every server frame to `protobuf-es` JSON and pretty-prints to stdout.
Reads JSON from stdin (one envelope per line), encodes via `fromJson` + `toBinary`, and sends.

```bash
task server:dev
task server:wscat -- ws://localhost:3000/ws

# Skip auto-hello and drive the handshake manually:
echo '{"hello":{"deviceClass":"DEVICE_CLASS_PHONE","deviceProfile":{"width":390,"height":844,"shape":"DEVICE_SHAPE_RECT"}}}' \
  | task server:wscat -- ws://localhost:3000/ws --no-hello
```

JSON follows the proto-JSON envelope form: lowerCamelCase fields, SCREAMING_SNAKE_CASE enums.
Use for: debugging mis-encoded client frames, verifying codegen round-trips, inspecting wire `seq`.

## Dependencies

- `node_modules/@bufbuild/buf` — the Buf CLI (npm devDependency, version pinned)
- `node_modules/@bufbuild/protoc-gen-es` — TS code generator (npm devDependency)
- `node_modules/@bufbuild/protobuf` — TS runtime (Vitest, server, PWA)
- `.venv/Scripts/nanopb_generator.exe` — nanopb code generator (uv-managed Python dep)
- Wire Gradle plugin `com.squareup.wire` 5.1.0 (Android + Wear)
- Wire runtime `com.squareup.wire:wire-runtime:5.1.0` (Android + Wear)
- nanopb ESP-IDF Component Manager dep `nikas-belogolov/nanopb ^1.0.0`

Versions: `shared/protocol/package.json` (npm), `app/build.gradle.kts` ×2 (Wire),
`components/transport/idf_component.yml` (nanopb). No single versions file — grep all four.
