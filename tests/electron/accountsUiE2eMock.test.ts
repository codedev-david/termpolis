// The e2e spec's mock Claude Code (e2e/mocks/mock-claude-accounts.cjs, through its shims in
// e2e/test-shims-accounts), checked here where it can be: found on PATH the way main finds a CLI
// for a sign-in (signInCli, R20: on Windows its .cmd through cmd.exe), signed in through the real
// hidden sign-in session over REAL node-pty, and its status read back by the real status check.
// The e2e spec itself runs in CI only; this is what proves its mock answers the way main asks.
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { _resetSignInSessionsForTest, endSignIns, signInInput, startSignInSession } from '../../src/main/signInSession'
import type { PtyLike, SessionDeps } from '../../src/main/signInSession'
import { killProcessTree } from '../../src/main/processTree'
import { signInCli, signInEnv } from '../../src/main/accountsIpc'
import { claudeSignedInNow } from '../../src/main/accountIdentity'
import type { SignInPhase, SignInState } from '../../src/shared/signInScreens'

const require = createRequire(import.meta.url)
let pty: { spawn: (file: string, args: string[] | string, opts: Record<string, unknown>) => PtyLike } | null = null
try {
  pty = require('node-pty')
} catch {
  pty = null
}

const SHIMS = join(__dirname, '..', '..', 'e2e', 'test-shims-accounts')
const dirs: string[] = []
let sent: SignInState[] = []

function deps(): SessionDeps {
  return {
    spawn: (file, args, opts) => pty!.spawn(file, args, opts as unknown as Record<string, unknown>),
    killTree: (pid) => { killProcessTree(pid) },
    send: (s) => { sent.push(s) },
    openExternal: () => undefined,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  }
}

async function until(kind: SignInPhase['kind'], ms = 30_000): Promise<SignInPhase> {
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

describe.skipIf(!pty)('the account UI e2e spec\'s mock Claude Code', () => {
  it('is the CLI main finds first on PATH, signs in with the pasted code, and its status says so', async () => {
    try { chmodSync(join(SHIMS, 'claude'), 0o755) } catch { /* Windows */ }
    const home = mkdtempSync(join(tmpdir(), 'tp-e2emock-'))
    dirs.push(home)
    const profile = join(home, '.claude-codedev')
    mkdirSync(profile)
    const base = { ...process.env, PATH: `${SHIMS}${delimiter}${process.env.PATH ?? ''}`, TERMPOLIS_TEST_AGENT_HOME: home, MOCK_SIGNED_IN_EMAIL: 'codedev@example.test' }
    const env = signInEnv('claude', profile, base)
    const cli = signInCli('claude', ['auth', 'login', '--claudeai'], env)
    if ('error' in cli) throw new Error(cli.error)
    expect(cli.file.toLowerCase()).toContain(process.platform === 'win32' ? 'cmd.exe' : join('test-shims-accounts', 'claude').toLowerCase())
    // Before: signed out, as the real status check reads it.
    expect(await claudeSignedInNow(profile, { cwd: home, env: base })).toMatchObject({ identity: { signedIn: false } })
    const s = startSignInSession({
      accountId: 'acc_1', agent: 'claude', key: 'k-e2emock', file: cli.file, args: cli.args, env, cwd: home, mode: 'sign-in', label: 'e2e mock',
      confirm: async () => {
        const r = await claudeSignedInNow(profile, { cwd: home, env: base })
        return 'identity' in r && r.identity.signedIn ? { email: r.identity.email, plan: r.identity.plan } : { signedOut: true }
      },
    }, deps())
    const b = await until('browser') as Extract<SignInPhase, { kind: 'browser' }>
    expect(b.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
    expect(b.canOpen).toBe(true)
    expect(await signInInput(s.sessionId, { kind: 'code', value: 'good-code' })).toEqual({ ok: true })
    expect(await until('success')).toEqual({ kind: 'success', email: 'codedev@example.test', plan: 'max' })
  }, 60_000)
})
