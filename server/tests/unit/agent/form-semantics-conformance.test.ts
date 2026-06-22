/**
 * Cross-client conformance: drives `validateAndCoerceUIArgs` from the
 * single shared fixture at `shared/protocol/fixtures/form-semantics/spec.json`.
 *
 * The fixture is the source-of-truth for the type contract documented in
 * `shared/protocol/FORM_SCOPE.md`. Per-client harnesses (under each
 * `clients/<id>/.../FormSemanticsConformanceTest` plus the web
 * `dispatcher.test.ts`) consume the `client_resolver` block; this server
 * test consumes `server_coercion` and `server_rejection`. Drift in either
 * implementation breaks the test.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { executeTool } from '../../../src/server/agent/tool-executor.js'
import type { ToolDefinition, ToolParameter } from '../../../src/server/agent/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../../../../shared/protocol/fixtures/form-semantics/spec.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Spec

interface Spec {
  version: number
  widget_form_types: Record<string, string>
  client_resolver: { cases: ClientResolverCase[] }
  server_coercion: { cases: ServerCoercionCase[] }
  server_rejection: { cases: ServerRejectionCase[] }
}
interface ClientResolverCase {
  name: string
  form_state: Record<string, unknown>
  action_args: Record<string, unknown>
  expected_wire_args: Record<string, unknown>
  expected_wire_arg_types: Record<string, string>
}
interface ServerCoercionCase {
  name: string
  wire_args: Record<string, unknown>
  tool_params: Record<string, ToolParameter>
  expected_coerced_args: Record<string, unknown>
  expected_coerced_types: Record<string, string>
}
interface ServerRejectionCase {
  name: string
  wire_args: Record<string, unknown>
  tool_params: Record<string, ToolParameter>
  expected_error_pattern: string
}

function makeTool(
  parameters: Record<string, ToolParameter>,
  capture: { args?: Record<string, unknown> } = {},
): ToolDefinition {
  return {
    name: 'fixture_tool',
    description: 'fixture',
    parameters,
    execute: async ({ params }) => {
      capture.args = params as Record<string, unknown>
      return { result: 'ok' }
    },
  }
}

describe('form-semantics conformance (fixture-driven)', () => {
  describe('server_coercion', () => {
    for (const c of fixture.server_coercion.cases) {
      it(c.name, async () => {
        const capture: { args?: Record<string, unknown> } = {}
        const tool = makeTool(c.tool_params, capture)
        const result = await executeTool(tool, c.wire_args, { db: {} as any })
        expect(result.error).toBeUndefined()
        expect(capture.args).toEqual(c.expected_coerced_args)
        for (const [name, type] of Object.entries(c.expected_coerced_types)) {
          expect(typeof capture.args![name]).toBe(type)
        }
      })
    }
  })

  describe('server_rejection', () => {
    for (const c of fixture.server_rejection.cases) {
      it(c.name, async () => {
        const tool = makeTool(c.tool_params)
        const result = await executeTool(tool, c.wire_args, { db: {} as any })
        expect(result.error).toMatch(new RegExp(c.expected_error_pattern))
      })
    }
  })
})
