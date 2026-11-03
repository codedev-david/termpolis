// @vitest-environment node
//
// accounts:limit-look and the agent's lifecycle in main (src/main/accountsIpc.ts): the usage-limit
// chooser's look at a terminal, with main's own records of the agent started there (its launch
// line, a switch's relaunch, an agent typed by hand) and of the terminal's account. The terminal is
// the scripted one of _switchTerminal.ts, in the sandbox of accountsIpc.test.ts: a scratch home
// under TERMPOLIS_TEST_AGENT_HOME, never a real profile.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  _gatherLinesForTest, _resetTerminalAccountsForTest, isAccountChangedByHand, noteAgentStart, noteSwarmWorker, noteTerminalAccount, noteTypedInput, noteWorkerCommand, registerAccountsIpc,
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

// Endpoint security reads a process query on a timer as discovery (v1.54.3: endpointActivityGuard). The
// chooser's look runs for every changed screen of every agent terminal, every 2 s: it reads the
// terminal's own foreground (isShellInForeground, no process listing), and never the OS's full answer
// (shellAlone.ts), which a switch asks only at the moments that need it.
describe('accounts:limit-look never asks the OS who runs in the terminal', () => {
  it('reads the screen and the cheap foreground, however often it looks', async () => {
    const shellAlone = vi.fn(async () => true as boolean | null)
    const atShell = vi.fn(() => false as boolean | null)
    register({ switchIO: { output: (id) => term.io().output(id), outputFrom: (id, from) => term.io().outputFrom(id, from), end: (id) => term.io().end(id), size: () => ({ cols: 80, rows: 24 }), write: (id, data) => term.io().write(id, data), sleep: (ms) => term.io().sleep(ms), now: () => clock, atShell, shellAlone } })
    await launch('claude')
    for (let i = 0; i < 6; i++) {
      clock += 2000
      await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    }
    expect(atShell).toHaveBeenCalled()
    expect(shellAlone).not.toHaveBeenCalled()
  })
})
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

  it('looks at the screen once per write at most, and never for a line that could change nothing', async () => {
    const output = vi.fn(term.io().output)
    register({ switchIO: { ...term.io(), output } })
    // A plain shell, nothing started there: a pasted block of lines never replays the screen.
    noteTypedInput('t1', 'ls\rgit status\recho hi\r', clock)
    expect(output).not.toHaveBeenCalled()
    // Two launches in one paste: one look, shared. The second line goes to the Codex the first
    // started, as a paste's would, so the start stays Codex's.
    noteTypedInput('t1', 'codex\rclaude\r', clock)
    expect(output).toHaveBeenCalledTimes(1)
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'codex', commands: ['codex'] })
  })

  it('takes a live agent\'s first turn with one look, and needs none for the lines after it', async () => {
    const output = vi.fn(term.io().output)
    register({ switchIO: { ...term.io(), output } })
    // Termpolis's own launch line: no look.
    await launch('claude')
    expect(output).not.toHaveBeenCalled()
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'one\rtwo\rthree\r', clock)
    expect(output).toHaveBeenCalledTimes(1)
    expect(terminalAgentStart('t1')!.turned).toBe(true)
    noteTypedInput('t1', 'four\r/model sonnet\r', clock)
    expect(output).toHaveBeenCalledTimes(1)
  })

  it('takes no turn from a slash command, and looks for none', () => {
    const output = vi.fn(term.io().output)
    register({ switchIO: { ...term.io(), output } })
    noteTypedInput('t1', 'claude\r', clock)
    output.mockClear()
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', '/model sonnet\r', clock)
    expect(output).not.toHaveBeenCalled()
    expect(terminalAgentStart('t1')!.turned).toBeUndefined()
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
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(typeof key).toBe('string')
    noteTypedInput('t1', 'claude --model sonnet --continue\r', clock, key)
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

describe('R4: an old limit the CLI redraws is no new stop (round 1)', () => {
  const OLD = "You've hit your session limit · resets 3pm (America/New_York)"
  const NEWER = "You've hit your weekly limit · resets Nov 3, 9am (America/New_York)"
  const limitScreen = (words: string, prompt = 'Build the login page.') => paint([`❯ ${prompt}`, `  ⎿  ${words}`, '', RULE, '❯ ', RULE])
  const lookNow = (): Promise<LimitLook> => ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })

  /** A relaunch or a resume: the conversation's last message, an old limit, is on screen and no prompt was entered. */
  async function resumed(): Promise<void> {
    await launch('claude')
    term.mode = 'agent'
    term.out += term.frame()
    term.out += limitScreen(OLD)
  }

  it('a pasted block of lines (bracketed paste) is text in the box, not Enters: no turn', async () => {
    await resumed()
    noteTypedInput('t1', `${E}[200~first line of a note\rsecond line of a note${E}[201~`, clock)
    const l = await lookNow()
    expect(l).toMatchObject({ live: true, turned: false, words: OLD })
    expect(terminalAgentStart('t1')!.turned).toBeUndefined()
  })

  it("a pasted line is held for the Enter the user sends, and its line breaks read as ';' like a shell takes them", async () => {
    await launch('claude')
    noteTypedInput('t1', `${E}[200~export CLAUDE_CONFIG_DIR=/x/.claude-b\r${E}[201~`, clock)
    // Nothing was entered by the paste: the line waits, whole, for the Enter.
    expect(isAccountChangedByHand('t1')).toBe(false)
    noteTypedInput('t1', '\r', clock)
    expect(isAccountChangedByHand('t1')).toBe(true)
  })

  it('an unfinished paste (its end marker never came) is text to the end of what was written', async () => {
    await launch('claude')
    noteTypedInput('t1', `${E}[200~export CLAUDE_CONFIG_DIR=/x/.claude-c\r`, clock)
    expect(isAccountChangedByHand('t1')).toBe(false)
    noteTypedInput('t1', '\r', clock)
    expect(isAccountChangedByHand('t1')).toBe(true)
  })

  it('Shift+Enter (Esc then Enter) is a new line in the box, not a submit', async () => {
    await resumed()
    noteTypedInput('t1', 'the first line of a two line prompt', clock)
    noteTypedInput('t1', `${E}\r`, clock)
    expect((await lookNow()).turned).toBe(false)
    expect(terminalAgentStart('t1')!.turned).toBeUndefined()
  })

  it('the Enter that then sends it is the turn, but the old limit above the box is not this turn\'s answer', async () => {
    await resumed()
    noteTypedInput('t1', 'the first line of a two line prompt', clock)
    noteTypedInput('t1', `${E}\r`, clock)
    noteTypedInput('t1', 'and the second\r', clock)
    expect(terminalAgentStart('t1')!.turned).toBe(true)
    // The CLI has not redrawn yet: the old limit is still above the box, printed before the Enter.
    const before = await lookNow()
    expect(before).toMatchObject({ live: true, turned: false, words: OLD })
    // Its answer is a limit, printed after: that one is a stop.
    term.out += limitScreen(NEWER, 'and the second')
    expect(await lookNow()).toMatchObject({ turned: true, words: NEWER })
  })

  it('the same words printed again after the turn are a stop: the account ran out here too', async () => {
    await resumed()
    noteTypedInput('t1', 'continue\r', clock)
    expect((await lookNow()).turned).toBe(false)
    term.out += limitScreen(OLD, 'continue')
    expect(await lookNow()).toMatchObject({ turned: true, words: OLD })
  })

  it('a turn seen at work (not typed here) counts from the look that saw it', async () => {
    await resumed()
    term.out += paint(['❯ continue', '✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ ', RULE])
    const working = await lookNow()
    expect(working.turned).toBe(true)
    expect(terminalAgentStart('t1')!.turnedAt).toBe(term.out.length)
    // The old limit redrawn above the box after that is not printed since the turn began: ... unless it is.
    term.out += limitScreen(NEWER, 'continue')
    expect(await lookNow()).toMatchObject({ turned: true, words: NEWER })
  })

  it('/resume typed inside the agent starts over: no turn until a prompt is entered on the conversation it shows', async () => {
    await launch('claude')
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'an earlier prompt\r', clock)
    expect(terminalAgentStart('t1')!.turned).toBe(true)
    // /resume picks a conversation whose last message is an old limit, and the CLI draws it.
    noteTypedInput('t1', '/resume\r', clock)
    term.out += limitScreen(OLD)
    const l = await lookNow()
    expect(l).toMatchObject({ live: true, turned: false, words: OLD })
    expect(terminalAgentStart('t1')!.turned).toBe(false)
    // A prompt entered on it is a turn again.
    noteTypedInput('t1', 'go on\r', clock)
    expect(terminalAgentStart('t1')!.turned).toBe(true)
    term.out += limitScreen(NEWER, 'go on')
    expect(await lookNow()).toMatchObject({ turned: true, words: NEWER })
  })

  it('/continue does the same, and any other slash command leaves the turn alone', async () => {
    await launch('claude')
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'an earlier prompt\r', clock)
    noteTypedInput('t1', '/model\r', clock)
    expect(terminalAgentStart('t1')!.turned).toBe(true)
    noteTypedInput('t1', '/continue\r', clock)
    expect(terminalAgentStart('t1')!.turned).toBe(false)
  })

  it('/resume typed at an agent that has exited changes nothing', async () => {
    await launch('claude')
    terminalAgentStart('t1')!.ended = true
    noteTypedInput('t1', '/resume\r', clock)
    expect(terminalAgentStart('t1')!.turned).toBeUndefined()
  })
})

describe('R15: an account benched before an agent started on it, whose agent then answers a prompt, is not out of usage (round 1)', () => {
  const WORDS = "You've hit your session limit · resets 3pm (America/New_York)"
  const WORKING = ['❯ continue', '✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ ', RULE]

  /** A registered account, the terminal's agent started on it at `clock`, and a prompt entered. */
  async function onAccount(): Promise<string> {
    const added = await ok<{ account: { id: string } }>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', email: 'g@example.test' })
    return added.account.id
  }
  const limitOf = async (id: string): Promise<unknown> => (await ok<{ accounts: Array<{ id: string; limit?: unknown }> }>(ACCOUNTS_IPC.list)).accounts.find((a) => a.id === id)?.limit
  const lookNow = (): Promise<LimitLook> => ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })

  async function started(id: string): Promise<void> {
    await launch('claude')
    noteTerminalAccount('t1', id)
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'continue\r', clock)
  }

  it('lifts the limit that was recorded before the agent started, once the agent is seen at work on a turn', async () => {
    const id = await onAccount()
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    expect(await limitOf(id)).toBeDefined()
    clock += 60_000
    await started(id)
    term.out += paint(WORKING)
    expect((await lookNow()).turned).toBe(true)
    expect(await limitOf(id)).toBeUndefined()
  })

  // CHOOSER-R1-5 (H06): an agent that is gone cannot have answered a prompt, whatever the frame it left shows.
  it('lifts nothing for an agent that is gone, though the last frame it left shows it at work', async () => {
    const id = await onAccount()
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    clock += 60_000
    await started(id)
    term.out += paint(WORKING)
    // Killed mid-turn: the shell's prompt is drawn under the frame it left.
    term.mode = 'shell'
    term.out += term.prompt()
    const seen = await lookNow()
    expect(seen.live).toBe(false)
    expect(await limitOf(id)).toBeDefined()
  })

  it('keeps a limit recorded after the agent started, and one while the agent is not at work', async () => {
    const id = await onAccount()
    clock += 60_000
    await started(id)
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    clock += 1000
    term.out += paint(WORKING)
    await lookNow()
    expect(await limitOf(id)).toBeDefined()
    // Not at work: a screen that shows only the box.
    const other = await ok<{ account: { id: string } }>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'h', email: 'h@example.test' })
    await ok(ACCOUNTS_IPC.noteLimit, { id: other.account.id, text: WORDS, window: 'weekly' })
    clock += 60_000
    noteTerminalAccount('t1', other.account.id)
    noteAgentStart('t1', { at: term.out.length, commands: ['claude'], agent: 'claude' }, clock)
    noteTypedInput('t1', 'continue\r', clock)
    term.out += paint(['❯ ', RULE, '❯ ', RULE])
    await lookNow()
    expect(await limitOf(other.account.id)).toBeDefined()
  })

  it('lifts it once per start, and leaves a limit of another account alone', async () => {
    const id = await onAccount()
    const other = await ok<{ account: { id: string } }>(ACCOUNTS_IPC.add, { agent: 'agy', label: 'h', email: 'h@example.test' })
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    await ok(ACCOUNTS_IPC.noteLimit, { id: other.account.id, text: WORDS, window: 'weekly' })
    clock += 60_000
    await started(id)
    term.out += paint(WORKING)
    await lookNow()
    expect(await limitOf(id)).toBeUndefined()
    expect(await limitOf(other.account.id)).toBeDefined()
    // Recorded again meanwhile (another terminal hit it): this start does not lift it a second time.
    clock += 1000
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    term.out += paint(WORKING)
    await lookNow()
    expect(await limitOf(id)).toBeDefined()
  })

  it('does nothing for a terminal on no account, or an agent that is not live', async () => {
    const id = await onAccount()
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    clock += 60_000
    await launch('claude')
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'continue\r', clock)
    term.out += paint(WORKING)
    await lookNow()
    expect(await limitOf(id)).toBeDefined()
  })

  it('lifts nothing it cannot read: an unreadable registry is left as it is, and the look still answers', async () => {
    const id = await onAccount()
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    const file = join(sb.paths.userData, 'agent-accounts.json')
    const good = readFileSync(file, 'utf8')
    clock += 60_000
    await started(id)
    term.out += paint(WORKING)
    writeFileSync(file, '{ not json')
    expect((await lookNow()).turned).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    writeFileSync(file, good)
    expect(await limitOf(id)).toBeDefined()
  })

  it("lifts nothing when it doesn't know when the agent started: a limit is no older than a start nobody dated", async () => {
    const id = await onAccount()
    await ok(ACCOUNTS_IPC.noteLimit, { id, text: WORDS, window: 'weekly' })
    clock += 60_000
    await started(id)
    delete terminalAgentStart('t1')!.time
    term.out += paint(WORKING)
    expect((await lookNow()).turned).toBe(true)
    expect(await limitOf(id)).toBeDefined()
  })
})

// CHOOSER-R1-1: the launch line of an agent, pasted into a shell as copied from a README (a trailing newline), is
// text in the box until the user's Enter, and its line breaks read as ';'. A trailing or empty line adds nothing:
// "claude;" is not a launch, and the chooser would never watch the agent that really runs.
describe('a launch line pasted into a shell, then Enter', () => {
  it.each([
    ['claude', 'claude', 'claude'],
    ['claude\n', 'claude', 'claude'],
    ['cd proj\nclaude\n', 'claude', 'claude'],
    ['cd proj\rclaude\r', 'claude', 'claude'],
    ['claude --resume abc\r\n\r\n', 'claude', 'claude'],
    ['\n\ncodex -m gpt-5.6-sol\n', 'codex', 'codex'],
  ])('%j starts a record for %s', (text, _agent, expected) => {
    noteTypedInput('t1', `${E}[200~${text}${E}[201~`, clock)
    // Nothing was entered by the paste: no record until the user's Enter.
    expect(terminalAgentStart('t1')).toBeUndefined()
    noteTypedInput('t1', '\r', clock)
    expect(terminalAgentStart('t1')?.agent).toBe(expected)
  })

  it('does not read a pasted note that only mentions the agent as a launch', () => {
    noteTypedInput('t1', `${E}[200~please run claude now\n${E}[201~\r`, clock)
    expect(terminalAgentStart('t1')).toBeUndefined()
  })
})

describe('how the keys of one write are gathered into lines (CHOOSER-R1-5)', () => {
  // CHOOSER-R1-5 (G02, G03, G05, G07, G08): how a write's keys are gathered into a line.
  it.each([
    ['a paste and the Enter in one write', `${E}[200~foo bar${E}[201~\r`, 'foo bar'],
    ['a paste, then keys after its end marker, then Enter', `${E}[200~foo${E}[201~ bar\r`, 'foo bar'],
    ['Esc then LF (Shift+Enter) is a space in the line, not a submit', `foo${E}\nbar\r`, 'foo bar'],
    ['control characters in a paste are left out', `${E}[200~fo\x01\x02o\x1b bar${E}[201~\r`, 'foo bar'],
    ['a paste\'s line breaks read as ";"', `${E}[200~one\ntwo${E}[201~\r`, 'one; two'],
    // F-R2-4: Ctrl+C and Ctrl+U clear the line a shell is reading, as the keys do there, and what is typed after is the line.
    ['Ctrl+C clears the line typed so far', 'foo\x03bar\r', 'bar'],
    ['Ctrl+U clears the line typed so far', 'foo\x15bar\r', 'bar'],
    ['Backspace takes the last character off', 'fooo\x7f\r', 'foo'],
  ])('%s', (_what, written, expected) => {
    const lines: string[] = []
    _gatherLinesForTest('t9', written, (l) => lines.push(l))
    expect(lines).toEqual([expected])
  })

  // F-R2-4: a line is kept to 4096 characters. A longer one is a paste or a runaway, whose first 4096 are the line (the rest is
  // not held, so a flood of typed text costs a terminal no more than that), and what is typed after it still reaches its Enter.
  it('keeps no more than 4096 characters of a line, and still ends it at its Enter', () => {
    const lines: string[] = []
    _gatherLinesForTest('t8', `${'a'.repeat(5000)}\r`, (l) => lines.push(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(4096)
    expect(lines[0]).toBe('a'.repeat(4096))
    _gatherLinesForTest('t8', `${'b'.repeat(4096)}c\r`, (l) => lines.push(l))
    expect(lines[1]).toBe('b'.repeat(4096))
  })

  it('keeps no more than 4096 characters of a line typed across several writes', () => {
    const lines: string[] = []
    for (let i = 0; i < 5; i++) _gatherLinesForTest('t7', 'x'.repeat(1000), (l) => lines.push(l))
    _gatherLinesForTest('t7', 'x'.repeat(1000) + '\r', (l) => lines.push(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(4096)
  })
})

// F-R2-2: main keeps the screen of a terminal an agent runs in (terminalOutputBuffer.ts watchScreen), since a
// replay of its 32 KB window loses the input box Claude Code paints once. Every start it records asks for that.
describe('a terminal an agent was started in has its screen kept (F-R2-2)', () => {
  const baseIO = (): AccountsIpcDeps['switchIO'] => ({
    output: (id) => term.io().output(id),
    outputFrom: (id, from) => term.io().outputFrom(id, from),
    end: (id) => term.io().end(id),
    size: () => ({ cols: 80, rows: 24 }),
    write: (id, data) => term.io().write(id, data),
    sleep: (ms) => term.io().sleep(ms),
    now: () => clock,
  })
  const watching = (watch: (id: string) => void): void => register({ switchIO: { ...baseIO()!, watch } })

  it('on a launch line of Termpolis\'s own', async () => {
    const watched: string[] = []
    watching((id) => { watched.push(id) })
    await launch('claude')
    expect(watched).toEqual(['t1'])
  })

  it('on an agent typed by hand at a shell', () => {
    const watched: string[] = []
    watching((id) => { watched.push(id) })
    noteTypedInput('t2', 'codex\r', clock)
    expect(watched).toEqual(['t2'])
  })

  it('on a swarm worker\'s agent, as run_command typed it', () => {
    const watched: string[] = []
    watching((id) => { watched.push(id) })
    noteSwarmWorker('w1')
    noteWorkerCommand('w1', 'claude --dangerously-skip-permissions')
    expect(watched).toEqual(['w1'])
  })

  it('on the relaunch of a switch', () => {
    const watched: string[] = []
    watching((id) => { watched.push(id) })
    noteAgentStart('t1', { at: 0, commands: ['claude --resume x'], agent: 'claude' })
    expect(watched).toEqual(['t1'])
  })

  it('and never because of a line that starts no agent', () => {
    const watched: string[] = []
    watching((id) => { watched.push(id) })
    noteTypedInput('t1', 'npm test\r', clock)
    expect(watched).toEqual([])
    expect(terminalAgentStart('t1')).toBeUndefined()
  })

  it('and a terminal that cannot keep one still has its start recorded', () => {
    watching(() => { throw new Error('no such terminal') })
    expect(() => noteTypedInput('t1', 'claude\r', clock)).not.toThrow()
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude' })
  })
})
