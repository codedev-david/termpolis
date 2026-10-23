// @vitest-environment node
//
// A swarm's workers (§9), main's side (src/main/accountsIpc.ts). run_command types no account line
// into a worker, so main records what it typed there (sanitized) as the worker's start: its agent,
// its flags, and the account Termpolis's own environment gives it. A restart of the worker on
// another account then holds it as a worker's (R7) and starts the worker's own command again. In
// the sandbox of accountsIpc.test.ts: a scratch home under TERMPOLIS_TEST_AGENT_HOME, never a
// real profile.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  _resetTerminalAccountsForTest, envAccountOf, envAccounts, forgetTerminalAccount, isAccountChangedByHand, noteSwarmWorker,
  noteTypedInput, noteWorkerCommand, registerAccountsIpc, terminalAccountId, terminalAgentStart,
} from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { _resetSwitchLocksForTest, relaunchLockReason } from '../../src/main/accountSwitch'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AccountsView, AddAccountResult } from '../../src/shared/agentAccounts'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import { loadAccounts } from '../../src/main/agentAccounts'
import type { AccountsDoc } from '../../src/main/agentAccounts'
import { createSandbox, writeJson } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import { FakeTerminal, ID } from './_switchTerminal'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let sent: Array<{ channel: string; payload: any }>
let term: FakeTerminal
let end = 0

function register(over: Partial<AccountsIpcDeps> = {}): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => true,
    pickFolder: async () => null,
    send: (channel, payload) => { sent.push({ channel, payload }) },
    checkCwd: () => sb.root,
    env: {},
    now: () => 42,
    outputEnd: () => end,
    switchIO: {
      output: (id) => term.io().output(id),
      outputFrom: (id, from) => term.io().outputFrom(id, from),
      end: (id) => term.io().end(id),
      size: () => ({ cols: 80, rows: 24 }),
      write: (id, data) => term.io().write(id, data),
      sleep: (ms) => term.io().sleep(ms),
      now: () => term.clock,
    },
    ...over,
  })
}

async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

const doc = (): AccountsDoc => {
  const d = loadAccounts(sb.paths.userData)
  if (!d.ok) throw new Error(d.error)
  return d.doc
}

/** The default Claude profile and a second one, b; Codex's default too when asked. */
async function accounts(codex = false): Promise<{ main: string; b: string; bDir: string; codexMain?: string }> {
  mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
  writeJson(sb.paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' } })
  const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share: ['projects'] })
  if (codex) {
    mkdirSync(sb.paths.codexHome, { recursive: true })
    await ok(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cx', folder: 'new', copy: false, share: [] })
  }
  const d = doc()
  return {
    main: d.file.accounts.find((a) => a.agent === 'claude' && a.profile === null)!.id,
    b: r.account.id,
    bDir: r.account.profile!,
    codexMain: d.file.accounts.find((a) => a.agent === 'codex' && a.profile === null)?.id,
  }
}

const accountEvents = (): any[] => sent.filter((s) => s.channel === ACCOUNTS_IPC.terminalAccount).map((s) => s.payload)

beforeEach(() => {
  sb = createSandbox()
  sent = []
  end = 0
  term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', launch: 'claude --dangerously-skip-permissions' })
  _resetTerminalAccountsForTest()
  _resetSwitchLocksForTest()
  register()
})

afterEach(() => {
  _resetTerminalAccountsForTest()
  sb.dispose()
})

describe('noteWorkerCommand: a worker\'s start, as run_command typed it', () => {
  it('leaves alone a terminal that is no worker of the swarm\'s (the user\'s own, a phone\'s)', async () => {
    await accounts()
    noteWorkerCommand('mine', 'claude --dangerously-skip-permissions')
    expect(terminalAgentStart('mine')).toBeUndefined()
    expect(terminalAccountId('mine')).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('records a Claude Code worker\'s start where its output ended, on the default account, and tells the renderer its agent', async () => {
    const { main } = await accounts()
    end = 1234
    noteSwarmWorker('w1')
    noteWorkerCommand('w1', '  claude --dangerously-skip-permissions --model sonnet ', 7)
    expect(terminalAgentStart('w1')).toEqual({ at: 1234, commands: ['claude --dangerously-skip-permissions --model sonnet'], agent: 'claude', time: 7 })
    expect(terminalAccountId('w1')).toBe(main)
    expect(accountEvents()).toEqual([{ terminalId: 'w1', accountId: main, byHand: false, agent: 'claude' }])
  })

  it('records the start at the output\'s beginning where main can\'t say where it ends', async () => {
    await accounts()
    register({ outputEnd: undefined })
    noteSwarmWorker('w1')
    noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
    expect(terminalAgentStart('w1')!.at).toBe(0)
  })

  it('puts it on the account whose profile Termpolis\'s own environment names', async () => {
    const { b, bDir } = await accounts()
    register({ env: { CLAUDE_CONFIG_DIR: `${bDir}\\` } })
    noteSwarmWorker('w1')
    noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
    expect(terminalAccountId('w1')).toBe(b)
  })

  it('knows no account for a profile no registered account is, nor for an empty value (R24)', async () => {
    await accounts()
    for (const value of [join(sb.root, 'elsewhere'), '', '  ']) {
      register({ env: { CLAUDE_CONFIG_DIR: value } })
      noteSwarmWorker('w1')
      noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
      expect(terminalAccountId('w1')).toBeUndefined()
    }
    expect(accountEvents().every((e) => e.accountId === null && e.agent === 'claude')).toBe(true)
  })

  it('records a Codex worker on its default account, an agy worker with no account, and a worker with no registry with none', async () => {
    const { codexMain } = await accounts(true)
    noteSwarmWorker('wc')
    noteWorkerCommand('wc', 'codex -a never -s workspace-write -c check_for_update_on_startup=false')
    expect(terminalAccountId('wc')).toBe(codexMain)
    expect(terminalAgentStart('wc')!.agent).toBe('codex')
    noteSwarmWorker('wg')
    noteWorkerCommand('wg', 'agy --dangerously-skip-permissions')
    expect(terminalAccountId('wg')).toBeUndefined()
    expect(accountEvents().pop()).toEqual({ terminalId: 'wg', accountId: null, byHand: false, agent: 'agy' })
    writeFileSync(join(sb.paths.userData, 'agent-accounts.json'), '{ not json')
    noteSwarmWorker('wn')
    noteWorkerCommand('wn', 'claude --dangerously-skip-permissions')
    expect(terminalAgentStart('wn')!.agent).toBe('claude')
    expect(terminalAccountId('wn')).toBeUndefined()
  })

  it('leaves the account unknown once a line set the profile variable itself, for the shell\'s life', async () => {
    const { main } = await accounts()
    noteSwarmWorker('w1')
    noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
    expect(terminalAccountId('w1')).toBe(main)
    // The sanitizer passes a line that starts with an assignment unchanged (F7).
    noteWorkerCommand('w1', 'CLAUDE_CONFIG_DIR=/x claude -p "go"')
    expect(isAccountChangedByHand('w1')).toBe(true)
    expect(terminalAccountId('w1')).toBeUndefined()
    expect(terminalAgentStart('w1')).toBeUndefined()
    noteWorkerCommand('w1', 'export CODEX_HOME=/y')
    noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
    expect(terminalAgentStart('w1')!.agent).toBe('claude')
    expect(terminalAccountId('w1')).toBeUndefined()
    expect(accountEvents()).toEqual([
      { terminalId: 'w1', accountId: main, byHand: false, agent: 'claude' },
      { terminalId: 'w1', accountId: null, byHand: true },
      { terminalId: 'w1', accountId: null, byHand: true, agent: 'claude' },
    ])
  })

  it('forgets the agent at a command that starts none, and the worker once its terminal is gone', async () => {
    await accounts()
    noteSwarmWorker('w1')
    noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
    noteWorkerCommand('w1', 'cd src')
    expect(terminalAgentStart('w1')).toBeUndefined()
    expect(accountEvents()).toHaveLength(1)
    forgetTerminalAccount('w1')
    noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
    expect(terminalAgentStart('w1')).toBeUndefined()
    expect(accountEvents()).toHaveLength(1)
  })

  // What the conductor sends a worker reaches main's typed-line watch (index.ts): a prompt entered
  // while the worker's box shows is its turn (R4), which a carried stop asks about.
  it('counts a prompt entered in the worker\'s box as its turn', async () => {
    await accounts()
    noteSwarmWorker('w1')
    end = term.launchedAt
    noteWorkerCommand('w1', term.launchLine())
    expect(terminalAgentStart('w1')!.turned).toBeUndefined()
    noteTypedInput('w1', 'Continue your task.')
    expect(terminalAgentStart('w1')!.turned).toBeUndefined()
    noteTypedInput('w1', '\r')
    expect(terminalAgentStart('w1')!.turned).toBe(true)
  })

  it('never throws: the worker runs as before', async () => {
    await accounts()
    register({ paths: () => { throw new Error('no paths') } })
    noteSwarmWorker('w1')
    expect(() => noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')).not.toThrow()
    expect(terminalAgentStart('w1')!.agent).toBe('claude')
  })
})

describe('envAccountOf and the view\'s envAccount', () => {
  // R24: an empty CLAUDE_CONFIG_DIR is no profile. Read as a path, it is the folder the agent starts
  // in, which a registered profile could be.
  it('takes an empty value for no profile, even where the folder it would resolve to is one', () => {
    const here = { id: 'acc_here', agent: 'claude', label: 'here', profile: process.cwd(), autoOffer: true, order: 1, connect: true, origin: 'adopted', links: [] }
    const doc = { file: { accounts: [here] } } as unknown as AccountsDoc
    expect(envAccountOf(doc, 'claude', { CLAUDE_CONFIG_DIR: process.cwd() })?.id).toBe('acc_here')
    expect(envAccountOf(doc, 'claude', { CLAUDE_CONFIG_DIR: '' })).toBeNull()
  })

  it('names the account each profile agent\'s terminals run on with no account line', async () => {
    const { main, b, bDir, codexMain } = await accounts(true)
    expect(envAccounts(doc(), {})).toEqual({ claude: main, codex: codexMain })
    expect(envAccounts(doc(), { CLAUDE_CONFIG_DIR: bDir, CODEX_HOME: join(sb.root, 'none') })).toEqual({ claude: b })
    expect(envAccountOf(doc(), 'claude', { CLAUDE_CONFIG_DIR: bDir })!.label).toBe('b')
    const view = await ok<AccountsView>(ACCOUNTS_IPC.list)
    expect(view.envAccount).toEqual({ claude: main, codex: codexMain })
  })
})

describe('accounts:switch on a worker (§9)', () => {
  it('holds it as a worker\'s while it runs, starts the worker\'s own command on the target, and records it', async () => {
    const { main, b, bDir } = await accounts()
    noteSwarmWorker('t1')
    end = term.launchedAt
    noteWorkerCommand('t1', term.launchLine())
    expect(terminalAccountId('t1')).toBe(main)
    let held: string | null = null
    const io = { ...term.io(), write: (id: string, d: string) => { held ??= relaunchLockReason(id, term.clock); term.io().write(id, d) } }
    register({ switchIO: { ...io, size: () => ({ cols: 80, rows: 24 }) } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const outcome = await ok<SwitchOutcome>(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: b, shellType: 'gitbash', reason: 'usage limit' })
    log.mockRestore()
    expect(outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(held).toBe('Termpolis is restarting this worker; wait for system\'s next message')
    const line = `export CLAUDE_CONFIG_DIR='${bDir}' && claude --dangerously-skip-permissions --resume ${ID}`
    expect(term.ran).toEqual(['', line])
    expect(terminalAccountId('t1')).toBe(b)
    expect(terminalAgentStart('t1')!.commands).toEqual([line])
    expect(accountEvents().pop()).toEqual({ terminalId: 't1', accountId: b, byHand: false })
  })

  // The restart's account line stays set in the worker's shell: an agent run_command starts there
  // later runs on the target, not on the account Termpolis's environment names.
  it('keeps the worker on the target for a later start in the same shell', async () => {
    const { main, b } = await accounts()
    noteSwarmWorker('t1')
    end = term.launchedAt
    noteWorkerCommand('t1', term.launchLine())
    expect(terminalAccountId('t1')).toBe(main)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await ok<SwitchOutcome>(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: b, shellType: 'gitbash' })
    log.mockRestore()
    noteWorkerCommand('t1', 'claude --dangerously-skip-permissions')
    expect(terminalAccountId('t1')).toBe(b)
    expect(accountEvents().pop()).toEqual({ terminalId: 't1', accountId: b, byHand: false, agent: 'claude' })
    // Another agent there reads its own variable, which no line set; Claude Code's stays set.
    mkdirSync(sb.paths.codexHome, { recursive: true })
    await ok(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cx', folder: 'new', copy: false, share: [] })
    const codexMain = doc().file.accounts.find((a) => a.agent === 'codex' && a.profile === null)!.id
    noteWorkerCommand('t1', 'codex -a never -s workspace-write -c check_for_update_on_startup=false')
    expect(terminalAccountId('t1')).toBe(codexMain)
    noteWorkerCommand('t1', 'claude --dangerously-skip-permissions')
    expect(terminalAccountId('t1')).toBe(b)
    // A closed worker's id starts over.
    forgetTerminalAccount('t1')
    noteSwarmWorker('t1')
    noteWorkerCommand('t1', 'claude --dangerously-skip-permissions')
    expect(terminalAccountId('t1')).toBe(main)
  })

  it('holds any other terminal as an account switch', async () => {
    const { main, b } = await accounts()
    term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint' })
    let held: string | null = null
    register({ switchIO: { ...term.io(), write: (id, d) => { held ??= relaunchLockReason(id, term.clock); term.io().write(id, d) } } })
    void main
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await ok<SwitchOutcome>(ACCOUNTS_IPC.switchAccount, { terminalId: 't9', targetId: b, shellType: 'gitbash' })
    log.mockRestore()
    expect(held).toBe('Termpolis is switching this agent\'s account; wait for system\'s next message')
  })
})
