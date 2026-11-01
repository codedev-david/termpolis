// @vitest-environment node
//
// Signing an account in from the sheet (the in-app account UI, §3): accounts:sign-in-start starts
// the CLI's own login in main's hidden session, with the account's profile and nothing of
// Termpolis's, and accounts:sign-in-input relays the user's own choices. The CLIs are the mocks of
// tests/electron/mocks, behind a fake PTY; the sandbox is a scratch home under
// TERMPOLIS_TEST_AGENT_HOME, never a real profile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetTerminalAccountsForTest, endAccountSignIns, noteTerminalAccount, registerAccountsIpc, signInCli, signInEnv,
} from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { _resetSignInSessionsForTest, signInSessionCount } from '../../src/main/signInSession'
import type { PtyLike } from '../../src/main/signInSession'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AddAccountResult } from '../../src/shared/agentAccounts'
import type { SignInPhase, SignInState } from '../../src/shared/signInScreens'
import { loadAccounts } from '../../src/main/agentAccounts'
import { createSandbox } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

// The terminal manager is spied on for the whole file: a sign-in session must never reach it.
const terminalManagerCalls: string[] = []
vi.mock('../../src/main/terminalManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/terminalManager')>()
  const spy = <T extends (...a: never[]) => unknown>(name: string, fn: T): T =>
    ((...a: never[]) => { terminalManagerCalls.push(name); return fn(...a) }) as T
  return { ...real, spawnTerminal: spy('spawnTerminal', real.spawnTerminal), writeToTerminal: spy('writeToTerminal', real.writeToTerminal), killTerminal: spy('killTerminal', real.killTerminal), resizeTerminal: spy('resizeTerminal', real.resizeTerminal) }
})

const require = createRequire(import.meta.url)
const { createMockLogin } = require('./mocks/mockLogin.cjs') as { createMockLogin: (io: unknown) => { input: (d: string) => void } }
const { createMockAgy } = require('./mocks/mockAgy.cjs') as { createMockAgy: (io: unknown) => { input: (d: string) => void } }

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let sent: Array<{ channel: string; payload: any }>
let spawned: Array<{ file: string; args: string[] | string; env: Record<string, string>; cwd: string }>
let mockEnv: Record<string, string>
/** The CLIs' working folder: Termpolis's own, outside the sandbox the test deletes. */
let cwd: string

/** A fake PTY running a mock CLI in-process (as signInSession.test.ts's). */
function fakePty(make: (io: { write: (s: string) => void; exit: (code: number) => void }) => { input: (d: string) => void }): PtyLike {
  let onData: ((d: string) => void) | null = null
  let onExit: ((e: { exitCode: number }) => void) | null = null
  const pending: string[] = []
  let exitCode: number | null = null
  let exited = false
  const cli = make({
    write: (s) => { if (exited) return; if (onData) onData(s); else pending.push(s) },
    exit: (code) => { if (exited) return; exited = true; if (onExit) onExit({ exitCode: code }); else exitCode = code },
  })
  return {
    pid: 0,
    write: (d) => cli.input(d),
    kill: () => undefined,
    onData: (cb) => { onData = cb; for (const d of pending.splice(0)) cb(d) },
    onExit: (cb) => { onExit = cb; if (exitCode !== null) cb({ exitCode }) },
  }
}

function deps(over: Partial<AccountsIpcDeps> = {}): AccountsIpcDeps {
  return {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => true,
    pickFolder: async () => null,
    send: (channel, payload) => { sent.push({ channel, payload }) },
    checkCwd: () => cwd,
    env: { PATH: '/nowhere' },
    openExternal: vi.fn(),
    signInCli: (agent, args) => ({ file: agent, args }),
    signInSpawn: (file, args, opts) => {
      spawned.push({ file, args, env: opts.env, cwd: opts.cwd })
      return file === 'agy'
        ? fakePty((io) => createMockAgy({ ...io, env: mockEnv }))
        : fakePty((io) => createMockLogin({ ...io, env: { ...mockEnv, ...opts.env }, args: args as string[] }))
    },
    signedInNow: async () => ({ identity: { email: 'person@example.test', signedIn: true, plan: 'max', checkedAt: 1, source: 'auth-status' } }),
    ...over,
  }
}

function register(over: Partial<AccountsIpcDeps> = {}): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, deps(over))
}

async function call<T = any>(channel: string, input?: unknown, e: unknown = null): Promise<{ success: boolean; data?: T; error?: string }> {
  return (await handlers.get(channel)!(e, input)) as { success: boolean; data?: T; error?: string }
}

async function ok<T = any>(channel: string, input?: unknown, e: unknown = null): Promise<T> {
  const r = await call<T>(channel, input, e)
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

const states = (): SignInState[] => sent.filter((s) => s.channel === ACCOUNTS_IPC.signInState).map((s) => s.payload as SignInState)
const lastPhase = (): SignInPhase => states()[states().length - 1].phase

async function until(kind: SignInPhase['kind']): Promise<SignInPhase> {
  for (let t = 0; t < 40; t++) {
    if (states().length > 0 && lastPhase().kind === kind) return lastPhase()
    await vi.advanceTimersByTimeAsync(500)
  }
  throw new Error(`no ${kind}: ${states().map((s) => s.phase.kind).join(',')}`)
}

async function addClaude(label = 'codedev', email?: string): Promise<AddAccountResult> {
  return ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label, folder: 'new', copy: false, share: [], connect: false, ...(email ? { email } : {}) })
}

beforeEach(() => {
  vi.useFakeTimers()
  sb = createSandbox()
  cwd = mkdtempSync(join(tmpdir(), 'tp-signin-cwd-'))
  sent = []
  spawned = []
  mockEnv = {}
  _resetTerminalAccountsForTest()
  _resetSignInSessionsForTest()
  register()
})

afterEach(() => {
  endAccountSignIns()
  _resetSignInSessionsForTest()
  _resetTerminalAccountsForTest()
  sb.dispose()
  vi.useRealTimers()
})

describe('signInEnv: the CLI\'s env', () => {
  it('keeps the terminal\'s env, less Termpolis\'s variables and every profile variable, plus the account\'s', () => {
    const base = {
      PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080', BROWSER: 'firefox', CLAUDE_CONFIG_DIR: '/old', CODEX_HOME: '/old-codex', GEMINI_CLI_HOME: '/g',
      TERMPOLIS_LIMIT_CHOOSER: '1', ELECTRON_RUN_AS_NODE: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', UNSET: undefined,
    }
    expect(signInEnv('claude', '/p/.claude-b', base)).toEqual({ PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080', BROWSER: 'firefox', TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: '/p/.claude-b' })
    expect(signInEnv('codex', '/p/.codex-b', base).CODEX_HOME).toBe('/p/.codex-b')
  })

  it('deletes the variable for the default profile, never sets it empty (R24), and sets none for agy', () => {
    expect('CLAUDE_CONFIG_DIR' in signInEnv('claude', null, { CLAUDE_CONFIG_DIR: '/old' })).toBe(false)
    expect(signInEnv('agy', null, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/x' })).toEqual({ PATH: '/bin', TERM: 'xterm-256color' })
  })

  it('puts a test run\'s scratch home in for the real one', () => {
    expect(signInEnv('claude', null, { HOME: '/real', USERPROFILE: 'C:\\real', TERMPOLIS_TEST_AGENT_HOME: ' /scratch ' })).toEqual({ HOME: '/scratch', USERPROFILE: '/scratch', TERM: 'xterm-256color' })
  })
})

describe('signInCli: the CLI it runs', () => {
  function bin(...names: string[]): string {
    const dir = join(sb.root, `bin-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir)
    for (const n of names) writeFileSync(join(dir, n), '')
    return dir
  }

  it('runs a CLI by its resolved path', () => {
    const dir = bin('claude.exe', 'agy.exe')
    expect(signInCli('claude', ['auth', 'login'], { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toEqual({ file: join(dir, 'claude.exe'), args: ['auth', 'login'] })
    expect(signInCli('agy', [], { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toEqual({ file: join(dir, 'agy.exe'), args: [] })
  })

  it('runs an npm shim through cmd.exe with plain arguments, leaving off an email its line can\'t take', () => {
    const dir = bin('claude.cmd')
    const shim = join(dir, 'claude.cmd')
    expect(signInCli('claude', ['auth', 'login', '--claudeai', '--email', 'a@b.test'], { PATH: dir, PATHEXT: '.CMD', COMSPEC: 'C:\\Windows\\cmd.exe' }, 'win32'))
      .toEqual({ file: 'C:\\Windows\\cmd.exe', args: `/d /s /c ""${shim}" auth login --claudeai"` })
  })

  it('says why it can\'t: not installed, or a shim in a folder cmd would read', () => {
    expect(signInCli('codex', ['login'], { PATH: sb.root, PATHEXT: '.EXE' }, 'win32')).toEqual({ error: 'Codex isn\'t installed where Termpolis can find it (not on PATH)' })
    expect(signInCli('agy', [], { PATH: sb.root, PATHEXT: '.EXE' }, 'win32')).toEqual({ error: 'Gemini / Antigravity CLI isn\'t installed where Termpolis can find it (not on PATH)' })
    const odd = join(sb.root, 'a&b')
    mkdirSync(odd)
    writeFileSync(join(odd, 'codex.cmd'), '')
    expect(signInCli('codex', ['login'], { PATH: odd, PATHEXT: '.CMD' }, 'win32')).toEqual({ error: 'the CLI is installed in a folder Termpolis can\'t run it from safely' })
  })
})

describe('accounts:sign-in-start and sign-in-input', () => {
  it('starts the CLI\'s login in the account\'s profile, in Termpolis\'s own folder, and relays a code', async () => {
    const r = await addClaude('codedev', 'me@example.test')
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: r.account.id, method: 'console' })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toEqual(['auth', 'login', '--console', '--email', 'me@example.test'])
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe(r.account.profile)
    expect(spawned[0].cwd).toBe(cwd)
    const b = await until('browser') as Extract<SignInPhase, { kind: 'browser' }>
    expect(b.url!.startsWith('https://platform.claude.com/oauth/authorize?')).toBe(true)
    expect(await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'code', value: 'good-code' })).toEqual({ ok: true })
    expect(await until('success')).toEqual({ kind: 'success', email: 'person@example.test', plan: 'max' })
    // The answer is kept, as a check's would be.
    const doc = loadAccounts(sb.paths.userData)
    expect(doc.ok && doc.doc.file.identity[r.account.id]).toMatchObject({ email: 'person@example.test', signedIn: true })
  })

  it('takes the method asked for, and the default where it names none of the agent\'s', async () => {
    const r = await addClaude()
    await ok(ACCOUNTS_IPC.signInStart, { accountId: r.account.id, method: 'device' })
    expect(spawned[0].args).toEqual(['auth', 'login', '--claudeai'])
    const c = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cb', folder: 'new', copy: false })
    await ok(ACCOUNTS_IPC.signInStart, { accountId: c.account.id, method: 'device' })
    expect(spawned[1].args).toEqual(['login', '--device-auth'])
    expect(spawned[1].env.CODEX_HOME).toBe(c.account.profile)
  })

  it('confirms a fresh sign-in by its status command even with a terminal running on the profile', async () => {
    const r = await addClaude()
    noteTerminalAccount('t1', r.account.id)
    mockEnv = { MOCK_LOGIN_MODE: 'callback' }
    await ok(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    expect(await until('success')).toMatchObject({ kind: 'success', email: 'person@example.test' })
    // A Check from Settings is still not asked while that terminal runs (R21).
    const check = await call(ACCOUNTS_IPC.check, { id: r.account.id })
    expect(check.error).toMatch(/A Termpolis terminal is running on codedev/)
  })

  it('says so when the status command says signed out, or can\'t answer', async () => {
    const r = await addClaude()
    mockEnv = { MOCK_LOGIN_MODE: 'callback' }
    register({ signedInNow: async () => ({ identity: { email: null, signedIn: false, checkedAt: 1, source: 'auth-status' } }) })
    await ok(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    expect(await until('error')).toMatchObject({ message: 'Claude Code said it signed in, but its status still says signed out' })
    sent = []
    register({ signedInNow: async () => ({ error: 'it took too long' }) })
    await ok(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    expect(await until('error')).toMatchObject({ message: 'Termpolis couldn\'t confirm the sign-in: it took too long' })
  })

  it('refuses before anything runs: no such account, the wrong mode, a missing folder, no CLI', async () => {
    expect((await call(ACCOUNTS_IPC.signInStart, { accountId: 'nope' })).error).toMatch(/isn't registered/)
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', email: 'g@example.test' })
    expect((await call(ACCOUNTS_IPC.signInStart, { accountId: g.account.id })).error).toBe('the Antigravity CLI signs in through its switch')
    const r = await addClaude()
    expect((await call(ACCOUNTS_IPC.signInStart, { accountId: r.account.id, mode: 'agy-switch' })).error).toBe('codedev isn\'t an Antigravity CLI account')
    register({ signInCli: () => ({ error: 'Claude Code isn\'t installed where Termpolis can find it (not on PATH)' }) })
    expect((await call(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })).error).toMatch(/isn't installed/)
    const { rmdirSync } = await import('fs')
    rmdirSync(r.account.profile as string)
    expect((await call(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })).error).toBe('codedev\'s profile folder doesn\'t exist')
    expect(spawned).toEqual([])
  })

  it('refuses agy\'s switch where agy signs in from the environment, by the variable\'s name only', async () => {
    register({ env: { PATH: '/nowhere', GEMINI_API_KEY: 'a'.repeat(39) } })
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', email: 'g@example.test' })
    const r = await call(ACCOUNTS_IPC.signInStart, { accountId: g.account.id, mode: 'agy-switch' })
    expect(r.error).toBe('agy signs in with GEMINI_API_KEY from the environment here, so signing out changes nothing: change GEMINI_API_KEY instead')
    expect(r.error).not.toContain('aaaa')
    expect(spawned).toEqual([])
  })

  it('runs agy\'s switch in the hidden agy, and moves every agy terminal and new launches to the account once agy is back', async () => {
    const old = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'old', email: 'old@example.test' })
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', email: 'new.person@example.test' })
    noteTerminalAccount('agy-1', old.account.id)
    noteTerminalAccount('claude-1', null)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: g.account.id, mode: 'agy-switch' })
    expect(spawned[0].file).toBe('agy')
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBeUndefined()
    await until('choose')
    expect(await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'pick', index: 0, label: 'Continue with Google' })).toEqual({ ok: true })
    await until('browser')
    await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'code', value: 'good-code' })
    expect(await until('success')).toEqual({ kind: 'success', email: 'new.person@example.test' })
    const moves = sent.filter((s) => s.channel === ACCOUNTS_IPC.terminalAccount).map((s) => s.payload)
    expect(moves).toEqual([{ terminalId: 'agy-1', accountId: g.account.id, byHand: false }])
    expect(log).toHaveBeenCalledWith('[accounts] agy moved to g: 1 terminal')
    const doc = loadAccounts(sb.paths.userData)
    expect(doc.ok && doc.doc.file.preferred.agy).toBe(g.account.id)
    log.mockRestore()
  })

  it('says how many agy terminals moved, for several', async () => {
    const old = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'old', email: 'old@example.test' })
    const g = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', email: 'new.person@example.test' })
    noteTerminalAccount('agy-1', old.account.id)
    noteTerminalAccount('agy-2', old.account.id)
    mockEnv = { MOCK_AGY_SIGNED_IN: '0' }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: g.account.id, mode: 'agy-switch' })
    await until('choose')
    await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'pick', index: 0, label: 'Continue with Google' })
    await until('browser')
    await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'code', value: 'good-code' })
    await until('success')
    expect(log).toHaveBeenCalledWith('[accounts] agy moved to g: 2 terminals')
    log.mockRestore()
  })

  it('ends a window\'s sessions when it goes, watching each window once', async () => {
    const r = await addClaude()
    mockEnv = { MOCK_LOGIN_MODE: 'silent' }
    const listeners: Array<() => void> = []
    const sender = { once: vi.fn((_ev: string, fn: () => void) => { listeners.push(fn) }) }
    await ok(ACCOUNTS_IPC.signInStart, { accountId: r.account.id }, { sender })
    await ok(ACCOUNTS_IPC.signInStart, { accountId: r.account.id }, { sender })
    expect(sender.once).toHaveBeenCalledTimes(1)
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(signInSessionCount()).toBe(1)
    listeners[0]()
    expect(signInSessionCount()).toBe(0)
  })

  it('relays input to its session only, and says so of one that ended', async () => {
    expect(await ok(ACCOUNTS_IPC.signInInput, { sessionId: 'nope', kind: 'cancel' })).toEqual({ ok: false, why: 'that sign-in has ended' })
    expect(await ok(ACCOUNTS_IPC.signInInput, { kind: 'cancel' })).toEqual({ ok: false, why: 'that sign-in has ended' })
  })

  it('opens the provider\'s page through main\'s own reading of it', async () => {
    const opened = vi.fn()
    register({ openExternal: opened })
    const r = await addClaude()
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    const b = await until('browser') as Extract<SignInPhase, { kind: 'browser' }>
    expect(await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'open' })).toEqual({ ok: true })
    expect(opened).toHaveBeenCalledWith(b.url)
  })

  it('opens nothing where main has no browser to hand it to', async () => {
    register({ openExternal: undefined })
    const r = await addClaude()
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    await until('browser')
    expect(await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'open' })).toEqual({ ok: true })
  })

  it('finds the CLI itself when no test stands in for it, and says so when it isn\'t installed', async () => {
    register({ signInCli: undefined, env: { PATH: join(sb.root, 'no-such-folder'), PATHEXT: '.EXE' } })
    const r = await addClaude()
    expect((await call(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })).error).toBe('Claude Code isn\'t installed where Termpolis can find it (not on PATH)')
    expect(spawned).toEqual([])
  })

  it('takes no input but an object, names the default profile\'s key, and keeps no plan the status didn\'t give', async () => {
    expect((await call(ACCOUNTS_IPC.signInStart, 'nonsense')).error).toMatch(/isn't registered/)
    register({ signedInNow: async () => ({ identity: { email: 'main@example.test', signedIn: true, checkedAt: 1, source: 'auth-status' } }) })
    // The default profile's folder, as a signed-in user's machine has it.
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    const r = await addClaude()
    // Adding one registered the default profile too: its key has no folder in it.
    const doc = loadAccounts(sb.paths.userData)
    const main = doc.ok ? doc.doc.file.accounts.find((a) => a.profile === null && a.agent === 'claude') : undefined
    expect(main).toBeDefined()
    mockEnv = { MOCK_LOGIN_MODE: 'callback' }
    await ok(ACCOUNTS_IPC.signInStart, { accountId: main!.id })
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(await until('success')).toEqual({ kind: 'success', email: 'main@example.test' })
    expect(r.account.id).not.toBe(main!.id)
  })

  it('runs the CLI it finds by itself, through real node-pty, when no test stands in for them', async () => {
    let pty: unknown = null
    try { pty = require('node-pty') } catch { /* this Node can't load it: the default spawner isn't reachable here */ }
    if (!pty) return
    vi.useRealTimers()
    // The "CLI" is the mock login, by an absolute path the default spawner runs as it is.
    const mock = join(__dirname, 'mocks', 'mockLogin.cjs')
    register({ signInSpawn: undefined, signInCli: (_agent, args) => ({ file: process.execPath, args: [mock, ...args] }), env: { ...process.env, MOCK_LOGIN_MODE: 'silent' } as Record<string, string> })
    const r = await addClaude()
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    expect(signInSessionCount()).toBe(1)
    // The mock is up (it holds its working folder) before it is ended, and gone before the sandbox is.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'cancel' })).toEqual({ ok: true })
    expect(signInSessionCount()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    vi.useFakeTimers()
  }, 30_000)

  it('ends every session at quit, and a quit before any is a no-op', async () => {
    endAccountSignIns()
    const r = await addClaude()
    mockEnv = { MOCK_LOGIN_MODE: 'silent' }
    await ok(ACCOUNTS_IPC.signInStart, { accountId: r.account.id })
    expect(signInSessionCount()).toBe(1)
    endAccountSignIns()
    expect(signInSessionCount()).toBe(0)
  })
})

// The hidden sign-in session is not a Termpolis terminal (the in-app UI addendum, section 3 and 5): nothing
// lists it, polls it, writes to it through the terminal tools, or tells a renderer terminal about it. It
// is one PTY, spawned by main's own seam, whose only outward word is the sign-in state channel. These guard
// that: a source scan of the modules that run it, a mutation of the scan itself, and a run of a real session
// with the terminal manager's spawn, write and kill spied on.
describe('the hidden sign-in session is invisible to terminal tools and pollers (UI addendum section 5)', () => {
  const ROOT = join(__dirname, '..', '..')
  const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')
  // What makes a PTY a "Termpolis terminal": the terminal manager's spawn/registry/write functions, the MCP
  // server's terminal tools, and the renderer-visible terminal events.
  const TERMINAL_REACH = /from ['"]\.\/(terminalManager|terminalBuffers?|terminalRegistry|mcpServer)['"]|\b(spawnTerminal|createTerminalSession|writeToTerminal|killTerminal|registerTerminal)\b|['"]terminal:(data|exit|created)['"]|webContents\.send\(['"]terminal/

  it.each(['src/main/signInSession.ts', 'src/shared/signInScreens.ts'])('%s has no reach into terminals', (f) => {
    expect(read(f).match(TERMINAL_REACH)).toBeNull()
  })

  it('accountsIpc.ts spawns the sign-in PTY through node-pty itself, and imports no terminal manager', () => {
    const t = read('src/main/accountsIpc.ts')
    expect(t.match(/from ['"]\.\/(terminalManager|terminalBuffers?|terminalRegistry)['"]/)).toBeNull()
    expect(t).toMatch(/require\('node-pty'\)\s+as\s+\{\s*spawn: SessionDeps\['spawn'\]\s*\}\)\.spawn\(file, args, opts\)/)
  })

  it('tells the renderer about a session in one way only: the sign-in state channel', () => {
    const sends = [...read('src/main/signInSession.ts').matchAll(/deps\.send\(([^)]*)\)/g)].map((m) => m[1].trim())
    expect(sends).toEqual(['{ sessionId: s.id, accountId: s.spec.accountId, agent: s.spec.agent, phase }'])
  })

  it('sees a regression: the scan flags a sign-in module that imported the terminal manager, or sent a terminal event', () => {
    expect(("import { writeToTerminal } from './terminalManager'\n" + read('src/main/signInSession.ts')).match(TERMINAL_REACH)).not.toBeNull()
    expect((read('src/main/signInSession.ts') + "\nwin.webContents.send('terminal:data', 1)").match(TERMINAL_REACH)).not.toBeNull()
    expect((read('src/main/signInSession.ts') + "\nspawnTerminal('x')").match(TERMINAL_REACH)).not.toBeNull()
  })

  it('runs a whole session (start, a pasted code, success, cancel of another) without the terminal manager being touched', async () => {
    const r = await addClaude('codedev', 'me@example.test')
    const { sessionId } = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: r.account.id, method: 'console' })
    await until('browser')
    await ok(ACCOUNTS_IPC.signInInput, { sessionId, kind: 'code', value: 'good-code' })
    await until('success')
    const second = await addClaude('spare', 'spare@example.test')
    const other = await ok<{ sessionId: string }>(ACCOUNTS_IPC.signInStart, { accountId: second.account.id })
    await ok(ACCOUNTS_IPC.signInInput, { sessionId: other.sessionId, kind: 'cancel' })
    endAccountSignIns()
    const channels = [...new Set(sent.map((s) => s.channel))]
    // Main said nothing about a terminal: only the sign-in state (and the account events a sign-in causes).
    expect(channels.filter((c) => /terminal/i.test(c) && c !== ACCOUNTS_IPC.terminalAccount)).toEqual([])
    expect(terminalManagerCalls).toEqual([])
  })
})
