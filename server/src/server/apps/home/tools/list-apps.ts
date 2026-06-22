import { defineTool } from '../../../agent/define-tool.js'

/**
 * list_apps — return available mini apps.
 *
 * The execute function receives the app list via a context injector
 * set up by main.ts (similar to talk_to_app delegation injection).
 */
export default defineTool({
  name: 'list_apps',
  description: 'List all available apps the user can interact with',
  parameters: {},
  execute: async () => {
    // Placeholder — replaced at runtime with actual app list provider
    return { result: [] }
  },
})
