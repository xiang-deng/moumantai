/**
 * Protocol fixture round-trip: typed `ServerMessage`/`ClientMessage` encode via
 * `toBinary`, decode via `fromBinary`, and assert the typed shape survives.
 * Catches bugs in the builders' DB↔proto enum translation and field defaulting.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { create, fromBinary, fromJson, toBinary, type DescMessage } from '@bufbuild/protobuf'
import * as messages from '@moumantai/protocol/generated/moumantai/v1'
import {
  ClientMessageSchema,
  ServerMessageSchema,
  DeviceClass,
  DeviceShape,
  VoiceStateValue,
  ProtocolErrorCode,
} from '@moumantai/protocol/generated/moumantai/v1'
import {
  msgHelloOk,
  msgChat,
  msgVoiceState,
  msgError,
  msgAppList,
  msgFaceUpdate,
} from '../../src/server/transport/messages.js'
import {
  scaffold,
  topBar,
  column,
  text,
  pathRef,
} from '../../src/server/protocol/components/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, '..', '..', '..', 'shared', 'protocol', 'fixtures')
const specPath = path.join(fixturesDir, 'fixtures.spec.json')

interface FixtureSpec {
  dir: string
  message: string
  package: string
}
interface FixtureSpecFile {
  fixtures: FixtureSpec[]
}

function loadSpec(): FixtureSpecFile {
  return JSON.parse(fs.readFileSync(specPath, 'utf-8')) as FixtureSpecFile
}

function resolveSchema(messageName: string): DescMessage {
  const schema = (messages as unknown as Record<string, DescMessage>)[`${messageName}Schema`]
  if (!schema) throw new Error(`no codegen schema named '${messageName}Schema' exported`)
  return schema
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Per-fixture byte-equality round-trip lives in shared/protocol/scripts/fixture-roundtrip.ts.

describe('envelope builders: typed wire round-trip', () => {
  it('hello-ok envelope preserves session id (no resume creds)', () => {
    const bytes = toBinary(
      ServerMessageSchema,
      msgHelloOk({
        sessionId: 'abc-123',
      }),
    )
    const back = fromBinary(ServerMessageSchema, bytes)
    expect(back.payload.case).toBe('helloOk')
    if (back.payload.case !== 'helloOk') return
    expect(back.payload.value.sessionId).toBe('abc-123')
  })

  it('chat message with enum role + status', () => {
    const bytes = toBinary(
      ServerMessageSchema,
      msgChat({
        id: '11111111-1111-1111-1111-111111111111',
        scope: 'home',
        conversationId: '22222222-2222-2222-2222-222222222222',
        role: 'user',
        text: 'hello there',
        timestamp: '2026-04-25T12:34:56Z',
        status: 'pending',
        clientMsgId: 'client-msg-1',
      }),
    )
    const back = fromBinary(ServerMessageSchema, bytes)
    expect(back.payload.case).toBe('chat')
    if (back.payload.case !== 'chat') return
    const chat = back.payload.value
    expect(chat.role).toBe(messages.ChatRole.USER)
    expect(chat.status).toBe(messages.TurnStatus.PENDING)
    expect(chat.text).toBe('hello there')
    expect(chat.scope).toBe('home')
    expect(chat.clientMsgId).toBe('client-msg-1')
  })

  it('voice state preserves enum value', () => {
    const bytes = toBinary(ServerMessageSchema, msgVoiceState({ state: VoiceStateValue.THINKING }))
    const back = fromBinary(ServerMessageSchema, bytes)
    expect(back.payload.case).toBe('voiceState')
    if (back.payload.case !== 'voiceState') return
    expect(back.payload.value.state).toBe(VoiceStateValue.THINKING)
  })

  it('error message preserves error code mapping', () => {
    const bytes = toBinary(
      ServerMessageSchema,
      msgError({
        code: ProtocolErrorCode.RATE_LIMITED,
        message: 'slow down',
        retryAfterMs: 1000,
      }),
    )
    const back = fromBinary(ServerMessageSchema, bytes)
    expect(back.payload.case).toBe('error')
    if (back.payload.case !== 'error') return
    expect(back.payload.value.code).toBe(ProtocolErrorCode.RATE_LIMITED)
    expect(back.payload.value.retryAfterMs).toBe(1000)
    expect(back.payload.value.message).toBe('slow down')
  })

  it('client hello round-trips with nav intent', () => {
    const msg = create(ClientMessageSchema, {
      payload: {
        case: 'hello',
        value: {
          deviceClass: DeviceClass.PHONE,
          deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
          currentAppId: 'home',
        },
      },
    })
    const bytes = toBinary(ClientMessageSchema, msg)
    const back = fromBinary(ClientMessageSchema, bytes)
    expect(back.payload.case).toBe('hello')
    if (back.payload.case !== 'hello') return
    const hello = back.payload.value
    expect(hello.deviceClass).toBe(DeviceClass.PHONE)
    expect(hello.currentAppId).toBe('home')
    expect(hello.deviceProfile).toMatchObject({ width: 390, height: 844, shape: DeviceShape.RECT })
  })

  it('chat input preserves scope + text + clientMsgId', () => {
    const msg = create(ClientMessageSchema, {
      payload: {
        case: 'chatInput',
        value: { scope: 'home', text: 'what is the weather?', clientMsgId: 'cmid-1' },
      },
    })
    const bytes = toBinary(ClientMessageSchema, msg)
    const back = fromBinary(ClientMessageSchema, bytes)
    expect(back.payload.case).toBe('chatInput')
    if (back.payload.case !== 'chatInput') return
    expect(back.payload.value).toMatchObject({
      scope: 'home',
      text: 'what is the weather?',
      clientMsgId: 'cmid-1',
    })
  })

  it('viewing message round-trips', () => {
    const msg = create(ClientMessageSchema, {
      payload: { case: 'viewing', value: { scope: 'app:spend-tracker' } },
    })
    const bytes = toBinary(ClientMessageSchema, msg)
    const back = fromBinary(ClientMessageSchema, bytes)
    expect(back.payload.case).toBe('viewing')
    if (back.payload.case !== 'viewing') return
    expect(back.payload.value).toMatchObject({ scope: 'app:spend-tracker' })
  })

  it('app list with nested apps array', () => {
    // proto3 strips scalar defaults on the wire; only asserting nonzero positions.
    const apps = [
      { appId: 'home', label: 'Home', icon: 'home', position: 1 },
      { appId: 'spend-tracker', label: 'Spend', icon: 'attach_money', position: 2 },
    ]
    const bytes = toBinary(ServerMessageSchema, msgAppList({ apps }))
    const back = fromBinary(ServerMessageSchema, bytes)
    expect(back.payload.case).toBe('appList')
    if (back.payload.case !== 'appList') return
    expect(back.payload.value.apps).toHaveLength(2)
    expect(back.payload.value.apps[0]).toMatchObject({
      appId: 'home',
      label: 'Home',
      icon: 'home',
      position: 1,
    })
    expect(back.payload.value.apps[1]).toMatchObject({
      appId: 'spend-tracker',
      label: 'Spend',
      icon: 'attach_money',
      position: 2,
    })
  })

  it('face update with simple components', () => {
    const bytes = toBinary(
      ServerMessageSchema,
      msgFaceUpdate({
        scope: 'home',
        appId: 'home',
        faceId: 'main',
        components: [
          scaffold('root', { top_bar: 'top', body: 'content' }),
          topBar('top', 'Moumantai'),
          column('content', ['welcome'], { spacing: 8, padding: 16 }),
          text('welcome', 'Welcome to Moumantai', { typography: 'headlineMedium' }),
        ],
        data: { hint: 'Hello' },
      }),
    )
    const back = fromBinary(ServerMessageSchema, bytes)
    expect(back.payload.case).toBe('faceUpdate')
    if (back.payload.case !== 'faceUpdate') return
    const fu = back.payload.value
    expect(fu.faceId).toBe('main')
    expect(fu.scope).toBe('home')
    expect(fu.components).toHaveLength(4)

    const root = fu.components[0]
    expect(root.id).toBe('root')
    expect(root.component.case).toBe('scaffold')
    if (root.component.case === 'scaffold') {
      expect(root.component.value.topBar).toBe('top')
      expect(root.component.value.body).toBe('content')
    }

    const welcome = fu.components[3]
    expect(welcome.id).toBe('welcome')
    expect(welcome.component.case).toBe('text')
    if (welcome.component.case === 'text') {
      const t = welcome.component.value
      expect(t.typography).toBe('headlineMedium')
      expect(t.text?.value.case).toBe('literal')
      if (t.text?.value.case === 'literal') {
        expect(t.text.value.value).toBe('Welcome to Moumantai')
      }
    }

    const col = fu.components[2]
    expect(col.component.case).toBe('column')
    if (col.component.case === 'column') {
      expect(col.component.value.spacing).toBe(8)
    }
  })

  it('face update with pathRef-style dynamic value', () => {
    const bytes = toBinary(
      ServerMessageSchema,
      msgFaceUpdate({
        scope: 'home',
        appId: 'home',
        faceId: 'main',
        components: [text('hint', pathRef('/hint'), { typography: 'bodyMedium' })],
        data: { hint: 'Type a message' },
      }),
    )
    const back = fromBinary(ServerMessageSchema, bytes)
    expect(back.payload.case).toBe('faceUpdate')
    if (back.payload.case !== 'faceUpdate') return
    const hint = back.payload.value.components[0]
    expect(hint.id).toBe('hint')
    expect(hint.component.case).toBe('text')
    if (hint.component.case !== 'text') return
    expect(hint.component.value.typography).toBe('bodyMedium')
    expect(hint.component.value.text?.value.case).toBe('path')
    if (hint.component.value.text?.value.case === 'path') {
      expect(hint.component.value.text.value.value).toBe('/hint')
    }
  })
})
