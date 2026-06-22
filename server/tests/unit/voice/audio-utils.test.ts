/**
 * Tests for audio utility functions: pcmToWav and resample.
 */

import { describe, it, expect } from 'vitest'
import { pcmToWav, resample } from '../../../src/server/voice/audio-utils.js'

describe('pcmToWav', () => {
  it('produces a buffer that is 44 bytes larger than input', () => {
    const pcm = Buffer.alloc(1000, 0x42)
    const wav = pcmToWav(pcm, 16000)
    expect(wav.length).toBe(1000 + 44)
  })

  it('starts with RIFF header', () => {
    const wav = pcmToWav(Buffer.alloc(100), 16000)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
  })

  it('has correct fmt chunk markers', () => {
    const wav = pcmToWav(Buffer.alloc(100), 16000)
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16) // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1) // PCM format
    expect(wav.readUInt16LE(22)).toBe(1) // mono
  })

  it('encodes sample rate and byte rate correctly', () => {
    const wav = pcmToWav(Buffer.alloc(100), 16000)
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(32000) // byte rate = 16000 * 1 * 2
    expect(wav.readUInt16LE(32)).toBe(2) // block align = 1 * 2
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
  })

  it('has correct data chunk with size matching input', () => {
    const pcm = Buffer.alloc(500, 0xaa)
    const wav = pcmToWav(pcm, 16000)
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(500) // data size
  })

  it('encodes RIFF file size correctly', () => {
    const pcm = Buffer.alloc(1000)
    const wav = pcmToWav(pcm, 1000)
    // RIFF size = total - 8 = (44 + 1000) - 8 = 1036
    expect(wav.readUInt32LE(4)).toBe(36 + 1000)
  })

  it('preserves PCM data after the header', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04])
    const wav = pcmToWav(pcm, 16000)
    expect(wav[44]).toBe(0x01)
    expect(wav[45]).toBe(0x02)
    expect(wav[46]).toBe(0x03)
    expect(wav[47]).toBe(0x04)
  })

  it('handles different sample rates', () => {
    const wav = pcmToWav(Buffer.alloc(100), 44100)
    expect(wav.readUInt32LE(24)).toBe(44100)
    expect(wav.readUInt32LE(28)).toBe(88200) // 44100 * 1 * 2
  })

  it('handles empty PCM buffer', () => {
    const wav = pcmToWav(Buffer.alloc(0), 16000)
    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(40)).toBe(0) // data size = 0
  })
})

describe('resample', () => {
  it('returns same buffer when rates are equal', () => {
    const pcm = Buffer.alloc(100, 0x42)
    const result = resample(pcm, 16000, 16000)
    expect(result).toBe(pcm) // identity — same object
  })

  it('downsamples 24kHz to 16kHz (2/3 ratio)', () => {
    // 6 samples at 24kHz = 12 bytes → should produce ~4 samples at 16kHz = 8 bytes
    const src = new Int16Array([100, 200, 300, 400, 500, 600])
    const pcm = Buffer.from(src.buffer)
    const result = resample(pcm, 24000, 16000)
    // 6 / (24000/16000) = 6 / 1.5 = 4 samples = 8 bytes
    expect(result.length).toBe(8)
  })

  it('upsamples 16kHz to 24kHz (3/2 ratio)', () => {
    const src = new Int16Array([100, 200, 300, 400])
    const pcm = Buffer.from(src.buffer)
    const result = resample(pcm, 16000, 24000)
    // 4 / (16000/24000) = 4 / 0.667 = 6 samples = 12 bytes
    expect(result.length).toBe(12)
  })

  it('preserves first sample value on downsample', () => {
    const src = new Int16Array([1000, 2000, 3000, 4000, 5000, 6000])
    const pcm = Buffer.from(src.buffer)
    const result = resample(pcm, 24000, 16000)
    const dst = new Int16Array(result.buffer, result.byteOffset, result.length / 2)
    // First sample should be 1000 (srcPos=0, no interpolation needed)
    expect(dst[0]).toBe(1000)
  })

  it('handles empty buffer', () => {
    const result = resample(Buffer.alloc(0), 24000, 16000)
    expect(result.length).toBe(0)
  })

  it('produces monotonically interpolated output for linear input', () => {
    // Linear ramp: each sample increases by 100
    const src = new Int16Array([0, 100, 200, 300, 400, 500])
    const pcm = Buffer.from(src.buffer)
    const result = resample(pcm, 24000, 16000)
    const dst = new Int16Array(result.buffer, result.byteOffset, result.length / 2)
    // All samples should be non-decreasing for a linear ramp
    for (let i = 1; i < dst.length; i++) {
      expect(dst[i]!).toBeGreaterThanOrEqual(dst[i - 1]!)
    }
  })
})
