/**
 * Raw-WebSocket helpers for tests that need lower-level access than `TestClient`
 * (custom hello timing, multi-tab scenarios, etc.). Uses the protobuf-es binary
 * codec directly — no wrapper.
 */

import { WebSocket } from 'ws'
import { fromBinary, toBinary, create } from '@bufbuild/protobuf'
import {
  ClientMessageSchema,
  ServerMessageSchema,
  DeviceClass,
  DeviceShape,
  type ClientMessage,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'

export interface Connected {
  ws: WebSocket
  sessionId: string
  received: ServerMessage[]
}

/** Extra ClientHello fields to merge in (currentAppId, deviceId, etc.). */
export interface HelloExtras {
  currentAppId?: string
  currentFaceId?: string
  deviceId?: string
}

export function handshake(port: number, extras: HelloExtras = {}): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['moumantai.v1.proto'])
    const received: ServerMessage[] = []
    let settled = false

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      let msg: ServerMessage
      try {
        msg = fromBinary(ServerMessageSchema, data as Uint8Array)
      } catch {
        return
      }
      if (!settled && msg.payload.case === 'helloOk') {
        settled = true
        resolve({
          ws,
          sessionId: msg.payload.value.sessionId,
          received,
        })
        return
      }
      received.push(msg)
    })
    ws.on('open', () => {
      const hello = create(ClientMessageSchema, {
        payload: {
          case: 'hello',
          value: {
            deviceClass: DeviceClass.PHONE,
            deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
            currentAppId: extras.currentAppId,
            currentFaceId: extras.currentFaceId,
            deviceId: extras.deviceId,
          },
        },
      })
      ws.send(toBinary(ClientMessageSchema, hello))
    })
    ws.on('error', (err) => {
      if (!settled) reject(err)
    })
  })
}

/** Encode a typed ClientMessage to proto bytes for `ws.send`. */
export function encode(msg: ClientMessage): Uint8Array {
  return toBinary(ClientMessageSchema, msg)
}
