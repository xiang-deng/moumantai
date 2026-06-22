# Moumantai ESP32 Client

ESP-IDF + LVGL client for the [CrowPanel Advance 3.5" HMI](https://www.elecrow.com/pub/wiki/CrowPanel_Advance_3.5-HMI_ESP32_AI_Display.html) (ESP32-S3).

Connects to the Moumantai server over WiFi/WebSocket and renders server-driven UI faces on the 3.5-inch touch panel.

## Hardware

- **Board:** CrowPanel Advance 3.5" HMI ([GitHub](https://github.com/Elecrow-RD/CrowPanel-Advance-3.5-HMI-ESP32-S3-AI-Powered-IPS-Touch-Screen-480x320))
- **MCU:** ESP32-S3-WROOM-1-N16R8 (16MB flash, 8MB PSRAM)
- **Display:** 3.5" IPS 320x480 (ILI9488, SPI, 18-bit color)
- **Touch:** Capacitive (GT911, I2C addr `0x5D`; `0x14` on alternate strapping)
- **Connectivity:** WiFi 2.4GHz, BLE 5.0

## Prerequisites

Install ESP-IDF v5.4+:

```powershell
# Option A: via Espressif Installation Manager (recommended)
winget install Espressif.EIM-CLI
eim install -i v5.4 -t esp32s3 -p C:\esp

# Option B: manual
git clone -b v5.4 --recursive https://github.com/espressif/esp-idf.git C:\esp\esp-idf
cd C:\esp\esp-idf && .\install.ps1 esp32s3
```

Activate in every terminal session (use the path that matches your install — EIM/Option A nests by version, the manual clone/Option B does not):

```powershell
. C:\esp\v5.4\esp-idf\export.ps1    # PowerShell (EIM/Option A; manual clone → C:\esp\esp-idf)
# or: C:\esp\v5.4\esp-idf\export.bat  # cmd.exe
```

Also set `IDF_PATH` and `PORT` in `.mise.local.toml` at the repo root (copy from `.mise.local.toml.example`); `IDF_PATH` must match the path you activated above:

```toml
[env]
IDF_PATH = "C:/esp/v5.4/esp-idf"   # EIM/Option A; manual clone → C:/esp/esp-idf
PORT     = "COM3"                  # COM port on Windows, /dev/ttyUSB0 on Linux, /dev/cu.usbserial-XXXX on macOS
```

### Windows + MSys2 / git-bash users — required

ESP-IDF refuses to run under MSys/git-bash. Use the bundled wrapper, which strips `MSYSTEM` from the env and prepends the IDF tool paths:

```bash
# Set this once for every esp32 task invocation under MSys / git-bash:
export IDF_PY="python tools/run_idf.py"
# (Or set IDF_PY in your shell rc.) The Taskfile honors this env var.
```

The wrapper lives at `clients/esp32/tools/run_idf.py`; PowerShell and Linux/macOS shells don't need it.

### Optional: fonts pipeline

`task esp32:fonts` rebuilds the unified LVGL font (Inter + Material Symbols + emoji + CJK). It requires `lv_font_conv` on PATH:

```bash
npm install -g lv_font_conv
```

Without this step icons fall back to rounded text chips — useful, but visually different.

## Quick Start

Run from the repo root. `PORT` comes from `.mise.local.toml`; override inline with `PORT=COM4 task esp32:flash`.

```bash
# 1. Set target chip (one-time)
task esp32:set-target

# 2. (Optional, one-time) Build the unified LVGL font (needs lv_font_conv)
task esp32:fonts

# 3. Build
task esp32:build

# 4. Flash and open serial monitor
task esp32:flash
```

In another terminal, run the server (the ESP32 connects to it over your LAN):

```bash
task server:dev    # binds ws://0.0.0.0:3000
```

### Configuring WiFi and server URI on first boot

WiFi credentials and the server URI are **not** baked into the firmware — every
build ships an empty NVS partition, so the same `.bin` is safe to share. Set them
**on the device**, on the ConfigScreen (tile 0, the leftmost tile):

1. Boot — the device lands on the ConfigScreen with a red "Disconnected" status.
2. Enter **Server URI** — `ws://<your-LAN-ip>:3000` (your machine's LAN IP, not
   `localhost`; find it with `ipconfig` / `ip addr` / `ipconfig getifaddr en0`),
   then **WiFi SSID** (2.4 GHz only) and **WiFi Password** (tap **Show** to verify).
3. Tap **Save & Reconnect** — values persist to NVS and the device connects; the
   status dot turns green once connected and paired (see [Pairing](#pairing)).

To change them later, swipe back to tile 0 and edit. Because credentials live in
NVS (not `sdkconfig`), shared firmware images are safe to distribute and anyone
can reconfigure without a flash tool.

### Pairing

Pairing is on by default — the server only accepts allowlisted devices. After
**Save & Reconnect**, the panel shows a **pairing code**. Approve it from the
checkout:

```bash
task server:cli -- device approve <code>   # <code> is shown on the panel
```

Or open a timed enrollment window with `task server:cli -- device pair`, then type
`approve <code>` at its prompt. See the root [Quick start](../../README.md#quick-start).

## Project Structure

```
clients/esp32/
  CMakeLists.txt          Root ESP-IDF project
  sdkconfig.defaults      Board config (flash, PSRAM, LVGL) — committed
  partitions.csv          16MB flash partition layout
  spec.md                 Module spec (architecture, APIs, constraints)
  main/
    main.c                Entry point: board → WiFi → transport → state → UI
    idf_component.yml     Managed dependencies
  components/
    board/                Hardware init: SPI display, I2C touch, LVGL port
    transport/            WebSocket client, Moumantai protocol parsing, binary frames
    state/                Session state machine, data model store, action dispatch
    renderer/             Moumantai component tree → LVGL widget tree + icon map
    wifi_mgr/             WiFi STA connection with retry
    config_store/         NVS-backed WiFi creds + server URI (set on-device via ConfigScreen)
    navigation/           2D tileview pager (H=apps, V=faces), ConfigScreen, dots
    chat/                 Chat FAB + panel with message display + on-screen keyboard
  assets/
    fonts/                Unified LVGL font pipeline — Inter + CJK + emoji + icons (lv_font_conv driver)
```

## Navigation Model

- **Horizontal swipe** switches apps (matches phone/wear clients).
- **Vertical swipe** within an app switches between its faces.
- **Column 0** of the tileview is the ConfigScreen (server URL, connection
  state, Reconnect). Swipe right from there to reach the first app.
- **Home app** (app id `"home"`) is the chat surface; other apps render
  their face tree and expose chat via the FAB.
- Server-driven `navigate { appId, faceId }` scrolls the tileview to the
  target tile with animation.

## Pin Configuration

All pin definitions are in `components/board/include/board_config.h`.

| Function | GPIO |
|----------|------|
| SPI SCLK | 42 |
| SPI MOSI | 39 |
| LCD DC | 41 |
| LCD CS | 40 |
| LCD RST | 2 |
| LCD Backlight | 38 |
| I2C SDA (touch) | 15 |
| I2C SCL (touch) | 16 |
| Touch INT | 47 |
| Touch RST | 48 |

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Display blank | Check backlight (IO38); verify SPI pins in `board_config.h`; `task esp32:monitor` for init logs. |
| Colors wrong | ILI9488 needs `BSP_LCD_COLOR_INVERT=true` (already set); if red/blue are still swapped on your board revision, toggle it in `board_config.h`. |
| Display rotated | Adjust `BSP_LCD_SWAP_XY` / `BSP_LCD_MIRROR_X` / `BSP_LCD_MIRROR_Y` in `board_config.h`. |
| Touch dead | GT911 may be on the alternate I2C address (`0x5D` ↔ `0x14`); check serial logs for I2C errors; try INT = -1 (`GPIO_NUM_NC`) for polling mode. |
| WiFi won't connect | Re-enter SSID/password on the ConfigScreen (tile 0); `task esp32:monitor` shows retries; must be 2.4 GHz (no 5 GHz). |
| WebSocket fails | Verify the server URI on the ConfigScreen; ESP32 + host on the same LAN; server running (`task server:dev`). |
| COM port missing | Install [Espressif USB drivers](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/establish-serial-connection.html). |
