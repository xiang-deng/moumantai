/** Integration: bootstrap pushes the client's pre-disconnect active app. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import {
  DeviceClass,
  DeviceShape,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient, type TestClientHello } from '../helpers/test-client.js'

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

async function connectWith(
  port: number,
  helloExtras: Partial<TestClientHello> = {},
): Promise<{ client: TestClient; received: ServerMessage[] }> {
  const client = await TestClient.connect(port, {
    hello: {
      deviceClass: DeviceClass.PHONE,
      deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
      ...helloExtras,
    },
  })
  await waitForIdle(client.received)
  return { client, received: client.received }
}

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-bootstrap-nav-'))
  components = await createAppServer({
    adapterOverride: await connectMockAdapter(),
    port: 0,
    home,
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

function appIdsOf<T extends 'faceList' | 'faceUpdate'>(
  received: ServerMessage[],
  caseName: T,
): string[] {
  return received.flatMap((m) => (m.payload.case === caseName ? [m.payload.value.appId] : []))
}

describe('sendInitialState honors ClientHello.currentAppId', () => {
  it('omitted currentAppId: bootstraps only home (not spend-tracker)', async () => {
    const { client, received } = await connectWith(port)
    try {
      // hello-ok consumed during connect(); appList arrives post-handshake.
      const appList = received.find((m) => m.payload.case === 'appList')
      expect(appList).toBeTruthy()
      expect(client.sessionId).toBeTruthy()

      // The initial appList must carry per-app `themeSeed`; spend-tracker declares
      // a manifest color so its seed must be non-empty. Value not asserted to
      // avoid importing from apps/.

      const apps = appList?.payload.case === 'appList' ? appList.payload.value.apps : []
      const spend = apps.find((a) => a.appId === 'spend-tracker')
      expect(spend?.themeSeed).toBeTruthy()

      const faceListApps = appIdsOf(received, 'faceList')
      expect(faceListApps).toContain('home')
      expect(faceListApps).not.toContain('spend-tracker')

      const faceUpdateApps = new Set(appIdsOf(received, 'faceUpdate'))
      expect(faceUpdateApps.has('home')).toBe(true)
      expect(faceUpdateApps.has('spend-tracker')).toBe(false)
    } finally {
      client.close()
    }
  })

  it('currentAppId=spend-tracker: bootstraps home AND spend-tracker', async () => {
    const { client, received } = await connectWith(port, { currentAppId: 'spend-tracker' })
    try {
      const faceListApps = appIdsOf(received, 'faceList')
      expect(faceListApps).toContain('home')
      expect(faceListApps).toContain('spend-tracker')

      const faceUpdateApps = new Set(appIdsOf(received, 'faceUpdate'))
      expect(faceUpdateApps.has('home')).toBe(true)
      expect(faceUpdateApps.has('spend-tracker')).toBe(true)

      for (const appId of faceListApps) {
        const updatesForApp = received.filter(
          (m) => m.payload.case === 'faceUpdate' && m.payload.value.appId === appId,
        )
        expect(updatesForApp.length).toBeGreaterThan(0)
      }
    } finally {
      client.close()
    }
  })

  it('unknown currentAppId is silently skipped (no crash, only home bootstrapped)', async () => {
    const { client, received } = await connectWith(port, { currentAppId: 'does-not-exist' })
    try {
      // hello-ok consumed by connect(); assert no crash and home still bootstraps.
      expect(client.sessionId).toBeTruthy()

      const faceListApps = appIdsOf(received, 'faceList')
      expect(faceListApps).toContain('home')
      expect(faceListApps).not.toContain('does-not-exist')
    } finally {
      client.close()
    }
  })

  it('currentAppId="home" behaves the same as omitted (no duplicate home bootstrap)', async () => {
    const { client, received } = await connectWith(port, { currentAppId: 'home' })
    try {
      // home must be pushed exactly once.
      const homeFaceLists = received.filter(
        (m) => m.payload.case === 'faceList' && m.payload.value.appId === 'home',
      )
      expect(homeFaceLists).toHaveLength(1)

      // Neighbor prefetch may push additional faceLists, but must not duplicate home.
      const faceListApps = appIdsOf(received, 'faceList')
      expect(faceListApps).toContain('home')
      expect(faceListApps.filter((id) => id === 'home')).toHaveLength(1)
    } finally {
      client.close()
    }
  })
})
