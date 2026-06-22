/**
 * Typed-proto WebSocket test client using the protobuf-es binary codec.
 * Outbound `send(msg)` takes a typed `ClientMessage`; inbound frames decode
 * into typed `ServerMessage` and land in `received`.
 */

import { WebSocket } from 'ws'
import { fromBinary, toBinary, create } from '@bufbuild/protobuf'
import {
  ClientMessageSchema,
  ServerMessageSchema,
  ClientHelloSchema,
  type ClientMessage,
  type ServerMessage,
  type DeviceClass,
  type DeviceShape,
} from '@moumantai/protocol/generated/moumantai/v1'

export interface TestClientHello {
  deviceClass: DeviceClass
  deviceProfile: { width: number; height: number; shape: DeviceShape }
  currentAppId?: string
  currentFaceId?: string
  deviceId?: string
}

export interface TestClientOptions {
  hello: TestClientHello
  /** When true, do NOT send the initial hello automatically. */
  manualHello?: boolean
}

/**
 * Typed test WebSocket client. `received` buffers every inbound `ServerMessage`
 * in arrival order; the first `helloOk` is consumed by `connect()` and stored
 * in `sessionId` rather than pushed into `received`.
 */
export class TestClient {
  readonly ws: WebSocket
  readonly received: ServerMessage[] = []
  sessionId = ''

  private constructor(ws: WebSocket) {
    this.ws = ws
  }

  /** Open a WebSocket, perform the proto handshake, and resolve once `helloOk` arrives. */
  static connect(port: number, opts: TestClientOptions): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['moumantai.v1.proto'])
      const client = new TestClient(ws)
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
          client.sessionId = msg.payload.value.sessionId
          settled = true
          resolve(client)
          return
        }
        client.received.push(msg)
      })

      ws.on('open', () => {
        if (opts.manualHello) return
        client.sendHello(opts.hello)
      })
      ws.on('error', (err) => {
        if (!settled) reject(err)
      })
    })
  }

  /** Send the initial ClientHello. Use only when constructed with manualHello. */
  sendHello(hello: TestClientHello): void {
    const value = create(ClientHelloSchema, {
      deviceClass: hello.deviceClass,
      deviceProfile: hello.deviceProfile,
      currentAppId: hello.currentAppId,
      currentFaceId: hello.currentFaceId,
      deviceId: hello.deviceId,
    })
    this.send(create(ClientMessageSchema, { payload: { case: 'hello', value } }))
  }

  /** Send a typed ClientMessage envelope. */
  send(msg: ClientMessage): void {
    this.ws.send(toBinary(ClientMessageSchema, msg))
  }

  /** Send a raw binary frame (e.g. audio). The frame is sent verbatim. */
  sendBinary(buf: Buffer): void {
    this.ws.send(buf)
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Poll until `pred(buf)` returns truthy or `timeoutMs` elapses.
 * `received` is updated in-place, so the predicate observes live arrivals.
 */
export async function waitFor<T>(
  buf: ServerMessage[],
  pred: (m: ServerMessage[]) => T | false,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = pred(buf)
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms; buffer cases: ` +
      buf.map((m) => m.payload.case ?? 'unknown').join(','),
  )
}
