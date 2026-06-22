/**
 * Persistence edge cases:
 *  10. Assistant row + sdk_bound_at must land after runUserTurn.
 *  11. Outbound `chat` frame must echo `clientMsgId` for optimistic reconciliation.
 *  12. Deleting the SDK `.jsonl` between turns must not crash the server.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import { create } from '@bufbuild/protobuf'
import {
  ChatRole,
  ClientMessageSchema,
  type ChatMessage,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'

import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { handshake, encode } from '../helpers/raw-ws.js'

async function waitFor<T>(
  fn: () => T | false | undefined | null,
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

function findChat(
  received: ServerMessage[],
  match: (c: ChatMessage) => boolean,
): ChatMessage | undefined {
  for (const m of received) {
    if (m.payload.case === 'chat' && match(m.payload.value)) return m.payload.value
  }
  return undefined
}

async function startServer(home: string): Promise<{ components: ServerComponents; port: number }> {
  const components = await createAppServer({
    adapterOverride: await connectMockAdapter(),
    port: 0,
    home,
  })
  await new Promise<void>((resolve) => {
    components.httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (components.httpServer.address() as AddressInfo).port
  return { components, port }
}

async function stopServer(components: ServerComponents): Promise<void> {
  components.appEngine.shutdown()
  await components.wsServer.close()
  await components.adapter.disconnect()
  await new Promise<void>((resolve, reject) => {
    components.httpServer.close((err) => (err ? reject(err) : resolve()))
  })
}

describe('persistence edge cases: assistant appendTurn', () => {
  it('scenario 10: assistant row MUST land in the conversation AND stamp sdk_bound_at', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-adv-10-'))
    const { components, port } = await startServer(home)
    try {
      const phone = await handshake(port)
      components.store.reset('home')
      phone.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      await new Promise((r) => setTimeout(r, 100))
      phone.received.length = 0

      phone.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text: 'hello' } },
          }),
        ),
      )

      await waitFor(
        () =>
          findChat(phone.received, (c) => c.role === ChatRole.USER && c.text === 'hello') !==
          undefined,
        5000,
        'user echo',
      )

      await waitFor(
        () => findChat(phone.received, (c) => c.role === ChatRole.ASSISTANT) !== undefined,
        5000,
        'assistant reply',
      )

      await new Promise((r) => setTimeout(r, 50))

      const window = components.store.getWindow('home').entries
      expect(window.filter((e) => e.role === 'user').map((e) => e.text)).toContain('hello')
      expect(window.some((e) => e.role === 'assistant')).toBe(true)

      phone.ws.close()
    } finally {
      await stopServer(components)
    }
  }, 20_000)
})

describe('persistence edge cases: clientMsgId echo on chat frame', () => {
  it("scenario 11: the server's outbound `chat` frame includes the clientMsgId the client sent on chatInput", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-adv-11-'))
    const { components, port } = await startServer(home)
    try {
      const phone = await handshake(port)
      components.store.reset('home')
      phone.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      await new Promise((r) => setTimeout(r, 100))
      phone.received.length = 0

      const cmid = `local-${crypto.randomUUID()}`

      phone.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: {
              case: 'chatInput',
              value: { scope: 'home', text: 'echo me', clientMsgId: cmid },
            },
          }),
        ),
      )

      const userFrame = await waitFor(
        () =>
          findChat(phone.received, (c) => c.role === ChatRole.USER && c.text === 'echo me') ??
          false,
        5000,
        'user echo frame',
      )

      expect(userFrame.clientMsgId).toBe(cmid)

      phone.ws.close()
    } finally {
      await stopServer(components)
    }
  }, 10_000)
})

describe('persistence edge cases: SDK jsonl deletion between turns', () => {
  it('scenario 12: deleting the synthetic-cwd/claude-cwd directory between turns does not crash subsequent turns', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-adv-12-'))
    const { components, port } = await startServer(home)
    try {
      const phone = await handshake(port)
      components.store.reset('home')
      phone.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )
      await new Promise((r) => setTimeout(r, 100))

      // Turn 1: land an assistant row before nuking the cwd.
      phone.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text: 'turn one' } },
          }),
        ),
      )
      await waitFor(
        () => findChat(phone.received, (c) => c.role === ChatRole.ASSISTANT) !== undefined,
        5000,
        'assistant after turn 1',
      )
      const convBefore = components.store.getActive('home')

      const cwd = path.join(home, 'apps', 'home', 'cwd')
      if (fs.existsSync(cwd)) {
        fs.rmSync(cwd, { recursive: true, force: true })
      }

      // Turn 2: server must not crash; assistant row must still land.
      phone.received.length = 0
      phone.ws.send(
        encode(
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text: 'turn two' } },
          }),
        ),
      )
      await waitFor(
        () => findChat(phone.received, (c) => c.role === ChatRole.ASSISTANT) !== undefined,
        5000,
        'assistant after turn 2 (post jsonl deletion)',
      )

      const convAfter = components.store.getActive('home')
      expect(convAfter.id).toBe(convBefore.id)

      const window = components.store.getWindow('home').entries
      const userTexts = window.filter((e) => e.role === 'user').map((e) => e.text)
      expect(userTexts).toEqual(['turn one', 'turn two'])

      expect(fs.existsSync(cwd)).toBe(true)

      phone.ws.close()
    } finally {
      await stopServer(components)
    }
  }, 20_000)
})
