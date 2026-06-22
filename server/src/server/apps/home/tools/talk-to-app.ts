import { defineTool } from '../../../agent/define-tool.js'

/**
 * talk_to_app — delegate a user request to a mini app's sub-agent.
 *
 * The execute function receives a `delegation` object in the tool context
 * that provides the runDelegation capability. This is injected by the
 * server when building the home session's tool registry.
 *
 * The actual delegation logic is in agent/delegation.ts.
 */
export default defineTool({
  name: 'talk_to_app',
  description:
    'Delegate a user request to a specific mini app. Use when the request is about a specific domain (expenses, todos, etc.)',
  parameters: {
    app_id: { type: 'string', required: true, description: 'Target app ID (e.g. "spend-tracker")' },
    message: { type: 'string', required: true, description: 'The user request to forward' },
  },
  execute: async () => {
    // This is a placeholder. The actual execute function is replaced at runtime
    // by main.ts when wiring the home session's tools with delegation context.
    return {
      result: null,
      error: 'talk_to_app: delegation context not injected. This should not happen in production.',
    }
  },
})
