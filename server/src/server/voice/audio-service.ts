/**
 * AudioService — interface for speech-to-text and text-to-speech.
 *
 * Decoupled from the LLM adapter: audio is a server-side transport concern,
 * not an LLM concern. The agent only ever sees text.
 */

import type { AudioCodec } from '../agent/types.js'

export type { AudioCodec }

export interface AudioService {
  /** Transcribe audio buffer to text (speech-to-text). */
  transcribe(audio: Buffer, codec: AudioCodec): Promise<string>

  /** Synthesize text to PCM16 audio buffer at 16kHz mono (text-to-speech). */
  synthesize(text: string, voice?: string): Promise<Buffer>
}
