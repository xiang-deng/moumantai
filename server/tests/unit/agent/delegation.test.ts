import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MockAgentAdapter } from '../../../src/server/agent/mock/adapter.js'
import { AppEngine } from '../../../src/server/agent/app-engine.js'
import { ConversationStore } from '../../../src/server/conversations/store.js'
import { openPlatformDb } from '../../../src/server/db/platform-db.js'
import { runDelegation } from '../../../src/server/agent/delegation.js'
import { TurnQueue } from '../../../src/server/agent/turn-queue.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpDirs = []
})

describe('runDelegation', () => {
  it('delegation to nonexistent app returns error', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-delegation-'))
    tmpDirs.push(home)

    const db = openPlatformDb(home)
    const store = new ConversationStore(db)

    const adapter = new MockAgentAdapter()
    await adapter.connect({ type: 'mock' })

    const appEngine = new AppEngine()

    const result = await runDelegation('nonexistent', 'do something', {
      appEngine,
      adapter,
      store,
      sendFaceUpdate: vi.fn(),
      turnQueue: new TurnQueue(),
      backend: 'mock',
      home,
    })

    expect(result.status).toBe('error')
    expect(result.text).toContain('not found')
  })
})
