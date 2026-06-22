import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable, Readable } from 'node:stream'
import type { Interface as RlInterface } from 'node:readline/promises'
import { runWizard } from '../../../src/server/workspace/wizard.js'

let tmpHome: string
let originalCwd: string

beforeEach(() => {
  originalCwd = process.cwd()
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-wizard-'))
  // Block any real network calls in case the wizard validation fires.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ok', { status: 200 })),
  )
  // Avoid auto-detecting repo apps: chdir to a location with no `apps/` parent.
  process.chdir(os.tmpdir())
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

interface FakeRl {
  rl: RlInterface
  prompts: string[]
}

/** Mock readline.Interface that returns scripted answers in order, ignoring extra prompts. */
function fakeReadline(answers: string[]): FakeRl {
  let i = 0
  const prompts: string[] = []
  const rl: Partial<RlInterface> = {
    question: ((q: string) => {
      prompts.push(q)
      return Promise.resolve(answers[i++] ?? '')
    }) as RlInterface['question'],
    close: () => {},
  }
  return { rl: rl as RlInterface, prompts }
}

function makeStreams() {
  const out: string[] = []
  const err: string[] = []
  const stdout = new Writable({
    write(c, _e, cb) {
      out.push(c.toString())
      cb()
    },
  })
  const stderr = new Writable({
    write(c, _e, cb) {
      err.push(c.toString())
      cb()
    },
  })
  const stdin = Readable.from([])
  return { stdout, stderr, stdin, outText: () => out.join(''), errText: () => err.join('') }
}

/**
 * Run the wizard with `pointerPath: null` so tests never write the real pointer file.
 * `home` is set to `tmpHome` so the default workspace suggestion resolves there.
 */
function callWizard(io: {
  home: string
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin: NodeJS.ReadableStream
  readline: RlInterface
}): Promise<void> {
  return runWizard({ ...io, pointerPath: null })
}

describe('runWizard', () => {
  it('fresh run with all defaults: skip credential, no voice, default port', async () => {
    const { rl } = fakeReadline([
      '', // workspace location → accept default (tmpHome)
      '', // backend default → claude
      '', // skip Anthropic credential
      'n', // setup voice? no
      '', // port = 3000 (default)
      '', // dev mode? → default (no)
      'y', // confirm write
    ])
    const s = makeStreams()
    await callWizard({
      home: tmpHome,
      stdout: s.stdout,
      stderr: s.stderr,
      stdin: s.stdin,
      readline: rl,
    })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'))
    expect(cfg.backend).toBe('claude')
    expect(cfg.port).toBe(3000)
    expect(cfg.voice.sttModel).toBe('gpt-4o-mini-transcribe')
    expect(s.outText()).toMatch(/Workspace ready/)
  })

  it('writes API key to ANTHROPIC_API_KEY when credential prefix is sk-ant-api', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )

    const { rl } = fakeReadline([
      '', // workspace → accept default
      '', // backend default → claude
      'sk-ant-api-test', // API key (sk-ant-api... → ANTHROPIC_API_KEY)
      'n', // skip voice
      '', // default port
      '', // dev mode? → default (no)
      'y', // confirm
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    const envContent = fs.readFileSync(path.join(tmpHome, '.env'), 'utf8')
    expect(envContent).toMatch(/^ANTHROPIC_API_KEY=sk-ant-api-test$/m)
    // The prompt points the user at how to obtain an OAuth token.
    expect(s.outText()).toMatch(/claude setup-token/)
  })

  it('writes OAuth token to CLAUDE_CODE_OAUTH_TOKEN when credential prefix is sk-ant-oat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )

    const { rl } = fakeReadline([
      '', // workspace → accept default
      '', // backend default → claude
      'sk-ant-oat01-abc', // OAuth token → CLAUDE_CODE_OAUTH_TOKEN
      'n',
      '',
      '', // dev mode? → default (no)
      'y',
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    const envContent = fs.readFileSync(path.join(tmpHome, '.env'), 'utf8')
    expect(envContent).toMatch(/^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc$/m)
    expect(envContent).not.toMatch(/^ANTHROPIC_API_KEY=/m)
  })

  it('quotes API keys containing # so they round-trip through dotenv', async () => {
    // The dotenv parser strips trailing `# comment` from unquoted values.
    // If the wizard writes a raw `KEY=foo#bar`, it gets re-read as `foo`.
    // Mitigation: write quoted when the value contains `#` or whitespace.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )

    const tokenWithHash = 'sk-ant-api-abc#def' // contrived but matches API-key shapes
    const { rl } = fakeReadline([
      '', // workspace → accept default
      '', // backend default → claude
      tokenWithHash,
      'n',
      '',
      '', // dev mode? → default (no)
      'y',
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    // Round-trip: writing then re-parsing must yield the original value.
    const { readEnvFile } = await import('../../../src/server/workspace/dotenv.js')
    const parsed = readEnvFile(path.join(tmpHome, '.env'))
    expect(parsed.ANTHROPIC_API_KEY).toBe(tokenWithHash)
  })

  it('cancel at confirm: nothing is written', async () => {
    const { rl } = fakeReadline([
      '', // workspace location → accept default (tmpHome)
      '', // backend default → claude
      '', // skip credential
      'n', // skip voice
      '', // default port
      '', // dev mode? → default (no)
      'n', // do NOT confirm
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    expect(s.outText()).toMatch(/Cancelled/)
    // config.json may or may not have been pre-loaded (defaulted) but no
    // "Workspace ready" line should appear.
    expect(s.outText()).not.toMatch(/Workspace ready/)
  })

  it('invalid API key triggers retry prompt; user can skip', async () => {
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++
        return new Response('nope', { status: 401 })
      }),
    )

    const { rl, prompts } = fakeReadline([
      '', // workspace → accept default
      '', // backend default → claude
      'sk-bad', // first attempt
      'n', // do NOT retry
      'n', // skip voice
      '', // default port
      '', // dev mode? → default (no)
      'y', // confirm
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    // The validation was attempted (401)
    expect(callCount).toBe(1)
    // Wizard wrote config.json but no API key in .env (skipped)
    const envPath = path.join(tmpHome, '.env')
    if (fs.existsSync(envPath)) {
      expect(fs.readFileSync(envPath, 'utf8')).not.toMatch(/sk-bad/)
    }
    // Confirmation prompt was reached
    expect(prompts.some((p) => p.includes('Write these settings'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Pi backend flows
  // -------------------------------------------------------------------------

  describe('pi backend', () => {
    beforeEach(() => {
      // Wipe Anthropic env state — these tests own credential detection.
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_OAUTH_TOKEN
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.OPENAI_API_KEY
      delete process.env.GEMINI_API_KEY
    })

    it('pi + anthropic API-key happy path: writes ANTHROPIC_API_KEY + pi config', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('ok', { status: 200 })),
      )
      const { rl } = fakeReadline([
        '', // workspace → accept default
        '2', // backend = pi
        '1', // provider = anthropic
        '', // model = default (claude-opus-4-7)
        '', // thinking level = default (medium)
        '1', // menu pick [1] API key
        'sk-ant-api-fresh', // the key
        'n', // no voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'))
      expect(cfg.backend).toBe('pi')
      expect(cfg.pi.provider).toBe('anthropic')
      expect(cfg.pi.model).toBe('claude-opus-4-7')
      expect(cfg.pi.thinkingLevel).toBe('medium')

      const envText = fs.readFileSync(path.join(tmpHome, '.env'), 'utf8')
      expect(envText).toMatch(/^ANTHROPIC_API_KEY=sk-ant-api-fresh$/m)
    })

    it('pi + anthropic OAuth-mirror: pre-existing CLAUDE_CODE_OAUTH_TOKEN is mirrored to ANTHROPIC_OAUTH_TOKEN', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-shared'
      const { rl } = fakeReadline([
        '', // workspace → accept default
        '2', // backend = pi
        '1', // provider = anthropic
        '', // default model
        '', // default thinking
        '', // mirror [Y/n] default Y
        'n', // no voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      const envText = fs.readFileSync(path.join(tmpHome, '.env'), 'utf8')
      expect(envText).toMatch(/^ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-shared$/m)
      // Wizard should NOT also write ANTHROPIC_API_KEY in this case.
      expect(envText).not.toMatch(/^ANTHROPIC_API_KEY=/m)
    })

    it('pi + anthropic auth.json reuse: existing OAuth in <home>/pi-agent/auth.json bypasses prompts', async () => {
      fs.mkdirSync(path.join(tmpHome, 'pi-agent'), { recursive: true })
      const future = Date.now() + 60 * 60 * 1000
      fs.writeFileSync(
        path.join(tmpHome, 'pi-agent', 'auth.json'),
        JSON.stringify({
          anthropic: { type: 'oauth', access: 'tok', refresh: 'ref', expires: future },
        }),
      )
      const { rl, prompts } = fakeReadline([
        '', // workspace → accept default
        '2', // backend = pi
        '1', // provider = anthropic
        '', // default model
        '', // default thinking
        // NO credential prompts expected — auth.json takes over
        'n', // no voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      // Wizard mentions auth.json reuse
      expect(s.outText()).toMatch(/auth\.json/)
      // No credential setup menu was shown
      expect(prompts.some((p) => p.includes('How do you want to authenticate'))).toBe(false)
    })

    // NOTE: The spawn-based OAuth flow (menu [2] → pi /login) is exercised by
    // manual smoke testing rather than unit tests. We attempted to mock
    // `node:child_process.spawn` here, but combining the mock with vitest's
    // own forks pool reliably crashes the worker (heap OOM via something in
    // vitest's startup path interacting with the partial child_process
    // namespace). The covered paths below — detection (a-d), menu pick [1]
    // API key, menu pick [s] skip — exercise everything around the spawn.
    // The spawn helper itself is small and self-contained:
    //   spawn(process.execPath, [piCliPath], { stdio: 'inherit', env })
    //   await exit → checkPiProviderAuth(authFile, provider)
    // and the auth.json read path IS tested via the auth.json-reuse case.

    it('pi + openai (API-key): uses existing OPENAI_API_KEY from env, no prompt', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-existing'
      const { rl, prompts } = fakeReadline([
        '', // workspace → accept default
        '2', // backend = pi
        '2', // provider = openai
        '', // default model (gpt-5.4)
        '', // default thinking
        // No credential prompt expected — env already has it
        'n', // no voice (skip the voice prompt which would re-ask for openai)
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'))
      expect(cfg.pi.provider).toBe('openai')
      expect(s.outText()).toMatch(/Found OPENAI_API_KEY in env/)
      // Wizard did NOT prompt for a key
      expect(prompts.some((p) => p.includes('OpenAI API key'))).toBe(false)
    })

    it('pi + google (API-key): prompts and validates Gemini key', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{"models":[]}', { status: 200 })),
      )
      const { rl } = fakeReadline([
        '', // workspace → accept default
        '2', // backend = pi
        '4', // provider = google
        '', // default model (gemini-3.1-pro-preview)
        '', // default thinking
        'AIzaSyDmock', // gemini key
        'n', // no voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      const envText = fs.readFileSync(path.join(tmpHome, '.env'), 'utf8')
      expect(envText).toMatch(/^GEMINI_API_KEY=AIzaSyDmock$/m)
    })

    it('pi + anthropic skip [s]: writes config.json but no env, prints warning', async () => {
      const { rl } = fakeReadline([
        '', // workspace → accept default
        '2', // backend = pi
        '1', // provider = anthropic
        '', // default model
        '', // default thinking
        's', // skip credentials
        'n', // no voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'))
      expect(cfg.backend).toBe('pi')
      expect(cfg.pi.provider).toBe('anthropic')
      // No env file written, OR an existing one without any ANTHROPIC_* keys
      const envPath = path.join(tmpHome, '.env')
      if (fs.existsSync(envPath)) {
        const envText = fs.readFileSync(envPath, 'utf8')
        expect(envText).not.toMatch(/ANTHROPIC_/)
      }
      expect(s.errText()).toMatch(/Skipping credential setup|server will refuse/)
    })
  })

  it('preserves existing values on re-run (defaults shown match prior state)', async () => {
    // Pre-seed a config
    fs.writeFileSync(
      path.join(tmpHome, 'config.json'),
      JSON.stringify({
        port: 4242,
        backend: 'claude',
      }),
    )

    const { rl, prompts } = fakeReadline([
      '', // workspace location → accept default (tmpHome)
      '', // backend default → claude (existing config has backend='claude')
      '', // skip credential
      'n', // skip voice
      '', // port default → 4242
      '', // dev mode? → default (no)
      'y', // confirm
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'))
    expect(cfg.port).toBe(4242)
    expect(cfg.backend).toBe('claude')
    // The port prompt showed [4242] as default
    expect(prompts.some((p) => p.includes('4242'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Developer mode (step 4b)
  // -------------------------------------------------------------------------

  it('writes devMode=true when the user opts in, and is off by default', async () => {
    const { rl, prompts } = fakeReadline([
      '', // workspace → accept default
      '', // backend default → claude
      '', // skip credential
      'n', // skip voice
      '', // default port
      'y', // dev mode? → YES
      'y', // confirm write
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'))
    expect(cfg.devMode).toBe(true)
    // The prompt was actually shown, and the summary reflects the choice.
    expect(prompts.some((p) => /developer mode/i.test(p))).toBe(true)
    expect(s.outText()).toMatch(/devMode = enabled/)
  })

  it('defaults devMode to the prior value on re-run (preserved when not changed)', async () => {
    // Pre-seed a config with devMode already enabled.
    fs.writeFileSync(
      path.join(tmpHome, 'config.json'),
      JSON.stringify({
        port: 3000,
        backend: 'claude',
        devMode: true,
      }),
    )

    const { rl, prompts } = fakeReadline([
      '', // workspace → accept default
      '', // backend default → claude
      '', // skip credential
      'n', // skip voice
      '', // default port
      '', // dev mode? → accept default (prior = enabled)
      'y', // confirm
    ])
    const s = makeStreams()
    await callWizard({ home: tmpHome, ...s, readline: rl })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'))
    expect(cfg.devMode).toBe(true)
    // The dev-mode prompt defaulted to Yes (prior value), shown as [Y/n].
    expect(prompts.some((p) => /developer mode/i.test(p) && p.includes('[Y'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Workspace location (step 0)
  // -------------------------------------------------------------------------

  describe('workspace location', () => {
    it('lists tmpHome as a numbered option and accepts it by default', async () => {
      const { rl, prompts } = fakeReadline([
        '', // accept default workspace
        '', // backend default → claude
        '', // skip credential
        'n', // skip voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      // The workspace prompt was shown with tmpHome surfaced
      expect(s.outText()).toMatch(/Workspace location/)
      expect(s.outText()).toContain(tmpHome)
      // config landed inside tmpHome
      expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true)
      // Pick prompt was issued
      expect(prompts.some((p) => /^Pick \[/.test(p))).toBe(true)
    })

    it('writes the pointer file when pointerPath is provided', async () => {
      const pointerPath = path.join(tmpHome, 'pointer-out')
      const { rl } = fakeReadline([
        '', // accept default workspace
        '', // backend default → claude
        '', // skip credential
        'n', // skip voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await runWizard({ home: tmpHome, ...s, readline: rl, pointerPath })

      expect(fs.existsSync(pointerPath)).toBe(true)
      expect(fs.readFileSync(pointerPath, 'utf8').trim()).toBe(path.resolve(tmpHome))
    })

    it('honors a custom path entered via [c]', async () => {
      const customHome = path.join(tmpHome, 'custom-location')
      const { rl } = fakeReadline([
        'c', // custom path
        customHome, // the path
        '', // backend default
        '', // skip credential
        'n', // skip voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await callWizard({ home: tmpHome, ...s, readline: rl })

      // config landed at the custom location, NOT tmpHome
      expect(fs.existsSync(path.join(customHome, 'config.json'))).toBe(true)
      expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(false)
    })

    it('soft-fails when pointer write throws (read-only fs simulated by bad parent path)', async () => {
      // Pass a pointer path whose parent we cannot create (a file we own
      // posing as the parent dir). writeHomePointer throws; the wizard
      // catches and continues with a warning.
      const parentFile = path.join(tmpHome, 'blocker')
      fs.writeFileSync(parentFile, 'I am a file, not a dir', 'utf8')
      const pointerPath = path.join(parentFile, 'pointer') // can't mkdir inside a regular file

      const { rl } = fakeReadline([
        '', // accept default workspace
        '', // backend default
        '', // skip credential
        'n', // skip voice
        '', // default port
        '', // dev mode? → default (no)
        'y', // confirm
      ])
      const s = makeStreams()
      await expect(
        runWizard({ home: tmpHome, ...s, readline: rl, pointerPath }),
      ).resolves.toBeUndefined()
      expect(s.errText()).toMatch(/Couldn't write workspace pointer/)
      // config still wrote — the workspace itself is fine
      expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true)
    })
  })
})
