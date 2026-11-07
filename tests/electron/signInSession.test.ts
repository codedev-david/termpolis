// The hidden sign-in session (src/main/signInSession.ts), against the mock CLIs (tests/electron/mocks)
// run in-process behind a fake PTY, with fake timers: every state the sheet shows, and every guard on
// what reaches the CLI. signInSessionPty.test.ts runs the same mocks through real node-pty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'module'
import {
  AGY_SIGN_IN_SHOW_MS, ANSWER_SETTLE_MS, MAX_OUTPUT, PICK_MOVE_MS, TICK_MS, _resetSignInSessionsForTest, _typedHeldForTest, endSignIns, endSignInsOf, signInInput,
  signInSessionCount, startSignInSession,
} from '../../src/main/signInSession'
import type { Confirmed, PtyLike, SessionDeps, SessionSpec } from '../../src/main/signInSession'
import { SIGN_IN_TIMEOUT_MS, SIGN_IN_UNKNOWN_MS } from '../../src/shared/signInScreens'
import type { SignInPhase, SignInState } from '../../src/shared/signInScreens'

const require = createRequire(import.meta.url)
const { createMockLogin } = require('./mocks/mockLogin.cjs') as { createMockLogin: (io: unknown) => { input: (d: string) => void } }
const { createMockAgy } = require('./mocks/mockAgy.cjs') as { createMockAgy: (io: unknown) => { input: (d: string) => void } }

interface FakePty extends PtyLike {
  writes: string[]
  killed: boolean
  exited: boolean
}

let sent: SignInState[]
let ptys: FakePty[]
let deps: SessionDeps

/** A fake PTY that runs a mock CLI in-process: what the session writes is the mock's input, what the
 *  mock writes is the PTY's output. */
function fakePty(make: (io: { write: (s: string) => void; exit: (code: number) => void }) => { input: (d: string) => void }): FakePty {
  // Like a real PTY, what the CLI prints before anyone listens is delivered once they do.
  let onData: ((d: string) => void) | null = null
  let onExit: ((e: { exitCode: number }) => void) | null = null
  const pending: string[] = []
  let exitCode: number | null = null
  const pty: FakePty = {
    pid: 4000 + ptys.length,
    writes: [],
    killed: false,
    exited: false,
    write: (d) => { pty.writes.push(d); cli.input(d) },
    kill: () => { pty.killed = true },
    onData: (cb) => { onData = cb; for (const d of pending.splice(0)) cb(d) },
    onExit: (cb) => { onExit = cb; if (exitCode !== null) cb({ exitCode }) },
  }
  const cli = make({
    write: (s) => {
      if (pty.exited) return
      if (onData) onData(s)
      else pending.push(s)
    },
    exit: (code) => {
      if (pty.exited) return
      pty.exited = true
      if (onExit) onExit({ exitCode: code })
      else exitCode = code
    },
  })
  ptys.push(pty)
  return pty
}

function login(env: Record<string, string> = {}) {
  return (file: string, args: string[] | string) => fakePty((io) => createMockLogin({ ...io, env, args: args as string[] }))
}

function agy(env: Record<string, string> = {}) {
  return () => fakePty((io) => createMockAgy({ ...io, env }))
}

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    accountId: 'acc_1', agent: 'claude', key: 'claude:/p', file: 'claude', args: ['auth', 'login', '--claudeai'], env: {}, cwd: '/tmp', mode: 'sign-in',
    label: 'codedev', confirm: async () => ({ email: 'person@example.test', plan: 'max' }), ...over,
  }
}

const phases = (): SignInPhase['kind'][] => sent.map((s) => s.phase.kind)
const last = (): SignInPhase => sent[sent.length - 1].phase
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetSignInSessionsForTest()
  sent = []
  ptys = []
  deps = {
    spawn: login(),
    killTree: vi.fn(),
    send: (s) => { sent.push(JSON.parse(JSON.stringify(s)) as SignInState) },
    openExternal: vi.fn(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  }
})

afterEach(() => {
  endSignIns()
  vi.useRealTimers()
})

describe('Claude Code: claude auth login', () => {
  it('shows the browser step with its address, and signs in with the code the user pasted', async () => {
    const confirm = vi.fn(async (): Promise<Confirmed> => ({ email: 'person@example.test', plan: 'max' }))
    const { sessionId } = startSignInSession(spec({ confirm }), deps)
    expect(last()).toEqual({ kind: 'starting' })
    await advance(TICK_MS)
    const b = last() as Extract<SignInPhase, { kind: 'browser' }>
    expect(b.kind).toBe('browser')
    expect(b.url!.startsWith('https://claude.com/cai/oauth/authorize?')).toBe(true)
    expect(b.canOpen).toBe(true)
    expect(b.codeField).toBe(true)
    expect(await signInInput(sessionId, { kind: 'code', value: '  good-code  ' })).toEqual({ ok: true })
    expect(ptys[0].writes).toEqual(['good-code\r'])
    await advance(TICK_MS)
    // Working on it as the code went in, then its status command asked, in that order.
    expect(phases().slice(-3)).toEqual(['working', 'confirming', 'success'])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(last()).toEqual({ kind: 'success', email: 'person@example.test', plan: 'max' })
    expect(phases()).toContain('confirming')
    expect(signInSessionCount()).toBe(0)
    // It exited by itself: nothing to end.
    expect(deps.killTree).not.toHaveBeenCalled()
  })

  it('asks the CLI\'s status command once, though its tick comes round again while that is being asked (UI-R1-I)', async () => {
    let release: (c: Confirmed) => void = () => undefined
    const confirm = vi.fn(() => new Promise<Confirmed>((r) => { release = r }))
    const { sessionId } = startSignInSession(spec({ confirm }), deps)
    await advance(TICK_MS)
    await signInInput(sessionId, { kind: 'code', value: 'good-code' })
    await advance(TICK_MS)
    expect(confirm).toHaveBeenCalledTimes(1)
    await advance(TICK_MS * 6)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(last().kind).toBe('confirming')
    release({ email: 'person@example.test', plan: 'max' })
    await advance(TICK_MS)
    expect(last()).toEqual({ kind: 'success', email: 'person@example.test', plan: 'max' })
  })

  it('says the CLI\'s own words when the code is wrong, and never shows or logs the code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    await signInInput(sessionId, { kind: 'code', value: 'wrong-code-1234' })
    await advance(TICK_MS)
    const e = last() as Extract<SignInPhase, { kind: 'error' }>
    expect(e).toMatchObject({ kind: 'error', message: 'Invalid code. Please make sure the full code was copied.' })
    // The CLI echoed it: shown masked.
    expect(e.details.join('\n')).toContain('•'.repeat('wrong-code-1234'.length))
    expect(JSON.stringify(sent)).not.toContain('wrong-code-1234')
    expect(log.mock.calls.flat().join(' ')).not.toContain('wrong-code-1234')
    expect(log.mock.calls.flat().join(' ')).toContain('[accounts] sign-in for codedev: error')
    // Nothing the user typed is held once the session ended.
    expect(_typedHeldForTest()).toBe(0)
    log.mockRestore()
  })

  // SAFETY-R2-3 (a), UI2-7 (3): PRIVACY.md says nothing the session shows is logged. The log line holds the account's name and
  // how it ended, never the CLI's own sentence, which may repeat a code, an address or an email.
  it('logs the account and how the sign-in ended, and none of the CLI\'s own sentence', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    // This mock's CLI answers a wrong code with a sentence that repeats the code and holds a key-shaped string.
    deps.spawn = login({ MOCK_LOGIN_MODE: 'echo' })
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    await signInInput(sessionId, { kind: 'code', value: 'wrong-code-1234' })
    await advance(TICK_MS)
    const e = last() as Extract<SignInPhase, { kind: 'error' }>
    expect(e.message).toContain('was refused')
    // The sheet shows the sentence; the console holds one fixed line.
    expect(log.mock.calls.map((c) => c.join(' '))).toEqual(['[accounts] sign-in for codedev: error'])
    log.mockRestore()
  })

  it('masks a code the screen wraps over two rows', async () => {
    const code = 'x'.repeat(150)
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    await signInInput(sessionId, { kind: 'code', value: code })
    await advance(TICK_MS)
    expect(JSON.stringify(sent)).not.toMatch(/x{20}/)
  })

  it("masks the code and any key-shaped string in the error sentence itself, the sheet's main line, not only in the screen under it", async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'echo' })
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    await signInInput(sessionId, { kind: 'code', value: 'wrong-code-1234' })
    await advance(TICK_MS)
    const e = last() as Extract<SignInPhase, { kind: 'error' }>
    expect(e.kind).toBe('error')
    // The CLI's words stay, with the code hidden and the key redacted.
    expect(e.message).toBe(`the code ${'•'.repeat('wrong-code-1234'.length)} was refused (<redacted-key>)`)
    expect(JSON.stringify(sent)).not.toContain('wrong-code-1234')
    expect(JSON.stringify(sent)).not.toContain('sk-ant-oat01-')
    expect(e.details.join('\n')).toContain('<redacted-key>')
  })

  it('signs in when the browser hands it back by itself', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'callback', MOCK_CALLBACK_MS: '2000' })
    startSignInSession(spec(), deps)
    await advance(TICK_MS)
    expect(last().kind).toBe('browser')
    await advance(2000)
    await advance(TICK_MS)
    expect(last()).toEqual({ kind: 'success', email: 'person@example.test', plan: 'max' })
  })

  it('wants the code where the browser can\'t hand the sign-in back', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'nocallback' })
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    expect(last()).toMatchObject({ kind: 'code-wanted', canOpen: true })
    expect(await signInInput(sessionId, { kind: 'code', value: 'good-code' })).toEqual({ ok: true })
    await advance(TICK_MS)
    expect(last().kind).toBe('success')
  })

  it('says a failure in the CLI\'s own words', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'fail' })
    startSignInSession(spec(), deps)
    expect(last()).toMatchObject({ kind: 'error', message: 'the sign-in was refused' })
  })

  it('fails with the exit code when the CLI ends with nothing it recognises', async () => {
    let exit: (code: number) => void = () => undefined
    deps.spawn = () => fakePty((io) => { exit = io.exit; io.write('Something new\r\n'); return { input: () => undefined } })
    startSignInSession(spec(), deps)
    exit(3)
    expect(last()).toMatchObject({ kind: 'error', message: "Claude Code's sign-in ended before it signed in (exit code 3)" })
  })

  it('asks the status command when the CLI ends cleanly with no words of its own', async () => {
    let exit: (code: number) => void = () => undefined
    deps.spawn = () => fakePty((io) => { exit = io.exit; return { input: () => undefined } })
    startSignInSession(spec(), deps)
    exit(0)
    await advance(0)
    expect(last().kind).toBe('success')
  })

  it('fails when its status says signed out, can\'t be asked, or throws', async () => {
    for (const [confirm, message] of [
      [async (): Promise<Confirmed> => ({ signedOut: true }), 'Claude Code said it signed in, but its status still says signed out'],
      [async (): Promise<Confirmed> => ({ error: 'no answer' }), "Termpolis couldn't confirm the sign-in: no answer"],
      [async (): Promise<Confirmed> => { throw new Error('boom') }, "Termpolis couldn't confirm the sign-in: boom"],
      [async (): Promise<Confirmed> => { throw 'odd' }, "Termpolis couldn't confirm the sign-in: odd"],
    ] as const) {
      sent = []
      deps.spawn = login({ MOCK_LOGIN_MODE: 'callback' })
      startSignInSession(spec({ confirm }), deps)
      await advance(400)
      await advance(TICK_MS)
      expect(last()).toMatchObject({ kind: 'error', message })
    }
  })

  it('shows a screen it can\'t read only after SIGN_IN_UNKNOWN_MS, then as it is', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'garbage' })
    startSignInSession(spec(), deps)
    await advance(SIGN_IN_UNKNOWN_MS - TICK_MS)
    expect(last()).toEqual({ kind: 'starting' })
    await advance(TICK_MS * 2)
    expect(last()).toEqual({ kind: 'unknown', screen: ['Something no sign-in prints'], typing: false })
  })

  it('stops after 10 minutes, its process tree with it', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'silent' })
    startSignInSession(spec(), deps)
    await advance(SIGN_IN_TIMEOUT_MS)
    expect(last()).toMatchObject({ kind: 'error', timeout: true, message: 'The sign-in took longer than 10 minutes, so Termpolis stopped it.' })
    expect(deps.killTree).toHaveBeenCalledWith(4000)
    expect(ptys[0].killed).toBe(true)
  })

  it('ends on cancel, its tree too, and takes nothing after', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'silent' })
    const { sessionId } = startSignInSession(spec(), deps)
    expect(await signInInput(sessionId, { kind: 'cancel' })).toEqual({ ok: true })
    expect(last()).toEqual({ kind: 'cancelled' })
    expect(deps.killTree).toHaveBeenCalledWith(4000)
    expect(await signInInput(sessionId, { kind: 'code', value: 'x' })).toEqual({ ok: false, why: 'that sign-in has ended' })
    expect(await signInInput('nope', { kind: 'cancel' })).toEqual({ ok: false, why: 'that sign-in has ended' })
    expect(ptys[0].writes).toEqual([])
  })

  it('takes a code only where the CLI shows its field, and only a plausible one', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'silent' })
    const { sessionId } = startSignInSession(spec(), deps)
    expect(await signInInput(sessionId, { kind: 'code', value: 'good-code' })).toEqual({ ok: false, why: 'the CLI isn\'t asking for a code now' })
    deps.spawn = login()
    const two = startSignInSession(spec({ key: 'other' }), deps)
    await advance(TICK_MS)
    for (const value of ['', 'has space', 'a\u0007b', 'x'.repeat(2049), 42 as unknown as string]) {
      expect(await signInInput(two.sessionId, { kind: 'code', value })).toEqual({ ok: false, why: 'that doesn\'t look like a sign-in code' })
    }
    expect(ptys[1].writes).toEqual([])
  })

  it('opens the page only on the provider\'s own address, which is main\'s reading, never the renderer\'s', async () => {
    const { sessionId } = startSignInSession(spec(), deps)
    expect(await signInInput(sessionId, { kind: 'open' })).toEqual({ ok: false, why: 'that address isn\'t the provider\'s sign-in page' })
    await advance(TICK_MS)
    const url = (last() as { url: string }).url
    expect(await signInInput(sessionId, { kind: 'open', url: 'https://evil.test' } as never)).toEqual({ ok: true })
    expect(deps.openExternal).toHaveBeenCalledWith(url)
    expect(deps.openExternal).toHaveBeenCalledTimes(1)
  })

  it('never opens an address of another host the CLI printed', async () => {
    deps.spawn = () => fakePty((io) => { io.write("Opening browser to sign in\r\nIf the browser didn't open, visit: https://claude.com.evil.test/cai/oauth/authorize\r\n"); return { input: () => undefined } })
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    expect(last()).toMatchObject({ kind: 'browser', canOpen: false })
    expect(await signInInput(sessionId, { kind: 'open' })).toEqual({ ok: false, why: 'that address isn\'t the provider\'s sign-in page' })
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('shows the field again only once the CLI asks again, a while after the code', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => { write = io.write; io.write("Opening browser to sign in\r\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?x=1\r\nPaste code here if prompted > "); return { input: () => undefined } })
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    await signInInput(sessionId, { kind: 'code', value: 'some-code' })
    await advance(TICK_MS)
    expect(last()).toEqual({ kind: 'working' })
    write('\r\nPaste code here if prompted > ')
    await advance(TICK_MS)
    expect(last()).toEqual({ kind: 'working' })
    await advance(ANSWER_SETTLE_MS)
    expect(last().kind).toBe('browser')
  })

  it('runs one session per profile: a new one ends the one before', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'silent' })
    const one = startSignInSession(spec(), deps)
    startSignInSession(spec(), deps)
    expect(signInSessionCount()).toBe(1)
    expect(deps.killTree).toHaveBeenCalledWith(4000)
    expect(await signInInput(one.sessionId, { kind: 'cancel' })).toMatchObject({ ok: false })
  })

  it('ends a window\'s sessions when it goes, and every session at quit', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'silent' })
    const win = {}
    startSignInSession(spec({ owner: win }), deps)
    startSignInSession(spec({ key: 'b', owner: {} }), deps)
    endSignInsOf(win)
    expect(signInSessionCount()).toBe(1)
    endSignIns()
    expect(signInSessionCount()).toBe(0)
  })

  it('lets the user type into the screen only from the fallback, once they turn it on', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'garbage' })
    const { sessionId } = startSignInSession(spec(), deps)
    expect(await signInInput(sessionId, { kind: 'live', on: true })).toEqual({ ok: false, why: 'the screen is readable: use the sheet' })
    await advance(SIGN_IN_UNKNOWN_MS + TICK_MS)
    expect(await signInInput(sessionId, { kind: 'keys', data: 'x' })).toEqual({ ok: false, why: 'typing here is off' })
    expect(await signInInput(sessionId, { kind: 'live', on: true })).toEqual({ ok: true })
    expect(last()).toMatchObject({ kind: 'unknown', typing: true })
    for (const data of ['', 'x'.repeat(257), 7 as unknown as string]) {
      expect(await signInInput(sessionId, { kind: 'keys', data })).toEqual({ ok: false, why: 'nothing to type' })
    }
    expect(await signInInput(sessionId, { kind: 'keys', data: 'y\r' })).toEqual({ ok: true })
    expect(ptys[0].writes).toEqual(['y\r'])
    expect(await signInInput(sessionId, { kind: 'live', on: false })).toEqual({ ok: true })
    expect(await signInInput(sessionId, { kind: 'keys', data: 'z' })).toEqual({ ok: false, why: 'typing here is off' })
  })

  it('keeps reading the screen past MAX_OUTPUT, from a screen clear', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => { write = io.write; return { input: () => undefined } })
    startSignInSession(spec(), deps)
    write('x'.repeat(MAX_OUTPUT))
    write("\u001b[2J\u001b[HOpening browser to sign in\r\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?a=1\r\nPaste code here if prompted > ")
    await advance(TICK_MS)
    expect(last()).toMatchObject({ kind: 'browser', url: 'https://claude.com/cai/oauth/authorize?a=1' })
    write('y'.repeat(MAX_OUTPUT))
    await advance(TICK_MS)
    expect(last().kind).toBe('browser')
  })

  it('reads its success and its failure off the screen while it still runs', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => { write = io.write; return { input: () => undefined } })
    startSignInSession(spec({ confirm: async () => ({ email: null }) }), deps)
    write('Login successful\r\n')
    await advance(TICK_MS)
    expect(last()).toEqual({ kind: 'success', email: null })
    sent = []
    startSignInSession(spec({ key: 'b' }), deps)
    write('Login failed: refused\r\n')
    await advance(TICK_MS)
    expect(last()).toMatchObject({ kind: 'error', message: 'refused' })
  })

  it('reads nothing of an exit after it ended', async () => {
    let exit: (code: number) => void = () => undefined
    deps.spawn = () => fakePty((io) => { exit = io.exit; return { input: () => undefined } })
    const { sessionId } = startSignInSession(spec(), deps)
    await signInInput(sessionId, { kind: 'cancel' })
    const n = sent.length
    exit(1)
    expect(sent.length).toBe(n)
  })

  it('takes no pick or value outside agy\'s questions', async () => {
    const { sessionId } = startSignInSession(spec(), deps)
    await advance(TICK_MS)
    expect(await signInInput(sessionId, { kind: 'pick', index: 0, label: 'x' })).toEqual({ ok: false, why: 'there is nothing to choose now' })
    expect(await signInInput(sessionId, { kind: 'text', value: 'p' })).toEqual({ ok: false, why: 'the CLI isn\'t asking for that now' })
  })

  it('reads nothing more once it ended, whatever the CLI still prints', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => { write = io.write; return { input: () => undefined } })
    const { sessionId } = startSignInSession(spec(), deps)
    await signInInput(sessionId, { kind: 'cancel' })
    const n = sent.length
    write('Login successful\r\n')
    await advance(TICK_MS * 2)
    expect(sent.length).toBe(n)
  })

  it('ends a tree that is gone already without a fuss', () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'silent' })
    deps.killTree = () => { throw new Error('gone') }
    startSignInSession(spec(), deps)
    ptys[0].kill = () => { throw new Error('gone') }
    expect(() => endSignIns()).not.toThrow()
  })
})

describe('Codex: codex login', () => {
  it('shows the browser step, with the provider\'s page and no code field', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'callback', MOCK_CALLBACK_MS: '2000' })
    startSignInSession(spec({ agent: 'codex', args: ['login'] }), deps)
    await advance(TICK_MS)
    expect(last()).toMatchObject({ kind: 'browser', canOpen: true, codeField: false })
    expect((last() as { url: string }).url.startsWith('https://auth.openai.com/oauth/authorize?')).toBe(true)
    await advance(2000 + TICK_MS)
    expect(last().kind).toBe('success')
  })

  it('shows the device code and where to enter it', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'callback', MOCK_CALLBACK_MS: '2000' })
    startSignInSession(spec({ agent: 'codex', args: ['login', '--device-auth'] }), deps)
    await advance(TICK_MS)
    expect(last()).toEqual({ kind: 'device-code', code: 'WXYZ-2345', url: 'https://auth.openai.com/codex/device', canOpen: true })
    await advance(2000 + TICK_MS)
    expect(last().kind).toBe('success')
  })

  it('is at work until the device code comes', async () => {
    deps.spawn = () => fakePty((io) => { io.write('Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n'); return { input: () => undefined } })
    startSignInSession(spec({ agent: 'codex', args: ['login', '--device-auth'] }), deps)
    await advance(TICK_MS)
    expect(last()).toEqual({ kind: 'working' })
  })

  it('says its failure', async () => {
    deps.spawn = login({ MOCK_LOGIN_MODE: 'fail' })
    startSignInSession(spec({ agent: 'codex', args: ['login'] }), deps)
    expect(last()).toMatchObject({ kind: 'error', message: 'Login was not completed' })
  })
})

describe('agy: the switch-all sign-in, in a hidden agy', () => {
  function agySpec(over: Partial<SessionSpec> = {}): SessionSpec {
    return spec({ agent: 'agy', key: 'agy', file: 'agy', args: [], mode: 'agy-switch', label: 'personal google', confirm: undefined, ...over })
  }
  async function until(kind: SignInPhase['kind'], ms = 20_000): Promise<SignInPhase> {
    for (let t = 0; t < ms; t += TICK_MS) {
      if (last().kind === kind) return last()
      await advance(TICK_MS)
    }
    throw new Error(`no ${kind}: ${phases().join(',')}`)
  }

  it('signs agy out with its own /logout, relays the user\'s picks and code, and ends agy once it is back', async () => {
    deps.spawn = agy()
    const signedIn = vi.fn()
    const { sessionId } = startSignInSession(agySpec({ onAgySignedIn: signedIn }), deps)
    const choose = await until('choose') as Extract<SignInPhase, { kind: 'choose' }>
    expect(phases()).toContain('signing-out')
    // Type, look, then Enter: /logout went into agy's box first.
    expect(ptys[0].writes.slice(0, 2)).toEqual(['/logout', '\r'])
    expect(choose).toEqual({ kind: 'choose', question: 'Select login method:', detail: [], options: ['Continue with Google', 'Use a Google Cloud project', 'Other sign-in options'], selected: 0 })
    expect(await signInInput(sessionId, { kind: 'pick', index: 0, label: 'Continue with Google' })).toEqual({ ok: true })
    const b = await until('browser') as Extract<SignInPhase, { kind: 'browser' }>
    expect(b.codeField).toBe(true)
    expect(b.canOpen).toBe(true)
    expect(await signInInput(sessionId, { kind: 'code', value: 'good-code' })).toEqual({ ok: true })
    await until('success')
    expect(last()).toEqual({ kind: 'success', email: 'new.person@example.test' })
    expect(signedIn).toHaveBeenCalledWith('new.person@example.test')
    // agy exited with its own /exit, typed into its box.
    await advance(3000)
    expect(ptys[0].writes.join('')).toContain('/exit')
    expect(ptys[0].exited).toBe(true)
    expect(signInSessionCount()).toBe(0)
    expect(JSON.stringify(sent)).not.toContain('good-code')
  })

  it('types /login where agy goes back to its box after /logout with no sign-in screen', async () => {
    deps.spawn = agy({ MOCK_AGY_AFTER_LOGOUT: 'box' })
    startSignInSession(agySpec(), deps)
    await advance(AGY_SIGN_IN_SHOW_MS + 4000)
    expect(ptys[0].writes.join('')).toContain('/login')
    await until('choose')
  })

  it('shows the screen as it is when /login brings up no sign-in either', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => {
      write = io.write
      const box = '\u001b[2J\u001b[H' + '─'.repeat(80) + '\r\n> \r\n' + '─'.repeat(80) + '\r\n? for shortcuts\r\n'
      io.write(box)
      return { input: (d: string) => { if (d === '\r' || d.includes('\u0015')) write(box); else write('\u001b[2J\u001b[H' + '─'.repeat(80) + '\r\n> ' + d + '\r\n' + '─'.repeat(80) + '\r\n? for shortcuts\r\n') } }
    })
    startSignInSession(agySpec(), deps)
    await advance(AGY_SIGN_IN_SHOW_MS * 2 + 8000)
    expect(ptys[0].writes.join('')).toContain('/login')
    expect(last().kind).toBe('unknown')
  })

  it('relays agy\'s trust question as a choice, never as a sign-in', async () => {
    deps.spawn = agy({ MOCK_AGY_TRUST: '1' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    const trust = await until('choose') as Extract<SignInPhase, { kind: 'choose' }>
    expect(trust.question).toBe('Do you trust the contents of this project?')
    expect(trust.detail).toEqual(['Antigravity CLI requires permission to read, edit, and execute files here.'])
    expect(ptys[0].writes).toEqual([])
    expect(await signInInput(sessionId, { kind: 'pick', index: 0, label: 'Yes, I trust this folder' })).toEqual({ ok: true })
    const login = await until('choose') as Extract<SignInPhase, { kind: 'choose' }>
    expect(login.question).toBe('Select login method:')
  })

  it('shows agy\'s screen no more while a pick moves the highlight: its ticks wait for the pick (UI-R1-I)', async () => {
    // agy takes a second to draw each move of its highlight, so ticks come round while the pick waits for it.
    deps.spawn = () => fakePty((io) => {
      const cli = createMockAgy({ ...io, env: { MOCK_AGY_SIGNED_IN: '0' } })
      return { input: (d: string) => { if (d === '\u001b[B') setTimeout(() => cli.input(d), 1000); else cli.input(d) } }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const before = sent.length
    const go = signInInput(sessionId, { kind: 'pick', index: 2, label: 'Other sign-in options' })
    // The highlight is on the second row now, and the pick waits for the third: no tick shows it half way.
    await advance(1800)
    expect(sent.slice(before).map((s) => s.phase.kind)).not.toContain('choose')
    await advance(4000)
    expect(await go).toEqual({ ok: true })
  })

  it('moves the highlight down and up, each move seen before the next, and enters only on the row clicked', async () => {
    deps.spawn = agy({ MOCK_AGY_SIGNED_IN: '0' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 2, label: 'Other sign-in options' })
    await advance(PICK_MOVE_MS * 3)
    expect(await go).toEqual({ ok: true })
    expect(ptys[0].writes).toEqual(['\u001b[B', '\u001b[B', '\r'])
    const gcp = await until('choose') as Extract<SignInPhase, { kind: 'choose' }>
    expect(gcp.question).toBe('Select Google Cloud sign-in method:')
    // Down to the second, then back up to the first.
    const down = signInInput(sessionId, { kind: 'pick', index: 1, label: 'Continue with Advanced SSO' })
    await advance(PICK_MOVE_MS)
    expect((await down).ok).toBe(true)
  })

  it('moves up from a highlight below the one clicked', async () => {
    let write: (s: string) => void = () => undefined
    let sel = 1
    const draw = (): void => write('\u001b[2J\u001b[HSelect login method:\r\n\r\n' + ['One', 'Two'].map((o, i) => (i === sel ? '> ' : '  ') + o).join('\r\n') + '\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n')
    deps.spawn = () => fakePty((io) => {
      write = io.write
      setTimeout(draw, 10)
      return { input: (d: string) => { if (d === '\u001b[A') { sel = 0; draw() } } }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 0, label: 'One' })
    await advance(PICK_MOVE_MS)
    expect(await go).toEqual({ ok: true })
    expect(ptys[0].writes).toEqual(['\u001b[A', '\r'])
  })

  it('enters nothing when the highlight doesn\'t move, and shows agy\'s screen as it is', async () => {
    deps.spawn = agy({ MOCK_AGY_SIGNED_IN: '0', MOCK_AGY_IGNORE_ARROWS: '1' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 1, label: 'Use a Google Cloud project' })
    await advance(PICK_MOVE_MS + TICK_MS)
    expect(await go).toEqual({ ok: false, why: 'the highlight didn\'t move to that choice, so Termpolis pressed nothing' })
    expect(ptys[0].writes).toEqual(['\u001b[B'])
    expect(last().kind).toBe('unknown')
    // It stays so, for the user to pick there, while agy shows that question.
    await advance(TICK_MS * 4)
    expect(last().kind).toBe('unknown')
  })

  it('refuses a pick that isn\'t the option on screen', async () => {
    deps.spawn = agy({ MOCK_AGY_SIGNED_IN: '0' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    for (const [index, label] of [[3, 'x'], [-1, 'x'], [0, 'Use a Google Cloud project'], [0.5, 'Continue with Google']] as const) {
      expect(await signInInput(sessionId, { kind: 'pick', index, label })).toEqual({ ok: false, why: 'that choice isn\'t on the screen now' })
    }
    expect(ptys[0].writes).toEqual([])
  })

  it('stops a pick when the question changes under it', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => {
      write = io.write
      setTimeout(() => write('\u001b[2J\u001b[HSelect login method:\r\n\r\n> One\r\n  Two\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n'), 10)
      return { input: () => write('\u001b[2J\u001b[HSelect available license:\r\n\r\n  One\r\n> Two\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n') }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 1, label: 'Two' })
    await advance(PICK_MOVE_MS + TICK_MS)
    expect((await go).ok).toBe(false)
    expect(ptys[0].writes).toEqual(['\u001b[B'])
  })

  it('stops a pick whose last check finds the row moved on', async () => {
    let write: (s: string) => void = () => undefined
    let draws = 0
    deps.spawn = () => fakePty((io) => {
      write = io.write
      const frame = (sel: number): string => '\u001b[2J\u001b[HSelect login method:\r\n\r\n' + ['A', 'B', 'C'].map((o, i) => (i === sel ? '> ' : '  ') + o).join('\r\n') + '\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n'
      setTimeout(() => write(frame(0)), 10)
      // Each Down jumps two rows: the move is seen, but it overshoots the row clicked.
      return { input: () => { draws++; write(frame(2)) } }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 1, label: 'B' })
    await advance(PICK_MOVE_MS * 4)
    expect((await go).ok).toBe(false)
    expect(draws).toBeGreaterThan(0)
    expect(ptys[0].writes).not.toContain('\r')
  })

  it('stops a pick that would take more moves than agy has options', async () => {
    let write: (s: string) => void = () => undefined
    let sel = 0
    deps.spawn = () => fakePty((io) => {
      write = io.write
      const frame = (): string => '\u001b[2J\u001b[HSelect login method:\r\n\r\n' + ['A', 'B', 'C'].map((o, i) => (i === sel ? '> ' : '  ') + o).join('\r\n') + '\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n'
      setTimeout(() => write(frame()), 10)
      // Each Down moves the highlight, between the first two only: it never reaches the third.
      return { input: () => { sel = sel === 0 ? 1 : 0; write(frame()) } }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 2, label: 'C' })
    await advance(PICK_MOVE_MS * 6)
    expect(await go).toEqual({ ok: false, why: 'the highlight didn\'t move to that choice, so Termpolis pressed nothing' })
    expect(ptys[0].writes).toEqual(['\u001b[B', '\u001b[B', '\u001b[B'])
  })

  it('says agy is at work after a pick, until agy draws again', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => {
      write = io.write
      setTimeout(() => write('\u001b[2J\u001b[HSelect login method:\r\n\r\n> One\r\n  Two\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n'), 10)
      return { input: () => undefined }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    expect(await signInInput(sessionId, { kind: 'pick', index: 0, label: 'One' })).toEqual({ ok: true })
    await advance(TICK_MS * 3)
    expect(last()).toEqual({ kind: 'working' })
    write('\u001b[2J\u001b[HSelect login method:\r\n\r\n> One\r\n  Two\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n')
    await advance(TICK_MS)
    expect(last().kind).toBe('choose')
  })

  it('takes a Google Cloud project, then its license, then signs in', async () => {
    deps.spawn = agy({ MOCK_AGY_SIGNED_IN: '0' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 1, label: 'Use a Google Cloud project' })
    await advance(PICK_MOVE_MS)
    await go
    expect(await until('text-wanted')).toEqual({ kind: 'text-wanted', label: 'Google Cloud project ID' })
    for (const value of ['', 'two words', 42 as unknown as string]) expect(await signInInput(sessionId, { kind: 'text', value })).toEqual({ ok: false, why: 'that can\'t be typed for it' })
    expect(await signInInput(sessionId, { kind: 'text', value: 'my-project-1' })).toEqual({ ok: true })
    const lic = await until('choose') as Extract<SignInPhase, { kind: 'choose' }>
    expect(lic.question).toBe('Select available license:')
    expect(await signInInput(sessionId, { kind: 'pick', index: 0, label: 'Gemini Code Assist Standard' })).toEqual({ ok: true })
    await until('success')
    expect(JSON.stringify(sent)).not.toContain('my-project-1')
  })

  // UI2-7 (4): the project id is the user's own and agy may name it in an error; wherever that screen is shown it is masked.
  it('masks the Google Cloud project the user typed wherever agy\'s error shows it, and logs none of it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    deps.spawn = agy({ MOCK_AGY_SIGNED_IN: '0', MOCK_AGY_BAD_PROJECT: '1' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 1, label: 'Use a Google Cloud project' })
    await advance(PICK_MOVE_MS)
    await go
    await until('text-wanted')
    expect(await signInInput(sessionId, { kind: 'text', value: 'my-project-1' })).toEqual({ ok: true })
    await until('error')
    const e = last() as Extract<SignInPhase, { kind: 'error' }>
    expect(JSON.stringify(sent)).not.toContain('my-project-1')
    expect(`${e.message}\n${e.details.join('\n')}`).toContain(`project ${'•'.repeat('my-project-1'.length)} was not found`)
    expect(log.mock.calls.flat().join(' ')).not.toContain('my-project-1')
    expect(_typedHeldForTest()).toBe(0)
    log.mockRestore()
  })

  it('says agy\'s own error, after a code it refused', async () => {
    deps.spawn = agy({ MOCK_AGY_SIGNED_IN: '0' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    await signInInput(sessionId, { kind: 'pick', index: 0, label: 'Continue with Google' })
    await until('browser')
    await signInInput(sessionId, { kind: 'code', value: 'bad-code' })
    await until('error')
    expect(last()).toMatchObject({ kind: 'error', message: 'Error: authentication interrupted.' })
  })

  it('fails when agy closes before the sign-in finished', async () => {
    deps.spawn = agy({ MOCK_AGY_TRUST: '1' })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 1, label: 'No, exit' })
    await advance(PICK_MOVE_MS)
    await go
    await advance(100)
    expect(last()).toMatchObject({ kind: 'error', message: 'agy closed before the sign-in finished' })
  })

  it('fails when /logout can\'t be typed into agy\'s box', async () => {
    deps.spawn = () => fakePty((io) => {
      io.write('\u001b[2J\u001b[H' + '─'.repeat(80) + '\r\n> \r\n' + '─'.repeat(80) + '\r\n? for shortcuts\r\n')
      // Nothing typed ever shows in its box.
      return { input: () => undefined }
    })
    startSignInSession(agySpec(), deps)
    await advance(TICK_MS + 3000)
    expect(last()).toMatchObject({ kind: 'error', message: 'Termpolis couldn\'t type /logout into agy' })
  })

  it('keeps going when a signed-out agy shows its sign-in at once, and when its callback throws', async () => {
    deps.spawn = agy({ MOCK_AGY_SIGNED_IN: '0' })
    const { sessionId } = startSignInSession(agySpec({ onAgySignedIn: () => { throw new Error('x') } }), deps)
    await until('choose')
    expect(ptys[0].writes).toEqual([])
    await signInInput(sessionId, { kind: 'pick', index: 0, label: 'Continue with Google' })
    await until('browser')
    await signInInput(sessionId, { kind: 'code', value: 'good-code' })
    await until('success')
  })

  it('ends agy\'s tree when it doesn\'t exit after its /exit', async () => {
    let write: (s: string) => void = () => undefined
    let signed = false
    const main = (text = ''): string => '\u001b[2J\u001b[H      Antigravity CLI\r\n     who@example.test (Google AI Pro)\r\n\r\n' + '─'.repeat(80) + '\r\n> ' + text + '\r\n' + '─'.repeat(80) + '\r\n? for shortcuts\r\n'
    deps.spawn = () => fakePty((io) => {
      write = io.write
      setTimeout(() => write('\u001b[2J\u001b[HSelect login method:\r\n\r\n> One\r\n\r\n  enter Confirm\r\n'), 10)
      return {
        input: (d: string) => {
          if (!signed && d === '\r') { signed = true; write('Authentication successful!\r\n'); setTimeout(() => write(main()), 20); return }
          if (d.startsWith('/')) write(main(d))
          else if (d.includes('\u0015')) write(main())
        },
      }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    await signInInput(sessionId, { kind: 'pick', index: 0, label: 'One' })
    await until('success')
    expect(last()).toEqual({ kind: 'success', email: 'who@example.test' })
    await advance(12_000)
    expect(signInSessionCount()).toBe(0)
    expect(deps.killTree).toHaveBeenCalled()
  })

  it('types nothing more once cancelled while it types into agy', async () => {
    let write: (s: string) => void = () => undefined
    const box = (t = ''): string => '\u001b[2J\u001b[H' + '─'.repeat(80) + '\r\n> ' + t + '\r\n' + '─'.repeat(80) + '\r\n? for shortcuts\r\n'
    deps.spawn = () => fakePty((io) => { write = io.write; io.write(box()); return { input: () => undefined } })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await advance(TICK_MS)
    expect(ptys[0].writes).toEqual(['/logout'])
    await signInInput(sessionId, { kind: 'cancel' })
    // Its box shows /logout now: the Enter that would follow goes nowhere.
    write(box('/logout'))
    await advance(3000)
    expect(ptys[0].writes).toEqual(['/logout'])
  })

  it('stops when agy shows an error after /logout', async () => {
    let write: (s: string) => void = () => undefined
    const box = (t = ''): string => '\u001b[2J\u001b[H' + '─'.repeat(80) + '\r\n> ' + t + '\r\n' + '─'.repeat(80) + '\r\n? for shortcuts\r\n'
    deps.spawn = () => fakePty((io) => {
      write = io.write
      io.write(box())
      return { input: (d: string) => { if (d === '\r') write('\u001b[2J\u001b[HError: authentication interrupted.\r\n'); else write(box(d)) } }
    })
    startSignInSession(agySpec(), deps)
    await advance(TICK_MS * 4)
    expect(last()).toMatchObject({ kind: 'error', message: 'Error: authentication interrupted.' })
  })

  it('says agy is at work after a code, while its field is still on screen', async () => {
    let write: (s: string) => void = () => undefined
    const paste = '\u001b[2J\u001b[HSigning in...\r\n\r\nOr, paste the authorization code here and press Enter:\r\n> \r\n'
    deps.spawn = () => fakePty((io) => { write = io.write; io.write('\u001b[2J\u001b[HWelcome back! You are currently not signed in.\r\n\r\n' + paste.slice(7)); return { input: () => undefined } })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('browser')
    expect(await signInInput(sessionId, { kind: 'code', value: 'a-code' })).toEqual({ ok: true })
    await advance(TICK_MS * 2)
    expect(last()).toEqual({ kind: 'working' })
    write(paste)
    await advance(ANSWER_SETTLE_MS + TICK_MS)
    expect(last().kind).toBe('browser')
  })

  it('stops a pick cancelled while it moves the highlight', async () => {
    let write: (s: string) => void = () => undefined
    deps.spawn = () => fakePty((io) => {
      write = io.write
      setTimeout(() => write('\u001b[2J\u001b[HSelect login method:\r\n\r\n> One\r\n  Two\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n'), 10)
      return { input: () => undefined }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    const go = signInInput(sessionId, { kind: 'pick', index: 1, label: 'Two' })
    await signInInput(sessionId, { kind: 'cancel' })
    await advance(PICK_MOVE_MS)
    expect(await go).toEqual({ ok: false, why: 'the sign-in has ended' })
    expect(ptys[0].writes).toEqual(['\u001b[B'])
  })

  it('enters nothing when the highlight moved before the click', async () => {
    let write: (s: string) => void = () => undefined
    const frame = (sel: number): string => '\u001b[2J\u001b[HSelect login method:\r\n\r\n' + ['One', 'Two'].map((o, i) => (i === sel ? '> ' : '  ') + o).join('\r\n') + '\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n'
    deps.spawn = () => fakePty((io) => { write = io.write; setTimeout(() => write(frame(0)), 10); return { input: () => undefined } })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    // agy moved it itself, after the sheet showed One highlighted.
    write(frame(1))
    expect(await signInInput(sessionId, { kind: 'pick', index: 0, label: 'One' })).toEqual({ ok: false, why: 'the highlight didn\'t move to that choice, so Termpolis pressed nothing' })
    expect(ptys[0].writes).toEqual([])
  })

  it('ends once, cancelled while agy exits', async () => {
    let write: (s: string) => void = () => undefined
    const main = (text = ''): string => '\u001b[2J\u001b[H      Antigravity CLI\r\n\r\n' + '─'.repeat(80) + '\r\n> ' + text + '\r\n' + '─'.repeat(80) + '\r\n? for shortcuts\r\n'
    deps.spawn = () => fakePty((io) => {
      write = io.write
      setTimeout(() => write('\u001b[2J\u001b[HSelect login method:\r\n\r\n> One\r\n\r\n  enter Confirm\r\n'), 10)
      return { input: (d: string) => { if (d === '\r' && !/\/exit/.test(ptys[0].writes.join(''))) { write('Authentication successful!\r\n'); setTimeout(() => write(main()), 20) } else if (d.startsWith('/')) write(main(d)) } }
    })
    const { sessionId } = startSignInSession(agySpec(), deps)
    await until('choose')
    await signInInput(sessionId, { kind: 'pick', index: 0, label: 'One' })
    await until('success')
    await advance(3000)
    expect(await signInInput(sessionId, { kind: 'cancel' })).toEqual({ ok: true })
    await advance(10_000)
    expect(deps.killTree).toHaveBeenCalledTimes(1)
  })

  it('shows a screen it can\'t read, and agy\'s box without its success words, only after a while', async () => {
    deps.spawn = () => fakePty((io) => { io.write('\u001b[2J\u001b[HSomething agy never drew\r\n'); return { input: () => undefined } })
    startSignInSession(agySpec(), deps)
    await advance(SIGN_IN_UNKNOWN_MS + TICK_MS)
    expect(last().kind).toBe('unknown')
  })
})
