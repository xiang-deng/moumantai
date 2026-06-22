# Voice Module

Audio pipeline: buffers client audio, delegates STT/TTS to an AudioService, and emits events for the caller to forward.

## Public API

### `AudioService` (interface, `audio-service.ts`)

```typescript
interface AudioService {
  transcribe(audio: Buffer, codec: AudioCodec): Promise<string>
  synthesize(text: string, voice?: string): Promise<Buffer>
}
```

### `VoiceRelay` (`relay.ts`)

```typescript
constructor(audio: AudioService, options?: VoiceRelayOptions)

interface VoiceRelayOptions {
  maxAudioBytes?: number
  listeningIdleTtlMs?: number     // default 30_000
  clientStore: VoiceRelayClientStore   // per-client voice-state sink (required)
  send: (sessionId, message) => void   // wire push on TTL expiry (required)
}
```

| Method | Description |
|--------|-------------|
| `handleAudioInput(opts)` | Buffer incoming audio. `opts: { voiceKey, scope, data, format, sampleRate, final }`. On `final: true`, concatenate and transcribe. Every non-final chunk (re)arms the 30 s listening-idle TTL. Cross-scope guard: if a chunk's `scope` differs from the utterance's starting scope, the buffer is discarded and an error event is returned. Returns `VoiceRelayEvent[]`. |
| `synthesizeResponse(text, voiceKey)` | TTS the given text. Returns audio chunks + state events. |
| `handleInterruption(voiceKey)` | Cancel synthesis, transition to `listening`. |
| `getState(voiceKey)` | Current `VoiceStateValue` for a session (`idle` if unknown). |
| `destroyClient(clientId)` | Drop buffers, state, synthesis and the idle timer for the given session. Called from the WS disconnect cascade. |

**Listening-idle TTL.** If no audio frame arrives for 30 s while a client is
`listening`, the relay drops the buffer, calls `clientStore.setVoiceState`
back to `idle`, and pushes a `voiceState: 'idle'` wire message to that one
client. This prevents stuck mics / half-open streams from pinning a client
in `listening` until disconnect.

### `VoiceRelayEvent`

Discriminated union:
- `{ type: 'voiceState', state }` -- voice state transition
- `{ type: 'audioChunk', data, format, sampleRate, final }` -- outbound TTS audio
- `{ type: 'transcript', text }` -- STT result (caller routes to session as chat input)
- `{ type: 'error', message }` -- STT or TTS failure

### Implementations

| Class | File | Description |
|-------|------|-------------|
| `OpenAIAudioService` | `openai-audio.ts` | Real STT/TTS via OpenAI API (gpt-4o-mini-transcribe, gpt-4o-mini-tts) |
| `MockAudioService` | `mock-audio.ts` | Canned transcript + 1 s of PCM16 silence for dev/testing |

### Utilities (`audio-utils.ts`)

| Function | Description |
|----------|-------------|
| `pcmToWav(pcm, sampleRate)` | Wrap raw PCM16 mono in 44-byte RIFF/WAV header |
| `resample(pcm, fromRate, toRate)` | Linear interpolation PCM16 mono resampler |

## Dependencies

- `AudioService` interface (this module)
- `AudioCodec` from `agent/types.ts`
- `VoiceStateValue` from `shared/protocol.ts` (canonical)
- `openai` npm package (OpenAIAudioService only)

## Constraints

- Purely a pipeline: knows nothing about apps, surfaces, or routing.
- Stateless per-turn: only state is the audio buffer for the current turn.
- TTS audio is split into 4096-byte chunks (last chunk has `final: true`).
- Interruption cancels pending synthesis via an `activeSynthesis` set.
- STT and TTS are independent, on-demand features (no auto-TTS).
- **Voice state is per-client**, stored in the injected `VoiceRelayClientStore` (backed by `WsServer`'s per-session state) — the `ConversationStore` holds none. Two devices can be in `listening` concurrently without interfering.
- **Relay keys** (`voiceKey`) are the caller-supplied WS `sessionId`. The relay treats them as opaque exact-match keys (no prefix splitting). `voiceKey` is an internal identifier — it is NOT the wire-protocol `scope`.

## Example

```typescript
const audio = new OpenAIAudioService({ apiKey: process.env.OPENAI_API_KEY })
const relay = new VoiceRelay(audio, {
  clientStore: clientManager,
  send: (sessionId, message) => wsServer.send(sessionId, message),
})

// STT: Client sends audio → transcript
const events = await relay.handleAudioInput({
  voiceKey: 'ws-session-abc123', data: audioBuffer,
  format: 'pcm16', sampleRate: 16000, final: true,
})
// events: [{ type: 'voiceState', state: 'thinking' }, { type: 'transcript', text: '...' }]

// TTS: On-demand playback (triggered by user clicking play)
const synthEvents = await relay.synthesizeResponse('Here are your expenses', 'ws-session-abc123')
// synthEvents: [voiceState:speaking, audioChunk..., voiceState:idle]
```
