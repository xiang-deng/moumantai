# Moumantai Wear OS Client

Watch client written in Kotlin + Wear Compose Material 3. Same wire protocol as the phone client; the renderer is wear-specific (round-screen geometry, `TransformingLazyColumn`, `EdgeButton`).

## Prerequisites

- **JDK 17** — provisioned by mise (`mise install` at repo root).
- **Android SDK** — same install as the phone client; set `ANDROID_HOME` in `.mise.local.toml` (copy from `.mise.local.toml.example` at the repo root). `sdk.dir` is read from that env var.
- A **round Wear AVD** (e.g. `Wear_OS_XL_Round`, 384×384) — create via Android Studio's Device Manager.

| Stack item | Version |
|---|---|
| Kotlin | 2.0.21 |
| Wear Compose Material 3 | 1.6.1 |
| Compose BoM (shared foundation) | 2024.01.00 (older than the phone client — pinned for Wear Compose M3 1.6 / JVM 11 compat) |
| Android Gradle Plugin | 8.7.3 |
| compileSdk | 36 |
| targetSdk | 34 (Wear platform level cap) |
| minSdk | 30 |

`targetSdk = 34` is intentional: the Wear platform's API level is currently capped below the phone's; bumping it to 36 would invalidate the platform-level guarantees.

## Build & install

Run from the repo root:

```bash
task wear-os:build          # assembles a debug APK
task wear-os:install        # installs on a connected Wear device / running watch emulator
task wear-os:test           # JVM unit tests (wire roundtrip, layout resolution, form semantics)
task wear-os:clean          # gradle clean
```

The watch APK shares `applicationId = "com.moumantai.client"` with the phone client so that Wear OS treats the pair as one app (`com.moumantai.wear` is the namespace, but the install ID is shared). If you want both APKs side-by-side on the same physical phone, that is the only ID conflict you'll see.

## Configure the server URL

Defaults to `ws://10.0.2.2:3000` (host-machine loopback for the Android emulator). To target a physical watch on your LAN, edit the URL through the watch's in-app settings — the value is persisted in DataStore.

## Pairing

Pairing is on by default — the server only accepts allowlisted devices. On first connect the watch shows a **pairing code**. Approve it from the checkout:

```bash
task server:cli -- device approve <code>   # <code> is shown on the watch
```

Or open a timed enrollment window with `task server:cli -- device pair`, then type `approve <code>` at its prompt. See the root [Quick start](../../README.md#quick-start).

## Face rendering

Wear displays report a compact size class, so the server selects each app's
`*.compact.ts` face variant. App authors define that variant through the
[`build-moumantai-app`](../../.claude/skills/build-moumantai-app/) skill; the
Wear renderer owns round-screen geometry, rotary scrolling, `TimeText`, and
the translation of `BodyKind.LIST` and primary actions into native Wear
components.

## See also

- [`clients/android/`](../android) — sibling phone client.
- [`shared/protocol/spec.md`](../../shared/protocol/spec.md) — wire-protocol SSOT.
- [`shared/protocol/design-system/rendering.md`](../../shared/protocol/design-system/rendering.md) — cross-client renderer contract.
