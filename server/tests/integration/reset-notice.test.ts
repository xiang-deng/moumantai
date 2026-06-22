/**
 * Integration: `resetNotice` reaches sibling devices before the empty `chatWindow`,
 * with `requesterSessionId` = resetter's sessionId and `conversationId` = new convId.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import { create } from '@bufbuild/protobuf'
import { ClientMessageSchema, type ServerMessage } from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { handshake as connect, encode } from '../helpers/raw-ws.js'

type ServerCase = NonNullable<ServerMessage['payload']>['case']

async function waitForCase<C extends ServerCase>(
  buf: ServerMessage[],
  caseName: C,
  predicate?: (m: Extract<ServerMessage['payload'], { case: C }>['value']) => boolean,
  timeoutMs = 5000,
): Promise<{ msg: Extract<ServerMessage['payload'], { case: C }>['value']; index: number }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (let i = 0; i < buf.length; i++) {
      const m = buf[i]!
      if (m.payload.case === caseName) {
        const value = m.payload.value as Extract<ServerMessage['payload'], { case: C }>['value']
        if (!predicate || predicate(value)) {
          return { msg: value, index: i }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(
    `waitForCase(${caseName}) timed out after ${timeoutMs}ms; buffer cases: ` +
      buf.map((m) => m.payload.case ?? 'unknown').join(','),
  )
}

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-reset-notice-'))
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

describe('resetNotice frame (G1 sibling-coherence fix)', () => {
  it('sibling receives resetNotice BEFORE empty chatWindow; notice carries requesterSessionId and new conversationId', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 30))

    const a = await connect(port)
    const b = await connect(port)
    try {
      expect(a.sessionId).not.toBe(b.sessionId)

      a.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      b.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )

      await waitForCase(a.received, 'chatWindow')
      await waitForCase(b.received, 'chatWindow')
      const bReceivedBeforeReset = b.received.length

      a.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'resetConversation', value: { scope: 'home' } },
          }),
        ),
      )

      const notice = await waitForCase(b.received, 'resetNotice', (m) => m.scope === 'home')
      const window = await waitForCase(
        b.received,
        'chatWindow',
        (m) =>
          m.scope === 'home' &&
          m.conversationId === notice.msg.conversationId &&
          m.entries.length === 0,
      )

      expect(notice.index).toBeLessThan(window.index)
      expect(notice.index).toBeGreaterThanOrEqual(bReceivedBeforeReset)

      expect(notice.msg.requesterSessionId).toBe(a.sessionId)
      expect(notice.msg.conversationId).toBe(window.msg.conversationId)
      expect(typeof notice.msg.timestamp).toBe('string')
      expect(notice.msg.timestamp.length).toBeGreaterThan(10)

      const noticeOnA = await waitForCase(a.received, 'resetNotice', (m) => m.scope === 'home')
      expect(noticeOnA.msg.requesterSessionId).toBe(a.sessionId)
    } finally {
      a.ws.close()
      b.ws.close()
    }
  }, 15_000)

  it('resetNotice is disposable (no seq) and does not enter replay buffer', async () => {
    components.store.reset('home')
    await new Promise((r) => setTimeout(r, 30))

    const a = await connect(port)
    const b = await connect(port)
    try {
      a.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      b.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      await waitForCase(a.received, 'chatWindow')
      await waitForCase(b.received, 'chatWindow')

      a.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'resetConversation', value: { scope: 'home' } },
          }),
        ),
      )
      const notice = await waitForCase(b.received, 'resetNotice')
      expect(Object.hasOwn(notice.msg, 'seq')).toBe(false) // disposable: no seq field
    } finally {
      a.ws.close()
      b.ws.close()
    }
  }, 15_000)
})
