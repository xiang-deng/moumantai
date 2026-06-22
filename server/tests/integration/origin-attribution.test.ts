/** Integration: `originDeviceId` is set on user-row broadcasts and survives persistence. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import { create } from '@bufbuild/protobuf'
import {
  ChatRole,
  ClientMessageSchema,
  DeviceClass,
  DeviceShape,
  type ChatMessage,
  type ChatWindowEntry,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient, waitFor, type TestClientHello } from '../helpers/test-client.js'

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

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-origin-attribution-'))
  components = await createAppServer({ adapterOverride: await connectMockAdapter(), port: 0, home })
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

describe('origin attribution on broadcast chat frames', () => {
  it("client B sees A's user row stamped with both A.sessionId AND A.deviceId; assistant row omits both", async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))

    const aDeviceId = 'phone-a-' + Math.random().toString(36).slice(2)
    const a = await openClient(port, { deviceId: aDeviceId })
    const b = await openClient(port, { deviceId: 'phone-b-' + Math.random().toString(36).slice(2) })

    try {
      a.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      b.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      await new Promise((r) => setTimeout(r, 50))

      a.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'home', text: 'from A' } },
        }),
      )

      const chats = await waitFor(
        b.received,
        (buf) => {
          const cs = buf.flatMap((m) =>
            m.payload.case === 'chat' ? [m.payload.value] : [],
          ) as ChatMessage[]
          const hasUser = cs.some((m) => m.role === ChatRole.USER && m.text === 'from A')
          const hasAsst = cs.some((m) => m.role === ChatRole.ASSISTANT)
          return hasUser && hasAsst ? cs : false
        },
        10_000,
      )

      const userFrame = chats.find((m) => m.role === ChatRole.USER && m.text === 'from A')!
      const asstFrame = chats.find((m) => m.role === ChatRole.ASSISTANT)!

      expect(userFrame.originDeviceId).toBe(aDeviceId)
      expect(asstFrame.originDeviceId).toBeFalsy()

      // Self-echo carries the field too.
      const echoChats = await waitFor(
        a.received,
        (buf) => {
          const cs = buf.flatMap((m) =>
            m.payload.case === 'chat' && m.payload.value.role === ChatRole.USER
              ? [m.payload.value]
              : [],
          ) as ChatMessage[]
          return cs.length > 0 ? cs : false
        },
        5_000,
      )
      expect(echoChats[0]!.originDeviceId).toBe(aDeviceId)
    } finally {
      a.close()
      b.close()
    }
  }, 20_000)

  it('chatUpdate frames carry originDeviceId', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))

    const aDeviceId = 'phone-a2-' + Math.random().toString(36).slice(2)
    const a = await openClient(port, { deviceId: aDeviceId })
    const b = await openClient(port, {
      deviceId: 'phone-b2-' + Math.random().toString(36).slice(2),
    })

    try {
      a.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      b.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      await new Promise((r) => setTimeout(r, 50))

      a.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'home', text: 'watch what happens' } },
        }),
      )

      const updates = await waitFor(
        b.received,
        (buf) => {
          const us = buf.flatMap((m) => (m.payload.case === 'chatUpdate' ? [m.payload.value] : []))
          const hasAsst = buf.some(
            (m) => m.payload.case === 'chat' && m.payload.value.role === ChatRole.ASSISTANT,
          )
          return us.length >= 1 && hasAsst ? us : false
        },
        10_000,
      )

      for (const u of updates) {
        expect(u.originDeviceId).toBe(aDeviceId)
      }
    } finally {
      a.close()
      b.close()
    }
  }, 20_000)

  it('reconnect: fresh chatWindow carries both attribution fields from DB', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))

    const aDeviceId = 'phone-persist-' + Math.random().toString(36).slice(2)
    const a = await openClient(port, { deviceId: aDeviceId })
    const bOrig = await openClient(port, {
      deviceId: 'phone-bOrig-' + Math.random().toString(36).slice(2),
    })

    try {
      a.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      bOrig.send(
        create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
      )
      await new Promise((r) => setTimeout(r, 50))

      a.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'home', text: 'persist me' } },
        }),
      )

      await waitFor(
        bOrig.received,
        (buf) => {
          const hasUser = buf.some(
            (m) =>
              m.payload.case === 'chat' &&
              m.payload.value.role === ChatRole.USER &&
              m.payload.value.text === 'persist me',
          )
          const hasAsst = buf.some(
            (m) => m.payload.case === 'chat' && m.payload.value.role === ChatRole.ASSISTANT,
          )
          return hasUser && hasAsst
        },
        10_000,
      )

      bOrig.close()
      await new Promise((r) => setTimeout(r, 50))

      const bFresh = await openClient(port, {
        deviceId: 'phone-bFresh-' + Math.random().toString(36).slice(2),
      })
      try {
        const entries = await waitFor(
          bFresh.received,
          (buf) => {
            for (const m of buf) {
              if (m.payload.case === 'chatWindow' && m.payload.value.scope === 'home') {
                return m.payload.value.entries as ChatWindowEntry[]
              }
            }
            return false
          },
          5_000,
        )

        const userEntry = entries.find((e) => e.role === ChatRole.USER && e.text === 'persist me')
        expect(userEntry).toBeDefined()
        expect(userEntry!.originDeviceId).toBe(aDeviceId)

        const asstEntry = entries.find((e) => e.role === ChatRole.ASSISTANT)
        expect(asstEntry).toBeDefined()
        expect(asstEntry!.originDeviceId).toBeFalsy()
      } finally {
        bFresh.close()
      }
    } finally {
      a.close()
    }
  }, 30_000)
})
