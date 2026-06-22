import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  secretField,
  isSecretField,
  getSecretFieldDescription,
} from '../../../src/server/framework/secret-field.js'

describe('secretField()', () => {
  it('marks a field so isSecretField returns true', () => {
    const f = secretField(z.string().min(1))
    expect(isSecretField(f)).toBe(true)
  })

  it('does not affect plain (unmarked) fields', () => {
    expect(isSecretField(z.string())).toBe(false)
    expect(isSecretField(z.number())).toBe(false)
    expect(isSecretField(z.string().describe('plain'))).toBe(false)
  })

  it('preserves Zod parse semantics — value validation still works', () => {
    const f = secretField(z.string().min(1))
    expect(f.safeParse('').success).toBe(false)
    expect(f.safeParse('sk-abc').success).toBe(true)
  })

  it('returns the bare description for unmarked fields', () => {
    const plain = z.string().describe('Default endpoint')
    expect(getSecretFieldDescription(plain)).toBe('Default endpoint')
  })

  it('works inside z.object() — fields inspected via .shape', () => {
    const schema = z.object({
      endpoint: z.string().default('https://example.com'),
      api_key: secretField(z.string().min(1)),
    })
    const shape = schema.shape
    expect(isSecretField(shape.endpoint)).toBe(false)
    expect(isSecretField(shape.api_key)).toBe(true)
  })
})
