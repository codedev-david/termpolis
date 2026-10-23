// @vitest-environment node
//
// accounts:limit-look and the agent's lifecycle in main (src/main/accountsIpc.ts): the usage-limit
// chooser's look at a terminal, with main's own records of the agent started there (its launch
// line, a switch's relaunch, an agent typed by hand) and of the terminal's account. The terminal is
// the scripted one of _switchTerminal.ts, in the sandbox of accountsIpc.test.ts: a scratch home
// under TERMPOLIS_TEST_AGENT_HOME, never a real profile.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  _resetTerminalAccountsForTest, isAccountChangedByHand, noteAgentStart, noteTerminalAccount, noteTypedInput, registerAccountsIpc,
  terminalAccountId, terminalAgentStart, LIMIT_CHOOSER_VAR, withLimitChooser,
} from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { _resetSwitchLocksForTest } from '../../src/main/accountSwitch'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { LimitLook } from '../../src/shared/accountLimits'
import { stopKind } from '../../src/shared/agentStatusDetector'
import { createSandbox } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import { FakeTerminal, RULE } from './_switchTerminal'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let term: FakeTerminal
let clock: number

const E = '\x1b'
const paint = (rows: string[]): string => `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')

function register(over: Partial<AccountsIpcDeps> = {}): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => true,
    pickFolder: async () => null,
    send: () => {},
    checkCwd: () => sb.root,
    env: {},
    now: () => clock,
    outputEnd: () => term.out.length,
    switchIO: {
      output: (id) => term.io().output(id),
      outputFrom: (id, from) => term.io().outputFrom(id, from),
      end: (id) => term.io().end(id),
      size: () => ({ cols: 80, rows: 24 }),
      write: (id, data) => term.io().write(id, data),
      sleep: (ms) => term.io().sleep(ms),
      now: () => clock,
    },
    ...over,
  })
}

async function call<T = any>(channel: string, input?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
  return (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
}
async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = await call<T>(channel, input)
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

beforeEach(() => {
  sb = createSandbox()
  clock = 1000
  term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'gone-quiet', exit: 'hint' })
  _resetTerminalAccountsForTest()
  _resetSwitchLocksForTest()
  register()
})

afterEach(() => {
  _resetTerminalAccountsForTest()
  sb.dispose()
})

/** The launch line main builds, typed into the shell as the renderer types it. */
async function launch(command: string): Promise<string> {
  const { line } = await ok<{ line: string }>(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', shellType: 'gitbash', command })
  noteTypedInput('t1', `${line}\r`, clock)
  term.type(`${line}\r`)
  return line
}

describe('accounts:limit-look', () => {
  it('needs main\'s terminals and a terminal', async () => {
    expect((await call(ACCOUNTS_IPC.limitLook, {})).error).toBe('which terminal?')
    register({ switchIO: undefined })
    expect((await call(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })).error).toBe('main has no terminals to look at')
  })

  it('reads nothing as counting in a terminal Termpolis started no agent in', async () => {
    expect(await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })).toMatchObject({ agent: null, live: false, accountId: null, byHand: false })
  })

  it("watches an agent its launch line started, though the agent has no accounts, and records no account (D13)", async () => {
    await launch('claude')
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude', commands: ['claude'], time: 1000 })
    expect(terminalAccountId('t1')).toBeUndefined()
    const seen = await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(seen).toMatchObject({ agent: 'claude', live: true, turned: false, accountId: null, byHand: false })
  })

  it('names the agent its launch started though the line names it otherwise (a test shim, a wrapper)', async () => {
    const { line } = await ok<{ line: string }>(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'codex', shellType: 'gitbash', command: 'node mock-codex.cjs' })
    expect(line).toBe('node mock-codex.cjs')
    noteTypedInput('t1', `${line}\r`, clock)
    expect(terminalAgentStart('t1')).toEqual({ at: term.out.length, commands: ['node mock-codex.cjs'], agent: 'codex', time: 1000 })
  })

  it('names it so on an account line too', async () => {
    mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
    await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share: [] })
    const { line } = await ok<{ line: string }>(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', shellType: 'gitbash', command: 'node mock-claude.cjs' })
    expect(line).toMatch(/^unset CLAUDE_CONFIG_DIR && node mock-claude\.cjs --session-id /)
    noteTypedInput('t1', `${line}\r`, clock)
    expect(terminalAgentStart('t1')).toMatchObject({ commands: [line], agent: 'claude' })
  })

  it('counts a prompt entered in its box as a turn, and reads a limit drawn after it', async () => {
    await launch('claude')
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'Build the login page.\r', clock)
    term.out += paint(['❯ Build the login page.', "  ⎿  You've hit your session limit · resets 3pm (America/New_York)", '', RULE, '❯ ', RULE])
    const seen = await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(stopKind(seen.status)).toBe('limit')
    expect(seen).toMatchObject({ live: true, turned: true, words: "You've hit your session limit · resets 3pm (America/New_York)" })
  })

  it("names the terminal's account, and an account changed by hand", async () => {
    noteTerminalAccount('t1', 'acc_000000000001')
    expect(await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })).toMatchObject({ accountId: 'acc_000000000001', byHand: false })
    noteTypedInput('t1', 'export CLAUDE_CONFIG_DIR=/tmp/x\r', clock)
    expect(await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })).toMatchObject({ byHand: true })
  })
})

describe("the agent's lifecycle, from what is typed", () => {
  it('starts a record for an agent typed by hand at the shell', () => {
    noteTypedInput('t1', 'codex -m gpt-5.6-sol\r', clock)
    expect(terminalAgentStart('t1')).toEqual({ at: term.out.length, commands: ['codex -m gpt-5.6-sol'], agent: 'codex', time: 1000 })
  })

  it('keeps the record of a live agent when its prompt reads like a launch', async () => {
    await launch('claude')
    const start = terminalAgentStart('t1')!
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'claude fix the test\r', clock)
    expect(terminalAgentStart('t1')).toBe(start)
    expect(start.turned).toBe(true)
  })

  it('reads nothing when main has no terminals, and never lets a failed look stop the line\'s other checks', () => {
    register({ switchIO: undefined })
    noteTypedInput('t1', 'claude\r', clock)
    expect(terminalAgentStart('t1')).toBeUndefined()
    register({ switchIO: { ...term.io(), output: () => { throw new Error('gone') } } })
    noteTypedInput('t1', 'claude\r', clock)
    expect(terminalAgentStart('t1')).toBeUndefined()
    // The account changed by hand is still seen.
    noteTypedInput('t1', 'export CLAUDE_CONFIG_DIR=/tmp/x\r', clock)
    expect(isAccountChangedByHand('t1')).toBe(true)
  })

  it('records the agent a relaunch starts, and when', () => {
    noteAgentStart('t1', { at: 5, commands: ['codex -m x resume 01a1664b-6312-7121-97f6-88c7f6793c64'] }, 9)
    expect(terminalAgentStart('t1')).toEqual({ at: 5, commands: ['codex -m x resume 01a1664b-6312-7121-97f6-88c7f6793c64'], agent: 'codex', time: 9 })
    noteAgentStart('t1', { at: 6, commands: [], agent: 'agy', time: 3 })
    expect(terminalAgentStart('t1')).toEqual({ at: 6, commands: [], agent: 'agy', time: 3 })
    noteAgentStart('t1', { at: 7, commands: ['something else'] })
    expect(terminalAgentStart('t1')).toMatchObject({ at: 7, commands: ['something else'] })
    expect(terminalAgentStart('t1')!.agent).toBeUndefined()
    expect(typeof terminalAgentStart('t1')!.time).toBe('number')
    noteAgentStart('t1', { at: 8, commands: [] }, 11)
    expect(terminalAgentStart('t1')).toEqual({ at: 8, commands: [], time: 11 })
  })

  it("records the model picker's relaunch line as the agent's start once typed", async () => {
    term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint' })
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1', line: 'claude --model sonnet --continue' })
    expect(typeof key).toBe('string')
    noteTypedInput('t1', 'claude --model sonnet --continue\r', clock)
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude', commands: ['claude --model sonnet --continue'] })
  })
})

// The chooser's marker (§8.6, R6): TERMPOLIS_LIMIT_CHOOSER=1 only on a terminal Termpolis creates to
// launch an agent it watches, once that agent has two accounts; any other terminal never carries
// one, not even one Termpolis inherited.
describe('withLimitChooser', () => {
  const two = async (agent: 'claude' | 'codex' = 'claude') => {
    if (agent === 'claude') {
      mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
      await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share: [] })
    } else {
      mkdirSync(sb.paths.codexHome, { recursive: true })
      await ok(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cb', folder: 'new', copy: false, share: [] })
    }
  }

  it('adds nothing while no agent has two accounts (D13): every terminal is today\'s', () => {
    expect(withLimitChooser(undefined, 'claude')).toBeUndefined()
    expect(withLimitChooser(undefined, true)).toBeUndefined()
    const proxied = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }
    expect(withLimitChooser(proxied, 'claude')).toBe(proxied)
  })

  it('adds nothing for an agent with one account: the chooser has nowhere to switch it', async () => {
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'home', email: 'home@example.test' })
    expect(withLimitChooser(undefined, 'agy')).toBeUndefined()
    expect(withLimitChooser(undefined, true)).toBeUndefined()
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'school', email: 'school@example.test' })
    expect(withLimitChooser(undefined, 'agy')).toEqual({ TERMPOLIS_LIMIT_CHOOSER: '1' })
  })

  it("marks a launch of an agent with two accounts, keeping the launch's own env", async () => {
    await two()
    expect(withLimitChooser(undefined, 'claude')).toEqual({ [LIMIT_CHOOSER_VAR]: '1' })
    expect(withLimitChooser({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, 'claude')).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', TERMPOLIS_LIMIT_CHOOSER: '1' })
    // A swarm worker, its agent not known yet: any agent with two.
    expect(withLimitChooser(undefined, true)).toEqual({ TERMPOLIS_LIMIT_CHOOSER: '1' })
    // Another agent's launch, with fewer: unmarked.
    expect(withLimitChooser(undefined, 'codex')).toBeUndefined()
    expect(withLimitChooser(undefined, 'agy')).toBeUndefined()
  })

  it('never marks a terminal it does not watch: a plain shell, a phone\'s, anything not an agent', async () => {
    await two()
    for (const watch of [undefined, false, null, 'gemini', 'bash', 1]) expect(withLimitChooser(undefined, watch), String(watch)).toBeUndefined()
  })

  it('clears a marker Termpolis inherited on a terminal it does not mark', async () => {
    register({ env: { [LIMIT_CHOOSER_VAR]: '1' } })
    expect(withLimitChooser(undefined, undefined)).toEqual({ TERMPOLIS_LIMIT_CHOOSER: '' })
    expect(withLimitChooser({ A: 'b' }, 'claude')).toEqual({ A: 'b', TERMPOLIS_LIMIT_CHOOSER: '' })
    await two('codex')
    expect(withLimitChooser(undefined, 'codex')).toEqual({ TERMPOLIS_LIMIT_CHOOSER: '1' })
  })

  it("marks nothing before accounts are wired, and reads Termpolis's own env for an inherited one", async () => {
    vi.resetModules()
    const fresh = await import('../../src/main/accountsIpc')
    const saved = process.env[LIMIT_CHOOSER_VAR]
    try {
      process.env[LIMIT_CHOOSER_VAR] = '1'
      expect(fresh.withLimitChooser(undefined, 'claude')).toEqual({ TERMPOLIS_LIMIT_CHOOSER: '' })
      delete process.env[LIMIT_CHOOSER_VAR]
      expect(fresh.withLimitChooser(undefined, true)).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env[LIMIT_CHOOSER_VAR]
      else process.env[LIMIT_CHOOSER_VAR] = saved
    }
  })

  it('marks nothing while the registry is unreadable', async () => {
    await two()
    writeFileSync(join(sb.paths.userData, 'agent-accounts.json'), '{ not json')
    expect(withLimitChooser(undefined, 'claude')).toBeUndefined()
  })
})
