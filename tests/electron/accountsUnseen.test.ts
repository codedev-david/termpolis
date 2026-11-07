// @vitest-environment node
//
// CH4-1: an edited line typed after an agent's exit (Tab completion, a history recall) records an
// agent started with unknown options (noteUnseenLaunch, SAFETY-R3-1), since the shell may have run
// the agent again. In a terminal that can never show that agent's exit (Git Bash on Windows with a
// PROMPT_COMMAND of its own: no prompt report, and Windows has no foreground read), that guess must
// not count as a live agent for the usage-limit chooser, and a launch typed later replaces it.
// Where the exit can be seen (prompt reports, or the PTY's foreground on macOS and Linux), the guess
// is watched as before, so a relaunch by recall still has its limit seen.
//
// The real wiring: registerAccountsIpc's limit look, the real noteTypedInput (terminal:write) and
// the output buffers with their kept screen, as index.ts wires them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { _resetTerminalAccountsForTest, noteTypedInput, registerAccountsIpc, terminalAgentStart } from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { _resetSwitchLocksForTest } from '../../src/main/accountSwitch'
import type { SwitchIO } from '../../src/main/accountSwitch'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { LimitLook } from '../../src/shared/accountLimits'
import { stopKind } from '../../src/shared/agentStatusDetector'
import { appendOutput, liveScreen, readOutputFrom, readOutputTail, reportedFamilies, watchScreen } from '../../src/main/terminalOutputBuffer'
import type { OutputBuffers } from '../../src/main/terminalOutputBuffer'
import { createSandbox } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

const E = '\x1b'
const RULE = '─'.repeat(80)
const LIMIT_REPLY = "  ⎿  You've hit your session limit · resets 8:10pm (America/New_York)"
const CLAUDE_IDLE = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
const CLAUDE_UP = ['', '  Claude Code v2.1.317', '', ...CLAUDE_IDLE]
const CODEX_UP = ['', '  OpenAI Codex', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\repos\\app']
const CODEX_LIMIT = ["■ You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 3:04 PM.", '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~\\repos\\app']
const HINT = ['', 'Resume this session with:', 'claude --resume 11111111-2222-4333-8444-555555555555']
const CAPTURE = ['❯ go', '', LIMIT_REPLY, '', ...CLAUDE_IDLE]
const SESSION = '22222222-3333-4444-8555-666666666666'
const paint = (rows: string[]): string => `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')
const nl = (rows: string[]): string => rows.join('\r\n')

/** How the shell after an exit tells it: not at all (Git Bash with its own PROMPT_COMMAND, on
 *  Windows), with a prompt report before each prompt, or through the PTY's foreground. */
type Shell = 'silent' | 'reports' | 'foreground'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let buffers: OutputBuffers
let clock: number
let shell: Shell
/** Who holds the PTY's foreground, for the 'foreground' shell. */
let atShell: boolean

const data = (chunk: string): void => { appendOutput(buffers, 't1', chunk) }
const type = (keys: string): void => { noteTypedInput('t1', keys, clock) }
const prompt = (): string => (shell === 'reports' ? `\r\n${E}]7;file://host/c/repo${E}\\$ ` : '\r\n$ ')

function register(): void {
  handlers = new Map()
  const io = {
    output: (id: string) => {
      const raw = readOutputTail(buffers, id, 1000)
      return raw ? { raw, end: readOutputFrom(buffers, id, 0).nextOffset } : null
    },
    outputFrom: (id: string, from: number) => readOutputFrom(buffers, id, from).output,
    end: (id: string) => readOutputFrom(buffers, id, 0).nextOffset,
    size: () => ({ cols: 80, rows: 24 }),
    screen: (id: string) => liveScreen(buffers, id),
    watch: (id: string) => { watchScreen(buffers, id, { cols: 80, rows: 24 }) },
    reported: (id: string) => reportedFamilies(buffers, id),
    ...(shell === 'foreground' ? { atShell: () => atShell } : {}),
    write: () => undefined,
    sleep: async () => undefined,
    now: () => clock,
  } as unknown as SwitchIO
  const deps = {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => true,
    pickFolder: async () => null,
    send: () => {},
    checkCwd: () => sb.root,
    env: {},
    now: () => clock,
    outputEnd: () => io.end('t1'),
    switchIO: io,
  } as unknown as AccountsIpcDeps
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, deps)
}

async function lookNow(): Promise<LimitLook> {
  const r = (await handlers.get(ACCOUNTS_IPC.limitLook)!(null, { terminalId: 't1' })) as { success: boolean; data: LimitLook }
  return r.data
}
const opens = (l: LimitLook): boolean => l.live && l.turned && stopKind(l.status) === 'limit'

/** Claude typed at the shell, a turn that ends at its limit, /exit, the shell's prompt. */
async function firstSession(): Promise<void> {
  register()
  data('$ ')
  type('claude\r'); atShell = false; clock += 100
  data('claude\r\n' + paint(CLAUDE_UP))
  await lookNow()
  clock += 3000
  type('go\r')
  data(paint(CAPTURE))
  clock += 100
  expect(opens(await lookNow())).toBe(true)
  clock += 3000
  type('/exit\r')
  data(paint(['❯ go', '', LIMIT_REPLY, ...HINT]))
  atShell = true
  clock += 3000
  await lookNow()
  data(prompt())
  clock += 3000
  expect((await lookNow()).live).toBe(false)
}

/** `ls fo<Tab>`, completed by the shell, entered. */
async function editedLine(): Promise<void> {
  clock += 3000
  type('ls fo\t'); data('ls fo'); type('o.txt\r'); data('o.txt\r\nfoo.txt' + prompt())
  clock += 3000
  await lookNow()
}

beforeEach(() => {
  sb = createSandbox(); clock = 1000; buffers = new Map(); shell = 'silent'; atShell = true
  _resetTerminalAccountsForTest(); _resetSwitchLocksForTest()
})
afterEach(() => { _resetTerminalAccountsForTest(); sb.dispose() })

describe('an edited line after an exit, in a terminal that never shows an exit (CH4-1)', () => {
  it('never opens the chooser on a limit screen a shell prints, twice over', async () => {
    await firstSession(); await editedLine()
    // The guess is kept for the switch: an agent may have started, with options unknown.
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude', unsure: true, unseen: true })
    clock += 3000
    type('cat limit-a.txt\r')
    data('cat limit-a.txt\r\n' + nl(CAPTURE) + prompt())
    clock += 3000
    expect(opens(await lookNow())).toBe(false)
    type('cat limit-b.txt\r')
    clock += 100
    data('cat limit-b.txt\r\n' + nl(CAPTURE) + prompt())
    clock += 3000
    const l = await lookNow()
    expect(l.live).toBe(false)
    expect(opens(l)).toBe(false)
  })

  it('records codex typed afterwards as codex, and judges its limit as Codex\'s', async () => {
    await firstSession(); await editedLine()
    clock += 3000
    type('codex\r'); clock += 100
    data('codex\r\n' + paint(CODEX_UP))
    expect((await lookNow()).agent).toBe('codex')
    expect(terminalAgentStart('t1')).toMatchObject({ agent: 'codex', commands: ['codex'] })
    clock += 3000
    type('go\r')
    data(paint(['› go', '', ...CODEX_LIMIT]))
    clock += 100
    const l = await lookNow()
    expect(l.agent).toBe('codex')
    expect(opens(l)).toBe(true)
  })

  it('keeps the whole line of a launch typed with flags afterwards', async () => {
    await firstSession(); await editedLine()
    clock += 3000
    const line = 'claude --dangerously-skip-permissions --model opus'
    type(`${line}\r`); clock += 100
    data(`${line}\r\n` + paint(CLAUDE_UP))
    await lookNow()
    const start = terminalAgentStart('t1')
    expect(start?.commands).toEqual([line])
    expect(start?.unsure).toBeUndefined()
    expect(start?.unseen).toBeUndefined()
  })

  it('starts a record with no turn for `claude --resume` typed afterwards, so the old limit it draws again is no stop (R4)', async () => {
    await firstSession(); await editedLine()
    clock += 3000
    const line = `claude --resume ${SESSION}`
    type(`${line}\r`); clock += 100
    data(`${line}\r\n` + paint(CAPTURE))
    clock += 100
    const l = await lookNow()
    expect(terminalAgentStart('t1')).toMatchObject({ commands: [line], agent: 'claude' })
    expect(terminalAgentStart('t1')?.turned).not.toBe(true)
    expect(l.turned).toBe(false)
    expect(opens(l)).toBe(false)
  })
})

describe('an edited line after an exit, where the exit can be seen (CH4-1)', () => {
  for (const kind of ['reports', 'foreground'] as const) {
    it(`watches an agent relaunched by recall, and sees its limit (${kind})`, async () => {
      shell = kind
      await firstSession()
      clock += 3000
      // Up, Enter: the shell runs `claude` again, and the keys never name it.
      type(`${E}[A`); data('claude'); type('\r'); atShell = false; clock += 100
      data('\r\n' + paint(CLAUDE_UP))
      expect(terminalAgentStart('t1')).toMatchObject({ agent: 'claude', unsure: true, unseen: true })
      expect((await lookNow()).live).toBe(true)
      clock += 3000
      type('go\r')
      data(paint(CAPTURE))
      clock += 100
      expect(opens(await lookNow())).toBe(true)
    })
  }
})
