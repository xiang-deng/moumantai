/**
 * Integration: a `chatInput` whose `originConversationId` no longer matches
 * the active conversation is rejected — prevents stale offline-queue drains
 * from appending to a conversation reset by a sibling device.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import type { Server as HttpServer } from 'http'
import { create } from '@bufbuild/protobuf'
import { ClientMessageSchema, ProtocolErrorCode } from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { handshake as connect, encode } from '../helpers/raw-ws.js'

async function waitFor<T>(pred: () => T | false | undefined | null, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = pred()
    if (v) return v
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

let components: ServerComponents
let httpServer: HttpServer
let port: number

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-stale-chatinput-'))
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

describe('server-side staleness rejection on chatInput', () => {
  it('rejects a chatInput whose originConversationId no longer matches the active conv', async () => {
    const scope = 'home'
    const archivedConvId = components.store.getActive(scope).id

    const client = await connect(port)
    try {
      client.ws.send(
        encode(create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope } } })),
      )
      await new Promise((r) => setTimeout(r, 50))

      const { fresh } = components.store.reset(scope)
      expect(fresh.id).not.toBe(archivedConvId)

      await new Promise((r) => setTimeout(r, 100))
      const beforeCount = client.received.filter((m) => m.payload.case === 'chat').length

      const staleClientMsgId = 'cmid-stale-1'
      client.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: {
              case: 'chatInput',
              value: {
                scope,
                text: 'this should be rejected',
                clientMsgId: staleClientMsgId,
                originConversationId: archivedConvId,
              },
            },
          }),
        ),
      )

      const err = await waitFor(() => {
        for (const m of client.received) {
          if (
            m.payload.case === 'error' &&
            m.payload.value.code === ProtocolErrorCode.STALE_CONVERSATION
          ) {
            return m.payload.value
          }
        }
        return undefined
      }, 3000)

      expect(err.clientMsgId).toBe(staleClientMsgId)
      expect(err.message).toBe('Conversation advanced while offline')

      const afterChats = client.received.filter((m) => m.payload.case === 'chat')
      expect(afterChats.length).toBe(beforeCount)

      const freshEntries = components.store.getWindow(scope).entries
      expect(freshEntries.find((e) => e.text === 'this should be rejected')).toBeUndefined()
      expect(freshEntries.find((e) => e.clientMsgId === staleClientMsgId)).toBeUndefined()
    } finally {
      client.ws.close()
    }
  }, 15_000)

  it('accepts a chatInput whose originConversationId matches the current active conv', async () => {
    components.store.reset('home')
    const scope = 'home'
    const currentConvId = components.store.getActive(scope).id

    const client = await connect(port)
    try {
      client.ws.send(
        encode(create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope } } })),
      )
      await new Promise((r) => setTimeout(r, 50))

      const matchingClientMsgId = 'cmid-ok-1'
      client.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: {
              case: 'chatInput',
              value: {
                scope,
                text: 'this should succeed',
                clientMsgId: matchingClientMsgId,
                originConversationId: currentConvId,
              },
            },
          }),
        ),
      )

      await waitFor(() => {
        const entries = components.store.getWindow(scope).entries
        return entries.find((e) => e.clientMsgId === matchingClientMsgId)
      }, 5000)

      const err = client.received.find(
        (m) =>
          m.payload.case === 'error' &&
          m.payload.value.code === ProtocolErrorCode.STALE_CONVERSATION,
      )
      expect(err).toBeUndefined()
    } finally {
      client.ws.close()
    }
  }, 15_000)

  it('accepts a chatInput with no originConversationId (fresh live send)', async () => {
    components.store.reset('home')
    const scope = 'home'

    const client = await connect(port)
    try {
      client.ws.send(
        encode(create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope } } })),
      )
      await new Promise((r) => setTimeout(r, 50))

      const liveClientMsgId = 'cmid-live-1'
      client.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: {
              case: 'chatInput',
              value: { scope, text: 'fresh live send', clientMsgId: liveClientMsgId },
            },
          }),
        ),
      )

      await waitFor(() => {
        const entries = components.store.getWindow(scope).entries
        return entries.find((e) => e.clientMsgId === liveClientMsgId)
      }, 5000)

      const err = client.received.find(
        (m) =>
          m.payload.case === 'error' &&
          m.payload.value.code === ProtocolErrorCode.STALE_CONVERSATION,
      )
      expect(err).toBeUndefined()
    } finally {
      client.ws.close()
    }
  }, 15_000)
})
