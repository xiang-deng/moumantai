/**
 * Cross-language fixture round-trip — TypeScript leg.
 *
 * For every fixture under `shared/protocol/fixtures/`:
 *   1. Read the JSON.
 *   2. Decode into the typed protobuf-es message.
 *   3. Encode to canonical wire bytes and write `<fixture>.ts.bin`.
 *   4. Decode the wire bytes and re-encode; assert byte-identical (determinism check).
 *
 * `scripts/test-cross-language.py` then runs the Kotlin and C sub-runners, which
 * each read `.ts.bin`, decode via their own bindings, and write `.kotlin.bin` /
 * `.c.bin`. Byte-equality across all three is the cross-language acceptance gate.
 *
 * Usage:
 *   npm run fixture-roundtrip --workspace shared/protocol  # write .ts.bin files
 */
import { fromJson, toBinary, fromBinary, type DescMessage } from '@bufbuild/protobuf'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as messages from '../src/generated/moumantai/v1/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, '..', 'fixtures')
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
  const raw = fs.readFileSync(specPath, 'utf-8')
  return JSON.parse(raw) as FixtureSpecFile
}

/**
 * Resolve `messageName` to its protobuf-es schema descriptor.
 * Codegen exports schemas as `<MessageName>Schema` (e.g. `ClientHelloSchema`).
 */
function resolveSchema(messageName: string): DescMessage {
  const key = `${messageName}Schema`
  const schema = (messages as any)[key]
  if (!schema) {
    throw new Error(
      `fixture-roundtrip: no codegen schema named '${key}' exported from generated/moumantai/v1; ` +
        `did you regenerate via 'task protocol:gen'?`,
    )
  }
  return schema as DescMessage
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

interface RoundTripError {
  fixturePath: string
  error: unknown
}

function processFixture(spec: FixtureSpec, fixturePath: string): void {
  const json = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>
  const schema = resolveSchema(spec.message)

  const msg = fromJson(schema, json)
  const bytes1 = toBinary(schema, msg)
  // Round-trip: decode then re-encode must be byte-identical.
  const decoded = fromBinary(schema, bytes1)
  const bytes2 = toBinary(schema, decoded)

  if (!bytesEqual(bytes1, bytes2)) {
    throw new Error(
      `non-deterministic encode for ${path.relative(fixturesDir, fixturePath)}\n` +
        `  first  pass: ${bytesToHex(bytes1)}\n` +
        `  second pass: ${bytesToHex(bytes2)}`,
    )
  }

  const outPath = fixturePath.replace(/\.json$/, '.ts.bin')
  fs.writeFileSync(outPath, bytes1)
}

function main(): number {
  const specFile = loadSpec()
  const errors: RoundTripError[] = []
  let count = 0

  for (const spec of specFile.fixtures) {
    const dir = path.join(fixturesDir, spec.dir)
    if (!fs.existsSync(dir)) {
      console.error(`error: fixture dir missing: ${dir}`)
      return 2
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()

    if (files.length === 0) {
      console.error(`warn: no fixtures under ${spec.dir}`)
      continue
    }
    for (const f of files) {
      const fixturePath = path.join(dir, f)
      try {
        processFixture(spec, fixturePath)
        count++
      } catch (e) {
        errors.push({ fixturePath, error: e })
      }
    }
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} fixture(s) failed:`)
    for (const e of errors) {
      const rel = path.relative(fixturesDir, e.fixturePath)
      console.error(`  ${rel}: ${(e.error as Error).message}`)
    }
    return 1
  }

  console.log(`ok: round-tripped ${count} fixtures (TS bindings)`)
  return 0
}

process.exit(main())
