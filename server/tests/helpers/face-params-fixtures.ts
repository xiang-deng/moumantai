/**
 * Shared helpers for parameterized-face tests: in-memory platform DB +
 * ConversationStore setup, FakeTransport, ScriptedAdapter, and seed helpers.
 */

import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '../../src/server/conversations/schema.js'
import { ConversationStore } from '../../src/server/conversations/store.js'
import type { BroadcastTransport } from '../../src/server/agent/broadcast.js'
import type {
  AgentEvent,
  AgentRequest,
  BackendConfig,
  FaceDefinition,
  LLMAdapter,
  ToolResult,
} from '../../src/server/agent/types.js'
import { notes } from '../fixtures/test-app/schema.js'

export type PlatformDb = BetterSQLite3Database<typeof schema>

const here = path.dirname(fileURLToPath(import.meta.url))
const PLATFORM_MIGRATIONS = path.resolve(here, '../../drizzle/platform')

export function freshPlatformDb(): PlatformDb {
  const db = drizzle({ connection: ':memory:', schema, casing: 'snake_case' }) as PlatformDb
  migrate(db, { migrationsFolder: PLATFORM_MIGRATIONS })
  return db
}

export function newConversation(db: PlatformDb, scope = 'app:spend-tracker'): string {
  return new ConversationStore(db).getActive(scope).id
}

export class FakeTransport implements BroadcastTransport {
  broadcasts: unknown[] = []
  sends: { sessionId: string; message: unknown }[] = []
  /** Focus mutations issued by the unit-under-test; asserted by navigate-origin tests. */
  focusChanges: { deviceId: string; appId: string; faceId?: string }[] = []
  broadcast(message: unknown): void {
    this.broadcasts.push(message)
  }
  send(sessionId: string, message: unknown): void {
    this.sends.push({ sessionId, message })
  }
  setDeviceFocus(deviceId: string, appId: string, faceId?: string): void {
    this.focusChanges.push({ deviceId, appId, ...(faceId ? { faceId } : {}) })
  }
}

/**
 * Scripted LLMAdapter: yields a pre-set event sequence; tool-call events
 * block until `submitToolResult` resolves them. `recordedToolResults`
 * captures everything fed back to the LLM for assertion.
 */
export class ScriptedAdapter implements LLMAdapter {
  private events: AgentEvent[] = []
  private pending = new Map<string, (r: ToolResult) => void>()
  recordedToolResults: { callId: string; result: ToolResult }[] = []

  setEvents(events: AgentEvent[]) {
    this.events = events
  }
  async connect(_c: BackendConfig) {}
  async disconnect() {}
  async resetSession(_id: string) {}

  async *run(_req: AgentRequest): AsyncIterable<AgentEvent> {
    for (const ev of this.events) {
      if (ev.type === 'toolCall') {
        const wait = new Promise<ToolResult>((resolve) => {
          this.pending.set(ev.callId, resolve)
        })
        yield ev
        await wait
        continue
      }
      yield ev
    }
  }

  submitToolResult(_conv: string, callId: string, result: ToolResult): void {
    this.recordedToolResults.push({ callId, result })
    const resolver = this.pending.get(callId)
    if (resolver) {
      resolver(result)
      this.pending.delete(callId)
    }
  }
}

/** Seed the test-app DB: 2 work notes + 3 personal notes. Change in lockstep with assertions. */
export function seedTestAppNotes(appDb: BetterSQLite3Database): void {
  const insert = (content: string, category: string) => {
    appDb.insert(notes).values({ content, category }).run()
  }
  insert('work-1', 'work')
  insert('work-2', 'work')
  insert('personal-1', 'personal')
  insert('personal-2', 'personal')
  insert('personal-3', 'personal')
}

/** Minimal parameterized FaceDefinition for store/validation tests. */
export function paramFace(overrides: Partial<FaceDefinition> = {}): FaceDefinition {
  return {
    id: 'summary',
    label: 'Summary',
    position: 0,
    components: [],
    resolve: () => ({}),
    params: { month: { type: 'string' }, category: { type: 'string' } },
    paramsVersion: 1,
    viewToolDescription: 'show summary',
    ...overrides,
  }
}
