// PCM-capture AudioWorkletProcessor.
//
// Runs in the audio rendering thread (no main-thread allocation pressure,
// glitch-free). Buffers 4096 samples (~256 ms at 16 kHz) of mono Float32
// audio, converts to PCM16, and posts the underlying ArrayBuffer to the main
// thread by transfer (zero-copy IPC).
//
// Companion: clients/pwa/src/hooks/useVoiceCapture.ts

const FRAME_SAMPLES = 4096

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(FRAME_SAMPLES)
    this.offset = 0
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true

    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff

      if (this.offset === FRAME_SAMPLES) {
        const out = this.buffer.buffer
        this.port.postMessage(out, [out])
        this.buffer = new Int16Array(FRAME_SAMPLES)
        this.offset = 0
      }
    }

    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
