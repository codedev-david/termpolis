// @vitest-environment node
//
// Round 4: what main reads from the writes a terminal gets (accountsIpc.ts gatherLines, noteLine) about the agent's start and the
// terminal's account. The terminal is the scripted one of _switchTerminal.ts, in the sandbox of accountsIpc.test.ts.
//
//   MODELS-R3-1  xterm.js's own reports (focus, the mouse, answers to queries) are no keys
//   SW3-6        a key that changes nothing in an empty line marks nothing
//   SAFETY-R3-1, MODELS-R3-3  a line the shell ran that the keys do not say (a recall, a completion)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  _gatherLinesForTest, _resetTerminalAccountsForTest, noteAgentStart, noteSwarmWorker, noteTerminalSession, noteTypedInput, noteWorkerCommand,
  registerAccountsIpc, terminalAgentStart, terminalSessionId,
} from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { _resetSwitchLocksForTest } from '../../src/main/accountSwitch'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import { createSandbox } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import { FakeTerminal } from './_switchTerminal'
import type { LimitLook } from '../../src/shared/accountLimits'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let term: FakeTerminal
let clock: number

const E = '\x1b'

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

async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
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

describe('what a terminal itself sends is no key (MODELS-R3-1)', () => {
  const REPLIES: Array<[string, string]> = [
    ['a focus-in report', `${E}[I`],
    ['a focus-out report', `${E}[O`],
    ['an SGR mouse press', `${E}[<0;10;5M`],
    ['an SGR mouse release', `${E}[<0;10;5m`],
    ['an SGR mouse wheel report', `${E}[<64;40;12M`],
    ['an X10 mouse report', `${E}[M !%`],
    ['a cursor position report', `${E}[12;40R`],
    ['a primary device attributes reply', `${E}[?1;2c`],
    ['a secondary device attributes reply', `${E}[>0;276;0c`],
    ['a status report', `${E}[0n`],
    ['a window size report', `${E}[8;24;80t`],
    ['a mode report', `${E}[?1004;1$y`],
    ['an OSC colour reply ended by ST', `${E}]11;rgb:1e1e/1e1e/1e1e${E}\\`],
    ['an OSC colour reply ended by BEL', `${E}]10;rgb:ffff/ffff/ffff\x07`],
    ['a DCS reply', `${E}P1$r0m${E}\\`],
    ['a paste end marker alone', `${E}[201~`],
  ]
  const LAUNCH = 'claude --dangerously-skip-permissions --model opus'

  it.each(REPLIES)('does not mark the next line edited, nor leave its text in it: %s', (_what, report) => {
    const seen: Array<[string, boolean]> = []
    _gatherLinesForTest('r1', `${report}${LAUNCH}\r`, (l, edited) => seen.push([l, edited]))
    expect(seen).toEqual([[LAUNCH, false]])
  })

  it.each(REPLIES)('nor one that comes in the middle of the line: %s', (_what, report) => {
    const seen: Array<[string, boolean]> = []
    _gatherLinesForTest('r2', `claude --dang${report}erously-skip-permissions\r`, (l, edited) => seen.push([l, edited]))
    expect(seen).toEqual([['claude --dangerously-skip-permissions', false]])
  })

  it('records a hand-typed launch whole after the reports ConPTY and a focus change bring', () => {
    noteTypedInput('t1', `${E}[O${E}[I${E}[12;40R${LAUNCH}\r`, clock)
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude', commands: [LAUNCH] })
    expect(terminalAgentStart('t1')?.unsure).toBeUndefined()
  })

  it('and after a mouse wheel report that came after the last Enter', () => {
    noteTypedInput('t1', `${E}[<64;40;12M${E}[<65;40;12M`, clock)
    noteTypedInput('t1', `${LAUNCH}\r`, clock)
    expect(terminalAgentStart('t1')).toMatchObject({ commands: [LAUNCH] })
    expect(terminalAgentStart('t1')?.unsure).toBeUndefined()
  })

  it('still reads Alt+] and Alt+Shift+P as keys, not as the start of a reply', () => {
    for (const key of [`${E}]`, `${E}P`]) {
      const seen: Array<[string, boolean]> = []
      _gatherLinesForTest('r3', `${key}claude\r`, (l, edited) => seen.push([l, edited]))
      expect(seen).toEqual([['claude', true]])
    }
  })
})

describe('a key that can change nothing in an empty line marks nothing (SW3-6)', () => {
  it.each([
    ['Ctrl+D, leaving an agent', '\x04'],
    ['two Ctrl+D', '\x04\x04'],
    ['Ctrl+A', '\x01'],
    ['Ctrl+E', '\x05'],
    ['Ctrl+B and Ctrl+F', '\x02\x06'],
    ['Ctrl+K', '\x0b'],
    ['Ctrl+W', '\x17'],
    ['Ctrl+T', '\x14'],
    ['Left and Right', `${E}[D${E}[C`],
    ['Home and End', `${E}[H${E}[F`],
    ['SS3 Home and End', `${E}OH${E}OF`],
    ['Delete and Insert', `${E}[3~${E}[2~`],
    ['Ctrl+Left and Ctrl+Right', `${E}[1;5D${E}[1;5C`],
    ['Tab', '\t'],
  ])('%s, then a plainly typed launch line', (_what, keys) => {
    const seen: Array<[string, boolean]> = []
    _gatherLinesForTest('n1', `${keys}claude --model opus --permission-mode plan\r`, (l, edited) => seen.push([l, edited]))
    expect(seen).toEqual([['claude --model opus --permission-mode plan', false]])
  })

  it('across writes: leaving an agent with two Ctrl+D, then a launch typed whole', () => {
    noteTypedInput('t1', '\x04', clock)
    noteTypedInput('t1', '\x04', clock)
    noteTypedInput('t1', 'claude --model opus --permission-mode plan\r', clock)
    expect(terminalAgentStart('t1')).toMatchObject({ commands: ['claude --model opus --permission-mode plan'] })
    expect(terminalAgentStart('t1')?.unsure).toBeUndefined()
  })

  it.each([
    ['Up', `${E}[A`],
    ['Down', `${E}[B`],
    ['SS3 Up', `${E}OA`],
    ['Page Up', `${E}[5~`],
    ['Shift+Tab', `${E}[Z`],
    ['F3, which cmd repeats the last line with', `${E}OR`],
    ['F8', `${E}[19~`],
    ['Alt+. (the last argument)', `${E}.`],
    ['Ctrl+P', '\x10'],
    ['Ctrl+N', '\x0e'],
    ['Ctrl+R', '\x12'],
    ['Ctrl+Y', '\x19'],
  ])('%s fills an empty line, so what follows is still read as edited', (_what, keys) => {
    const seen: Array<[string, boolean]> = []
    _gatherLinesForTest('n2', `${keys}claude\r`, (l, edited) => seen.push([l, edited]))
    expect(seen).toEqual([['claude', true]])
  })

  it.each([
    ['Left', `${E}[D`],
    ['Home', `${E}[H`],
    ['Delete', `${E}[3~`],
    ['Ctrl+A', '\x01'],
    ['Ctrl+D', '\x04'],
    ['Tab', '\t'],
  ])('%s in a line that holds text is an edit', (_what, keys) => {
    const seen: Array<[string, boolean]> = []
    _gatherLinesForTest('n3', `cla${keys}ude\r`, (l, edited) => seen.push([l, edited]))
    expect(seen[0][1]).toBe(true)
  })
})

// The shell ran a line Termpolis did not see (a history recall, a completion). While an earlier start is on record and its agent is
// gone, that line may have started the agent again, with other flags and another conversation: the record is then one of an agent
// started with unknown options, and the session Termpolis remembered from the earlier launch is not this one.
describe('a line the shell ran that the keys do not say (SAFETY-R3-1, MODELS-R3-3)', () => {
  const SESSION = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'

  /** Termpolis's own launch, the agent seen exiting, the shell's prompt drawn again. */
  async function exitedAfterLaunch(command = 'claude --dangerously-skip-permissions'): Promise<void> {
    const { line } = await ok<{ line: string }>(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', shellType: 'gitbash', command })
    noteTypedInput('t1', `${line}\r`, clock)
    // The session Termpolis started it with (an account launch names one with --session-id).
    noteTerminalSession('t1', SESSION)
    term.type(`${line}\r`)
    term.mode = 'shell'
    term.out += term.prompt()
    clock += 5000
  }

  it.each([
    ['Up and Enter', `${E}[A\r`],
    ['Ctrl+P and Enter', '\x10\r'],
    ['Ctrl+R and Enter', '\x12\r'],
    ['Up, Up and Enter', `${E}[A${E}[A\r`],
    ['cla, Tab and Enter (a completion no launch word names)', 'cla\t\r'],
    ['a completion with a space after it', 'co\t \r'],
  ])('%s: the record becomes one of an agent started with unknown options, and the old conversation is forgotten', async (_what, keys) => {
    await exitedAfterLaunch()
    expect(terminalAgentStart('t1')).toMatchObject({ commands: [expect.stringContaining('--dangerously-skip-permissions')] })
    expect(terminalSessionId('t1')).toMatch(/^[0-9a-f-]{36}$/)
    noteTypedInput('t1', keys, clock)
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude', commands: ['claude'], unsure: true, time: clock })
    expect(terminalSessionId('t1')).toBeUndefined()
  })

  it('leaves the record alone while its agent still runs: a recalled prompt in its box is no launch', async () => {
    await ok(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', shellType: 'gitbash', command: 'claude --model opus' })
    noteTypedInput('t1', 'claude --model opus\r', clock)
    const before = terminalAgentStart('t1')!
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', `${E}[A\r`, clock)
    expect(terminalAgentStart('t1')).toBe(before)
    expect(before.unsure).toBeUndefined()
  })

  it('leaves it alone when nothing is on record: no agent, nothing to start again', () => {
    noteTypedInput('t1', `${E}[A\r`, clock)
    expect(terminalAgentStart('t1')).toBeUndefined()
  })

  // A line the keys cut short names no agent whatever: `cd repo && cla`, Tab runs claude too, so any edited line after the exit is read so.
  it.each([
    ['a path completed with Tab', 'cd src/ma\t\r'],
    ['an agent started later in a line', 'cd repo && cla\t\r'],
    ['a line recalled and then edited', `${E}[Afoo\r`],
  ])('reads %s, after the agent exited, as a line that may have started it again', async (_what, keys) => {
    await exitedAfterLaunch()
    noteTypedInput('t1', keys, clock)
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude', commands: ['claude'], unsure: true })
    expect(terminalSessionId('t1')).toBeUndefined()
  })

  it('and not for an edited line while the agent still runs, whatever the line says', async () => {
    await ok(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', shellType: 'gitbash', command: 'claude --model opus' })
    noteTypedInput('t1', 'claude --model opus\r', clock)
    noteTerminalSession('t1', SESSION)
    const before = terminalAgentStart('t1')!
    term.mode = 'agent'
    term.out += term.frame()
    noteTypedInput('t1', 'cd src/ma\t\r', clock)
    expect(terminalAgentStart('t1')).toBe(before)
    expect(before.unsure).toBeUndefined()
    expect(terminalSessionId('t1')).toBe(SESSION)
  })

  it('leaves a record that names no agent alone: it is no agent whose start could be unseen', async () => {
    noteAgentStart('t1', { at: 0, commands: ['some-wrapper --flag'] }, clock)
    const before = terminalAgentStart('t1')!
    expect(before.agent).toBeUndefined()
    term.mode = 'shell'
    term.out += term.prompt()
    clock += 5000
    noteTypedInput('t1', `${E}[A\r`, clock)
    noteTypedInput('t1', 'cd src/ma\t\r', clock)
    expect(terminalAgentStart('t1')).toBe(before)
    expect(before.unsure).toBeUndefined()
  })

  it('a line typed whole that starts the agent again replaces the record and the conversation with its own', async () => {
    await exitedAfterLaunch()
    noteTypedInput('t1', 'claude --model sonnet\r', clock)
    expect(terminalAgentStart('t1')).toMatchObject({ commands: ['claude --model sonnet'] })
    expect(terminalSessionId('t1')).toBeUndefined()
    // Gone again, then one that names its conversation.
    term.mode = 'shell'
    term.out += term.prompt()
    clock += 5000
    noteTypedInput('t1', `claude --resume ${SESSION}\r`, clock)
    expect(terminalSessionId('t1')).toBe(SESSION)
  })

  it('an edited launch line forgets the conversation too: what the shell ran is not what the keys say', async () => {
    await exitedAfterLaunch()
    noteTypedInput('t1', `claude --resume ${SESSION}\t\r`, clock)
    expect(terminalAgentStart('t1')).toMatchObject({ commands: ['claude'], unsure: true })
    expect(terminalSessionId('t1')).toBeUndefined()
  })

  it('a swarm worker\'s command forgets the conversation of the agent it replaces', () => {
    noteSwarmWorker('t1')
    noteTerminalSession('t1', SESSION)
    noteWorkerCommand('t1', 'claude --dangerously-skip-permissions', clock)
    expect(terminalSessionId('t1')).toBeUndefined()
    noteWorkerCommand('t1', `claude --resume ${SESSION}`, clock)
    expect(terminalSessionId('t1')).toBe(SESSION)
  })
})

// SAFETY-R3-8: main keeps a live screen for every terminal an agent was started in, and every chunk the terminal prints is drawn on it, the
// terminal's whole life. Once the agent is seen gone nothing reads it, and it is let go until the next recorded start.
describe('the kept screen of a terminal whose agent is gone (SAFETY-R3-8)', () => {
  const baseIO = (watch: (id: string) => void, unwatch: (id: string) => void): AccountsIpcDeps['switchIO'] => ({
    output: (id) => term.io().output(id),
    outputFrom: (id, from) => term.io().outputFrom(id, from),
    end: (id) => term.io().end(id),
    size: () => ({ cols: 80, rows: 24 }),
    write: (id, data) => term.io().write(id, data),
    sleep: (ms) => term.io().sleep(ms),
    now: () => clock,
    watch,
    unwatch,
  })
  const trace: string[] = []
  const wire = (): void => {
    trace.length = 0
    register({ switchIO: baseIO((id) => { trace.push(`watch ${id}`) }, (id) => { trace.push(`unwatch ${id}`) }) })
  }
  const launched = async (): Promise<void> => {
    const { line } = await ok<{ line: string }>(ACCOUNTS_IPC.launchLine, { terminalId: 't1', agent: 'claude', shellType: 'gitbash', command: 'claude' })
    noteTypedInput('t1', `${line}\r`, clock)
  }

  it('lets it go when a look finds the agent gone, once, and keeps it while the agent runs', async () => {
    wire()
    await launched()
    expect(trace).toEqual(['watch t1'])
    term.mode = 'agent'
    term.out += term.frame()
    clock += 5000
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(trace).toEqual(['watch t1'])
    term.mode = 'shell'
    term.out += term.hint?.() ?? ''
    term.out += term.prompt()
    clock += 5000
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(trace).toEqual(['watch t1', 'unwatch t1'])
    // Once: the next looks find it gone already, and let go of nothing again.
    clock += 5000
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(trace).toEqual(['watch t1', 'unwatch t1'])
  })

  it('keeps one again at the next start, which is recorded as ever, and lets it go again at that agent\'s exit', async () => {
    wire()
    await launched()
    term.mode = 'shell'
    term.out += term.prompt()
    clock += 5000
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(trace).toEqual(['watch t1', 'unwatch t1'])
    noteTypedInput('t1', 'claude --model sonnet\r', clock)
    expect(trace).toEqual(['watch t1', 'unwatch t1', 'watch t1'])
    // The second agent runs, then exits: its screen is let go too, once.
    term.mode = 'agent'
    term.out += term.frame()
    clock += 5000
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(trace).toEqual(['watch t1', 'unwatch t1', 'watch t1'])
    term.mode = 'shell'
    term.out += term.prompt()
    clock += 5000
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(trace).toEqual(['watch t1', 'unwatch t1', 'watch t1', 'unwatch t1'])
  })

  it('lets it go when a line entered at the shell finds the agent gone, before any look did', async () => {
    wire()
    await launched()
    expect(trace).toEqual(['watch t1'])
    term.mode = 'shell'
    term.out += term.prompt()
    clock += 5000
    noteTypedInput('t1', 'ls -la\r', clock)
    expect(trace).toEqual(['watch t1', 'unwatch t1'])
    // And it was once: a second line says nothing more.
    noteTypedInput('t1', 'pwd\r', clock)
    expect(trace).toEqual(['watch t1', 'unwatch t1'])
  })

  it('never lets one go for a terminal no agent was started in, and a screen that will not let go changes nothing', async () => {
    wire()
    await ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    expect(trace).toEqual([])
    register({ switchIO: baseIO(() => undefined, () => { throw new Error('no such terminal') }) })
    await launched()
    term.mode = 'shell'
    term.out += term.prompt()
    clock += 5000
    await expect(ok<LimitLook>(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })).resolves.toMatchObject({ agent: 'claude', live: false })
  })
})
