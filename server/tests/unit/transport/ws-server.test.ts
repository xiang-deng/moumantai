/**
 * Unit tests for WsServer.
 *
 * Tests:
 * - ClientHello → ServerHello handshake
 * - Handshake timeout (4001 close)
 * - Invalid ClientHello rejection (4002 close)
 * - ChatInput message routing
 * - Binary frame parsing
 * - Multi-client broadcast
 * - Supersede-on-reconnect
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  AudioFormat,
  BinaryFrameType,
  ClientMessageSchema,
  CloseCode,
  DeviceClass,
  DeviceShape,
  ImageChunkHeaderSchema,
  ServerMessageSchema,
  type ClientHello as ProtoClientHello,
  type ClientMessage,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'
import { WsServer } from '../../../src/server/transport/ws-server.js'
import {
  audioChunkHeader,
  encodeAudioFrame,
  encodeBinaryFrame,
  encodeImageFrame,
  parseBinaryFrame,
} from '@moumantai/protocol'
import { msgChat, msgAppList } from '../../../src/server/transport/messages.js'

interface HelloOverrides {
  deviceClass?: DeviceClass
  deviceProfile?: { width: number; height: number; shape: DeviceShape }
  deviceId?: string
}

let nextId = 0

function testGenerateId(): string {
  return `test-session-${nextId++}`
}

function makeHelloMessage(overrides?: HelloOverrides): ClientMessage {
  const value: ProtoClientHello = {
    $typeName: 'moumantai.v1.ClientHello',
    deviceClass: overrides?.deviceClass ?? DeviceClass.PHONE,
    deviceProfile: {
      $typeName: 'moumantai.v1.DeviceProfile',
      width: 390,
      height: 844,
      shape: DeviceShape.RECT,
      ...overrides?.deviceProfile,
    },
    deviceId: overrides?.deviceId ?? '',
  }
  return create(ClientMessageSchema, { payload: { case: 'hello', value } })
}

interface ServerHelloShape {
  sessionId: string
}

async function connectClient(
  port: number,
  hello?: ClientMessage,
): Promise<[WebSocket, ServerHelloShape]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, ['moumantai.v1.proto'])
    ws.on('open', () => {
      ws.send(toBinary(ClientMessageSchema, hello ?? makeHelloMessage()))
    })
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      let msg: ServerMessage
      try {
        msg = fromBinary(ServerMessageSchema, data as Uint8Array)
      } catch {
        return
      }
      if (msg.payload.case === 'helloOk') {
        resolve([
          ws,
          {
            sessionId: msg.payload.value.sessionId,
          },
        ])
      }
    })
    ws.on('error', reject)
  })
}

function waitForMessage<T extends ServerMessage>(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs)
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      let msg: ServerMessage
      try {
        msg = fromBinary(ServerMessageSchema, data as Uint8Array)
      } catch {
        return
      }
      if (predicate(msg)) {
        clearTimeout(timeout)
        resolve(msg as T)
      }
    })
  })
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs)
    ws.on('close', (code, reason) => {
      clearTimeout(timeout)
      resolve({ code, reason: reason.toString() })
    })
  })
}

function startServer(): [WsServer, number] {
  const s = new WsServer({
    generateId: testGenerateId,
    handshakeTimeoutMs: 500,
  })
  const wss = s.listen(0)
  const addr = wss.address()
  const p = typeof addr === 'object' && addr ? addr.port : 0
  return [s, p]
}

describe('WsServer', () => {
  let server: WsServer
  let port: number

  beforeEach(() => {
    nextId = 0
    ;[server, port] = startServer()
  })

  afterEach(async () => {
    await server.close()
  })

  describe('handshake', () => {
    it('responds with ServerHello after valid ClientHello', async () => {
      const [ws, hello] = await connectClient(port)
      expect(hello.sessionId).toBe('test-session-0')
      ws.close()
    })

    it('assigns unique session IDs to each client', async () => {
      const [ws1, hello1] = await connectClient(port)
      const [ws2, hello2] = await connectClient(port)
      expect(hello1.sessionId).not.toBe(hello2.sessionId)
      ws1.close()
      ws2.close()
    })

    it('closes with 4001 if no ClientHello within timeout', async () => {
      const ws = new WebSocket(`ws://localhost:${port}`)
      const { code } = await waitForClose(ws, 3000)
      expect(code).toBe(4001)
    })

    it.each([
      {
        label: 'UNSPECIFIED device class',
        msg: () =>
          makeHelloMessage({
            deviceClass: DeviceClass.UNSPECIFIED,
            deviceProfile: { width: 100, height: 100, shape: DeviceShape.RECT },
          }),
      },
      {
        label: 'empty hello (proto defaults to UNSPECIFIED enum + zero dims)',
        msg: () => create(ClientMessageSchema, { payload: { case: 'hello', value: {} } }),
      },
    ])('closes with 4002 for invalid ClientHello: $label', async ({ msg }) => {
      const ws = new WebSocket(`ws://localhost:${port}`, ['moumantai.v1.proto'])
      const closePromise = waitForClose(ws, 5000)
      ws.on('open', () => {
        ws.send(toBinary(ClientMessageSchema, msg()))
      })
      const { code } = await closePromise
      expect(code).toBe(4002)
    })

    it('tracks client metadata after handshake', async () => {
      const [ws, serverHello] = await connectClient(
        port,
        makeHelloMessage({ deviceClass: DeviceClass.WATCH }),
      )
      const client = server.getClient(serverHello.sessionId)
      expect(client).toBeDefined()
      expect(client!.deviceClass).toBe(DeviceClass.WATCH)
      ws.close()
    })
  })

  describe('message routing', () => {
    it('routes ChatInput to chatInput handlers', async () => {
      const received: { sessionId: string; text: string }[] = []
      server.onChatInput((sid, msg) => received.push({ sessionId: sid, text: msg.text }))

      const [ws, hello] = await connectClient(port)
      ws.send(
        toBinary(
          ClientMessageSchema,
          create(ClientMessageSchema, {
            payload: { case: 'chatInput', value: { scope: 'home', text: 'Hello world' } },
          }),
        ),
      )

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1)
        },
        { timeout: 2000, interval: 20 },
      )
      expect(received[0]!.sessionId).toBe(hello.sessionId)
      expect(received[0]!.text).toBe('Hello world')
      ws.close()
    })

    it('silently ignores unknown message types (envelope decode fails)', async () => {
      const invokeReceived: unknown[] = []
      server.onInvokeTool((_, a) => invokeReceived.push(a))

      const [ws] = await connectClient(port)
      ws.send(Buffer.from([0xff, 0xfe, 0xfd]))

      await new Promise((r) => setTimeout(r, 100))
      expect(invokeReceived).toHaveLength(0)
      ws.close()
    })

    it('closes the socket on text frames post-handshake (proto subprotocol forbids them)', async () => {
      const [ws] = await connectClient(port)
      const closePromise = waitForClose(ws, 2000)
      ws.send('not a binary frame')
      const { code } = await closePromise
      expect(code).toBe(CloseCode.FRAME_TOO_LARGE)
    })
  })

  describe('send / broadcast', () => {
    it('sends message to a specific session', async () => {
      const [ws, hello] = await connectClient(port)

      const msgPromise = waitForMessage(ws, (m) => m.payload.case === 'chat')

      server.send(
        hello.sessionId,
        msgChat({
          id: 'srv-hi',
          scope: 'home',
          conversationId: 'c',
          role: 'assistant',
          text: 'Hi from server',
          timestamp: 't',
        }),
      )
      const msg = await msgPromise
      expect(msg.payload.case).toBe('chat')
      if (msg.payload.case !== 'chat') return
      expect(msg.payload.value.text).toBe('Hi from server')
      ws.close()
    })

    it('broadcasts to all connected clients', async () => {
      const [ws1] = await connectClient(port)
      const [ws2] = await connectClient(port)

      const msg1Promise = waitForMessage(ws1, (m) => m.payload.case === 'appList')
      const msg2Promise = waitForMessage(ws2, (m) => m.payload.case === 'appList')

      server.broadcast(msgAppList({ apps: [] }))

      const [r1, r2] = await Promise.all([msg1Promise, msg2Promise])
      expect(r1.payload.case).toBe('appList')
      expect(r2.payload.case).toBe('appList')

      ws1.close()
      ws2.close()
    })

    it('getClientCount reflects connected clients', async () => {
      expect(server.getClientCount()).toBe(0)
      const [ws1] = await connectClient(port)
      expect(server.getClientCount()).toBe(1)
      const [ws2] = await connectClient(port)
      expect(server.getClientCount()).toBe(2)
      ws1.close()
      ws2.close()
    })
  })

  describe('connect / disconnect', () => {
    it('calls onConnect handlers on successful handshake', async () => {
      const connects: { sessionId: string; deviceClass: DeviceClass }[] = []
      server.onConnect((sid, _did, dc) => connects.push({ sessionId: sid, deviceClass: dc }))

      const [ws] = await connectClient(port, makeHelloMessage({ deviceClass: DeviceClass.GLASS }))
      expect(connects).toHaveLength(1)
      expect(connects[0]!.deviceClass).toBe(DeviceClass.GLASS)
      ws.close()
    })

    it('calls onDisconnect handlers immediately on socket close (no grace)', async () => {
      const disconnects: string[] = []
      server.onDisconnect((sid) => disconnects.push(sid))

      const [ws, hello] = await connectClient(port)
      ws.close()

      // Supersede-on-deviceId: no grace window. The disconnect fires as
      // soon as the socket close event reaches the server.
      await vi.waitFor(
        () => {
          expect(disconnects).toHaveLength(1)
        },
        { timeout: 1000, interval: 20 },
      )
      expect(disconnects[0]).toBe(hello.sessionId)
    })

    it('supersedes prior socket on reconnect with same deviceId', async () => {
      const disconnects: string[] = []
      server.onDisconnect((sid) => disconnects.push(sid))

      const deviceId = 'test-device-supersede'
      const [ws1, hello1] = await connectClient(port, makeHelloMessage({ deviceId }))
      const session1 = hello1.sessionId

      // Same deviceId reconnects → server closes ws1 with code 1000
      // 'superseded' WITHOUT firing onDisconnect (the new connection is
      // the continuation, not a teardown).
      const [ws2, hello2] = await connectClient(port, makeHelloMessage({ deviceId }))
      expect(hello2.sessionId).not.toBe(session1)

      // Give time for the supersede close to propagate.
      await new Promise((r) => setTimeout(r, 100))

      // Disconnect handlers should NOT have fired for the superseded socket.
      expect(disconnects).toHaveLength(0)

      ws1.close() // already closed by server; just clean up
      ws2.close()
    })
  })
})

// ---------------------------------------------------------------------------
// Binary frame parsing (pure function, no server needed)
// ---------------------------------------------------------------------------

describe('parseBinaryFrame', () => {
  it('parses a valid audio binary frame with proto-encoded header', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04])
    const frame = encodeAudioFrame(
      audioChunkHeader({
        scope: 'home',
        format: AudioFormat.PCM16,
        sampleRate: 16000,
        final: true,
      }),
      payload,
    )

    const parsed = parseBinaryFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.frameType).toBe(BinaryFrameType.AUDIO)
    expect(parsed!.payload).toEqual(payload)
  })

  it('parses a valid image binary frame with proto-encoded header', () => {
    const payload = new TextEncoder().encode('fake-jpeg-data')
    const header = create(ImageChunkHeaderSchema, { scope: 'mini:receipt', mimeType: 'image/jpeg' })
    const frame = encodeImageFrame(header, payload)

    const parsed = parseBinaryFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.frameType).toBe(BinaryFrameType.IMAGE)
    expect(new TextDecoder().decode(parsed!.payload)).toBe('fake-jpeg-data')
  })

  it('returns null on undersized frames or oversized header claims', () => {
    expect(parseBinaryFrame(new Uint8Array([0x01]))).toBeNull()
    expect(parseBinaryFrame(new Uint8Array([0x01, 0x00]))).toBeNull()
    // Header length claim exceeds the frame body.
    expect(parseBinaryFrame(new Uint8Array([0x01, 0xff, 0x00, 0x00]))).toBeNull()
  })

  it('handles empty payload', () => {
    const frame = encodeAudioFrame(
      audioChunkHeader({
        scope: 'home',
        format: AudioFormat.PCM16,
        sampleRate: 16000,
        final: false,
      }),
      new Uint8Array(0),
    )
    const parsed = parseBinaryFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.payload.length).toBe(0)
  })
})

describe('encodeBinaryFrame', () => {
  it('round-trips arbitrary header bytes through parseBinaryFrame', () => {
    const headerBytes = new TextEncoder().encode('arbitrary opaque header')
    const payload = new TextEncoder().encode('hello binary world')
    const frame = encodeBinaryFrame(BinaryFrameType.AUDIO, headerBytes, payload)
    const parsed = parseBinaryFrame(frame)

    expect(parsed).not.toBeNull()
    expect(parsed!.frameType).toBe(BinaryFrameType.AUDIO)
    expect(new TextDecoder().decode(parsed!.headerBytes)).toBe('arbitrary opaque header')
    expect(new TextDecoder().decode(parsed!.payload)).toBe('hello binary world')
  })

  it('encodeAudioFrame round-trips through parseBinaryFrame + decodeAudioHeader', async () => {
    const { decodeAudioHeader } = await import('@moumantai/protocol')
    const inHeader = audioChunkHeader({
      scope: 'app:spend-tracker',
      format: AudioFormat.PCM16,
      sampleRate: 16000,
      final: true,
      clientMsgId: '01234567-89ab-cdef-0123-456789abcdef',
    })
    const frame = encodeAudioFrame(inHeader, new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    const parsed = parseBinaryFrame(frame)
    const outHeader = decodeAudioHeader(parsed!.headerBytes)

    expect(outHeader.scope).toBe(inHeader.scope)
    expect(outHeader.format).toBe(inHeader.format)
    expect(outHeader.sampleRate).toBe(inHeader.sampleRate)
    expect(outHeader.final).toBe(inHeader.final)
    expect(outHeader.clientMsgId).toBe(inHeader.clientMsgId)
  })
})

describe('broadcastToScope', () => {
  let s: WsServer
  let p: number

  beforeEach(() => {
    nextId = 0
    ;[s, p] = startServer()
  })

  afterEach(async () => {
    await s.close()
  })

  function decodeChat(received: ServerMessage[]) {
    return received.flatMap((m) => (m.payload.case === 'chat' ? [m.payload.value] : []))
  }

  function attachReceiver(ws: WebSocket): ServerMessage[] {
    const received: ServerMessage[] = []
    ws.on('message', (d, isBinary) => {
      if (!isBinary) return
      try {
        received.push(fromBinary(ServerMessageSchema, d as Uint8Array))
      } catch {
        /* ignore */
      }
    })
    return received
  }

  it('delivers to sockets whose activeScope matches and SKIPS the others', async () => {
    const [homeWs, homeHello] = await connectClient(p)
    const [spendWs, spendHello] = await connectClient(p)
    s.setActiveScope(homeHello.sessionId, 'home')
    s.setActiveScope(spendHello.sessionId, 'app:spend-tracker')

    const homeReceived = attachReceiver(homeWs)
    const spendReceived = attachReceiver(spendWs)

    const frame = msgChat({
      id: 'm1',
      scope: 'app:spend-tracker',
      conversationId: 'conv-spend',
      role: 'assistant',
      text: 'hi from spend',
      timestamp: new Date().toISOString(),
    })
    s.broadcastToScope('app:spend-tracker', frame)

    await new Promise((r) => setTimeout(r, 50))

    expect(decodeChat(homeReceived).some((c) => c.text === 'hi from spend')).toBe(false)
    expect(decodeChat(spendReceived).filter((c) => c.text === 'hi from spend')).toHaveLength(1)

    homeWs.close()
    spendWs.close()
  })

  it('delivers to EVERY socket currently viewing the scope (positive)', async () => {
    const [a, aHello] = await connectClient(p)
    const [b, bHello] = await connectClient(p)
    s.setActiveScope(aHello.sessionId, 'home')
    s.setActiveScope(bHello.sessionId, 'home')

    const aReceived = attachReceiver(a)
    const bReceived = attachReceiver(b)

    s.broadcastToScope(
      'home',
      msgChat({
        id: 'm2',
        scope: 'home',
        conversationId: 'conv-home',
        role: 'assistant',
        text: 'hello both',
        timestamp: new Date().toISOString(),
      }),
    )

    await new Promise((r) => setTimeout(r, 50))

    for (const received of [aReceived, bReceived]) {
      expect(decodeChat(received).filter((c) => c.text === 'hello both')).toHaveLength(1)
    }

    a.close()
    b.close()
  })
})
