/**
 * defineTool() helper for authoring app tools.
 *
 * Validates the tool spec shape and returns a frozen ToolDefinition.
 * Used by developer-authored tools in apps/{id}/tools/*.ts files.
 */

import type { ToolDefinition, ToolParameter } from './types.js'

const VALID_PARAM_TYPES = new Set(['string', 'number', 'boolean'])

/**
 * Define a tool that the LLM can call.
 *
 * ```typescript
 * export default defineTool({
 *   name: 'add_expense',
 *   description: 'Add a new expense',
 *   parameters: {
 *     amount: { type: 'number', required: true, description: 'Amount in dollars' },
 *     description: { type: 'string', required: true },
 *   },
 *   execute: async ({ params, db }) => {
 *     const row = db.expenses.insert({ amount: params.amount, ... })
 *     return { result: { id: row.id } }
 *   },
 * })
 * ```
 */
export function defineTool(spec: {
  name: string
  description: string
  parameters: Record<string, ToolParameter>
  execute: ToolDefinition['execute']
}): ToolDefinition {
  if (!spec.name || typeof spec.name !== 'string') {
    throw new Error('defineTool: name is required and must be a string')
  }
  if (!spec.description || typeof spec.description !== 'string') {
    throw new Error('defineTool: description is required and must be a string')
  }
  if (!spec.parameters || typeof spec.parameters !== 'object') {
    throw new Error('defineTool: parameters is required and must be an object')
  }
  if (typeof spec.execute !== 'function') {
    throw new Error('defineTool: execute is required and must be a function')
  }

  // Validate parameter types
  for (const [key, param] of Object.entries(spec.parameters)) {
    if (!VALID_PARAM_TYPES.has(param.type)) {
      throw new Error(
        `defineTool: parameter "${key}" has invalid type "${param.type}". ` +
          `Must be one of: ${[...VALID_PARAM_TYPES].join(', ')}`,
      )
    }
  }

  return Object.freeze({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: spec.execute,
  })
}
