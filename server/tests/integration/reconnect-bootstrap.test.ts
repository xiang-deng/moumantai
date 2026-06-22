/**
 * Integration: reconnecting client sees face-state that landed while offline.
 * DB mutations bypass the agent loop to focus purely on bootstrap behavior.
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
  type FaceUpdateMsg,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { notes } from '../fixtures/test-app/schema.js'
import { TestClient, type TestClientHello } from '../helpers/test-client.js'

const APP_ID = 'test-app'
const FACE_ID = 'notes-list'
const SCOPE = `app:${APP_ID}`

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

async function waitFor<T>(
  fn: () => T | false | undefined,
  timeoutMs = 5000,
  label = '',
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${label ? ' [' + label + ']' : ''}`)
}

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-reconnect-bootstrap-'))
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

function notesListUpdate(received: TestClient['received']): FaceUpdateMsg | undefined {
  for (let i = received.length - 1; i >= 0; i--) {
    const m = received[i]!
    if (
      m.payload.case === 'faceUpdate' &&
      m.payload.value.appId === APP_ID &&
      m.payload.value.faceId === FACE_ID
    ) {
      return m.payload.value
    }
  }
  return undefined
}

function totalFromUpdate(update: FaceUpdateMsg | undefined): number | undefined {
  return (update?.data as { total?: number } | undefined)?.total
}

describe('reconnect face-state recovery (server-SSOT)', () => {
  it('reconnect with same deviceId + currentAppId bootstraps post-offline face state', async () => {
    const app = await components.appEngine.use(APP_ID)
    app.db.delete(notes).run()

    const deviceId = 'phone-reconnect-' + Math.random().toString(36).slice(2)

    const phone = await openClient(port, { deviceId })
    phone.send(
      create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: SCOPE } } }),
    )
    await waitFor(
      () => totalFromUpdate(notesListUpdate(phone.received)) === 0,
      5000,
      'initial total=0',
    )

    // Insert directly — no broadcast fires.
    app.db.insert(notes).values({ content: 'first', category: 'work' }).run()

    phone.close()
    await new Promise((r) => setTimeout(r, 200))

    // Mutation while disconnected.
    app.db.insert(notes).values({ content: 'offline-write', category: 'personal' }).run()
    expect(app.db.select().from(notes).all()).toHaveLength(2)

    // Reconnect: server identifies device by deviceId; currentAppId is a nav hint.
    const resumed = await openClient(port, {
      deviceId,
      currentAppId: APP_ID,
    })
    try {
      await waitFor(
        () => {
          const faceListApps = new Set(
            resumed.received.flatMap((m) =>
              m.payload.case === 'faceList' ? [m.payload.value.appId] : [],
            ),
          )
          return faceListApps.has('home') && faceListApps.has(APP_ID)
        },
        5000,
        'bootstrap faceLists',
      )

      await waitFor(
        () => totalFromUpdate(notesListUpdate(resumed.received)) === 2,
        5000,
        'post-offline face update with total=2',
      )

      expect(resumed.received.some((m) => m.payload.case === 'appList')).toBe(true)
    } finally {
      resumed.close()
    }
  }, 20_000)

  it('reconnect WITHOUT currentAppId bootstraps from devices.last_active_app (server-SSOT)', async () => {
    // Server reads scope from devices.last_active_app (written by the prior viewing), not from the client.
    const app = await components.appEngine.use(APP_ID)
    app.db.delete(notes).run()

    const deviceId = 'phone-ssot-' + Math.random().toString(36).slice(2)

    const phone = await openClient(port, { deviceId })
    phone.send(
      create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: SCOPE } } }),
    )
    await waitFor(
      () => totalFromUpdate(notesListUpdate(phone.received)) === 0,
      5000,
      'initial total=0',
    )
    phone.close()
    await new Promise((r) => setTimeout(r, 100))

    app.db.insert(notes).values({ content: 'while-disconnected', category: 'work' }).run()

    // Reconnect without currentAppId — server must read scope from devices table.
    const resumed = await openClient(port, { deviceId })
    try {
      await waitFor(
        () => {
          const faceListApps = new Set(
            resumed.received.flatMap((m) =>
              m.payload.case === 'faceList' ? [m.payload.value.appId] : [],
            ),
          )
          return faceListApps.has(APP_ID)
        },
        5000,
        'bootstrap faceLists from server-SSOT',
      )

      await waitFor(
        () => totalFromUpdate(notesListUpdate(resumed.received)) === 1,
        5000,
        'face update with total=1',
      )
    } finally {
      resumed.close()
    }
  }, 20_000)
})
