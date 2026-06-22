/**
 * Binary-frame envelope helpers.
 *
 * Wire layout: `[1 byte type][2 bytes LE header_len][header bytes][payload]`
 *
 * Header bytes are proto-encoded (`AudioChunkHeader` or `ImageChunkHeader`).
 * Decoding is caller-driven per `frameType` — no polymorphic envelope needed.
 */

import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  type AudioChunkHeader,
  AudioChunkHeaderSchema,
  type ImageChunkHeader,
  ImageChunkHeaderSchema,
  BinaryFrameType,
} from './generated/moumantai/v1/index.js'

const HEADER_LEN_BYTES = 2
const TYPE_BYTE_LEN = 1
const ENVELOPE_PREFIX_LEN = TYPE_BYTE_LEN + HEADER_LEN_BYTES // 3
const HEADER_MAX = 0xffff // uint16

export interface ParsedBinaryFrame {
  frameType: BinaryFrameType
  /** Proto-encoded header bytes; decode via `decodeAudioHeader` / `decodeImageHeader`. */
  headerBytes: Uint8Array
  payload: Uint8Array
}

/** Parse a binary frame's outer envelope. Returns null on malformed bytes. */
export function parseBinaryFrame(data: Uint8Array): ParsedBinaryFrame | null {
  if (data.length < ENVELOPE_PREFIX_LEN) return null

  const frameType = data[0] as BinaryFrameType
  const headerLen = data[1]! | (data[2]! << 8)
  if (data.length < ENVELOPE_PREFIX_LEN + headerLen) return null

  return {
    frameType,
    headerBytes: data.subarray(ENVELOPE_PREFIX_LEN, ENVELOPE_PREFIX_LEN + headerLen),
    payload: data.subarray(ENVELOPE_PREFIX_LEN + headerLen),
  }
}

/** Build a binary frame from a typed frame-type, raw header bytes, and payload. */
export function encodeBinaryFrame(
  frameType: BinaryFrameType,
  headerBytes: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  if (headerBytes.length > HEADER_MAX) {
    throw new Error(
      `Binary frame header exceeds uint16 max (${headerBytes.length} > ${HEADER_MAX})`,
    )
  }
  const frame = new Uint8Array(ENVELOPE_PREFIX_LEN + headerBytes.length + payload.length)
  frame[0] = frameType
  frame[1] = headerBytes.length & 0xff
  frame[2] = (headerBytes.length >> 8) & 0xff
  frame.set(headerBytes, ENVELOPE_PREFIX_LEN)
  frame.set(payload, ENVELOPE_PREFIX_LEN + headerBytes.length)
  return frame
}

// ---------------------------------------------------------------------------
// Type-safe convenience helpers
// ---------------------------------------------------------------------------

export function encodeAudioFrame(header: AudioChunkHeader, payload: Uint8Array): Uint8Array {
  return encodeBinaryFrame(BinaryFrameType.AUDIO, toBinary(AudioChunkHeaderSchema, header), payload)
}

export function decodeAudioHeader(headerBytes: Uint8Array): AudioChunkHeader {
  return fromBinary(AudioChunkHeaderSchema, headerBytes)
}

export function encodeImageFrame(header: ImageChunkHeader, payload: Uint8Array): Uint8Array {
  return encodeBinaryFrame(BinaryFrameType.IMAGE, toBinary(ImageChunkHeaderSchema, header), payload)
}

export function decodeImageHeader(headerBytes: Uint8Array): ImageChunkHeader {
  return fromBinary(ImageChunkHeaderSchema, headerBytes)
}

/** Convenience constructor for `AudioChunkHeader`. */
export function audioChunkHeader(fields: {
  scope?: string
  format: AudioChunkHeader['format']
  sampleRate: number
  final: boolean
  clientMsgId?: string
}): AudioChunkHeader {
  return create(AudioChunkHeaderSchema, {
    scope: fields.scope ?? '',
    format: fields.format,
    sampleRate: fields.sampleRate,
    final: fields.final,
    clientMsgId: fields.clientMsgId,
  })
}
