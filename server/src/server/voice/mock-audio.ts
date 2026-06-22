/**
 * Mock AudioService for development and testing. Canned transcript and
 * 1 second of PCM16 silence at 16 kHz mono.
 */

import type { AudioService, AudioCodec } from './audio-service.js'

export class MockAudioService implements AudioService {
  async transcribe(_audio: Buffer, _codec: AudioCodec): Promise<string> {
    return 'show my expenses'
  }

  async synthesize(_text: string, _voice?: string): Promise<Buffer> {
    return Buffer.alloc(16000 * 2)
  }
}
