/**
 * Pi-backend paths under Moumantai Home.
 *
 * Pi normally stamps state at `~/.pi/agent/` (auth.json) and
 * `~/.pi/agent/sessions/--<encoded-cwd>--/` (jsonl). We override both so
 * everything Moumantai's Pi backend writes lives under `<home>/` — same
 * workspace-containment principle as `platform.db` and `apps/`.
 *
 *   <home>/
 *   ├── pi-agent/          ← agentDir (auth.json, settings, etc.)
 *   │   └── auth.json      ← AuthStorage.create() custom path
 *   └── pi-sessions/       ← sessionDir root (one subdir per conversation)
 *       └── <conv-id>/
 *           └── <session>.jsonl
 *
 * Mirrors `homeLayout` / `appPaths` in `./home.ts`.
 */

import path from 'node:path'

export interface PiPaths {
  /** Pi agent's working dir — passed as `agentDir` to `createAgentSession`. */
  agentDir: string
  /**
   * Root for per-conversation session jsonl dirs. The adapter joins
   * `<root>/<conversationId>/` and passes that to `SessionManager.create()`.
   */
  sessionDirRoot: string
  /** AuthStorage's persistent file. Passed to `AuthStorage.create(authFile)`. */
  authFile: string
}

export function piPaths(home: string): PiPaths {
  const agentDir = path.join(home, 'pi-agent')
  return {
    agentDir,
    sessionDirRoot: path.join(home, 'pi-sessions'),
    authFile: path.join(agentDir, 'auth.json'),
  }
}
