/**
 * Integration: both `viewing` and `chatInput` write the device's last active
 * app to the devices table for use during reconnect bootstrap.
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
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient, type TestClientHello } from '../helpers/test-client.js'

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-device-focus-write-'))
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

describe('device-focus write path', () => {
  it('viewing writes lastActiveApp to devices row', async () => {
    const deviceId = 'phone-view-' + Math.random().toString(36).slice(2)
    const c = await openClient(port, { deviceId })

    try {
      // Initial connect upserts a row with default home.
      await new Promise((r) => setTimeout(r, 50))
      let row = components.store.getDevice(deviceId)!
      expect(row.lastActiveApp).toBe('home')

      // User swipes to a scope.
      c.send(
        create(ClientMessageSchema, {
          payload: { case: 'viewing', value: { scope: 'app:test-app' } },
        }),
      )
      await new Promise((r) => setTimeout(r, 50))

      row = components.store.getDevice(deviceId)!
      expect(row.lastActiveApp).toBe('test-app')
      expect(row.lastActiveFace).toBeNull()
    } finally {
      c.close()
    }
  }, 10_000)

  it('chatInput updates focus as a safety net (no prior viewing)', async () => {
    const deviceId = 'phone-chat-' + Math.random().toString(36).slice(2)
    const c = await openClient(port, { deviceId })

    try {
      await new Promise((r) => setTimeout(r, 50))
      // No prior viewing; chatInput alone must update focus.
      c.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'app:test-app', text: 'hi' } },
        }),
      )
      await new Promise((r) => setTimeout(r, 100))

      const row = components.store.getDevice(deviceId)!
      expect(row.lastActiveApp).toBe('test-app')
    } finally {
      c.close()
    }
  }, 10_000)

  it("home scope writes 'home' as lastActiveApp", async () => {
    const deviceId = 'phone-home-' + Math.random().toString(36).slice(2)
    const c = await openClient(port, { deviceId })

    try {
      await new Promise((r) => setTimeout(r, 50))
      c.send(
        create(ClientMessageSchema, {
          payload: { case: 'viewing', value: { scope: 'home' } },
        }),
      )
      await new Promise((r) => setTimeout(r, 50))

      const row = components.store.getDevice(deviceId)!
      expect(row.lastActiveApp).toBe('home')
    } finally {
      c.close()
    }
  }, 10_000)
})
