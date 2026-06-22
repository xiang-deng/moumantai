/**
 * Integration: device pairing gate with `pairingRequired: true`.
 *
 * Unknown devices are rejected with PAIRING_REQUIRED (4008). While an enrollment
 * window is open they are also recorded as PENDING for operator approval; without
 * a window they are rejected-and-forgotten. Approval flips the flag; the next
 * reconnect succeeds.
 *
 * Uses raw sockets (not TestClient) because rejected handshakes never send helloOk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import { WebSocket } from 'ws'
import { fromBinary, toBinary, create } from '@bufbuild/protobuf'
import {
  ClientMessageSchema,
  ServerMessageSchema,
  CloseCode,
  DeviceClass,
  DeviceShape,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { openPairingWindow, closePairingWindow } from '../../src/server/workspace/pairing-window.js'

interface HelloOverride {
  deviceClass?: DeviceClass
  deviceId?: string
  omitDeviceProfile?: boolean
  userAgent?: string
}

interface AttemptResult {
  ok: boolean
  code?: number
  sessionId?: string
}

/** Open a socket, send one hello, resolve on helloOk (ok) or close (rejected). */
function attempt(port: number, hello: HelloOverride = {}): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['moumantai.v1.proto'], {
      headers: hello.userAgent ? { 'User-Agent': hello.userAgent } : {},
    })
    let settled = false
    const done = (r: AttemptResult): void => {
      if (settled) return
      settled = true
      resolve(r)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      let msg
      try {
        msg = fromBinary(ServerMessageSchema, data as Uint8Array)
      } catch {
        return
      }
      if (msg.payload.case === 'helloOk') done({ ok: true, sessionId: msg.payload.value.sessionId })
    })
    ws.on('open', () => {
      const value = {
        deviceClass: hello.deviceClass ?? DeviceClass.PHONE,
        ...(hello.omitDeviceProfile
          ? {}
          : { deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT } }),
        ...(hello.deviceId !== undefined ? { deviceId: hello.deviceId } : {}),
      }
      ws.send(
        toBinary(
          ClientMessageSchema,
          create(ClientMessageSchema, { payload: { case: 'hello', value } }),
        ),
      )
    })
    ws.on('close', (code) => done({ ok: false, code }))
    ws.on('error', () => done({ ok: false, code: -1 }))
  })
}

async function startServer(opts: { pairingRequired: boolean }): Promise<{
  components: ServerComponents
  httpServer: HttpServer
  port: number
  home: string
}> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-pairing-'))
  const components = await createAppServer({
    adapterOverride: await connectMockAdapter(),
    port: 0,
    home,
    appDirs: ['tests/fixtures'],
    pairingRequired: opts.pairingRequired,
  })
  const httpServer = components.httpServer
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const port = (httpServer.address() as AddressInfo).port
  return { components, httpServer, port, home }
}

describe('device pairing (pairingRequired = true, window closed by default)', () => {
  let components: ServerComponents
  let httpServer: HttpServer
  let port: number
  let home: string

  beforeAll(async () => {
    ;({ components, httpServer, port, home } = await startServer({ pairingRequired: true }))
  }, 15_000)

  afterAll(async () => {
    closePairingWindow(home)
    components.appEngine.shutdown()
    await components.wsServer.close()
    await components.adapter.disconnect()
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    )
  }, 10_000)

  it('window CLOSED: unknown device is rejected AND not recorded (reject-and-forget)', async () => {
    const deviceId = 'closed-' + Math.random().toString(36).slice(2)
    const r = await attempt(port, { deviceId })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(CloseCode.PAIRING_REQUIRED)
    await new Promise((res) => setTimeout(res, 30))
    expect(components.store.getDevice(deviceId)).toBeUndefined() // no junk row
  }, 10_000)

  it('window OPEN: unknown device is recorded as pending (with its UA), then approve → connects', async () => {
    const deviceId = 'open-' + Math.random().toString(36).slice(2)
    openPairingWindow(home, 5)
    try {
      const r = await attempt(port, { deviceId, userAgent: 'test-agent/1.0' })
      expect(r.code).toBe(CloseCode.PAIRING_REQUIRED) // still rejected at connect…
      await new Promise((res) => setTimeout(res, 30))
      const row = components.store.getDevice(deviceId)
      expect(row).toBeDefined() // …but recorded so the operator can approve
      expect(row!.paired).toBe(false)
      expect(row!.deviceUa).toBe('test-agent/1.0') // UA captured at handshake time

      // Operator approves.
      components.store.setDevicePaired(deviceId, true, 'My Phone')
      const ok = await attempt(port, { deviceId })
      expect(ok.ok).toBe(true)
      expect(ok.sessionId).toBeTruthy()
    } finally {
      closePairingWindow(home)
    }
  }, 15_000)

  it('revoke → next connect rejected again; forget → row deleted', async () => {
    const deviceId = 'rev-' + Math.random().toString(36).slice(2)
    components.store.setDevicePaired(deviceId, true) // pre-approve (creates the row)
    expect((await attempt(port, { deviceId })).ok).toBe(true)

    components.store.setDevicePaired(deviceId, false)
    expect((await attempt(port, { deviceId })).code).toBe(CloseCode.PAIRING_REQUIRED)
    expect(components.store.getDevice(deviceId)).toBeDefined() // revoke keeps the row

    expect(components.store.forgetDevice(deviceId)).toBe(true)
    expect(components.store.getDevice(deviceId)).toBeUndefined()
  }, 15_000)

  it('empty-deviceId hello is rejected without leaving an orphan row', async () => {
    openPairingWindow(home, 5) // window open, but an id-less device is unpairable
    try {
      const before = components.store.listDevices({ includeOldPending: true }).length
      const r = await attempt(port, { deviceId: '' })
      expect(r.ok).toBe(false)
      expect(r.code).toBe(CloseCode.PAIRING_REQUIRED)
      await new Promise((res) => setTimeout(res, 30))
      expect(components.store.listDevices({ includeOldPending: true }).length).toBe(before)
    } finally {
      closePairingWindow(home)
    }
  }, 10_000)

  it('a malformed hello still gets INVALID_HELLO, not PAIRING_REQUIRED (ordering)', async () => {
    const r = await attempt(port, { deviceClass: DeviceClass.UNSPECIFIED, deviceId: 'bad' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(CloseCode.INVALID_HELLO)
  }, 10_000)
})

describe('device pairing (pairingRequired = false)', () => {
  let components: ServerComponents
  let httpServer: HttpServer
  let port: number

  beforeAll(async () => {
    ;({ components, httpServer, port } = await startServer({ pairingRequired: false }))
  }, 15_000)

  afterAll(async () => {
    components.appEngine.shutdown()
    await components.wsServer.close()
    await components.adapter.disconnect()
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    )
  }, 10_000)

  it('accepts an unknown device but records it as not-paired', async () => {
    const deviceId = 'nopair-' + Math.random().toString(36).slice(2)
    const r = await attempt(port, { deviceId })
    expect(r.ok).toBe(true)
    await new Promise((res) => setTimeout(res, 30))
    const row = components.store.getDevice(deviceId)
    expect(row).toBeDefined()
    expect(row!.paired).toBe(false) // gate bypassed, but flag left false
  }, 10_000)
})
