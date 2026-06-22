/**
 * Pairing code — the last 4 hex chars of the deviceId UUID, uppercased.
 *
 * Never sent over the wire: the device derives it from its own id to show
 * on screen; the operator matches it against `device list` to approve. On
 * collision (16-bit space), the operator falls back to the full deviceId.
 *
 * Keep in lockstep with client one-liners (e.g. PWA
 * `clients/pwa/src/transport/ws-transport.ts`: `deviceId.slice(-4).toUpperCase()`).
 */
export function deviceCode(deviceId: string): string {
  return deviceId.slice(-4).toUpperCase()
}
