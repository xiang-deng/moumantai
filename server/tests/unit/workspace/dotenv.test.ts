import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  parseEnvText,
  readEnvFile,
  applyToProcessEnv,
} from '../../../src/server/workspace/dotenv.js'

describe('parseEnvText', () => {
  it('parses simple KEY=value pairs', () => {
    expect(parseEnvText('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('handles double-quoted values with whitespace', () => {
    expect(parseEnvText('KEY="hello world"')).toEqual({ KEY: 'hello world' })
  })

  it('handles single-quoted values with whitespace', () => {
    expect(parseEnvText("KEY='hello world'")).toEqual({ KEY: 'hello world' })
  })

  it('strips trailing inline comments only when whitespace-separated', () => {
    expect(parseEnvText('A=1 # comment')).toEqual({ A: '1' })
    // No whitespace before #: kept verbatim (allows API keys that contain `#`)
    expect(parseEnvText('B=token#abc')).toEqual({ B: 'token#abc' })
  })

  it('skips blank lines and comment lines', () => {
    expect(parseEnvText('\n# comment\n\nA=1\n# another\nB=2\n')).toEqual({ A: '1', B: '2' })
  })

  it('tolerates `export` prefix', () => {
    expect(parseEnvText('export FOO=bar')).toEqual({ FOO: 'bar' })
  })

  it('treats KEY= as empty string', () => {
    expect(parseEnvText('KEY=')).toEqual({ KEY: '' })
  })

  it('ignores malformed lines: no `=`, leading digit, whitespace in key', () => {
    expect(parseEnvText('not-a-pair\n1BAD=v\n  bad space=v\nGOOD=ok')).toEqual({ GOOD: 'ok' })
  })
})

describe('readEnvFile', () => {
  // Only the ENOENT path is unique to readEnvFile — the real-file path is just
  // readFileSync + parseEnvText, both covered above and elsewhere.
  it('returns {} when file missing', () => {
    expect(readEnvFile(path.join(os.tmpdir(), 'definitely-not-here-xyz123'))).toEqual({})
  })
})

describe('applyToProcessEnv', () => {
  it('does NOT overwrite existing keys', () => {
    const target: NodeJS.ProcessEnv = { EXISTING: 'real' }
    applyToProcessEnv({ EXISTING: 'from-file', NEW_VAL: 'from-file' }, target)
    expect(target.EXISTING).toBe('real')
    expect(target.NEW_VAL).toBe('from-file')
  })

  it('fills gaps when keys are absent', () => {
    const target: NodeJS.ProcessEnv = {}
    applyToProcessEnv({ A: '1' }, target)
    expect(target.A).toBe('1')
  })
})
