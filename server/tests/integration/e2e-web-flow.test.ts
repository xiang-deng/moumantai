/**
 * E2E web flow: client → WS server → mock LLM.
 * Real `createAppServer`, real WebSocket (via `ws`), zero-latency mock adapter.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  ChatRole,
  ClientMessageSchema,
  DeviceClass,
  DeviceShape,
  ServerMessageSchema,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient } from '../helpers/test-client.js'

/** Poll until a predicate matches a buffered message, or `timeoutMs` elapses. */
async function waitFor(
  buf: ServerMessage[],
  pred: (m: ServerMessage) => boolean,
  timeoutMs = 5000,
): Promise<ServerMessage | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const m = buf.find(pred)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  return undefined
}

async function waitForIdle(buf: ServerMessage[], idleMs = 300, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  let lastLen = -1
  let stableSince = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (buf.length !== lastLen) {
      lastLen = buf.length
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= idleMs) {
      return
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function connectClient(port: number): Promise<TestClient> {
  return TestClient.connect(port, {
    hello: {
      deviceClass: DeviceClass.PHONE,
      deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
    },
  })
}

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-e2e-web-'))
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

describe('E2E web flow: HTTP health endpoint', () => {
  it('health endpoint returns OK with app list', async () => {
    const res = await fetch(`http://127.0.0.1:${port}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['version']).toBe('1')
    expect(body['backend']).toBe('claude')
    expect(Array.isArray(body['apps'])).toBe(true)
    const apps = body['apps'] as string[]
    expect(apps).toContain('home')
    expect(apps).toContain('test-app')
  })

  it('home app is registered and available in the engine', async () => {
    const manifests = components.appEngine.listApps()
    const homeManifest = manifests.find((m) => m.id === 'home')
    expect(homeManifest).toBeDefined()
    expect(homeManifest!.name).toBe('Home')
    const res = await fetch(`http://127.0.0.1:${port}`)
    const body = (await res.json()) as Record<string, unknown>
    expect((body['apps'] as string[]).includes('home')).toBe(true)
  })
})

describe('E2E web flow: client → WS server → mock LLM', () => {
  it('WebSocket handshake succeeds and returns a session ID', async () => {
    const c = await connectClient(port)
    try {
      expect(typeof c.sessionId).toBe('string')
      expect(c.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      c.close()
    }
  })

  it('server sends appList after handshake', async () => {
    const c = await connectClient(port)
    try {
      await waitForIdle(c.received)
      const appListMsg = c.received.find((m) => m.payload.case === 'appList')
      expect(appListMsg).toBeDefined()
      if (appListMsg?.payload.case !== 'appList') return
      expect(appListMsg.payload.value.apps.length).toBeGreaterThanOrEqual(1)
      expect(appListMsg.payload.value.apps.some((a) => a.appId === 'home')).toBe(true)
    } finally {
      c.close()
    }
  })

  it('server sends faceList for home app after handshake', async () => {
    const c = await connectClient(port)
    try {
      await waitForIdle(c.received)
      const faceListMsg = c.received.find(
        (m) => m.payload.case === 'faceList' && m.payload.value.appId === 'home',
      )
      expect(faceListMsg).toBeDefined()
      if (faceListMsg?.payload.case !== 'faceList') return
      expect(faceListMsg.payload.value.faces.length).toBeGreaterThan(0)
    } finally {
      c.close()
    }
  })

  it('server sends faceUpdate with resolved data after boot', async () => {
    const c = await connectClient(port)
    try {
      await waitForIdle(c.received)
      const faceUpdateMsgs = c.received.filter((m) => m.payload.case === 'faceUpdate')
      expect(faceUpdateMsgs.length).toBeGreaterThanOrEqual(1)
      const first = faceUpdateMsgs[0]!
      if (first.payload.case !== 'faceUpdate') return
      expect(first.payload.value.appId).toBeDefined()
      expect(first.payload.value.faceId).toBeDefined()
    } finally {
      c.close()
    }
  })

  it('chat message round-trip: chatInput is processed by the server', async () => {
    const c = await connectClient(port)
    try {
      c.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'home', text: 'hello' } },
        }),
      )
      const chatResponse = await waitFor(
        c.received,
        (m) => m.payload.case === 'chat' && m.payload.value.role === ChatRole.ASSISTANT,
        5000,
      )
      expect(chatResponse).toBeDefined()
      if (chatResponse?.payload.case !== 'chat') return
      expect(chatResponse.payload.value.text.length).toBeGreaterThan(0)
    } finally {
      c.close()
    }
  })

  it('multiple chat messages are stored in order', async () => {
    const c = await connectClient(port)
    try {
      const texts = ['first', 'second', 'third']
      for (const text of texts) {
        c.send(
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text } },
          }),
        )
        await new Promise((r) => setTimeout(r, 50))
      }
      await new Promise((r) => setTimeout(r, 1000))

      const window = components.store.getWindow('home')
      const ourMessages = window.entries.filter((m) => m.role === 'user' && texts.includes(m.text))
      expect(ourMessages).toHaveLength(3)
      expect(ourMessages[0]!.text).toBe(texts[0])
      expect(ourMessages[1]!.text).toBe(texts[1])
      expect(ourMessages[2]!.text).toBe(texts[2])
    } finally {
      c.close()
    }
  })

  it('invalid ClientHello (bad deviceClass) results in connection close', async () => {
    // UNSPECIFIED deviceClass (proto enum 0) → rejected with close code 4002.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['moumantai.v1.proto'])
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() })
      })
    })

    const helloBytes = toBinary(
      ClientMessageSchema,
      create(ClientMessageSchema, {
        payload: {
          case: 'hello',
          value: {
            deviceClass: DeviceClass.UNSPECIFIED,
            deviceProfile: { width: 100, height: 100, shape: DeviceShape.RECT },
          },
        },
      }),
    )
    ws.send(helloBytes)

    const { code, reason } = await closePromise
    expect(code).toBe(4002)
    expect(reason).toBe('Invalid ClientHello')
  })

  it('messages before handshake are ignored (no crash)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['moumantai.v1.proto'])
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    try {
      // Non-hello before handshake — server must ignore without crashing.
      const premature = toBinary(
        ClientMessageSchema,
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'test', text: 'premature' } },
        }),
      )
      ws.send(premature)
      await new Promise((r) => setTimeout(r, 50))

      // Proper handshake must still succeed.
      const got = new Promise<ServerMessage | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 3000)
        ws.on('message', (data, isBinary) => {
          if (!isBinary) return
          let decoded: ServerMessage
          try {
            decoded = fromBinary(ServerMessageSchema, data as Uint8Array)
          } catch {
            return
          }
          if (decoded.payload.case === 'helloOk') {
            clearTimeout(t)
            resolve(decoded)
          }
        })
      })
      ws.send(
        toBinary(
          ClientMessageSchema,
          create(ClientMessageSchema, {
            payload: {
              case: 'hello',
              value: {
                deviceClass: DeviceClass.PHONE,
                deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
              },
            },
          }),
        ),
      )
      const helloOk = await got
      expect(helloOk).not.toBeNull()
    } finally {
      ws.close()
    }
  })

  it('chat routes to the app named in scope (not to home) even without prior viewing', async () => {
    const c = await connectClient(port)
    try {
      const text = `route-test-${Date.now()}`
      c.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'app:test-app', text } },
        }),
      )
      const chatResponse = await waitFor(
        c.received,
        (m) => m.payload.case === 'chat' && m.payload.value.role === ChatRole.ASSISTANT,
        5000,
      )
      expect(chatResponse).toBeDefined()
      if (chatResponse?.payload.case !== 'chat') return
      expect(chatResponse.payload.value.scope).toBe('app:test-app')

      const appWindow = components.store.getWindow('app:test-app')
      expect(appWindow.entries.some((m) => m.role === 'user' && m.text === text)).toBe(true)
      const homeWindow = components.store.getWindow('home')
      expect(homeWindow.entries.some((m) => m.role === 'user' && m.text === text)).toBe(false)
    } finally {
      c.close()
    }
  })

  it('viewing message triggers faceList response for the new scope', async () => {
    const c = await connectClient(port)
    try {
      await waitForIdle(c.received)
      c.send(
        create(ClientMessageSchema, {
          payload: { case: 'viewing', value: { scope: 'app:test-app' } },
        }),
      )
      const faceListMsg = await waitFor(
        c.received,
        (m) => m.payload.case === 'faceList' && m.payload.value.appId === 'test-app',
        3000,
      )
      expect(faceListMsg).toBeDefined()
    } finally {
      c.close()
    }
  })

  it('server handles concurrent connections', async () => {
    const c1 = await connectClient(port)
    const c2 = await connectClient(port)
    try {
      expect(c1.sessionId).not.toBe(c2.sessionId)
      await waitForIdle(c1.received)
      await waitForIdle(c2.received)
      expect(c1.received.length).toBeGreaterThan(0)
      expect(c2.received.length).toBeGreaterThan(0)
      expect(components.wsServer.getClientCount()).toBeGreaterThanOrEqual(2)
    } finally {
      c1.close()
      c2.close()
    }
  })

  it('disconnect is handled gracefully', async () => {
    const c = await connectClient(port)
    const sid = c.sessionId
    c.close()
    await new Promise((r) => setTimeout(r, 200))
    const client = components.wsServer.getClient(sid)
    if (client) {
      expect(client.ws.readyState).toBe(WebSocket.CLOSED)
    }
  })
})
