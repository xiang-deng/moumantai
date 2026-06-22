#!/usr/bin/env -S tsx
/**
 * wscat-protobuf — debug tool for the Moumantai protobuf wire codec.
 *
 * Connects via `Sec-WebSocket-Protocol: moumantai.v1.proto`, decodes every
 * inbound binary frame as a `ServerMessage`, and prints it as indented JSON.
 * Sends `ClientHello` automatically. Paste JSON-form `ClientMessage` payloads
 * into stdin to send messages after the server replies with hello-ok.
 *
 * Input/output uses proto-JSON form (`toJson()`): lowerCamelCase fields,
 * SCREAMING_SNAKE_CASE enum names, envelope as `{ chat: {...} }` etc.
 *
 * Usage:
 *   tsx scripts/wscat-protobuf.ts <ws-url>
 *   echo '{"viewing":{"scope":"home"}}' | tsx scripts/wscat-protobuf.ts ws://localhost:5174
 *
 * Optional flags:
 *   --device-class <PHONE|WATCH|GLASS|IOT_SMALL|HMI_PANEL>  default PHONE
 *   --width <int>    default 390
 *   --height <int>   default 844
 *   --shape <RECT|ROUND|WIDE>  default RECT
 *   --no-hello       skip the auto-hello
 */

import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf'
import {
  ClientMessageSchema,
  ServerMessageSchema,
} from '@moumantai/protocol/generated/moumantai/v1'

interface ParsedArgs {
  url: string
  deviceClass: string
  width: number
  height: number
  shape: string
  autoHello: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    url: '',
    deviceClass: 'DEVICE_CLASS_PHONE',
    width: 390,
    height: 844,
    shape: 'DEVICE_SHAPE_RECT',
    autoHello: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--device-class') {
      const v = argv[++i]
      if (v) out.deviceClass = v.startsWith('DEVICE_CLASS_') ? v : `DEVICE_CLASS_${v.toUpperCase()}`
    } else if (a === '--width') out.width = Number(argv[++i] ?? out.width)
    else if (a === '--height') out.height = Number(argv[++i] ?? out.height)
    else if (a === '--shape') {
      const v = argv[++i]
      if (v) out.shape = v.startsWith('DEVICE_SHAPE_') ? v : `DEVICE_SHAPE_${v.toUpperCase()}`
    } else if (a === '--no-hello') out.autoHello = false
    else if (!out.url && (a.startsWith('ws://') || a.startsWith('wss://'))) out.url = a
  }
  if (!out.url) {
    console.error(
      'usage: tsx scripts/wscat-protobuf.ts <ws-url> [--device-class PHONE] [--width 390] [--height 844] [--shape RECT] [--no-hello]',
    )
    process.exit(2)
  }
  return out
}

function nowIso(): string {
  return new Date().toISOString()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  // Lazy-import so the script fails gracefully if `ws` isn't installed.
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(args.url, ['moumantai.v1.proto'])

  ws.on('open', () => {
    console.error(`[${nowIso()}] connected to ${args.url} subprotocol=${ws.protocol}`)
    if (args.autoHello) {
      const hello = {
        hello: {
          deviceClass: args.deviceClass,
          deviceProfile: { width: args.width, height: args.height, shape: args.shape },
        },
      }
      const proto = fromJson(ClientMessageSchema, hello as never)
      const bytes = toBinary(ClientMessageSchema, proto)
      ws.send(bytes)
      console.error(`[${nowIso()}] sent hello (${bytes.length} bytes)`)
    }
  })

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      console.error(`[${nowIso()}] (text frame) ${data.toString()}`)
      return
    }
    const buf = data as Buffer
    try {
      const msg = fromBinary(ServerMessageSchema, buf)
      const json = toJson(ServerMessageSchema, msg)
      process.stdout.write(JSON.stringify(json, null, 2) + '\n')
    } catch (e) {
      console.error(
        `[${nowIso()}] decode failed: ${(e as Error).message}; raw bytes: ${buf.toString('hex')}`,
      )
    }
  })

  ws.on('close', (code, reason) => {
    console.error(`[${nowIso()}] closed code=${code} reason=${reason.toString() || '(none)'}`)
    process.exit(0)
  })

  ws.on('error', (err) => {
    console.error(`[${nowIso()}] error: ${err.message}`)
    process.exit(1)
  })

  // Each non-empty stdin line is a ClientMessage in proto-JSON envelope form.
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>
      const proto = fromJson(ClientMessageSchema, json as never)
      const bytes = toBinary(ClientMessageSchema, proto)
      ws.send(bytes)
      console.error(`[${nowIso()}] sent ${bytes.length} bytes`)
    } catch (e) {
      console.error(`[${nowIso()}] send failed: ${(e as Error).message}`)
    }
  })
  rl.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close()
  })
}

if (
  import.meta.url === `file://${fileURLToPath(import.meta.url).replace(/\\/g, '/')}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error(`fatal: ${(e as Error).message}`)
    process.exit(1)
  })
}
