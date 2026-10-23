// The hidden sign-in session end to end: the real session module, through REAL node-pty, driving the
// mock CLIs (tests/electron/mocks) as child processes, into the sheet's states. Never a real CLI. The
// mocks' scratch profiles are temp folders; the process tree is ended the way main ends it
// (processTree.ts). Skipped where node-pty can't load in plain Node.
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _resetSignInSessionsForTest, endSignIns, signInInput, startSignInSession } from '../../src/main/signInSession'
import type { PtyLike, SessionDeps, SessionSpec } from '../../src/main/signInSession'
import { killProcessTree } from '../../src/main/processTree'
import type { SignInPhase, SignInState } from '../../src/shared/signInScreens'

const require = createRequire(import.meta.url)
let pty: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike } | null = null
try {
  pty = require('node-pty')
} catch {
  pty = null
}

const MOCKS = join(__dirname, 'mocks')
const dirs: string[] = []
let sent: SignInState[] = []

function deps(): SessionDeps {
  return {
    spawn: (file, args, opts) => pty!.spawn(file, args as string[], opts as unknown as Record<string, unknown>),
    killTree: (pid) => { killProcessTree(pid) },
    send: (s) => { sent.push(s) },
    openExternal: () => undefined,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  }
}

/** A scratch profile folder, with nothing in it. */
function profile(): string {
  const d = mkdtempSync(join(tmpdir(), 'tp-signin-'))
  dirs.push(d)
  return d
}

function spec(over: Partial<SessionSpec>): SessionSpec {
  return { accountId: 'acc_1', agent: 'claude', key: `k-${Math.random()}`, file: process.execPath, args: [], env: { ...process.env } as Record<string, string>, cwd: tmpdir(), mode: 'sign-in', label: 'test', ...over }
}

async function until(kind: SignInPhase['kind'], ms = 20_000): Promise<SignInPhase> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const last = sent[sent.length - 1]?.phase
    if (last?.kind === kind) return last
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no ${kind}: ${sent.map((s) => s.phase.kind).join(',')}`)
}

afterEach(() => {
  endSignIns()
  _resetSignInSessionsForTest()
  sent = []
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe.skipIf(!pty)('the hidden sign-in session through real node-pty', () => {
  it('signs a mock Claude Code in with the code the user pasted, confirmed by its status', async () => {
    const dir = profile()
    const s = startSignInSession(spec({
      args: [join(MOCKS, 'mockLogin.cjs'), 'auth', 'login', '--claudeai', '--email', 'person@example.test'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, MOCK_SIGNED_IN_EMAIL: 'person@example.test' } as Record<string, string>,
      // The status command: what the mock left in the profile.
      confirm: async () => ({ email: readFileSync(join(dir, '.mock-signed-in'), 'utf8') }),
    }), deps())
    const b = await until('browser') as Extract<SignInPhase, { kind: 'browser' }>
    expect(b.url).toContain('login_hint=person%40example.test')
    expect(b.canOpen).toBe(true)
    expect(await signInInput(s.sessionId, { kind: 'code', value: 'good-code' })).toEqual({ ok: true })
    expect(await until('success')).toEqual({ kind: 'success', email: 'person@example.test' })
  }, 40_000)

  it('shows a mock Codex\'s device code, and signs it in when the browser is done', async () => {
    const dir = profile()
    startSignInSession(spec({
      agent: 'codex',
      args: [join(MOCKS, 'mockLogin.cjs'), 'login', '--device-auth'],
      env: { ...process.env, CODEX_HOME: dir, MOCK_LOGIN_MODE: 'callback', MOCK_CALLBACK_MS: '1500' } as Record<string, string>,
      confirm: async () => ({ email: readFileSync(join(dir, '.mock-signed-in'), 'utf8') }),
    }), deps())
    expect(await until('device-code')).toEqual({ kind: 'device-code', code: 'WXYZ-2345', url: 'https://auth.openai.com/codex/device', canOpen: true })
    expect(await until('success')).toEqual({ kind: 'success', email: 'person@example.test' })
  }, 40_000)

  it('signs a mock agy out and in for the switch, relaying the user\'s pick and code, then ends it', async () => {
    let signedInAs: string | null = 'none'
    const s = startSignInSession(spec({
      agent: 'agy', key: 'agy', mode: 'agy-switch', confirm: undefined,
      args: [join(MOCKS, 'mockAgy.cjs')],
      env: { ...process.env, MOCK_AGY_NEW_EMAIL: 'new.person@example.test' } as Record<string, string>,
      onAgySignedIn: (email) => { signedInAs = email },
    }), deps())
    const choose = await until('choose') as Extract<SignInPhase, { kind: 'choose' }>
    expect(choose.question).toBe('Select login method:')
    expect(await signInInput(s.sessionId, { kind: 'pick', index: 0, label: 'Continue with Google' })).toEqual({ ok: true })
    await until('browser')
    expect(await signInInput(s.sessionId, { kind: 'code', value: 'good-code' })).toEqual({ ok: true })
    expect(await until('success')).toEqual({ kind: 'success', email: 'new.person@example.test' })
    expect(signedInAs).toBe('new.person@example.test')
  }, 60_000)

  it('ends the CLI\'s process when the user cancels', async () => {
    let exited = false
    const d = deps()
    const spawn = d.spawn
    d.spawn = (file, args, opts) => {
      const p = spawn(file, args, opts)
      p.onExit(() => { exited = true })
      return p
    }
    const s = startSignInSession(spec({ args: [join(MOCKS, 'mockLogin.cjs'), 'auth', 'login', '--claudeai'], env: { ...process.env, MOCK_LOGIN_MODE: 'silent' } as Record<string, string> }), d)
    await new Promise((r) => setTimeout(r, 1000))
    expect(await signInInput(s.sessionId, { kind: 'cancel' })).toEqual({ ok: true })
    const t0 = Date.now()
    while (!exited && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100))
    expect(exited).toBe(true)
  }, 30_000)
})
