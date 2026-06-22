/**
 * Delegation — talk_to_app sub-agent execution.
 *
 * When the home conversation calls talk_to_app(appId, message), the server
 * runs an AgentLoop for the target app's conversation and returns a
 * DelegationResult. Writes flow through the persistent ConversationStore so
 * the target app's log accumulates across restarts (entries tagged
 * `turnMode='delegated_from_home'`, `source='home'`).
 *
 * The turn runs through `runBoundTurn`, so it serializes on the target app's
 * conversation (same TurnQueue every other turn uses) and resumes/binds the
 * SDK session id exactly like the direct-chat path. Home's conversation is a
 * different queue key, so home waiting on the app's slot can't deadlock.
 *
 * Side effects (DB mutations, face refreshes) commit immediately during
 * delegation. The home conversation receives the result to compose a final
 * reply.
 */

import fs from 'node:fs'
import type { LLMAdapter, DelegationResult } from './types.js'
import { type AppEngine, getToolSchemas } from './app-engine.js'
import type { ConversationStore } from '../conversations/store.js'
import type { FaceParamsStore } from './face-params-store.js'
import type { SendFaceUpdate } from './face-refresh.js'
import type { TurnQueue } from './turn-queue.js'
import { AgentLoop } from './agent-loop.js'
import { runBoundTurn } from './bound-turn.js'
import { appPaths } from '../workspace/home.js'
import { buildFaceContext } from './face-context.js'
import { appIdToScope } from '@moumantai/protocol'

export interface DelegationDeps {
  appEngine: AppEngine
  adapter: LLMAdapter
  store: ConversationStore
  sendFaceUpdate: SendFaceUpdate
  /** Serializes the delegated turn against direct chat on the same app. */
  turnQueue: TurnQueue
  /** Active LLM backend — gates SDK-session resume and is recorded on bind. */
  backend: string
  /** Moumantai home; synthetic cwd for the SDK lands at `<home>/apps/<appId>/cwd/`. */
  home: string
  /**
   * Optional. When present, the delegated AgentLoop reloads paramsByFaceId
   * before each face refresh so view_<faceId> calls during delegation are
   * reflected in the broadcast. When absent, faces refresh without params.
   */
  faceParamsStore?: FaceParamsStore
}

export async function runDelegation(
  appId: string,
  message: string,
  deps: DelegationDeps,
): Promise<DelegationResult> {
  const { appEngine, adapter, store, sendFaceUpdate, home } = deps

  // Boot the target app lazily so delegation works even if the app was
  // DORMANT when the home turn started.
  const app = await appEngine.use(appId).catch(() => null)
  if (!app) {
    return { text: `App "${appId}" not found`, status: 'error', toolCalls: [] }
  }

  const scope = appIdToScope(appId)
  const conv = store.getActive(scope)

  const cwd = appPaths(home, appId).cwd
  fs.mkdirSync(cwd, { recursive: true })

  let result
  try {
    result = await runBoundTurn(
      { store, turnQueue: deps.turnQueue, conversationId: conv.id, backend: deps.backend },
      async (resume, signal) => {
        // Append inside the slot so the delegated user message + reply serialize
        // against any direct turn on the same conversation.
        store.appendTurn(conv.id, {
          role: 'user',
          text: message,
          turnMode: 'delegated_from_home',
          source: 'home',
        })

        const agentLoop = new AgentLoop({
          adapter,
          toolRegistry: app.toolRegistry,
          faceRegistry: app.faceRegistry,
          db: app.db,
          appId,
          sendFaceUpdate,
          faceParamsStore: deps.faceParamsStore,
        })

        const turn = await agentLoop.runTurn({
          conversationId: conv.id,
          message,
          mode: 'delegated_from_home',
          tools: getToolSchemas(app),
          cwd,
          ...resume,
          signal,
          context: {
            appId,
            manifest: app.manifest,
            schema: app.schema,
            skill: app.skill,
            turnMode: 'delegated_from_home',
            faces: buildFaceContext(app, conv.id, deps.faceParamsStore),
          },
        })

        // Only stamp an assistant row on success. Failed turns (abort, error,
        // SDK init never completing) leave just the user row; the session id is
        // still bound by runBoundTurn if init fired, matching the direct path.
        if (turn.success) {
          store.appendTurn(conv.id, {
            role: 'assistant',
            text: turn.text,
            turnMode: 'delegated_from_home',
            source: 'home',
            toolCalls: turn.toolCalls,
          })
        }
        return turn
      },
    )
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    // Queue full / slot aborted — recoverable, surfaced to home as a normal
    // result rather than corrupting a concurrently-running session.
    if (name === 'SessionBusyError') {
      return {
        text: `App "${appId}" is busy with another request — try again in a moment.`,
        status: 'error',
        toolCalls: [],
      }
    }
    if (name === 'AbortError') {
      return { text: `Delegation to "${appId}" was interrupted.`, status: 'error', toolCalls: [] }
    }
    throw err
  }

  return {
    text: result.text,
    status: result.success ? 'success' : 'error',
    toolCalls: result.toolCalls,
  }
}
