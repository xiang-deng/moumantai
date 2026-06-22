/**
 * Server-side Transport interface.
 *
 * Manages multiple client sessions. Used by the server to send messages
 * and receive user actions from connected clients.
 */
import type {
  DeviceClass,
  DeviceProfile,
  InvokeToolMsg,
  ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'

export interface ServerTransport {
  /** Send an Moumantai protocol message to a specific session */
  send(sessionId: string, message: ServerMessage): void
  /** Register handler for client-initiated tool invocations */
  onInvokeTool(handler: (sessionId: string, message: InvokeToolMsg) => void): void
  /** Register handler for new connections */
  onConnect(
    handler: (
      sessionId: string,
      deviceId: string,
      deviceClass: DeviceClass,
      deviceProfile: DeviceProfile | undefined,
    ) => void,
  ): void
  /** Register handler for disconnections */
  onDisconnect(handler: (sessionId: string) => void): void
}
