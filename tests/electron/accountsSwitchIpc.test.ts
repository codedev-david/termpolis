// @vitest-environment node
//
// accounts:switch (src/main/accountsIpc.ts): what main checks before a switch, what it hands the
// switch (the terminal's own records, where the conversation's transcript can be and where the
// target looks for it), and what it records after. The switch itself runs for real, against the
// scripted terminal of _switchTerminal.ts, in the sandbox of accountsIpc.test.ts: a scratch home
// under TERMPOLIS_TEST_AGENT_HOME, never a real profile.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  _resetTerminalAccountsForTest, noteAgentStart, noteTerminalAccount, noteTerminalSession, noteTypedInput, registerAccountsIpc,
  terminalAccountId, terminalAgentStart, terminalSessionId,
} from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { _resetSwitchLocksForTest } from '../../src/main/accountSwitch'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AddAccountResult } from '../../src/shared/agentAccounts'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import { loadAccounts } from '../../src/main/agentAccounts'
import { createSandbox, writeJson } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import { FakeTerminal, ID } from './_switchTerminal'
import type { TermScript } from './_switchTerminal'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let sent: Array<{ channel: string; payload: any }>
let term: FakeTerminal

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

async function call<T = any>(channel: string, input?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
  return (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
}

async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = await call<T>(channel, input)
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

async function fails(channel: string, input?: unknown): Promise<string> {
  const r = await call(channel, input)
  if (r.success) throw new Error(`${channel} should have failed`)
  return r.error as string
}

const claude = (over: Partial<TermScript> = {}): TermScript => ({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', ...over })

beforeEach(() => {
  sb = createSandbox()
  sent = []
  term = new FakeTerminal(claude())
  _resetTerminalAccountsForTest()
  _resetSwitchLocksForTest()
  register()
})

afterEach(() => {
  _resetTerminalAccountsForTest()
  sb.dispose()
})

/** The default Claude profile and a second one with its own projects/ (nothing shared). */
async function twoClaude(share: string[] = []): Promise<{ main: string; b: string; bDir: string }> {
  mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
  writeJson(sb.paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' } })
  const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share })
  const doc = loadAccounts(sb.paths.userData)
  if (!doc.ok) throw new Error(doc.error)
  return { main: doc.doc.file.accounts.find((a) => a.agent === 'claude' && a.profile === null)!.id, b: r.account.id, bDir: r.account.profile! }
}

const switchTo = (targetId: string, over: Record<string, unknown> = {}): Promise<SwitchOutcome> =>
  ok<SwitchOutcome>(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId, shellType: 'gitbash', ...over })

describe('accounts:switch, before the switch', () => {
  it('needs main\'s terminals, a terminal, and a registered profile account of the terminal\'s agent', async () => {
    const { main, b } = await twoClaude()
    expect(await fails(ACCOUNTS_IPC.switchAccount, { targetId: b })).toBe('which terminal?')
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1' })).toBe("that account isn't registered any more")
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: 'acc_gone00000000' })).toBe('that account isn\'t registered any more')
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', email: 'g@example.test' })
    const g = loadAccounts(sb.paths.userData)
    const agyId = g.ok ? g.doc.file.accounts.find((a) => a.agent === 'agy')!.id : ''
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: agyId })).toBe('the Antigravity CLI switches through its own sign-in')
    noteTerminalAccount('t1', agyId)
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: b })).toBe('this terminal runs Gemini / Antigravity CLI, not Claude Code')
    noteTerminalAccount('t1', main)
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: main })).toBe('this terminal already runs on main')
    register({ switchIO: undefined })
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: b })).toBe('switching accounts isn\'t available')
  })

  it('refuses a target whose profile folder is gone', async () => {
    const { b, bDir } = await twoClaude()
    // Gone, as a folder can be: the registry still lists it. It holds no link (nothing shared).
    renameSync(bDir, `${bDir}-gone`)
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: b })).toBe('b\'s profile folder doesn\'t exist')
  })
})

describe('accounts:switch, the run', () => {
  it('switches with main\'s own records, carries the transcript to an unshared profile, and records the result', async () => {
    const { main, b, bDir } = await twoClaude()
    noteTerminalAccount('t1', main)
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    noteTerminalSession('t1', ID)
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'transcript-folder.txt'), 'x')
    mkdirSync(join(sb.paths.claudeDir, 'projects', 'C--repo'))
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'C--repo', `${ID}.jsonl`), '{}\n')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const outcome = await switchTo(b, { reason: 'usage limit', instructions: 42, stopBusy: true, fresh: 'yes' })
    expect(outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID, carried: true })
    expect(existsSync(join(bDir, 'projects', 'C--repo', `${ID}.jsonl`))).toBe(true)
    expect(terminalAccountId('t1')).toBe(b)
    expect(terminalSessionId('t1')).toBe(ID)
    expect(terminalAgentStart('t1')!.commands[0]).toBe(`export CLAUDE_CONFIG_DIR='${bDir}' && claude --model opus --resume ${ID}`)
    expect(sent).toContainEqual({ channel: ACCOUNTS_IPC.terminalAccount, payload: { terminalId: 't1', accountId: b, byHand: false } })
    expect(sent.filter((s) => s.channel === ACCOUNTS_IPC.switchProgress).map((s) => s.payload.step)).toEqual(['exiting', 'confirming', 'carrying', 'typing', 'waiting'])
    // Labels only, never an email.
    expect(log).toHaveBeenCalledWith('[accounts] switch of a Claude Code terminal from main to b (usage limit): switched')
    expect(JSON.stringify(log.mock.calls)).not.toContain('@')
    log.mockRestore()
  })

  it('says it kept the target\'s newer copy beside the one carried, and starts a new session with an id of its own when asked', async () => {
    const { main, b, bDir } = await twoClaude()
    noteTerminalAccount('t1', main)
    mkdirSync(join(sb.paths.claudeDir, 'projects', 'C--repo'))
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'C--repo', `${ID}.jsonl`), '{}\n')
    mkdirSync(join(bDir, 'projects', 'C--repo'), { recursive: true })
    writeFileSync(join(bDir, 'projects', 'C--repo', `${ID}.jsonl`), '{"a much longer copy":true}\n')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await switchTo(b)).toEqual({ kind: 'switched', resumed: true, sessionId: ID, carried: true, kept: `${ID}.jsonl.bak-42` })
    // Back to main, asking for a new session: an id of main's own making.
    term = new FakeTerminal(claude())
    const fresh = await switchTo(main, { fresh: true })
    expect(fresh).toEqual({ kind: 'fresh', why: 'asked' })
    expect(terminalSessionId('t1')).toMatch(/^[0-9a-f-]{36}$/)
    expect(terminalSessionId('t1')).not.toBe(ID)
    expect(term.ran[1]).toContain(`--session-id ${terminalSessionId('t1')}`)
    log.mockRestore()
  })

  it('refuses a terminal whose shell it wasn\'t told, typing nothing', async () => {
    const { b } = await twoClaude()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await ok(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: b })).toEqual({ kind: 'refused', why: 'Termpolis can\'t type an account line into this terminal\'s shell' })
    expect(term.writes).toEqual([])
    log.mockRestore()
  })

  it('carries nothing between profiles that share projects/', async () => {
    const { main, b } = await twoClaude(['projects'])
    noteTerminalAccount('t1', main)
    mkdirSync(join(sb.paths.claudeDir, 'projects', 'C--repo'))
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'C--repo', `${ID}.jsonl`), '{}\n')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await switchTo(b)).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    log.mockRestore()
  })

  it('looks for the transcript in every Claude Code profile when it doesn\'t know the terminal\'s, and resumes the session it started', async () => {
    const { b } = await twoClaude()
    term = new FakeTerminal(claude({ exit: 'no-hint' }))
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    noteTerminalSession('t1', ID)
    mkdirSync(join(sb.paths.claudeDir, 'projects', 'C--repo'))
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'C--repo', `${ID}.jsonl`), '{}\n')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await switchTo(b)).toEqual({ kind: 'switched', resumed: true, sessionId: ID, carried: true })
    expect(log).toHaveBeenCalledWith('[accounts] switch of a Claude Code terminal from an account Termpolis didn\'t know to b: switched')
    log.mockRestore()
  })

  it('switches a terminal changed by hand even to the account main last put it on', async () => {
    const { main } = await twoClaude()
    noteTerminalAccount('t1', main)
    noteTypedInput('t1', 'export CLAUDE_CONFIG_DIR=/x\r')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await switchTo(main)).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    // No start recorded for this terminal: no flags carried, and the default profile unset.
    expect(term.ran[1]).toBe(`unset CLAUDE_CONFIG_DIR && claude --resume ${ID}`)
    log.mockRestore()
  })

  it('switches a Codex terminal with the instruction the renderer prepared', async () => {
    mkdirSync(join(sb.paths.codexHome, 'sessions'), { recursive: true })
    const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cb', folder: 'new', copy: false })
    term = new FakeTerminal({ agent: 'codex', family: 'powershell', start: 'idle', exit: 'hint' })
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const outcome = await ok<SwitchOutcome>(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: r.account.id, shellType: 'powershell', instructions: 'Use the memory tools.' })
    expect(outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(term.ran[1]).toContain(`codex -m gpt-5.6-sol -c "developer_instructions='Use the memory tools.'" resume ${ID}`)
    // Codex's session id is not Claude Code's: none is recorded.
    expect(terminalSessionId('t1')).toBeUndefined()
    log.mockRestore()
  })
})

describe('accounts:agy-switch', () => {
  async function agyAccounts(): Promise<{ g1: string; g2: string }> {
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'home', email: 'home@example.test' })
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'work', email: 'work@example.test' })
    const doc = loadAccounts(sb.paths.userData)
    if (!doc.ok) throw new Error(doc.error)
    const [g1, g2] = doc.doc.file.accounts.filter((a) => a.agent === 'agy').map((a) => a.id)
    return { g1, g2 }
  }

  it('needs main\'s terminals, a terminal, a known step and an agy account', async () => {
    const { g2 } = await agyAccounts()
    const { b } = await twoClaude()
    expect(await fails(ACCOUNTS_IPC.agySwitch, { targetId: g2, step: 'check' })).toBe('which terminal?')
    // No shell named: only a typing step needs one, and refuses then.
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, step: 'sign-out' })).toEqual({ kind: 'refused', why: 'Termpolis can' + "'" + 't type into this terminal' + "'" + 's shell' })
    expect(await fails(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, step: 'jump' })).toBe('unknown step')
    expect(await fails(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: b, step: 'check' })).toBe('b is not an Antigravity CLI account')
    register({ switchIO: undefined })
    expect(await fails(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, step: 'check' })).toBe('switching accounts isn\'t available')
  })

  it('runs each step with main\'s records, and moves every agy terminal and new launches once agy is back', async () => {
    const { g1, g2 } = await agyAccounts()
    const { main } = await twoClaude()
    term = new FakeTerminal({ agent: 'agy', family: 'posix', start: 'idle', exit: 'hint' })
    noteTerminalAccount('t1', g1)
    noteTerminalAccount('t-other-agy', g1)
    noteTerminalAccount('t-claude', main)
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const out = await ok<any>(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'sign-out' })
    expect(out).toEqual({ kind: 'signing-in', conversationId: ID, mark: expect.any(Number) })
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'check', mark: out.mark })).toEqual({ kind: 'waiting' })
    term.completeSignIn('work@example.test')
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'check', mark: out.mark, conversationId: 'not-an-id', assumeExited: 'yes' })).toEqual({ kind: 'signed-in' })
    expect(terminalAccountId('t1')).toBe(g1)
    const done = await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'resume', conversationId: out.conversationId })
    expect(done).toEqual({ kind: 'switched', fresh: false, conversationId: ID, shownEmail: 'work@example.test' })
    expect(terminalAccountId('t1')).toBe(g2)
    expect(terminalAccountId('t-other-agy')).toBe(g2)
    expect(terminalAccountId('t-claude')).toBe(main)
    expect(terminalAgentStart('t1')!.commands).toEqual([`agy --conversation=${ID}`])
    const moved = sent.filter((s) => s.channel === ACCOUNTS_IPC.terminalAccount).map((s) => s.payload.terminalId).sort()
    expect(moved).toEqual(['t-other-agy', 't1'])
    const doc = loadAccounts(sb.paths.userData)
    expect(doc.ok && doc.doc.file.preferred.agy).toBe(g2)
    expect(log).toHaveBeenCalledWith('[accounts] agy moved to work: 2 terminals')
    log.mockRestore()
  })

  it('moves the one terminal it ran in, said in the singular, and ignores a bad mark', async () => {
    const { g2 } = await agyAccounts()
    term = new FakeTerminal({ agent: 'agy', family: 'posix', start: 'gone-quiet', exit: 'hint' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'resume', assumeExited: true, mark: -5 }))
      .toEqual(expect.objectContaining({ kind: 'switched', fresh: true }))
    expect(log).toHaveBeenCalledWith('[accounts] agy moved to work: 1 terminal')
    log.mockRestore()
  })
})
