// The model menu (v1.54.4) and the account switcher move the same agent in the same terminal, so each
// has to carry the other's choice: an account switch keeps the model the menu picked, and a model
// change keeps the account the switch chose. They meet in main's record of what started the agent
// (accountsIpc.ts): the line the menu types under its hold's key becomes that record, and the
// switch relaunches from it. The shell keeps the account's variable, so the menu's bare relaunch
// stays on the account without typing it again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  _resetTerminalAccountsForTest, isAccountChangedByHand, noteAgentStart, noteTerminalAccount, noteTypedInput, registerAccountsIpc,
  terminalAccountId, terminalAgentStart,
} from '../../src/main/accountsIpc'
import { _resetSwitchLocksForTest } from '../../src/main/accountSwitch'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AddAccountResult } from '../../src/shared/agentAccounts'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import { loadAccounts } from '../../src/main/agentAccounts'
import { createSandbox, writeJson } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import { FakeTerminal, ID } from './_switchTerminal'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let sent: Array<{ channel: string; payload: any }>
let term: FakeTerminal
/** Where main's buffer ends when a line is entered: where the agent was launched, unless a test types later. */
let outputEndAt: () => number = () => term.launchedAt

function register(): void {
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
    outputEnd: () => outputEndAt(),
    switchIO: {
      output: (id) => term.io().output(id),
      outputFrom: (id, from) => term.io().outputFrom(id, from),
      end: (id) => term.io().end(id),
      size: () => ({ cols: 80, rows: 24 }),
      write: (id, data) => term.io().write(id, data),
      sleep: (ms) => term.io().sleep(ms),
      now: () => term.clock,
    },
  })
}

async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

/** The default Claude profile and a second one, nothing shared. */
async function twoClaude(): Promise<{ main: string; b: string; bDir: string }> {
  mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
  writeJson(sb.paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' } })
  const r = await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share: [] })
  const doc = loadAccounts(sb.paths.userData)
  if (!doc.ok) throw new Error(doc.error)
  return { main: doc.doc.file.accounts.find((a) => a.agent === 'claude' && a.profile === null)!.id, b: r.account.id, bDir: r.account.profile! }
}

const switchTo = (targetId: string): Promise<SwitchOutcome> => ok<SwitchOutcome>(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId, shellType: 'gitbash' })
const MENU_LINE = `claude --dangerously-skip-permissions --model sonnet --resume ${ID}`

beforeEach(() => {
  sb = createSandbox()
  sent = []
  outputEndAt = () => term.launchedAt
  _resetTerminalAccountsForTest()
  _resetSwitchLocksForTest()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  _resetTerminalAccountsForTest()
  sb.dispose()
})

describe('the model menu and the account switch carry each other\'s choice', () => {
  it('an account switch relaunches on the model the menu picked, not the one the terminal was launched with', async () => {
    // The agent is up again from the menu's relaunch: that line is what started it now.
    term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', launch: MENU_LINE })
    register()
    const { main, b, bDir } = await twoClaude()
    noteTerminalAccount('t1', main)
    noteAgentStart('t1', { at: 0, commands: ['claude --dangerously-skip-permissions --model opus --session-id ' + ID] })
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(noteTypedInput('t1', `${MENU_LINE}\r`, 43, key)).toBe('own')
    await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1', key })

    expect(await switchTo(b)).toMatchObject({ kind: 'switched', resumed: true, sessionId: ID })
    expect(term.ran).toContain(`export CLAUDE_CONFIG_DIR='${bDir}' && claude --model sonnet --dangerously-skip-permissions --resume ${ID}`)
    expect(terminalAccountId('t1')).toBe(b)
  })

  it('a model change after an account switch leaves the account alone, and the next switch still has the picked model', async () => {
    term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', launch: 'claude --model opus --session-id ' + ID })
    register()
    const { main, b, bDir } = await twoClaude()
    noteTerminalAccount('t1', main)
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    expect(await switchTo(b)).toMatchObject({ kind: 'switched', resumed: true })
    expect(terminalAccountId('t1')).toBe(b)
    sent.length = 0
    outputEndAt = () => term.out.length

    // The menu changes the model on b: its line neither sets nor unsets the account...
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(noteTypedInput('t1', `claude --model sonnet --resume ${ID}\r`, 44, key)).toBe('own')
    await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1', key })
    expect(terminalAccountId('t1')).toBe(b)
    expect(isAccountChangedByHand('t1')).toBe(false)
    expect(sent.filter((s) => s.channel === ACCOUNTS_IPC.terminalAccount)).toEqual([])
    expect(terminalAgentStart('t1')!.commands).toEqual([`claude --model sonnet --resume ${ID}`])

    // ...and the switch back keeps the picked model, on the main profile (its variable unset).
    expect(await switchTo(main)).toMatchObject({ kind: 'switched', resumed: true })
    expect(term.ran[term.ran.length - 1]).toMatch(/^unset CLAUDE_CONFIG_DIR && claude --model sonnet --resume [0-9a-f-]{36}$/)
    expect(bDir).toBeTruthy()
  })

  it('an account switch refuses while the menu holds the terminal, and types nothing', async () => {
    term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint' })
    register()
    const { main, b } = await twoClaude()
    noteTerminalAccount('t1', main)
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'x.txt'), 'x')
    const { key } = await ok<{ key: string }>(ACCOUNTS_IPC.modelHold, { terminalId: 't1' })
    expect(await switchTo(b)).toEqual({ kind: 'refused', why: 'a switch is already running in this terminal' })
    expect(term.writes).toEqual([])
    await ok(ACCOUNTS_IPC.modelRelease, { terminalId: 't1', key })
    expect(await switchTo(b)).toMatchObject({ kind: 'switched' })
  })
})
