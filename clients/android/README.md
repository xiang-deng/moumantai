# Moumantai Android Client

Phone client written in Kotlin + Jetpack Compose Material 3. Connects to the Moumantai server over WebSocket and renders server-driven UI.

## Prerequisites

- **JDK 17** — provisioned by mise (`mise install` at repo root).
- **Android SDK** — install Android Studio, or use `sdkmanager` (`platform-tools`, `platforms;android-36`, `build-tools;36.0.0`).
- Set `ANDROID_HOME` to your SDK location in `.mise.local.toml` (copy from `.mise.local.toml.example` at the repo root). Gradle reads `sdk.dir` from this env var; you do not need to commit `local.properties`.

| Stack item | Version |
|---|---|
| Kotlin | 2.0.21 |
| Compose M3 (BoM) | 2024.10.01 |
| Android Gradle Plugin | 8.7.3 |
| compileSdk | 36 |
| targetSdk | 36 |
| minSdk | 28 |

## Build & install

Run from the repo root:

```bash
task android:build          # assembles a debug APK
task android:install        # installs on the connected device / running emulator
task android:test           # JVM unit tests — Wire (protobuf) roundtrip, layout resolution, form semantics
task android:clean          # gradle clean
```

To run the on-device E2E (`run-e2e-tests.sh`), you must have an AVD created. The default is `Small_Cover_Screen`; override cross-shell with:

```bash
task android:e2e AVD_NAME=<your-avd>
```

## Configure the server URL

The config screen is the **leftmost page** of the pager (page 0) — swipe all the way left to reach it.

| Scenario | Server URL | How |
|---|---|---|
| Emulator (default) | `ws://10.0.2.2:3000` | Nothing to do — `10.0.2.2` is the emulator's loopback to your host running `task server:dev`. |
| Physical device | `ws://<host-LAN-IP>:3000` (e.g. `ws://192.168.1.100:3000`) | Swipe to the config page (page 0), enter the URL. Persisted in DataStore. |
| Genymotion / non-emulator VM | `ws://<host-LAN-IP>:3000` | Same as physical device. |

## Pairing

Pairing is on by default — the server only accepts allowlisted devices. On first connect the app shows a **pairing code** and the command to run. Approve it from the checkout:

```bash
task server:cli -- device approve <code>   # <code> is shown on the device
```

Or open a timed enrollment window with `task server:cli -- device pair`, then type `approve <code>` at its prompt. See the root [Quick start](../../README.md#quick-start) for the full flow.

## Layout resolution + conformance

Android participates in the cross-renderer conformance corpus under `shared/protocol/fixtures/`. The full suites run from the **repo root** — they drive several clients at once, not just Android:

```bash
task test-layout-resolution    # server + Android + Wear + ESP32
task test-form-semantics       # server + Android + Wear (no ESP32)
```

## See also

- [`clients/wear-os/`](../wear-os) — sibling watch client; shares `applicationId` so installing both treats them as one Wear-pair app.
- [`shared/protocol/spec.md`](../../shared/protocol/spec.md) — wire-protocol SSOT.
- [`CLAUDE.md`](../../CLAUDE.md) — repo-level conventions.
