/**
 * Home App definition.
 *
 * Primary user-facing assistant. Chat-primary surface with routing tools
 * (talk_to_app, list_apps, navigate). Delegates domain work to app sub-agents.
 */

import type { AppDefinition, ToolDefinition } from '../../agent/types.js'
import talkToApp from './tools/talk-to-app.js'
import listApps from './tools/list-apps.js'
import navigateApp from './tools/navigate-app.js'
import mainFace from './faces/main.js'

export function createHomeDef(): AppDefinition {
  return {
    manifest: {
      id: 'home',
      version: '0.1.0',
      name: 'Home',
      icon: 'chat',
      description: 'Your personal assistant',
    },
    tools: [talkToApp, listApps, navigateApp],
    faces: [mainFace],
    skill:
      'You are the home assistant. Route domain-specific requests to the appropriate app using talk_to_app. For general questions, respond directly.',
  }
}

/**
 * Wire the home app's tools with runtime dependencies.
 *
 * Called by main.ts after the app engine boots. Replaces placeholder execute
 * functions with ones that have access to delegation, app list, and WS server.
 */
export function wireHomeTools(
  toolRegistry: Map<string, ToolDefinition>,
  deps: {
    runDelegation: (appId: string, message: string) => Promise<unknown>
    getAppList: () => { appId: string; name: string; description: string }[]
    /**
     * Per-device focus mutation. Called with the originating device's stable
     * id so only that device navigates — siblings on the same scope keep their
     * own view. No-op when deviceId is undefined (server-internal turns).
     */
    setDeviceFocus: (deviceId: string, appId: string) => void
  },
): void {
  // Replace tools in the registry with wired versions (originals are frozen)
  const talkTool = toolRegistry.get('talk_to_app')
  if (talkTool) {
    toolRegistry.set('talk_to_app', {
      ...talkTool,
      execute: async ({ params }) => {
        const result = await deps.runDelegation(params.app_id as string, params.message as string)
        return { result }
      },
    })
  }

  const listTool = toolRegistry.get('list_apps')
  if (listTool) {
    toolRegistry.set('list_apps', {
      ...listTool,
      execute: async () => ({ result: deps.getAppList() }),
    })
  }

  const navTool = toolRegistry.get('navigate')
  if (navTool) {
    toolRegistry.set('navigate', {
      ...navTool,
      execute: async ({ params, originDeviceId }) => {
        const appId = params.app_id as string
        if (originDeviceId) {
          deps.setDeviceFocus(originDeviceId, appId)
        }
        return { result: { navigated: true, appId } }
      },
    })
  }
}
