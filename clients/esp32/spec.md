# ESP32 Client — Module Spec

## Purpose

ESP-IDF + LVGL client that connects to the Moumantai server over WiFi/WebSocket and renders server-driven UI on the CrowPanel Advance 3.5" HMI (ESP32-S3, ILI9488 320x480, GT911 touch).

## Architecture

```
main.c
  ├─ board_init()       → SPI display + I2C touch + LVGL port
  ├─ transport_init()   → WebSocket lifecycle + protocol parsing
  ├─ state_init()       → Session state machine (listens to transport events)
  ├─ renderer_init()    → Screen theming + face-render helper
  ├─ navigation_init()  → 2D pager (lv_tileview): H-swipe = apps, V-swipe = faces
  ├─ chat_init()        → Chat FAB + panel + keyboard
  ├─ wifi_init_sta()    → WiFi connection (blocks until connected)
  └─ transport_connect()→ WebSocket + ClientHello handshake
```

UI layout (nested tileviews — horizontal = apps, vertical = faces-within-app):

```
 screen
 └── outer lv_tileview (horizontal only)
     ├── tile col 0        → ConfigScreen (server, status, reconnect)
     └── tile col 1..N     → app container, each hosting its own
                              inner lv_tileview (vertical only):
                              tile row 0..M = one face per row
 └── pager dots  (bottom; horizontal position across apps)
 └── face dots   (right edge; vertical position within active app)
 └── chat FAB    (bottom-right overlay)
```

Nested tileviews deliberately avoid a ragged 2D grid: tile (col=K, row=J) is scoped to app-K's inner tileview only, so swiping horizontally off an app with 3 faces onto an app with 1 face does not land on a non-existent tile. Horizontal swipes chain from inner → outer via LVGL's default `LV_OBJ_FLAG_SCROLL_CHAIN_HOR`.

Event flow: `WebSocket frame → transport (parse) → esp_event → state (mutate) → esp_event → navigation/chat (rebuild tiles / repaint)`. Navigation calls `renderer_render_face(tile_body, app, face)` for the active tile.

All event handlers run on the ESP-IDF default event loop task (single-threaded). The LVGL timer task runs separately — widget mutations happen on the LVGL task via `lv_async_call` (with `lvgl_port_lock()` held inside the deferred callback).

## Component APIs

### board (`components/board/`)
```c
esp_err_t board_init(lv_display_t **out_disp);
```

### transport (`components/transport/`)
```c
esp_err_t transport_init(void);
esp_err_t transport_connect(const char *uri);
void      transport_disconnect(void);
bool      transport_is_connected(void);
esp_err_t transport_send_chat_input(const char *scope, const char *text,
                                    const char *client_msg_id);
esp_err_t transport_send_viewing(const char *scope);
esp_err_t transport_send_reset_conversation(const char *scope);
esp_err_t transport_send_audio_input(const uint8_t *pcm_data, size_t len,
                                     const char *scope, bool final);
esp_err_t transport_send_invoke_tool(const char *tool_name,
                                     const char *source_face_id,
                                     const char *client_request_id);
void      transport_set_nav_intent_provider(nav_intent_provider_fn fn);

/* Offline queue (test-only / internal): */
bool   offline_queue_enqueue(const char *scope, const char *text, const char *client_msg_id);
size_t offline_queue_size(void);
bool   offline_queue_peek(size_t idx, const char **out_scope, const char **out_text,
                          const char **out_client_msg_id);
void   offline_queue_clear(void);
void   offline_queue_flush_on_connect(void);
uint32_t compute_reconnect_delay_ms(int attempt, uint32_t jitter_rand);
```
Events posted: `TRANSPORT_EVT_{CONNECTED,DISCONNECTED,HELLO_OK,APP_LIST,FACE_LIST,FACE_UPDATE,CHAT,CHAT_WINDOW,CHAT_UPDATE,RESET_NOTICE,VOICE_STATE,NAVIGATE,AUDIO_CHUNK,ERROR,UI_ACTION_ESCALATED}`. Each event carries the typed `moumantai_v1_*` struct as payload (heap pointer for variable-length messages, stack copy for fixed ones). `TRANSPORT_EVT_UI_ACTION_ESCALATED` carries a stack-copy `ui_escalated_evt_t { char scope[64]; }` — receivers strcmp `scope` against their active scope and no-op on mismatch.

**Wire format**: binary protobuf via WS subprotocol `moumantai.v1.proto`. Outbound encoding via `proto_encode.c`; inbound dispatch via `proto_decode.c`. Renderer + state consume the typed `moumantai_v1_*` structs directly. cJSON survives only inside the transport's `google.protobuf.Struct` payload helper (face data model is genuinely dynamic JSON).

**Static-alloc + parent-side `submsg_callback` is the canonical fix for nanopb oneof + callback hazards.** When a oneof has both submsg variants and callback variants (string/bytes/repeated), variant selection triggers a union memset (pb_decode.c:547-554) that wipes pre-installed callbacks. Fix: (1) give callback-string variants `max_size:N` so they become fixed inline buffers; (2) give submsg variants `submsg_callback:true` so nanopb generates a parent-side `cb_<field>` that fires after the union memset and before the variant body decodes — install per-variant callbacks there. Used in `nanopb.options` for all 13 ComponentDef variants and `google.protobuf.Value.{struct,list}_value`. Pre-installing callbacks across multiple union members never works — they self-clobber and are then memset-clobbered.

**Reassembly is fail-loud.** WS-frame reassembly never silently truncates: overflow logs WARN + resets the buffer; the completion check uses strict equality (`offset + data_len == payload_len`) — anything else logs WARN + resets. Silent truncation surfaces downstream as cryptic `invalid wire_type` errors that mis-attribute to decoder bugs.

R1 lifecycle: `ClientHello` now emits two optional nav fields — `currentAppId`, `currentFaceId` — sourced from the registered nav-intent provider. `main.c` registers `fill_nav_intent()` which reads `state_get_active_app()` / `state_get_active_face()`. Values are omitted when unset or when the active app is `home`.

### state (`components/state/`)
```c
esp_err_t           state_init(void);
const client_state_t *state_get(void);
const app_state_t   *state_get_active_app(void);
const face_state_t  *state_get_active_face(void);
connection_state_t   state_get_connection(void);
void                 state_switch_app(int index);
void                 state_switch_face(const char *app_id, int face_index);
voice_state_t        state_get_voice(void);
void                 state_evict_inactive_apps(int active_idx, int window);
/* R1 lifecycle — UI display-state derivation over the 3-valued transport enum */
display_state_t     derive_display_state(connection_state_t cur,
                                         uint64_t now_us,
                                         uint64_t last_non_connected_us);
void                display_state_init(void);
display_state_t     display_state_get(void);
```
Events posted: `STATE_EVT_{CONN_CHANGED,APPS_CHANGED,ACTIVE_APP_CHANGED,ACTIVE_FACE_CHANGED,FACE_UPDATED,VOICE_CHANGED,CHAT_MESSAGE,CHAT_WINDOW,CHAT_UPDATE,DISPLAY_CHANGED}`. `FACE_UPDATED` is posted only by `on_face_update` (new wire data), carrying `face_updated_evt_t {app_id, face_id}` (stack copy) so subscribers can gate on active-face match and skip renders for non-active faces. `state_switch_face` posts only `ACTIVE_FACE_CHANGED` — navigation translates it into scroll + render; a dual FACE_UPDATED post would add coalescing risk without benefit.

**`faceList` is a merge, not a wipe.** On a repeat `faceList` (every `viewing` + 150 ms neighbor-prefetch), `on_face_list` preserves `components`/`data` for surviving face_ids, pushes fallen-out faces onto `s_face_free_head`, and preserves `active_face_idx` if the active face_id survived (else clamps to 0). `STATE_EVT_APPS_CHANGED` is posted only on structural change — identical id sequence → no event → no tile teardown → no "Loading…" flash. Matches PWA `setFaceList` and Android `handleFaceList`.

`display_state_t = {DISPLAY_CONNECTED, DISPLAY_RECONNECTING, DISPLAY_OFFLINE}`. `derive_display_state()` is pure: CONNECTED while elapsed < 2 s, RECONNECTING for 2–14.999 s, OFFLINE from 15 s. Stateful wrapper runs on a 500 ms `esp_timer` and posts `STATE_EVT_DISPLAY_CHANGED` only on transitions. Subscribers: config-screen status dot and `navigation/status_indicator.c`.

`state_evict_inactive_apps(active, window)` releases `components`+`data` for apps outside the proximity window (default `NEIGHBOR_WINDOW=1` → active ± 1 = 3 apps cached). Releases go through `enqueue_face_free_locked` (deferred, not synchronous `free()`) — the LVGL task may hold a snapshot pointer. App/face metadata is kept so the pager renders labels; content refetches on revisit via `viewing → faceList + faceUpdate`. Proximity-based, not LRU.

### renderer (`components/renderer/`)
```c
esp_err_t  renderer_init(lv_display_t *disp);
void       renderer_render_face(lv_obj_t *body,
                                const app_state_t *app,
                                const face_state_t *face);
lv_obj_t  *renderer_get_screen(void);
```
Icons: `icon_label_create(parent, name, size, color)` (style_helpers.h) — renders Material Symbols glyph, or a rounded text-chip fallback if the font hasn't been generated or the name is unmapped. Icon map: `components/renderer/icon_map.c` (keep in lock-step with `assets/fonts/icon_codepoints.txt`).

Supported Moumantai components: Scaffold, TopBar, Column, Row, Card, Text, Button, TextField, CheckBox, Switch, Select, Slider, ProgressBar, List (data-driven), ListItem, Badge, Divider, Spacer, Icon.

**Font cascade roots.** `renderer_init` pins the unified body font on **every LVGL layer root** — `s_screen`, `lv_layer_top()`, `lv_layer_sys()`. LVGL widgets that materialize on a non-screen layer (dropdown popup-list, msgbox, calendar overlay, modal sys-layer popups) descend from those layers, NOT from the active screen. Setting the font once on each layer root is the single source of truth for "what font does an unstyled widget render in"; without it, popup widgets fall through to `LV_FONT_DEFAULT` (8-bit unscii in this build) while the rest of the UI is Inter-Bold.

**Icon convention.** All icons must be created via `icon_label_create("material_name", size, color)`. **Never use `LV_SYMBOL_*`** — those are FontAwesome glyphs (LVGL built-in) and the unified font does not include FontAwesome ranges. The Material Symbols Rounded glyphs in the unified font are the only iconography that's guaranteed to render.

**Design token consumption.** The renderer is driven by `generated_tokens.h` (AUTO-GENERATED from `shared/tokens/expanded.yaml` — do not hand-edit). ESP32 hardware is ILI9488 320×480; `proto_encode.c` reports `DeviceProfile.width=320`, server's `classifyWidth(320)` returns `EXPANDED`, so the server sends expanded face variants and the renderer reads the matching expanded token profile. Token categories consumed:

| Category | Tokens | Example usage |
|---|---|---|
| spacing | `MOUMANTAI_SPACING_{XS,S,M,L,XL}` (4 / 8 / 16 / 24 / 32) | Body padding, gap, pad_ver on list items |
| sizing | `MOUMANTAI_BUTTON_HEIGHT` (40), `MOUMANTAI_TOPBAR_HEIGHT` (56), `MOUMANTAI_CHIP_PADDING_X` (16), `MOUMANTAI_ICON_SIZE` (24), `MOUMANTAI_LIST_ITEM_HEIGHT` (56), `MOUMANTAI_CARD_PADDING` (16), `MOUMANTAI_DIALOG_PADDING` (24) | Touch targets, component dimensions |
| shape | `MOUMANTAI_SHAPE_{NONE,XS,SM,MD,LG,XL}` (0 / 4 / 8 / 12 / 16 / 24, invariant) | Border radius on cards, chips, textfields |
| elevation | `moumantai_elevation_t` enum + `apply_elevation(obj, level)` | Card elevated variant shadow |
| motion | `MOUMANTAI_MOTION_DURATION_{SHORT,MEDIUM}_MS` (150 / 250, invariant) | Available for animation call sites |
| state | `MOUMANTAI_STATE_DISABLED_OPA` (97 = 0.38·255, invariant) | Available for disabled widget opacity |

`apply_elevation(lv_obj_t *obj, moumantai_elevation_t level)` — sets `shadow_width`, `shadow_ofs_y`, and `shadow_opa` from the `moumantai_elevation_table[]` defined in `style_helpers.c`. The table maps four M3 levels (none/raised/floating/elevated) to LVGL single-layer shadow tuples (two-layer M3 shadows are approximated by the dominant/key shadow layer). x-offset is always 0 per M3's vertical-only shadow spec.

Color constants (`THEME_*` M3 light-theme values in `style_helpers.h`) use fixed hex values (see Known Limitations).

**Literals intentionally NOT tokenized:**
- `radius=10` on Button (shapeAlias.buttonRadius=full=LV_RADIUS_CIRCLE is the M3 canonical but would be a visual breaking change)
- `radius=12` on Modal (value-for-value match with `MOUMANTAI_SHAPE_MD`; shapeAlias.dialogRadius=xl=24 would be the M3 semantic — noted for future alignment)
- `pad_hor=14` on Button and Card (between spacing.s=8 and spacing.m=16; no exact token)
- `pad_ver=10` on Button, `pad_ver=6` on Chip (between spacing scale steps; no exact token)
- `pad_hor=10` on TextField (textarea-tuned internal value; not in spacing scale)
- `min_height=52` on ListItem (content-collapsed min; canonical compound on expanded is 72)
- `back_button=BUTTON_HEIGHT × BUTTON_HEIGHT` (40×40 — square icon-button sized to topbar height)
- `status_dot=8×8` (no "indicator dot" size primitive; SPACING_M=16 would be too large)
- Icon sizes of 24 (Material Symbols mid-size bucket; same value as ICON_SIZE but separately resolved)
- `cluster height=32` (topbar status cluster; sub-touch-target, no sizing token)

### navigation (`components/navigation/`)
```c
esp_err_t  navigation_init(lv_obj_t *screen);
lv_obj_t  *navigation_get_active_body(void);
```
Owns the nested tileview pager and pager-dot indicators. Outer tileview has config (col 0) + one tile per app (col 1..N). Each app-tile contains an inner vertical tileview with one row per face. Outer horizontal swipes call `state_switch_app`; inner vertical swipes call `state_switch_face` and also invoke `state_evict_inactive_apps` to bound per-app resident memory. Server-driven `navigate` events scroll both tileviews via `lv_tileview_set_tile_by_index`.

All `STATE_EVT_*` events are coalesced into a single dirty-flag dispatch so a burst of `appList + faceList + faceUpdate` triggers at most one rebuild per tick.

### chat (`components/chat/`)
```c
esp_err_t chat_init(lv_obj_t *parent);
void      chat_show(bool visible);
```

**Scope as a first-class key.** The chat module maintains a per-scope `conversation_id` table — never a single global. Outbound optimistic bubbles look up `get_scope_conv_id(scope)` so a message typed in `app:foo` is stamped with foo's conversation, never with whichever scope happened to receive the most recent `chatWindow`. The table is cleared on `TRANSPORT_EVT_DISCONNECTED` (server-side conversation generation may roll across reconnects).

**Single-task ring ownership.** `s_messages` is owned by the LVGL task. Event-loop handlers (`on_chat_message`, `on_chat_window`) hand ownership of the proto message to a deferred LVGL-task callback via `lv_async_call(deferred_apply_*, msg)` and `free` after the deferred call processes. This eliminates the cross-task race that previously surfaced as `xQueueGenericSend` asserts when ring mutation collided with `rebuild_messages` iteration.

**Active-scope listener.** `chat_init` registers `STATE_EVT_ACTIVE_APP_CHANGED` so app swipes trigger a chat-list rebuild against the new scope's filter. Without this listener the list would freeze on the previous app's history while the user swipes to a different app.

## Dependencies

- ESP-IDF v5.4+ (WiFi, WebSocket, NVS, event loop, SPI/I2C drivers)
- LVGL 9.x via `esp_lvgl_port` managed component
- GT911 touch via `esp_lcd_touch_gt911` managed component
- cJSON (bundled with ESP-IDF)

## Known Limitations (vs web/Android/Wear)

ESP32 implements `Action`/`InvokeToolMsg` but two behaviors stay deferred
until a plugin app needs them on the HMI panel:

- **No `$form` capture.** Inputs don't writeback; `pathRef('/$form/<id>')`
  placeholders resolve to empty args. Wire when needed via a `form_store`
  module + `LV_EVENT_VALUE_CHANGED` on `render_textfield`.
- **`Action.args` round-trip is supported** for primitive + nested-object
  args (covers filter chips like `invokeTool('view_scoreboard', {day: 'today'})`).
  Decode runs through `proto_decode.c:cb_action_args` → `struct_fields_cb`
  into a per-face cJSON sidecar (`face_state_t.action_args`, keyed by
  `component.id`); encode runs through `proto_encode.c:struct_fields_encode_cb`.
  Arrays at the args level are silently skipped — extend the encode path
  with a Value-emitter when an ESP32-bound face actually needs them.
- **Offline queue for chat only.** `transport_send_chat_input` while disconnected enqueues to a small ring buffer (flushed automatically on reconnect via `offline_queue_flush_on_connect`). All other sends (`invoke_tool`, `audio_input`, `viewing`, `reset_conversation`) return `ESP_ERR_INVALID_STATE` and drop while disconnected.
- **No error-UX surface.** `ServerMessage.error` frames are decoded but not
  rendered to the user. Other clients surface them via toast / snackbar /
  banner per `shared/protocol/FORM_SCOPE.md`; the ESP32 client would need an
  LVGL overlay (modal toast or top-bar banner) to surface them. An ESP32 leg
  can be added to `shared/protocol/fixtures/form-semantics/` if that lands.
- **Color constants use M3 light-theme values.** Dark mode and full token
  binding are not currently implemented.

## Constraints

- **Single-threaded event model.** All transport/state/UI event handlers run on the default event loop task. LVGL timer task is separate — always acquire `lvgl_port_lock()` before widget operations.
- **Face data lives in PSRAM.** `cJSON_InitHooks` routes all cJSON nodes to `MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT`; nanopb component arrays use `heap_caps_realloc(...SPIRAM...)`. With `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096` this keeps ~150 KB of internal heap free for LVGL widget churn — without it, internal-RAM fragmentation triggers watchdog hangs while 8 MB PSRAM sits idle. LVGL working memory (`LV_MEM_SIZE_KILOBYTES=64`) stays internal per esp-bsp's recipe.
- **Fixed limits.** `MOUMANTAI_MAX_APPS=32`, `MOUMANTAI_MAX_FACES=8`, `MOUMANTAI_MAX_COMPONENTS=64` (heap-grown nanopb decode), ID/label strings 64 chars (`MOUMANTAI_MAX_ID_LEN=64`).
- **Proximity face cache.** Active app ± 1 neighbour (`NEIGHBOR_WINDOW=1`, 3 apps total) keep resident `components`+`data`. Apps outside the window evict and reload on revisit; the server prefetches neighbours on each `viewing`. Proximity-based, not LRU.
- **Chat ring buffer.** 30 messages; text is heap-allocated per entry (no fixed size cap). Older messages are overwritten.
- **List cap.** `render_list` renders at most **20** items then shows "…and N more". Defensive guard — protocol should paginate for small-screen clients.
- **ESP32 visual policy** (performance-first; 240 MHz Xtensa, software draw, 64 KB LVGL pool, 5 s WDT — visual richness costs render time we don't have):
  - **No elevation/shadows.** `moumantai_elevation_table[]` (style_helpers.c) is all-zeros; `apply_elevation` still runs to overwrite any prior shadow style. `DS_KIND_ELEVATED_CONTAINER` Cards rely on background-color contrast (THEME_SURFACE_CONT) for their surface tier, not a shadow lift.
  - **Image components are skipped.** `render_image` returns a hidden 0×0 widget. App authors targeting ESP32 must not rely on Image for layout balance — slots collapse.
  - **Icon glyphs are single labels.** When the unified font (`assets/fonts/moumantai_font_*`) has the codepoint, `create_glyph_label` creates one `lv_label` (size_px-bounded, center-aligned) instead of a box wrapper + child label. The `create_chip_fallback` (missing-glyph) path is unchanged.
  - **Render hot loops feed the task watchdog** every 8 iterations via `esp_task_wdt_reset()`: `render_children_ids`, `render_list`, Tabs strip loop, Select option loops. Guards against faces whose subtrees exceed the 5 s WDT.
- **No audio playback.** `TRANSPORT_EVT_AUDIO_CHUNK` is parsed but no consumer exists yet (no I2S DAC wired).
- **DeviceClass `hmi-panel`.** Sends `{width:320, height:480, shape:"rect"}` in ClientHello. Requires server-side `hmi-panel` support (in `protocol.ts` and `ws-server.ts`).

## Example (happy path)

1. `board_init()` → SPI display initialized, LVGL running.
2. `navigation_init()` builds the tileview; ConfigScreen (tile 0,0) is visible by default.
3. WiFi connects → `transport_connect("ws://192.168.1.100:3000")`. ConfigScreen status dot goes amber ("Connecting…").
4. WebSocket opens → sends `ClientHello {type:"hello", deviceClass:"hmi-panel", deviceProfile:{...}}`.
5. Server replies `ServerHello` → state transitions to `CONN_SESSION_ACTIVE`. ConfigScreen dot goes green ("Connected").
6. Server sends `appList` → state posts `STATE_EVT_APPS_CHANGED` → navigation adds one tileview column per app.
7. Server sends `faceList` + `faceUpdate` → navigation rebuilds that app's row tiles and renders the active face via `renderer_render_face`.
8. User swipes right → `state_switch_app(idx)` → transport sends `viewing`, tileview scrolls, active face repaints. Swipe up/down within an app → `state_switch_face` (no wire send; scope unchanged).
9. User taps button → `action_dispatch_from_def()` looks up `args` via `state_get_action_args`, calls `transport_send_invoke_tool` (encodes `InvokeToolMsg` with args via `struct_fields_encode_cb`). Server runs the tool on the same path as the LLM (`handleInvokeTool` → `executeTool` → `refreshAllFaces`).
10. Server sends updated `faceUpdate` → navigation repaints the active tile body.
11. Server pushes `navigate {appId, faceId}` → state mutates active indices; navigation scrolls the tileview to the target tile with animation.
