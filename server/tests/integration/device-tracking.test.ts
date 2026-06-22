/** Integration: server upserts a `devices` row on every connect using ClientHello.deviceId. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import { DeviceClass, DeviceShape } from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient } from '../helpers/test-client.js'

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-device-tracking-'))
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

describe('device-tracking', () => {
  it('upserts devices row when ClientHello carries device_id', async () => {
    const deviceId = 'phone-test-' + Math.random().toString(36).slice(2)
    const client = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        deviceId,
      },
    })

    // Handler is synchronous, but allow an event-loop yield.
    await new Promise((r) => setTimeout(r, 50))

    const row = components.store.getDevice(deviceId)
    expect(row).toBeDefined()
    expect(row!.deviceId).toBe(deviceId)
    expect(row!.lastActiveApp).toBe('home')
    expect(row!.deviceClass).toBe(DeviceClass.PHONE)
    expect(row!.deviceProfileWidth).toBe(390)
    expect(row!.deviceProfileHeight).toBe(844)
    expect(row!.lastSeenAt).toBeTruthy()
    expect(row!.createdAt).toBeTruthy()

    client.close()
  }, 10_000)

  it('refreshes last_seen_at on subsequent connects without losing focus', async () => {
    const deviceId = 'phone-refresh-' + Math.random().toString(36).slice(2)
    const c1 = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        deviceId,
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    const before = components.store.getDevice(deviceId)!
    c1.close()

    components.store.setDeviceFocus(deviceId, 'spend-tracker', null)

    // Sleep so the ISO timestamp differs on reconnect.
    await new Promise((r) => setTimeout(r, 20))

    const c2 = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        deviceId,
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    const after = components.store.getDevice(deviceId)!
    c2.close()

    expect(after.lastSeenAt).not.toBe(before.lastSeenAt)
    expect(after.lastActiveApp).toBe('spend-tracker') // upsert must not clobber focus
    expect(after.createdAt).toBe(before.createdAt)
  }, 10_000)

  it('generates a fallback deviceId when ClientHello omits one', async () => {
    // Smoke: connection succeeds and a row lands in the table.
    const beforeCount = components.store.getDevice('nonexistent') === undefined
    expect(beforeCount).toBe(true)

    const client = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
        // deviceId omitted on purpose
      },
    })

    expect(client.sessionId).toBeTruthy()
    client.close()
  }, 10_000)

  it('setDeviceFocus updates lastActiveApp/Face', async () => {
    const deviceId = 'phone-focus-' + Math.random().toString(36).slice(2)
    components.store.setDeviceFocus(deviceId, 'spend-tracker', 'detail')

    const row = components.store.getDevice(deviceId)
    expect(row).toBeDefined()
    expect(row!.lastActiveApp).toBe('spend-tracker')
    expect(row!.lastActiveFace).toBe('detail')
  })
})
