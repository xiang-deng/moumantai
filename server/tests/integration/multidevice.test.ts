/**
 * Integration: multi-device — concurrent input serializes via TurnQueue;
 * navigate targets only the originating device; voice state is per-device.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import { create } from '@bufbuild/protobuf'
import {
  ClientMessageSchema,
  ChatRole,
  DeviceClass,
  DeviceShape,
  VoiceStateValue,
  AudioFormat,
} from '@moumantai/protocol/generated/moumantai/v1'
import { audioChunkHeader, encodeAudioFrame } from '@moumantai/protocol'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient, waitFor, type TestClientHello } from '../helpers/test-client.js'

async function connectDevice(port: number, device: 'phone' | 'watch'): Promise<TestClient> {
  return TestClient.connect(port, {
    hello:
      device === 'phone'
        ? {
            deviceClass: DeviceClass.PHONE,
            deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
          }
        : {
            deviceClass: DeviceClass.WATCH,
            deviceProfile: { width: 192, height: 192, shape: DeviceShape.ROUND },
          },
  })
}

async function openClient(
  port: number,
  extras: Partial<TestClientHello> = {},
): Promise<TestClient> {
  return TestClient.connect(port, {
    hello: {
      deviceClass: DeviceClass.PHONE,
      deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
      ...extras,
    },
  })
}

/** Send one audio binary frame (PCM16, 16 kHz). */
function sendAudioFrame(c: TestClient, final: boolean, payloadBytes = 512) {
  const frame = encodeAudioFrame(
    audioChunkHeader({ scope: 'home', format: AudioFormat.PCM16, sampleRate: 16000, final }),
    Buffer.alloc(payloadBytes, 0x42),
  )
  c.sendBinary(frame)
}

async function waitForLocal<T>(fn: () => T | false | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

let components: ServerComponents
let httpServer: HttpServer
let port: number

describe('multi-device scenarios', () => {
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-multidev-'))
    components = await createAppServer({
      adapterOverride: await connectMockAdapter(),
      port: 0,
      home,
      appDirs: ['tests/fixtures'],
    })
    httpServer = components.httpServer
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        port = (httpServer.address() as AddressInfo).port
        resolve()
      })
    })
  }, 15_000)

  afterAll(async () => {
    components.appEngine.shutdown()
    await components.wsServer.close()
    await components.adapter.disconnect()
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()))
    })
  }, 10_000)

  it('concurrent input on shared scope serializes through TurnQueue', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))

    const phone = await connectDevice(port, 'phone')
    const watch = await connectDevice(port, 'watch')

    try {
      expect(phone.sessionId).not.toBe(watch.sessionId)

      phone.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      watch.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      await new Promise((r) => setTimeout(r, 50))

      const phoneText = 'phone says hi'
      const watchText = 'watch says hello'

      phone.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'home', text: phoneText } },
        }),
      )
      await new Promise((r) => setTimeout(r, 50))
      watch.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'home', text: watchText } },
        }),
      )

      const check = (buf: typeof phone.received) => {
        const chats = buf.flatMap((m) => (m.payload.case === 'chat' ? [m.payload.value] : []))
        const userTexts = chats.filter((c) => c.role === ChatRole.USER).map((c) => c.text)
        const asstCount = chats.filter((c) => c.role === ChatRole.ASSISTANT).length
        if (userTexts.includes(phoneText) && userTexts.includes(watchText) && asstCount >= 2) {
          return chats
        }
        return false
      }

      await waitFor(phone.received, check, 15_000)
      await waitFor(watch.received, check, 15_000)

      const window = components.store.getWindow('home').entries
      const userRows = window.filter((e) => e.role === 'user')
      expect(userRows.map((r) => r.text)).toEqual(expect.arrayContaining([phoneText, watchText]))
      const assistantRows = window.filter((e) => e.role === 'assistant')
      expect(assistantRows.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < window.length; i++) {
        expect(window[i]!.seq).toBeGreaterThan(window[i - 1]!.seq)
      }
    } finally {
      phone.close()
      watch.close()
    }
  }, 30_000)

  it('navigate tool targets only the originating device', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))

    const phoneDeviceId = 'phone-' + Math.random().toString(36).slice(2)
    const watchDeviceId = 'watch-' + Math.random().toString(36).slice(2)

    const phone = await openClient(port, { deviceId: phoneDeviceId })
    const watch = await openClient(port, { deviceId: watchDeviceId })

    try {
      phone.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      watch.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      await new Promise((r) => setTimeout(r, 100))

      phone.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'home', text: 'open test-app' } },
        }),
      )

      const phoneNav = await waitFor(
        phone.received,
        (buf) => {
          const navs = buf.flatMap((m) => (m.payload.case === 'navigate' ? [m.payload.value] : []))
          return navs.length > 0 ? navs : false
        },
        10_000,
      )
      expect(phoneNav.length).toBeGreaterThanOrEqual(1)

      await new Promise((r) => setTimeout(r, 200))
      const watchNavs = watch.received.flatMap((m) =>
        m.payload.case === 'navigate' ? [m.payload.value] : [],
      )
      expect(watchNavs).toEqual([])

      const phoneRow = components.store.getDevice(phoneDeviceId)!
      const watchRow = components.store.getDevice(watchDeviceId)!
      expect(phoneRow.lastActiveApp).toBe('test-app')
      expect(watchRow.lastActiveApp).toBe('home')
    } finally {
      phone.close()
      watch.close()
    }
  }, 30_000)

  it('per-device voice state is isolated', async () => {
    const phone = await connectDevice(port, 'phone')
    const watch = await connectDevice(port, 'watch')

    try {
      const { voiceRelay, wsServer } = components

      sendAudioFrame(phone, /*final*/ false)
      sendAudioFrame(watch, /*final*/ false)

      await waitForLocal(() => voiceRelay.getState(phone.sessionId) === VoiceStateValue.LISTENING)
      await waitForLocal(() => voiceRelay.getState(watch.sessionId) === VoiceStateValue.LISTENING)
      expect(voiceRelay.getState(phone.sessionId)).toBe(VoiceStateValue.LISTENING)
      expect(voiceRelay.getState(watch.sessionId)).toBe(VoiceStateValue.LISTENING)

      expect(wsServer.getVoiceState(phone.sessionId)).toBe(VoiceStateValue.IDLE)
      expect(wsServer.getVoiceState(watch.sessionId)).toBe(VoiceStateValue.IDLE)

      sendAudioFrame(phone, /*final*/ true)

      const matchThinking = (m: (typeof phone.received)[number]) =>
        m.payload.case === 'voiceState' && m.payload.value.state === VoiceStateValue.THINKING

      await waitForLocal(() => phone.received.some(matchThinking))
      const phoneThinking = phone.received.find(matchThinking)
      expect(phoneThinking).toBeDefined()

      expect(watch.received.some(matchThinking)).toBe(false)

      await waitForLocal(() => wsServer.getVoiceState(phone.sessionId) === VoiceStateValue.THINKING)
      expect(wsServer.getVoiceState(phone.sessionId)).toBe(VoiceStateValue.THINKING)

      expect(voiceRelay.getState(watch.sessionId)).toBe(VoiceStateValue.LISTENING)

      sendAudioFrame(watch, /*final*/ true)
      await waitForLocal(() => watch.received.some(matchThinking))
      expect(watch.received.some(matchThinking)).toBe(true)
    } finally {
      phone.close()
      watch.close()
    }
  }, 15_000)
})
