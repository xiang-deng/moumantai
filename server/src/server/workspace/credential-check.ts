/**
 * Lightweight credential validators for the setup wizard. Each makes a single
 * cheap call (typically `models.list` or equivalent) to verify the credential
 * is well-formed and authorized. Avoids burning quota on real generations.
 *
 * Both functions ALWAYS resolve — never throw — so the wizard can present a
 * friendly retry prompt regardless of network/auth failure mode.
 */

export type CredentialResult = { ok: true } | { ok: false; error: string }

/**
 * Verify an Anthropic credential — works for both `sk-ant-api…` console API
 * keys and `sk-ant-oat…` OAuth tokens (from `claude setup-token`). Calls
 * `GET https://api.anthropic.com/v1/models`, which returns 200 for any working
 * credential and 401/403 otherwise. OAuth tokens authenticate via
 * `Authorization: Bearer`; API keys via `x-api-key`.
 */
export async function checkAnthropicCredential(value: string): Promise<CredentialResult> {
  const v = value.trim()
  if (!v) return { ok: false, error: 'Empty credential.' }

  try {
    // OAuth tokens and API keys BOTH start with `sk-`, so dispatch on the OAuth
    // marker specifically: `sk-ant-oat…` → `Authorization: Bearer`, everything
    // else → `x-api-key`. A plain `startsWith('sk-')` misfiles OAuth tokens as
    // API keys, the API rejects them 401, and a valid token looks "invalid".
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
    }
    if (v.startsWith('sk-ant-oat')) headers['Authorization'] = `Bearer ${v}`
    else headers['x-api-key'] = v

    const res = await fetch('https://api.anthropic.com/v1/models', { headers })
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Authentication failed (401/403). Check your key.' }
    }
    return { ok: false, error: `Unexpected status ${res.status} from api.anthropic.com.` }
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verify an OpenAI credential. Calls `GET https://api.openai.com/v1/models`,
 * which returns 200 for any working key and 401 otherwise.
 */
export async function checkOpenAICredential(value: string): Promise<CredentialResult> {
  const v = value.trim()
  if (!v) return { ok: false, error: 'Empty credential.' }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${v}` },
    })
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Authentication failed (401/403). Check your key.' }
    }
    return { ok: false, error: `Unexpected status ${res.status} from api.openai.com.` }
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verify a Google AI Studio (Gemini) credential. Calls
 * `GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>`,
 * which returns 200 + a `models` array for any working key and 400/403 otherwise.
 * Google uses query-string auth here — no header to set.
 */
export async function checkGoogleCredential(value: string): Promise<CredentialResult> {
  const v = value.trim()
  if (!v) return { ok: false, error: 'Empty credential.' }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(v)}`
    const res = await fetch(url)
    if (res.ok) return { ok: true }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Authentication failed. Check your key.' }
    }
    return {
      ok: false,
      error: `Unexpected status ${res.status} from generativelanguage.googleapis.com.`,
    }
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
