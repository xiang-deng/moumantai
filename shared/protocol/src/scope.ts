/**
 * Scope-string helpers. These are internal keys (`'home'` / `'app:<id>'`)
 * used by server, client, and DB layers — they never cross the wire as a
 * typed message. Wire types live in `@moumantai/protocol/generated/moumantai/v1`.
 *
 * No imports — pure functions only.
 */

/** Extract appId from an `app:<id>` scope. Returns null for `'home'` or malformed. */
export function scopeToAppId(scope: string): string | null {
  if (scope.startsWith('app:')) return scope.slice(4)
  return null
}

/**
 * Map a scope to the appId the chat-store UI keys on. `'home'` → `'home'`;
 * `'app:<id>'` → `<id>`. Falls back to `'home'` for malformed input.
 */
export function scopeToChatKey(scope: string): string {
  if (!scope || scope === 'home') return 'home'
  return scopeToAppId(scope) ?? 'home'
}

/** Inverse of scopeToAppId. Returns `'home'` for `'home'`, else `'app:<id>'`. */
export function appIdToScope(appId: string): string {
  return appId === 'home' ? 'home' : `app:${appId}`
}
