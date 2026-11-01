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

  it('marks the target\'s sign-in expired when the relaunch lands on its sign-in screen (§7.2 step 10)', async () => {
    const { main, b } = await twoClaude()
    noteTerminalAccount('t1', main)
    term = new FakeTerminal(claude({ relaunch: ['sign-in'] }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await switchTo(b)).toEqual({ kind: 'sign-in' })
    const doc = loadAccounts(sb.paths.userData)
    expect(doc.ok && doc.doc.file.identity[b]).toEqual({ email: null, signedIn: false, checkedAt: 42, source: 'sign-in-screen' })
    expect(doc.ok && doc.doc.file.identity[main]).toBeUndefined()
    // Its row in the view says so.
    const view = await ok<{ accounts: Array<{ id: string; identity?: { source: string } }> }>(ACCOUNTS_IPC.list)
    expect(view.accounts.find((a) => a.id === b)!.identity!.source).toBe('sign-in-screen')
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
    expect(await fails(ACCOUNTS_IPC.agySwitch, { targetId: g2, step: 'exit' })).toBe('which terminal?')
    // No shell named: the step refuses before typing anything.
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, step: 'exit' })).toEqual({ kind: 'refused', why: 'Termpolis can' + "'" + 't type into this terminal' + "'" + 's shell' })
    // The old guided steps, which typed agy's sign-in into the user's terminal, are gone.
    for (const step of ['sign-out', 'login', 'check', 'jump']) expect(await fails(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, step })).toBe('unknown step')
    expect(await fails(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: b, step: 'exit' })).toBe('b is not an Antigravity CLI account')
    register({ switchIO: undefined })
    expect(await fails(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, step: 'exit' })).toBe('switching accounts isn\'t available')
  })

  it('exits agy with main\'s records, and records a resumed terminal on the account it moved to', async () => {
    const { g1, g2 } = await agyAccounts()
    term = new FakeTerminal({ agent: 'agy', family: 'posix', start: 'idle', exit: 'hint', email: 'work@example.test' })
    noteTerminalAccount('t1', g1)
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    const out = await ok<any>(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'exit' })
    expect(out).toEqual({ kind: 'exited', conversationId: ID })
    expect(terminalAccountId('t1')).toBe(g1)
    const done = await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'resume', conversationId: out.conversationId })
    expect(done).toEqual({ kind: 'resumed', fresh: false, conversationId: ID, shownEmail: 'work@example.test' })
    expect(terminalAccountId('t1')).toBe(g2)
    expect(terminalAgentStart('t1')!.commands).toEqual([`agy --conversation=${ID}`])
    expect(sent.filter((x) => x.channel === ACCOUNTS_IPC.terminalAccount).map((x) => x.payload)).toEqual([{ terminalId: 't1', accountId: g2, byHand: false }])
  })

  it('takes the user\'s word that agy exited, and no conversation that isn\'t an id', async () => {
    const { g2 } = await agyAccounts()
    term = new FakeTerminal({ agent: 'agy', family: 'posix', start: 'gone-quiet', exit: 'hint' })
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'exit', assumeExited: true })).toEqual({ kind: 'exited', conversationId: null })
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'resume', conversationId: 'not-an-id', assumeExited: 'yes' }))
      .toEqual(expect.objectContaining({ kind: 'resumed', fresh: true, conversationId: null }))
  })

  it('records nothing for a resume that didn\'t come back', async () => {
    const { g1, g2 } = await agyAccounts()
    term = new FakeTerminal({ agent: 'agy', family: 'posix', start: 'gone-quiet', exit: 'hint', relaunch: ['sign-in'] })
    noteTerminalAccount('t1', g1)
    expect(await ok(ACCOUNTS_IPC.agySwitch, { terminalId: 't1', targetId: g2, shellType: 'gitbash', step: 'resume', conversationId: ID })).toEqual(expect.objectContaining({ kind: 'not-resumed' }))
    expect(terminalAccountId('t1')).toBe(g1)
  })
})

describe('accounts:model-hold and accounts:model-release (§7.5)', () => {
  const HELD = 'an account switch or another model change is running in this terminal'
  const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

  it('needs a terminal, and asks for nothing else: what the picker types is only known once the agent has exited', async () => {
    expect(await fails(ACCOUNTS_IPC.modelHold, {})).toBe('which terminal?')
    expect(await fails(ACCOUNTS_IPC.modelHold, { terminalId: 7 })).toBe('which terminal?')
    // Nothing was held by either; a line sent along is not asked for and not looked at.
    expect((await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1', line: 'export CLAUDE_CONFIG_DIR=/x && claude' })).key).toBeTruthy()
  })

  it('holds the terminal once, counts what is typed under the hold as the agent\'s start, and lets go only for its key', async () => {
    register({ outputEnd: () => 99 })
    const { main, b } = await twoClaude()
    noteTerminalAccount('t1', main)
    noteAgentStart('t1', { at: 3, commands: ['claude --model haiku'] })
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(await fails(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })).toBe(HELD)
    // A switch waits for it too, typing nothing.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await switchTo(b)).toEqual({ kind: 'refused', why: 'a switch is already running in this terminal' })
    expect(term.writes).toEqual([])
    log.mockRestore()
    // The picker's line, as typed under its key: the agent's start is now there, and it reads as
    // Termpolis's own, though nothing registered it beforehand (the exit chose it).
    expect(noteTypedInput('t1', `claude --model opus --resume ${SID}\r`, 43, key)).toBe('own')
    expect(terminalAgentStart('t1')).toEqual({ at: 99, commands: [`claude --model opus --resume ${SID}`], agent: 'claude', time: 43 })
    expect(terminalAccountId('t1')).toBe(main)
    expect(await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1', key: 'not-its-key' })).toBe(true)
    expect(await fails(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })).toBe(HELD)
    expect(await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1', key })).toBe(true)
    // Again, or with half a request: nothing to let go, and no error.
    expect(await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1', key })).toBe(true)
    expect(await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1' })).toBe(true)
    expect(await ok(ACCOUNTS_IPC.modelRelease, { key })).toBe(true)
    expect((await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })).key).not.toBe(key)
  })

  it('takes a line typed without the hold\'s key, or after it was let go, for any other typed line', async () => {
    register({ outputEnd: () => 99 })
    noteAgentStart('t1', { at: 3, commands: ['claude --model haiku'] })
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(noteTypedInput('t1', `claude --model opus --resume ${SID}\r`, 43, 'not-its-key')).toBeNull()
    expect(noteTypedInput('t1', `claude --model opus --resume ${SID}\r`, 43)).toBeNull()
    // A line that is not an agent's start is not the agent's start, key or not.
    expect(noteTypedInput('t1', 'ls -la\r', 43, key)).toBeNull()
    expect(terminalAgentStart('t1')?.commands).toEqual(['claude --model haiku'])
    await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1', key })
    expect(noteTypedInput('t1', `claude --model opus --resume ${SID}\r`, 44, key)).toBeNull()
  })

  it('follows the Claude Code session through what the picker types: the one it resumed, none for a new or an unnamed one', async () => {
    register({ outputEnd: () => 99 })
    noteTerminalSession('t1', 'launch-session')
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(noteTypedInput('t1', `claude --dangerously-skip-permissions --model opus --resume ${SID}\r`, 43, key)).toBe('own')
    expect(terminalSessionId('t1')).toBe(SID)
    // A new session (the exit named none), or "the latest": the launch's id no longer names it.
    expect(noteTypedInput('t1', 'claude --model opus\r', 44, key)).toBe('own')
    expect(terminalSessionId('t1')).toBeUndefined()
    noteTerminalSession('t1', SID)
    expect(noteTypedInput('t1', 'claude --model opus --continue\r', 45, key)).toBe('own')
    expect(terminalSessionId('t1')).toBeUndefined()
    // Codex and agy keep no session id of Termpolis's: whatever it was is left alone.
    noteTerminalSession('t1', SID)
    expect(noteTypedInput('t1', `codex --model gpt-5.6-sol resume ${SID}\r`, 46, key)).toBe('own')
    expect(noteTypedInput('t1', `agy --model gemini-3.8-flash-high --conversation=${SID}\r`, 47, key)).toBe('own')
    expect(terminalSessionId('t1')).toBe(SID)
  })

  it('keeps the launch\'s own line beside the picker\'s: either one, typed, is Termpolis\'s own', async () => {
    const { b } = await twoClaude()
    const launch = await ok<{ line: string }>(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', command: 'claude', shellType: 'gitbash', accountId: b })
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    // The launch's line sets CLAUDE_CONFIG_DIR: were it forgotten, typing it would read as a change by hand.
    expect(noteTypedInput('t1', `${launch.line}\r`, 43)).toBe('own')
    expect(noteTypedInput('t1', `claude --model opus --resume ${SID}\r`, 44, key)).toBe('own')
    expect(sent.filter((s) => s.channel === ACCOUNTS_IPC.terminalAccount)).toEqual([])
  })

  it('still marks a line typed under the hold that changes the account for what it is: a change by hand', async () => {
    // The picker never types one (its flags are plain words), but a hold's key opens no door for it.
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(noteTypedInput('t1', 'export CLAUDE_CONFIG_DIR=/x && claude --model opus\r', 43, key)).toBe('by-hand')
    expect(sent.filter((s) => s.channel === ACCOUNTS_IPC.terminalAccount)).toHaveLength(1)
  })
})

describe('accounts:switch, an account that isn\'t offered automatically (D14, R17)', () => {
  /** The default account and a second one the user marked "Offer automatically" off, as work is. */
  async function withWork(): Promise<{ main: string; work: string; workDir: string }> {
    const { main, b, bDir } = await twoClaude()
    await ok(ACCOUNTS_IPC.update, { id: b, autoOffer: false })
    return { main, work: b, workDir: bDir }
  }
  function aConversation(): void {
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    noteTerminalSession('t1', ID)
    mkdirSync(join(sb.paths.claudeDir, 'projects', 'C--repo'), { recursive: true })
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'C--repo', `${ID}.jsonl`), '{}\n')
  }

  it('refuses a switch onto it that holds no second confirmation, and types nothing', async () => {
    const { main, work } = await withWork()
    noteTerminalAccount('t1', main)
    aConversation()
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: work, shellType: 'gitbash' }))
      .toBe('b isn\'t offered automatically, so switching a conversation to or from it needs your confirmation')
    // Anything but a true is no confirmation.
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: work, shellType: 'gitbash', confirmedCarry: 'yes' })).toMatch(/isn't offered automatically/)
    expect(term.writes).toEqual([])
    expect(terminalAccountId('t1')).toBe(main)
  })

  it('refuses a switch carrying a conversation off it that holds no second confirmation, and types nothing', async () => {
    const { main, work } = await withWork()
    noteTerminalAccount('t1', work)
    aConversation()
    expect(await fails(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: main, shellType: 'gitbash' }))
      .toBe('b isn\'t offered automatically, so switching a conversation to or from it needs your confirmation')
    expect(term.writes).toEqual([])
    expect(terminalAccountId('t1')).toBe(work)
  })

  it('goes ahead when the request carries the confirmation, onto it and off it', async () => {
    const { main, work } = await withWork()
    noteTerminalAccount('t1', main)
    aConversation()
    const onto = await switchTo(work, { confirmedCarry: true })
    expect(onto.kind).toBe('switched')
    expect(terminalAccountId('t1')).toBe(work)
    term = new FakeTerminal(claude())
    register()
    noteTerminalAccount('t1', work)
    aConversation()
    const off = await switchTo(main, { confirmedCarry: true })
    expect(off.kind).toBe('switched')
    expect(terminalAccountId('t1')).toBe(main)
  })

  it('asks nothing of a switch between accounts that are offered automatically', async () => {
    const { main, b } = await twoClaude()
    noteTerminalAccount('t1', main)
    aConversation()
    expect((await switchTo(b)).kind).toBe('switched')
  })
})

describe('accounts:switch, what the agent was started with comes back with it (carryForSwitch)', () => {
  /** A terminal on the default account whose agent was started with `line`, on a conversation. */
  async function startedWith(line: string): Promise<{ main: string; b: string }> {
    const { main, b } = await twoClaude()
    noteTerminalAccount('t1', main)
    noteAgentStart('t1', { at: term.launchedAt, commands: [line] })
    noteTerminalSession('t1', ID)
    mkdirSync(join(sb.paths.claudeDir, 'projects', 'C--repo'), { recursive: true })
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'C--repo', `${ID}.jsonl`), '{}\n')
    return { main, b }
  }

  it('repeats the permission mode, the denied tools, the added folder and the model, in the order they were given', async () => {
    const { b } = await startedWith('claude --permission-mode plan --disallowedTools Bash --add-dir /srv/data --model sonnet')
    expect((await switchTo(b)).kind).toBe('switched')
    expect(term.ran[term.ran.length - 1]).toMatch(/&& claude --model sonnet --permission-mode plan --disallowedTools Bash --add-dir \/srv\/data --resume /)
  })

  it('repeats the flags of a line Termpolis typed with an account in front of it, and leaves its primer file out', async () => {
    const { b } = await startedWith(`export CLAUDE_CONFIG_DIR='/h/.claude' && claude --dangerously-skip-permissions --append-system-prompt-file "/p/primer.txt" --session-id ${ID}`)
    expect((await switchTo(b)).kind).toBe('switched')
    const typed = term.ran[term.ran.length - 1]
    expect(typed).toMatch(/&& claude --dangerously-skip-permissions --resume /)
    expect(typed).not.toContain('primer')
  })

  it('refuses a line it cannot repeat, before the agent is asked to exit: nothing is typed, and the terminal stays where it was', async () => {
    const { main, b } = await startedWith('claude --dangerously-skip-permissions "fix the login page"')
    const out = await switchTo(b)
    expect(out.kind).toBe('refused')
    expect((out as { why: string }).why).toMatch(/^Claude Code was started with options it cannot repeat/)
    expect(term.writes).toEqual([])
    expect(term.ran).toEqual([])
    expect(terminalAccountId('t1')).toBe(main)
  })

  it('keeps asking nothing of a terminal whose start was never recorded: the bare command, as before', async () => {
    const { b } = await twoClaude()
    noteTerminalAccount('t1', 'whoever')
    expect((await switchTo(b)).kind).toBe('switched')
    expect(term.ran[term.ran.length - 1]).toMatch(/&& claude(?: --resume \S+)?$/)
  })
})

describe('accounts:switch, a profile that routes Anthropic traffic itself (design 5.2)', () => {
  const typedLine = (): string => term.ran[term.ran.length - 1]

  async function profileWith(env: Record<string, string> | null): Promise<{ main: string; b: string }> {
    const { main, b, bDir } = await twoClaude()
    if (env) writeJson(join(bDir, 'settings.json'), { env })
    noteTerminalAccount('t1', main)
    return { main, b }
  }

  it('takes the compression proxy\'s variables out of the line, so the profile\'s own base URL is the one in force', async () => {
    const { b } = await profileWith({ ANTHROPIC_BASE_URL: 'https://gateway.example.test/v1' })
    expect((await switchTo(b)).kind).toBe('switched')
    expect(typedLine()).toMatch(/unset ANTHROPIC_BASE_URL TERMPOLIS_HEADROOM_PROXY && claude/)
  })

  it.each([
    ['an outbound proxy', { HTTPS_PROXY: 'http://proxy.example.test:3128' }],
    ['a cloud provider', { CLAUDE_CODE_USE_BEDROCK: '1' }],
  ])('also when the profile routes by %s', async (_name, env) => {
    const { b } = await profileWith(env)
    expect((await switchTo(b)).kind).toBe('switched')
    expect(typedLine()).toMatch(/unset ANTHROPIC_BASE_URL TERMPOLIS_HEADROOM_PROXY && claude/)
  })

  it('leaves the line alone for a profile that routes nothing itself', async () => {
    const { b } = await profileWith(null)
    expect((await switchTo(b)).kind).toBe('switched')
    expect(typedLine()).not.toContain('ANTHROPIC_BASE_URL')
    expect(typedLine()).not.toContain('TERMPOLIS_HEADROOM_PROXY')
  })
})
