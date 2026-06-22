/**
 * App manifest & device types.
 */

// Canonical definition lives in `@moumantai/protocol/generated/moumantai/v1`
// (numeric proto enum). Re-exported for server-side consumers.
export { DeviceClass } from '@moumantai/protocol/generated/moumantai/v1'

export interface AppManifest {
  id: string
  /** SemVer (e.g. "0.1.0"). Required — used for update detection + display. */
  version: string
  name: string
  icon: string
  description: string
  /** Minimum Moumantai engine version required (SemVer). Optional. Checked at install. */
  moumantaiMinVersion?: string
  color?: string
}
