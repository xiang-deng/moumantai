import { defineTool } from '../../../agent/define-tool.js'

/**
 * navigate — switch the client's active app.
 *
 * Sends a NavigateMsg to the client. The execute function is replaced
 * at runtime with one that has access to the WS server.
 */
export default defineTool({
  name: 'navigate',
  description: 'Switch the user to a specific app',
  parameters: {
    app_id: { type: 'string', required: true, description: 'App to navigate to' },
  },
  execute: async () => {
    // Placeholder — replaced at runtime
    return { result: { navigated: true } }
  },
})
