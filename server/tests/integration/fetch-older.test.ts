/**
 * Integration: fetchOlder pagination — FetchOlderMsg → ChatHistoryMsg round-trip.
 * Pages through 200 messages at 50/page; asserts hasMore and edge cases
 * (beforeSeq=0, beyond oldest, exact boundary, limit clamp).
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
  DeviceClass,
  DeviceShape,
  type ChatHistoryMsg,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient, waitFor } from '../helpers/test-client.js'

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-fetch-older-'))
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

async function expectHistory(
  client: TestClient,
  predicate?: (m: ChatHistoryMsg) => boolean,
): Promise<ChatHistoryMsg> {
  return waitFor(
    client.received,
    (buf) => {
      for (const m of buf) {
        if (m.payload.case === 'chatHistory' && (!predicate || predicate(m.payload.value))) {
          return m.payload.value
        }
      }
      return false
    },
    5_000,
  )
}

describe('fetchOlder pagination', () => {
  it('paginates 200 messages in 50-entry pages with hasMore flag', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))

    const conv = components.store.getActive('home')
    for (let i = 0; i < 200; i++) {
      components.store.appendTurn(conv.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `entry-${i}`,
      })
    }

    const client = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        deviceId: 'phone-fetch-' + Math.random().toString(36).slice(2),
      },
    })

    try {
      // Page 1: 50 entries below seq=151 → entries 100–149.
      client.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'fetchOlder',
            value: { scope: 'home', beforeSeq: BigInt(151), limit: 50 },
          },
        }),
      )
      const page1 = await expectHistory(client)
      expect(page1.entries).toHaveLength(50)
      expect(page1.hasMore).toBe(true)
      expect(page1.entries[0]!.text).toBe('entry-100')
      expect(page1.entries.at(-1)!.text).toBe('entry-149')

      // Page 2: from oldest of page 1 → entries 50–99.
      client.received.length = 0
      const oldestSeq = Number(page1.entries[0]!.seq)
      client.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'fetchOlder',
            value: { scope: 'home', beforeSeq: BigInt(oldestSeq), limit: 50 },
          },
        }),
      )
      const page2 = await expectHistory(client)
      expect(page2.entries).toHaveLength(50)
      expect(page2.hasMore).toBe(true)
      expect(page2.entries.at(-1)!.text).toBe(`entry-${oldestSeq - 2}`)

      // Page 3: from oldest of page 2 → entries 0–49.
      client.received.length = 0
      const oldest2 = Number(page2.entries[0]!.seq)
      client.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'fetchOlder',
            value: { scope: 'home', beforeSeq: BigInt(oldest2), limit: 50 },
          },
        }),
      )
      const page3 = await expectHistory(client)
      expect(page3.entries.length).toBeGreaterThan(0)
      expect(page3.hasMore).toBe(false) // reached start
    } finally {
      client.close()
    }
  }, 20_000)

  it('beforeSeq=0 returns the newest page (same as default chatWindow)', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))
    const conv = components.store.getActive('home')
    for (let i = 0; i < 30; i++) {
      components.store.appendTurn(conv.id, { role: 'user', text: `e-${i}` })
    }

    const client = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        deviceId: 'phone-bz-' + Math.random().toString(36).slice(2),
      },
    })
    try {
      client.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'fetchOlder',
            value: { scope: 'home', beforeSeq: BigInt(0), limit: 50 },
          },
        }),
      )
      const page = await expectHistory(client)
      expect(page.entries).toHaveLength(30)
      expect(page.hasMore).toBe(false)
      expect(page.entries[0]!.text).toBe('e-0')
      expect(page.entries.at(-1)!.text).toBe('e-29')
    } finally {
      client.close()
    }
  }, 15_000)

  it('beforeSeq below oldest returns empty with hasMore=false', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))
    const conv = components.store.getActive('home')
    for (let i = 0; i < 5; i++) {
      components.store.appendTurn(conv.id, { role: 'user', text: `e-${i}` })
    }

    const client = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        deviceId: 'phone-edge-' + Math.random().toString(36).slice(2),
      },
    })
    try {
      // Seq starts at 1; beforeSeq=1 returns nothing.
      client.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'fetchOlder',
            value: { scope: 'home', beforeSeq: BigInt(1), limit: 50 },
          },
        }),
      )
      const page = await expectHistory(client)
      expect(page.entries).toHaveLength(0)
      expect(page.hasMore).toBe(false)
    } finally {
      client.close()
    }
  }, 15_000)

  it('limit clamped to 200 max', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 50))
    const conv = components.store.getActive('home')
    for (let i = 0; i < 250; i++) {
      components.store.appendTurn(conv.id, { role: 'user', text: `e-${i}` })
    }

    const client = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        deviceId: 'phone-clamp-' + Math.random().toString(36).slice(2),
      },
    })
    try {
      client.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'fetchOlder',
            value: { scope: 'home', beforeSeq: BigInt(0), limit: 9999 },
          },
        }),
      )
      const page = await expectHistory(client)
      expect(page.entries.length).toBe(200)
      expect(page.hasMore).toBe(true)
    } finally {
      client.close()
    }
  }, 15_000)
})
