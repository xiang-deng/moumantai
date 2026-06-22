// JSON Pointer (RFC 6901) utilities for resolving and setting
// values in nested objects.

export function resolvePointer(obj: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') return obj
  const parts = pointer.split('/').slice(1)
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    current = Array.isArray(current)
      ? (current as unknown[])[parseInt(key, 10)]
      : (current as Record<string, unknown>)[key]
  }
  return current
}

export function setAtPointer(obj: unknown, pointer: string, value: unknown): unknown {
  if (!pointer || pointer === '/') return value
  const root = structuredClone(obj ?? {}) as Record<string, unknown>
  const parts = pointer.split('/').slice(1)
  let current: Record<string, unknown> = root
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!.replace(/~1/g, '/').replace(/~0/g, '~')
    const nextKey = parts[i + 1]!.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = /^\d+$/.test(nextKey) ? [] : {}
    } else {
      current[key] = Array.isArray(current[key])
        ? [...(current[key] as unknown[])]
        : { ...(current[key] as Record<string, unknown>) }
    }
    current = current[key] as Record<string, unknown>
  }
  const lastKey = parts[parts.length - 1]!.replace(/~1/g, '/').replace(/~0/g, '~')
  current[lastKey] = value
  return root
}
