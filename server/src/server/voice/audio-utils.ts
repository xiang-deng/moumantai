/**
 * Audio utility functions for PCM16 processing.
 *
 * - pcmToWav: Wrap raw PCM16 in a WAV header (for OpenAI transcription API).
 * - resample: Linear interpolation resampler (e.g., 24kHz → 16kHz).
 */

/**
 * Wrap a raw PCM16 mono buffer in a 44-byte RIFF/WAV header.
 *
 * OpenAI's HTTP transcription endpoint accepts WAV files.
 * Our wire format is headerless PCM, so we add the header server-side.
 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = pcm.length
  const fileSize = 36 + dataSize // RIFF header (44) - 8 byte preamble + data

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(fileSize, 4)
  header.write('WAVE', 8)
  // fmt sub-chunk
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  // data sub-chunk
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}

/**
 * Resample PCM16 mono audio via linear interpolation.
 *
 * Handles both upsampling and downsampling. Sufficient for speech audio
 * where sub-sample accuracy isn't critical.
 */
export function resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm

  const srcSamples = pcm.length / 2 // Int16 = 2 bytes
  const ratio = fromRate / toRate
  const dstSamples = Math.round(srcSamples / ratio)
  if (dstSamples === 0) return Buffer.alloc(0)

  const src = new Int16Array(pcm.buffer, pcm.byteOffset, srcSamples)
  const dst = new Int16Array(dstSamples)

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * ratio
    const srcIdx = Math.floor(srcPos)
    const frac = srcPos - srcIdx

    if (srcIdx + 1 < srcSamples) {
      // Linear interpolation between two adjacent samples
      dst[i] = Math.round(src[srcIdx]! * (1 - frac) + src[srcIdx + 1]! * frac)
    } else {
      dst[i] = src[Math.min(srcIdx, srcSamples - 1)]!
    }
  }

  return Buffer.from(dst.buffer)
}
