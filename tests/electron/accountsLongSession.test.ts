// F-R2-2: an agent that has been working for a minute. Claude Code 2.1.316 paints its input box once and
// updates a row above it in place, so main's 32 KB window (MAX_TERMINAL_BUFFER_CHARS) holds no box after
// that much work, and every read of the screen through it (the limit look, the idle gate of a switch, the
// liveness check) saw nothing: a real limit stop never opened the chooser, and a switch typed nothing.
// A terminal Termpolis watches now keeps its screen as the output draws it (watchScreen), and the reads
// use it; the window stays for the offset reads.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { atIdleBox, liveness, look, runAccountSwitch } from '../../src/main/accountSwitch'
import type { SwitchIO } from '../../src/main/accountSwitch'
import { lookForLimit } from '../../src/main/limitLook'
import type { LiveStart } from '../../src/main/limitLook'
import {
  appendOutput, liveScreen, readOutputFrom, readOutputTail, resizeScreen, watchScreen,
} from '../../src/main/terminalOutputBuffer'
import type { OutputBuffers } from '../../src/main/terminalOutputBuffer'
import { stopKind } from '../../src/shared/agentStatusDetector'
import { COLS, PAST_THE_WINDOW, ROWS, claudeTurn, limitReply, paintClaude, working } from './_longRun'
import { FakeTerminal, keys } from './_switchTerminal'
import { _resetTerminalAccountsForTest, noteTypedInput, registerAccountsIpc } from '../../src/main/accountsIpc'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { LimitLook } from '../../src/shared/accountLimits'
import { createSandbox } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import type { AgentAccount } from '../../src/shared/agentAccounts'

const ID = 't1'

/** A terminal as main holds one: the rolling window, and (when `live`) the screen kept beside it. The same
 *  reads index.ts hands the switch (switchIO). */
function mainTerminal(live: boolean) {
  const buffers: OutputBuffers = new Map()
  const size = { cols: COLS, rows: ROWS }
  const feed = (data: string): void => {
    appendOutput(buffers, ID, data)
  }
  const io: SwitchIO = {
    output: (id) => {
      const raw = readOutputTail(buffers, id, 1000)
      return raw ? { raw, end: readOutputFrom(buffers, id, 0).nextOffset } : null
    },
    outputFrom: (id, from) => readOutputFrom(buffers, id, from).output,
    end: (id) => readOutputFrom(buffers, id, 0).nextOffset,
    size: () => size,
    write: () => undefined,
    sleep: async () => undefined,
    now: () => 0,
    ...(live ? { screen: (id: string) => liveScreen(buffers, id) } : {}),
  }
  return { buffers, io, feed, size }
}

const START: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0, turned: true, turnedAt: 0 }

describe('a long-running Claude Code terminal (its box scrolled out of the 32 KB window)', () => {
  // F-R3-2: the kept screen's TITLE is what the reads judge a busy agent by (Claude Code's title spinner), as a replay of the window's is.
  it('reads the kept screen\'s window title, and a Claude title spinner still says the agent is at work', () => {
    const t = mainTerminal(true)
    t.feed(paintClaude(['❯ Build the login page.', '']))
    expect(watchScreen(t.buffers, ID, t.size)).toBe(true)
    t.feed(working(PAST_THE_WINDOW))
    t.feed(']0;⠐ Claude Code')
    expect(look(t.io, ID).title).toBe('⠐ Claude Code')
    expect(look(t.io, ID).box).toBeGreaterThanOrEqual(0)
    expect(lookForLimit(t.io, ID, { at: 0, commands: ['claude'], agent: 'claude', time: 0 }, 1000).status.status).toBe('working')
    t.feed(']0;Claude Code')
    expect(look(t.io, ID).title).toBe('Claude Code')
    expect(lookForLimit(t.io, ID, { at: 0, commands: ['claude'], agent: 'claude', time: 0 }, 1000).status.status).not.toBe('working')
  })

  it('has no box in a replay of the window: the cause', () => {
    const t = mainTerminal(false)
    t.feed(claudeTurn(PAST_THE_WINDOW))
    expect(look(t.io, ID).box).toBe(-1)
    expect(atIdleBox(t.io, ID)).toBeNull()
    expect(liveness(t.io, ID, 'claude', undefined)).toEqual({ state: 'unknown' })
  })

  it('has its box on the screen kept beside the window, and the switch\'s reads use it', () => {
    const t = mainTerminal(true)
    t.feed(paintClaude(['❯ Build the login page.', '']))
    expect(watchScreen(t.buffers, ID, t.size)).toBe(true)
    t.feed(working(PAST_THE_WINDOW))
    const l = look(t.io, ID)
    expect(l.box).toBeGreaterThanOrEqual(0)
    expect(l.lines[l.box + 1]).toMatch(/^─+$/)
    expect(atIdleBox(t.io, ID)).not.toBeNull()
    expect(liveness(t.io, ID, 'claude', undefined)).toEqual({ state: 'live' })
    // The offset reads still come from the window.
    expect(l.raw.length).toBeLessThanOrEqual(32_768)
    expect(l.end).toBeGreaterThan(PAST_THE_WINDOW)
  })

  it('opens the limit chooser for a limit that ended a long turn', () => {
    const quiet = mainTerminal(false)
    const live = mainTerminal(true)
    for (const t of [quiet, live]) {
      t.feed(paintClaude(['❯ Build the login page.', '']))
      if (t === live) watchScreen(t.buffers, ID, t.size)
      t.feed(working(PAST_THE_WINDOW) + limitReply())
    }
    // The window alone reads an idle terminal: no stop, no words.
    const missed = lookForLimit(quiet.io, ID, { ...START }, 1000)
    expect(stopKind(missed.status)).toBeNull()
    expect(missed.words).toBeNull()
    // The kept screen reads the stop the user sees.
    const seen = lookForLimit(live.io, ID, { ...START }, 1000)
    expect(stopKind(seen.status)).toBe('limit')
    expect(seen).toMatchObject({ live: true, turned: true, words: "You've hit your session limit · resets 8:10pm (America/New_York)" })
  })

  it('draws, after a resize, the repaint the CLI sends for the new size', () => {
    const t = mainTerminal(true)
    t.feed(paintClaude(['❯ Build the login page.', '']))
    watchScreen(t.buffers, ID, t.size)
    t.feed(working(PAST_THE_WINDOW))
    // A narrower pane: the screen is rebuilt for it, and the CLI repaints the box (it does on a resize).
    const narrow = { cols: 60, rows: 20 }
    resizeScreen(t.buffers, ID, narrow)
    expect(liveScreen(t.buffers, ID)!.lines).toHaveLength(20)
    t.feed(`\x1b[2J\x1b[H\x1b[17;1H${'─'.repeat(60)}\x1b[18;1H> \x1b[19;1H${'─'.repeat(60)}\x1b[20;1H  ? for shortcuts`)
    const rows = liveScreen(t.buffers, ID)!.lines
    expect(rows[16]).toBe('─'.repeat(60))
    expect(rows[17]).toBe('>')
  })
})

// The switch itself, end to end on a scripted terminal that reads as main hands it over: its rolling 32 KB
// window, and (the fix) the screen main keeps beside it.
describe('switching an agent that has worked past the window (F-R2-2)', () => {
  const B: AgentAccount = { id: 'acc_b', agent: 'claude', label: 'codedev', profile: 'C:\\Users\\me\\.claude-b', autoOffer: true, order: 1, connect: true, origin: 'created', links: [] }
  const NEW_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'

  async function switchIt(main: 'window' | 'kept') {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', main, worked: 40_000 })
    const outcome = await runAccountSwitch(
      { terminalId: 't1', targetId: B.id, shellType: 'gitbash' },
      { io: t.io(), target: B, agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, newSessionId: () => NEW_ID, record: () => undefined },
    )
    return { t, outcome }
  }

  it('control: with only the window to read, it cannot tell the agent is live, and types nothing', async () => {
    const { t, outcome } = await switchIt('window')
    expect(outcome).toEqual({ kind: 'unknown-exit' })
    expect(t.writes).toEqual([])
  })

  it('with the kept screen it exits the agent and resumes the conversation on the other account', async () => {
    const { t, outcome } = await switchIt('kept')
    expect(outcome).toMatchObject({ kind: 'switched', resumed: true })
    expect(t.ran.some((line) => /--resume/.test(line))).toBe(true)
    expect(keys(t)).toContain('/exit')
  })
})

// The kept screen must draw what a replay of everything draws, wherever the window still holds everything
// (every switch scenario's output is far under 32 KB): the engine's decisions, and the keys it types, are
// the same through either.
describe('the kept screen changes nothing while the window holds everything', () => {
  const B: AgentAccount = { id: 'acc_b', agent: 'claude', label: 'codedev', profile: 'C:\\Users\\me\\.claude-b', autoOffer: true, order: 1, connect: true, origin: 'created', links: [] }
  const CODEX_B: AgentAccount = { ...B, id: 'acc_cb', agent: 'codex', profile: 'C:\\Users\\me\\.codex-b' }
  const starts = ['idle', 'busy', 'menu', 'waiting', 'typed', 'question', 'gone-hint', 'gone-quiet', 'blank'] as const

  async function outcomeOf(script: ConstructorParameters<typeof FakeTerminal>[0]) {
    const t = new FakeTerminal(script)
    const target = script.agent === 'codex' ? CODEX_B : B
    const outcome = await runAccountSwitch(
      { terminalId: 't1', targetId: target.id, shellType: script.family === 'posix' ? 'gitbash' : script.family },
      { io: t.io(), target, agent: script.agent, start: { at: t.launchedAt, commands: [t.launchLine()] }, newSessionId: () => '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f', record: () => undefined },
    )
    return { outcome, writes: t.writes, ran: t.ran }
  }

  const cases = (['claude', 'codex'] as const).flatMap((agent) => (['posix', 'powershell', 'cmd'] as const).flatMap((family) => starts.map((start) => ({ agent, family, start }))))
  it.each(cases)('$agent in $family, starting $start', async ({ agent, family, start }) => {
    const script = { agent, family, start, exit: 'hint' as const }
    const whole = await outcomeOf(script)
    expect(await outcomeOf({ ...script, main: 'window' })).toEqual(whole)
    expect(await outcomeOf({ ...script, main: 'kept' })).toEqual(whole)
  })
})

// The chooser's own path, through the handler the renderer calls and the buffers index.ts keeps.
describe('accounts:limit-look on a terminal whose agent worked past the window (F-R2-2)', () => {
  const WORDS = "You've hit your session limit · resets 8:10pm (America/New_York)"
  let sb: Sandbox
  let buffers: OutputBuffers
  let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
  let clock: number
  const size = { cols: COLS, rows: ROWS }

  beforeEach(() => {
    sb = createSandbox()
    buffers = new Map()
    clock = 1000
    _resetTerminalAccountsForTest()
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
      outputEnd: (id) => readOutputFrom(buffers, id, 0).nextOffset,
      // What index.ts hands the switch: the window, the screen kept beside it, the terminal's size.
      switchIO: {
        output: (id) => {
          const raw = readOutputTail(buffers, id, 1000)
          return raw ? { raw, end: readOutputFrom(buffers, id, 0).nextOffset } : null
        },
        outputFrom: (id, from) => readOutputFrom(buffers, id, from).output,
        end: (id) => readOutputFrom(buffers, id, 0).nextOffset,
        size: () => size,
        screen: (id) => liveScreen(buffers, id),
        watch: (id) => { watchScreen(buffers, id, size) },
        write: () => undefined,
        sleep: async () => undefined,
        now: () => clock,
      },
    })
  })
  afterEach(() => {
    _resetTerminalAccountsForTest()
    sb.dispose()
  })

  const lookAt = async (): Promise<LimitLook> => {
    const r = (await handlers.get(ACCOUNTS_IPC.limitLook)!(null, { terminalId: 't1' })) as { success: boolean; data: LimitLook }
    expect(r.success).toBe(true)
    return r.data
  }

  /** The user starts the agent, it paints its box, takes a prompt, and works for a minute. */
  function aTurn(): void {
    appendOutput(buffers, 't1', '$ claude\r\n')
    noteTypedInput('t1', 'claude\r', clock)
    appendOutput(buffers, 't1', paintClaude(['❯ Build the login page.', '']))
    noteTypedInput('t1', 'Build the login page.\r', clock)
    appendOutput(buffers, 't1', working(PAST_THE_WINDOW))
  }

  it('reads a limit that ended the turn, though the window holds no box', async () => {
    aTurn()
    expect(readOutputTail(buffers, 't1', 1000)).not.toContain('─')
    appendOutput(buffers, 't1', limitReply())
    const seen = await lookAt()
    expect(seen).toMatchObject({ agent: 'claude', live: true, turned: true, words: WORDS })
    expect(stopKind(seen.status)).toBe('limit')
  })

  it('reads a working agent as working, and no limit', async () => {
    aTurn()
    appendOutput(buffers, 't1', `${'\x1b'}[2;1H✻ Thinking… (61s · esc to interrupt)${'\x1b'}[27;3H`)
    const seen = await lookAt()
    expect(seen).toMatchObject({ agent: 'claude', live: true, turned: true, words: null })
    expect(stopKind(seen.status)).toBeNull()
  })

  it('reads the agent as gone once it has exited and its shell is back', async () => {
    aTurn()
    // It exits below its box: the hint is at the screen's foot with the box above it, and the shell's prompt after.
    appendOutput(buffers, 't1', `\x1b[${ROWS};1H\r\nResume this session with:\r\nclaude --resume 3f2a9c1e-5b7d-4e8f-a012-3456789abcde\r\n$ `)
    const seen = await lookAt()
    expect(seen.live).toBe(false)
  })
})
