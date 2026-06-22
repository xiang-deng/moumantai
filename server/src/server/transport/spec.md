# WebSocket Server

Transport layer for client-server communication over WebSocket. Single wire
format: `moumantai.v1.proto` — binary protobuf-es over binary frames. Sockets
that fail to negotiate this subprotocol are rejected at handshake.

`WsServer` calls protobuf-es directly: `toBinary(ServerMessageSchema, msg)`
on every outbound frame, `fromBinary(ClientMessageSchema, bytes)` on every
inbound. There is no codec class and no codec dispatcher.

## Identity model

The durable identity is **`deviceId`** — a UUIDv4 the client generates on
first launch and persists in secure storage (Android EncryptedSharedPreferences,
iOS Keychain, ESP32 NVS, Web localStorage). Sent in every `ClientHello.device_id`.

**Each WebSocket gets a fresh server-issued `sessionId`** as a routing handle
for outbound frames. SessionId is ephemeral; deviceId is what survives.

**Supersede on reconnect:** if a hello arrives for a `deviceId` that already
has a live socket, the old socket is closed with code 1000 'superseded'
*without firing onDisconnect handlers* — the new connection IS the
continuation, not a teardown. At most one live connection per deviceId at a
time.

**No grace window, no replay buffer, no resume credentials.** Reconnect =
fresh handshake. State recovery is "full snapshot from the persistent SSOT":
on every (re)connect the server pushes appList + chatWindow(activeScope) +
faceList(activeApp) + faceUpdate(activeApp) for the device's last-known
focus (read from the `devices` row).

## Public API

| Export | Kind | Description |
|--------|------|-------------|
| `WsServer` | class | WebSocket server implementing `ServerTransport` |
| `WsServerOptions` | interface | Constructor options (generateId, timeouts, rate limits) |
| `ConnectedClient` | interface | Snapshot of one live connection |
| `HelloNavIntent` | interface | Navigation fields extracted from `ClientHello` (`currentAppId?`, `currentFaceId?`) |
| `classifyWidth(width)` | function | Map screen width (dp) → SizeClass |

## WsServer Methods

**Lifecycle:**
- `attach(httpServer)` / `listen(port)` / `close()`

**Send / broadcast:**
- `send(sessionId, message)` — send a typed `ServerMessage` to one session
- `broadcast(message)` — send to every live session
- `broadcastToScope(scope, message)` — send to every session whose `activeScope === scope`

**Connection introspection:**
- `getClient(sessionId)` — `ConnectedClient | undefined`
- `getClientCount()` — number of live sockets
- `getDeviceId(sessionId)` / `getSessionByDeviceId(deviceId)` — sessionId ↔ deviceId
- `getActiveScope(sessionId)` / `setActiveScope(sessionId, scope)`
- `getLiveConnections()` — snapshot list of every live connection
- `isBackpressurePaused(sessionId)` — true while ws.bufferedAmount > threshold

**Voice state (per LiveConnection):**
- `getVoiceState(sessionId)` / `setVoiceState(sessionId, value)`
- `getVoiceTurnId(sessionId)` / `setVoiceTurnId(sessionId, id)`

**Mounted-set tracking:**
- `setCurrentFaceMount(sessionId, faceId, params)` — update which face+params a session is actively rendering; called by the broadcast layer when pushing `createSurface`
- `getMountedSet()` — aggregate snapshot of every session that has both `activeScope` and `currentFaceId`; read by the refresh scheduler for `mountedOnly` task gating

**Error sending:**
- `sendError(sessionId, code, message, retryAfterMs?)` — push a structured `ErrorMessage` without closing the socket

**Handler registration:**
- `onConnect(handler)` — `(sessionId, deviceId, deviceClass, deviceProfile, nav?: HelloNavIntent) => void`
- `onDisconnect(handler)` — fires immediately on socket close (no grace)
- `onChatInput`, `onViewing`, `onResetConversation`, `onFetchOlder`, `onTTSRequest`, `onInvokeTool`, `onAudioInput`
- `setPairingResolver(resolver)` — inject the admission policy applied after `isValidClientHello`, before any `ServerHello` (see Constraints → Pairing gate)
- Draft preview (dev mode): `onPreviewOptIn`, `onDraftReload`, `onDraftPromote`, `onDraftDiscard`, `onDraftTurnCancel`; plus `setPreviewingDraft(sessionId, draftId, optIn)` / `sessionsPreviewingDraft(draftId)` to track which sessions are previewing a coding-agent draft

**Rate limiting:**
- `checkTurnRate(sessionId)` — sliding window (5 turns / 30s by default), per-LiveConnection

## Dependencies

- `ws` (npm package) — WebSocket implementation
- `transport/types.ts` — `ServerTransport` interface
- `@moumantai/protocol/generated/moumantai/v1` — typed wire bindings
- `@moumantai/protocol` — binary-frame helpers + scope-string helpers

## Constraints

- WsServer is purely transport. It does not import AppEngine or ConversationStore.
- ClientHello must arrive within 5s of socket open or the connection closes with `INVALID_HELLO`.
- **Pairing gate:** an injected `setPairingResolver()` decides admission *after*
  `isValidClientHello` but *before* any session/ServerHello. Unpaired devices close with
  `PAIRING_REQUIRED` (4008); the resolver (wired in `main.ts`) holds all policy + records
  the device row, keeping the transport policy-free. The hello path is async with a
  one-shot in-flight latch so a second pre-handshake frame can't race a duplicate hello.
- Inbound binary frames cap at 2 MiB (configurable via `maxInboundBinaryBytes`); text frames are rejected (the proto subprotocol is binary-only).
- Binary frame rate limiting: 200 frames/s per session by default (configurable via `maxBinaryFramesPerSec`); excess returns `RATE_LIMITED` error.
- Outbound durability is **disposable** for every variant — recovery on
  reconnect goes through `chatWindow` (full snapshot from `ConversationStore`).

## Example

```typescript
import { WsServer } from './ws-server.js'
import { createServer } from 'http'

const httpServer = createServer()
const ws = new WsServer()
ws.attach(httpServer)

ws.onConnect((sessionId, deviceId, deviceClass, deviceProfile, nav) => {
  console.log(`Connected: device=${deviceId} class=${deviceClass}`)
})

ws.onChatInput((sessionId, msg) => {
  console.log(`Chat from ${sessionId}: ${msg.text}`)
})

ws.broadcast(msgAppList({ apps: [] }))

httpServer.listen(3000)
```
