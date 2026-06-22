/**
 * Integration: `recoverOrphans()` runs on startup (before connections open) and
 * flips any orphaned running user row to `failed:server_interrupted`, inserting
 * a synthetic assistant row. Reconnecting clients never see a zombie.
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
  TurnStatus,
  type ChatWindowMsg,
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

function chatWindowsIn(received: ServerMessage[]): ChatWindowMsg[] {
  return received.flatMap((m) => (m.payload.case === 'chatWindow' ? [m.payload.value] : []))
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

describe('recoverOrphans on server startup', () => {
  it('a user row left in running is flipped to failed:server_interrupted with a synthetic assistant row before clients see it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-restart-recovery-'))

    const boot1 = await startServer(home)
    const conv = boot1.components.store.getActive('home')
    const orphanedUser = boot1.components.store.appendTurn(conv.id, {
      role: 'user',
      text: 'interrupted message',
      turnMode: 'direct_user_chat',
      clientMsgId: 'user-interrupted-xyz',
    })
    boot1.components.store.markTurnRunning(orphanedUser.id)

    {
      const win = boot1.components.store.getWindow('home').entries
      expect(win.find((e) => e.id === orphanedUser.id)?.status).toBe('running')
      expect(win.some((e) => e.role === 'assistant')).toBe(false)
    }

    await stopServer(boot1.components)

    // Boot 2: recoverOrphans() runs before the listener opens.
    const boot2 = await startServer(home)
    try {
      const windowPreConnect = boot2.components.store.getWindow('home').entries
      const recovered = windowPreConnect.find((e) => e.id === orphanedUser.id)
      expect(recovered?.status).toBe('failed')
      expect(recovered?.failureReason).toBe('server_interrupted')
      expect(
        windowPreConnect.some((e) => e.role === 'assistant' && e.text === '(server interrupted)'),
      ).toBe(true)

      const phone = await handshake(boot2.port)
      phone.ws.send(
        encode(
          create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: 'home' } } }),
        ),
      )

      const window = await waitFor(
        () => chatWindowsIn(phone.received).find((w) => w.scope === 'home'),
        5000,
        'chatWindow after reconnect',
      )

      const entries = window.entries
      const userEntry = entries.find((e) => e.id === orphanedUser.id)
      expect(userEntry).toBeDefined()
      expect(userEntry?.status).toBe(TurnStatus.FAILED)
      expect(userEntry?.failureReason).toBe('server_interrupted')
      expect(userEntry?.clientMsgId).toBe('user-interrupted-xyz')
      expect(
        entries.some((e) => e.role === ChatRole.ASSISTANT && e.text === '(server interrupted)'),
      ).toBe(true)

      phone.ws.close()
    } finally {
      await stopServer(boot2.components)
    }
  }, 30_000)
})
