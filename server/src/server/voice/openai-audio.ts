/**
 * OpenAI Audio Service — real STT/TTS via OpenAI API.
 *
 * - transcribe(): PCM → WAV → POST /v1/audio/transcriptions (gpt-4o-mini-transcribe)
 * - synthesize(): POST /v1/audio/speech (gpt-4o-mini-tts) → 24kHz PCM → resample to 16kHz
 */

import OpenAI, { toFile } from 'openai'
import type { AudioService, AudioCodec } from './audio-service.js'
import { pcmToWav, resample } from './audio-utils.js'

export interface OpenAIAudioConfig {
  apiKey: string
  sttModel?: string // default: 'gpt-4o-mini-transcribe'
  ttsModel?: string // default: 'gpt-4o-mini-tts'
  ttsVoice?: string // default: 'alloy'
}

/** Wire-format sample rate used by Moumantai clients. */
const WIRE_SAMPLE_RATE = 16000
/** OpenAI TTS PCM output sample rate. */
const OPENAI_TTS_SAMPLE_RATE = 24000

export class OpenAIAudioService implements AudioService {
  private client: OpenAI
  private sttModel: string
  private ttsModel: string
  private ttsVoice: string

  constructor(config: OpenAIAudioConfig) {
    // 30 s timeout: a hung connection would hold the relay in THINKING/SPEAKING
    // indefinitely; the abort surfaces as an error that resets it to IDLE.
    this.client = new OpenAI({ apiKey: config.apiKey, timeout: 30_000 })
    this.sttModel = config.sttModel ?? 'gpt-4o-mini-transcribe'
    this.ttsModel = config.ttsModel ?? 'gpt-4o-mini-tts'
    this.ttsVoice = config.ttsVoice ?? 'alloy'
  }

  async transcribe(audio: Buffer, codec: AudioCodec): Promise<string> {
    // Wrap raw PCM in WAV header (OpenAI accepts WAV files)
    const wav = pcmToWav(audio, codec.sampleRate)
    const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' })

    const response = await this.client.audio.transcriptions.create({
      model: this.sttModel,
      file,
    })

    return response.text
  }

  async synthesize(text: string, voice?: string): Promise<Buffer> {
    const response = await this.client.audio.speech.create({
      model: this.ttsModel,
      input: text,
      voice: (voice ?? this.ttsVoice) as 'alloy',
      response_format: 'pcm',
    })

    // Collect response stream into a single Buffer (24kHz PCM16)
    const arrayBuffer = await response.arrayBuffer()
    const pcm24k = Buffer.from(arrayBuffer)

    // Resample 24kHz → 16kHz to match our wire format
    return resample(pcm24k, OPENAI_TTS_SAMPLE_RATE, WIRE_SAMPLE_RATE)
  }
}
