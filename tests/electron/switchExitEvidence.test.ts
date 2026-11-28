// @vitest-environment node
//
// HOLD-C (signoff-decisions.md, 2026-11-28): the switch, its Codex fallback, agy's switch and the limit look treat an agent as
// gone, and type at the shell, only on positive evidence: the OS says only the shell is left (shellAlone), or the shell's own
// prompt report arrives after the agent's start record (after its prompt before the start). Silence, a repaint, a footer or a
// closing rule not drawn yet, a lost launch echo and a second look are never an exit: without evidence the switch types
// nothing ("unknown-exit"), and the limit look keeps the agent live. The probes are Codex R3's and Opus R3's (holdb review 3).
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetSwitchLocksForTest, livenessNow, runAccountSwitch } from '../../src/main/accountSwitch'
import type { SwitchContext, SwitchIO } from '../../src/main/accountSwitch'
import { lookForLimit } from '../../src/main/limitLook'
import type { LiveStart } from '../../src/main/limitLook'
import { LINE_CLEAR } from '../../src/shared/accountSwitch'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import type { AccountAgent, AgentAccount } from '../../src/shared/agentAccounts'
import limits from '../fixtures/agentScreensLimit.json'
import inputScreens from '../fixtures/agentScreensInput.json'
import agentScreens from '../fixtures/agentScreens.json'
import { FakeTerminal, ID } from './_switchTerminal'

const E = '\x1b'
const REPORT = `${E}]7;file://host/tmp/project\x07`
const PS_REPORT = `${E}]9;9;C:\\repo\x07`
const WIPE = `${E}[H${E}[2J`
const RULE = '─'.repeat(20)
/** Claude Code's first frame caught half drawn at the shell's first prompt: its box, and no closing rule under it yet. */
const PARTIAL = REPORT + '$ \r\n' + WIPE + 'Claude Code\r\n' + RULE + '\r\n❯ '
/** A prompt of the person's own drawn like a box (powerlevel10k's ruler over its ❯), with a clock under it. */
const RULED_SHELL = REPORT + WIPE + RULE + '\r\n❯ \x1b7\r\n12:00:00\x1b8'
const NEW_ID = '00000000-0000-4000-8000-000000000000'

const TARGET: AgentAccount = { id: 'g2', agent: 'claude', label: 'work', profile: null, autoOffer: true, order: 1, connect: false, origin: 'label', links: [] }
const CODEX_TARGET: AgentAccount = { id: 'b', agent: 'codex', label: 'work', profile: 'C:\\work', autoOffer: true, order: 1, connect: true, origin: 'created', links: [] }

interface Probe {
  io: SwitchIO
  keys: string[]
  sleeps: number[]
}

/** A terminal whose output is `initial`, which `repaint` changes at each sleep (the clock moved by it): what is typed goes nowhere. */
function probe(initial: string, repaint: (raw: string, now: number) => string = (raw) => raw, cols = 120, rows = 30): Probe {
  let raw = initial
  let now = 0
  const keys: string[] = []
  const sleeps: number[] = []
  const io: SwitchIO = {
    output: () => ({ raw, end: raw.length }),
    outputFrom: (_id, at) => raw.slice(at),
    end: () => raw.length,
    size: () => ({ cols, rows }),
    write: (_id, key) => { keys.push(key) },
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
      raw = repaint(raw, now)
    },
    now: () => now,
  }
  return { io, keys, sleeps }
}

function switchOf(io: SwitchIO, agent: AccountAgent = 'claude', start: SwitchContext['start'] = { at: 0, commands: [agent] }): Promise<SwitchOutcome> {
  return runAccountSwitch({ terminalId: 'probe', targetId: TARGET.id, shellType: 'gitbash' }, {
    io, agent, start, target: agent === 'codex' ? CODEX_TARGET : TARGET, newSessionId: () => NEW_ID, record: () => {},
  })
}

/** Nothing was typed at the shell's prompt: no line clear, and no Enter. */
function typedNothingAtPrompt(keys: readonly string[]): void {
  expect(keys).not.toContain(LINE_CLEAR.posix)
  expect(keys).not.toContain('\r')
}

beforeEach(() => _resetSwitchLocksForTest())

describe('Codex R3 MAJOR (accountSwitch.ts:357): a frame caught half drawn at the first prompt is no exit', () => {
  it('a closing rule drawn 1.1 s late leads to no typing at the prompt, and no second look', async () => {
    const p = probe(PARTIAL, (raw, now) => (now >= 1100 && raw === PARTIAL ? raw + '\r\n' + RULE : raw))
    await switchOf(p.io)
    typedNothingAtPrompt(p.keys)
    expect(p.sleeps).not.toContain(1000)
  })

  it('a frame repainted as "Loading workspace…" is unknown, and nothing is typed', async () => {
    const p = probe(PARTIAL, (raw) => (raw === PARTIAL ? raw + WIPE + 'Loading workspace…' : raw))
    expect(await switchOf(p.io)).toEqual({ kind: 'unknown-exit' })
    expect(p.keys).toEqual([])
  })
})

describe('Codex R3 MINOR (accountSwitch.ts:458): what changes between two looks is no exit', () => {
  it('a frame cleared and drawn again leads to no typing at the prompt', async () => {
    const p = probe(PARTIAL, (raw, now) => (now === 1000 ? raw + WIPE : raw + 'Claude Code\r\n' + RULE + '\r\n❯ \r\n' + RULE))
    const outcome = await switchOf(p.io)
    typedNothingAtPrompt(p.keys)
    expect(outcome.kind).not.toBe('switched')
    expect(p.sleeps).not.toContain(1000)
  })

  it('a ruled prompt whose clock ticks, its first report the only one since the start, leads to no typing at the prompt', async () => {
    let tick = 0
    const p = probe(RULED_SHELL, (raw) => raw + `\x1b7${E}[2;1H12:00:0${++tick % 10}\x1b8`)
    const outcome = await switchOf(p.io)
    typedNothingAtPrompt(p.keys)
    expect(['switched', 'fresh']).not.toContain(outcome.kind)
  })
})

describe('Opus R3-3: a boxed clock prompt', () => {
  /** The shell's prompt, then the agent's line, its frame, its exit, and the shell's ruled prompt with its clock. */
  const before = REPORT + '$ '
  const exited = before + 'claude\r\n' + WIPE + 'Claude Code\r\n' + RULE + '\r\n❯ \r\n' + RULE + '\r\n' + '\r\nGoodbye!\r\n' + RULED_SHELL

  it.each([false, true])('reads the shell back where its report came after the agent ran (the clock ticking: %s), and types the relaunch', async (ticks) => {
    let tick = 0
    const p = probe(exited, (raw) => (ticks ? raw + `\x1b7${E}[2;1H12:00:0${++tick % 10}\x1b8` : raw))
    await switchOf(p.io, 'claude', { at: before.length, commands: ['claude'] })
    expect(p.keys.slice(0, 2)).toEqual([LINE_CLEAR.posix, '\r'])
    expect(p.keys).not.toContain('/exit')
  })
})

describe('Codex R3 MAJOR (accountSwitch.ts:971): the Codex fallback types only where the shell is proven back', () => {
  it('Codex that says "No saved session found with ID" and stays up is sent no Enter, and the switch says it can\'t tell whether Codex exited', async () => {
    const t = new FakeTerminal({ agent: 'codex', family: 'powershell', start: 'idle', exit: 'hint', relaunch: ['box'] })
    const base = t.io()
    let errorAt: number | undefined
    const writesWhileLive: string[] = []
    const io: SwitchIO = {
      ...base,
      write: (id, key) => {
        if (errorAt !== undefined) writesWhileLive.push(key)
        base.write(id, key)
        if (key === '\r' && errorAt === undefined && t.ran.some((line) => line.includes(' resume '))) {
          t.out += '\r\nNo saved session found with ID 123\r\n'
          errorAt = t.out.length
        }
      },
    }
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: CODEX_TARGET.id, shellType: 'powershell' }, {
      io, agent: 'codex', start: { at: t.launchedAt, commands: [t.launchLine()] }, target: CODEX_TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(errorAt).toBeDefined()
    expect(writesWhileLive).not.toContain('\r')
    // HOLD-C R1 F1: nothing proves it exited, so it is the approved unknown-exit, not "the shell is at its prompt".
    expect(outcome).toEqual({ kind: 'unknown-exit' })
  })

  /** A Codex that answers its resume line "No saved session found", then quits or stays, in a shell whose prompt does not report,
   *  so the OS's word is all the fallback has. */
  async function notFoundOnOs(quits: 'now' | 'later' | false): Promise<{ outcome: Awaited<ReturnType<typeof runAccountSwitch>>; t: FakeTerminal; writesAfter: string[] }> {
    const t = new FakeTerminal({ agent: 'codex', family: 'powershell', reports: false, os: 'tells', start: 'idle', exit: 'hint', relaunch: ['box'] })
    const base = t.io()
    let said = false
    const writesAfter: string[] = []
    const io: SwitchIO = {
      ...base,
      write: (id, key) => {
        if (said) writesAfter.push(key)
        base.write(id, key)
        if (key === '\r' && !said && t.ran.some((line) => line.includes(' resume '))) {
          said = true
          t.out += '\r\nNo saved session found with ID 123\r\n'
          if (quits === 'now') {
            t.mode = 'shell'
            t.goneAt = t.clock
            t.out += t.prompt()
          }
          if (quits === 'later') {
            t.goneAt = t.clock + 3000
            t.late = { at: t.goneAt, text: t.prompt(), mode: 'shell' }
          }
        }
      },
    }
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: CODEX_TARGET.id, shellType: 'powershell' }, {
      io, agent: 'codex', start: { at: t.launchedAt, commands: [t.launchLine()] }, target: CODEX_TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    return { outcome, t, writesAfter }
  }

  it.each(['now', 'later'] as const)('Codex that says it found no session and quits (%s), in a shell that reports no prompt, is read back on the OS\'s word: a new session in place', async (when) => {
    const { outcome, writesAfter } = await notFoundOnOs(when)
    expect(outcome).toMatchObject({ kind: 'fresh', why: 'not-found' })
    expect(writesAfter).toContain('\r')
  })

  it('Codex that says it found no session and stays up, with the OS saying so, is sent nothing more', async () => {
    const { outcome, writesAfter } = await notFoundOnOs(false)
    expect(outcome).toEqual({ kind: 'unknown-exit', osSees: true })
    expect(writesAfter).toEqual([])
  })
})

// HOLD-C R1 F1: resume-not-found's card says the shell is at its prompt, and a swarm restart answers it with "it has exited" on
// its own, so it is said only where the shell is proven back: wherever the "can't see the conversation" line shows and nothing
// proves the program that printed it is gone, the switch ends as unknown-exit, with nothing typed after it.
describe('HOLD-C R1 F1: resume-not-found only where the shell is proven back', () => {
  /** A terminal whose relaunch prints `words` on the Enter of the line that holds `on`, and stays up (no box, no prompt). */
  function staysUp(agent: AccountAgent, on: (line: string) => boolean, words: string, over: Partial<ConstructorParameters<typeof FakeTerminal>[0]> = {}): { t: FakeTerminal; io: SwitchIO; writesAfter: string[]; said: () => boolean } {
    const t = new FakeTerminal({ agent, family: 'powershell', reports: false, os: 'tells', start: 'idle', exit: 'hint', relaunch: ['nothing'], ...over })
    const base = t.io()
    let said = false
    const writesAfter: string[] = []
    const io: SwitchIO = {
      ...base,
      write: (id, key) => {
        if (said) writesAfter.push(key)
        base.write(id, key)
        if (key === '\r' && !said && on(t.ran[t.ran.length - 1] ?? '')) {
          said = true
          t.mode = 'agent'
          t.out += `\r\n${words}\r\n`
        }
      },
    }
    return { t, io, writesAfter, said: () => said }
  }

  it('Claude Code that prints "No conversation found" and is still running, the OS saying so, is unknown-exit with nothing more typed', async () => {
    const s = staysUp('claude', (line) => line.includes('--resume'), `No conversation found with session ID: ${NEW_ID}`)
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'powershell' }, {
      io: s.io, agent: 'claude', start: { at: s.t.launchedAt, commands: [s.t.launchLine()] }, target: TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(s.said()).toBe(true)
    expect(outcome).toEqual({ kind: 'unknown-exit', osSees: true })
    expect(s.writesAfter).toEqual([])
  })

  it('Claude Code that prints it and goes, the OS saying the shell is alone, is still resume-not-found', async () => {
    const s = staysUp('claude', (line) => line.includes('--resume'), `No conversation found with session ID: ${NEW_ID}`)
    const write = s.io.write
    s.io.write = (id, key) => {
      const before = s.said()
      write(id, key)
      if (!before && s.said()) s.t.mode = 'shell'
    }
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'powershell' }, {
      io: s.io, agent: 'claude', start: { at: s.t.launchedAt, commands: [s.t.launchLine()] }, target: TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome).toEqual({ kind: 'resume-not-found' })
  })

  it('Codex whose new session in place says it too and stays up is unknown-exit, with nothing typed after it', async () => {
    // The resume line's "No saved session found" ends at the shell's prompt (FakeTerminal's 'not-found'); the new session's line
    // gets the same words, and that Codex stays.
    const s = staysUp('codex', (line) => line.includes('codex') && !line.includes(' resume '), 'No saved session found with ID 123', { relaunch: ['not-found', 'nothing'], reports: true })
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: CODEX_TARGET.id, shellType: 'powershell' }, {
      io: s.io, agent: 'codex', start: { at: s.t.launchedAt, commands: [s.t.launchLine()] }, target: CODEX_TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(s.said()).toBe(true)
    expect(outcome).toEqual({ kind: 'unknown-exit', osSees: true })
    expect(s.writesAfter).toEqual([])
  })
})

describe('Codex R3 MINOR (limitLook.ts:120): the limit look never latches "ended" from the screen alone', () => {
  it('keeps an agent whose closing rule came late live, at every look', () => {
    let raw = PARTIAL
    const io: SwitchIO = {
      output: () => ({ raw, end: raw.length }), outputFrom: (_id, at) => raw.slice(at), end: () => raw.length,
      size: () => ({ cols: 120, rows: 30 }), write: () => {}, sleep: async () => {}, now: () => 0,
    }
    const start: LiveStart = { at: 0, time: 0, agent: 'claude', commands: ['claude'] }
    expect(lookForLimit(io, 'probe', start, 3000).live).toBe(true)
    expect(lookForLimit(io, 'probe', start, 4000).live).toBe(true)
    raw = PARTIAL + '\r\n' + RULE
    expect(lookForLimit(io, 'probe', start, 4100).live).toBe(true)
    expect(start.ended).toBeUndefined()
  })
})

// Opus R3-1: a static agent screen at the shell's first prompt, the only report since the start, reads as running: Claude Code's
// 13 captured limit screens, its rate-limit menu, its edit question, its bypass warning, Codex's rate-limit and update menus, and
// Codex's "Resuming session…". No look of them is an exit, however many, and nothing is typed at the prompt.
interface Screen {
  name: string
  agent: AccountAgent
  raw: string
  start: LiveStart
  cols: number
  rows: number
}

function fakeScreen(name: string, agent: AccountAgent, state: FakeTerminal['agentState']): Screen {
  const t = new FakeTerminal({ agent, family: 'posix', start: 'idle', exit: 'hint' })
  t.agentState = state
  return { name, agent, raw: t.prompt() + t.launchLine() + '\r\n' + t.frame(), start: { at: t.launchedAt, commands: [t.launchLine()], agent, time: 0, prompted: true } as LiveStart, cols: 80, rows: 24 }
}

const SCREENS: Screen[] = [
  ...Object.entries(limits.captures).flatMap(([name, c]) => c.screens.map((s, i) => ({
    name: `capture ${name} #${i}`, agent: 'claude' as const, raw: c.raw.slice(0, s.at), start: { at: 0, commands: ['claude'], agent: 'claude' as const, time: 0 }, cols: s.cols, rows: s.rows,
  }))),
  { name: 'rateLimitMenu', agent: 'claude', raw: REPORT + '$ ' + inputScreens.rateLimitMenu.raw, start: { at: 0, commands: ['claude'], agent: 'claude', time: 0 }, cols: 80, rows: 24 },
  { name: 'codex updateMenu', agent: 'codex', raw: PS_REPORT + agentScreens.codex.updateMenu, start: { at: 0, commands: ['codex'], agent: 'codex', time: 0 }, cols: 120, rows: 30 },
  fakeScreen('claude edit question', 'claude', 'question'),
  fakeScreen('claude bypass warning', 'claude', 'asks'),
  fakeScreen('claude rate-limit menu', 'claude', 'menu'),
  fakeScreen('codex rate-limit menu', 'codex', 'menu'),
  fakeScreen('codex resuming session', 'codex', 'loading'),
]

describe('Opus R3-1: a static agent screen reads as running', () => {
  it.each(SCREENS.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    // The switch's first look, with no second one: not gone, and no sleep spent on a look again.
    const look = probe(s.raw, undefined, s.cols, s.rows)
    const alive = await livenessNow(look.io, 'probe', s.agent, s.start, { known: false })
    expect(alive.state).not.toBe('gone')
    expect(look.sleeps).toEqual([])
    // The limit look, again and again as the screen stays: live each time.
    const start: LiveStart = { ...s.start }
    for (const now of [3000, 4000, 6000, 10_000]) expect(lookForLimit(look.io, 'probe', start, now).live).toBe(true)
    // And the switch types nothing at the prompt.
    const sw = probe(s.raw, undefined, s.cols, s.rows)
    await switchOf(sw.io, s.agent, s.start)
    typedNothingAtPrompt(sw.keys)
  })
})

describe('a real shell with integration whose agent exited still switches with no wait', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)('%s: the relaunch is typed with no sleep before it', async (family) => {
    const t = new FakeTerminal({ agent: 'claude', family, start: 'gone-hint', exit: 'hint' })
    const writeAt: number[] = []
    const base = t.io()
    const io: SwitchIO = { ...base, write: (id, key) => { writeAt.push(t.clock); base.write(id, key) } }
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: family === 'posix' ? 'gitbash' : family }, {
      io, agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, target: TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome).toMatchObject({ kind: 'switched', sessionId: ID })
    expect(writeAt[0]).toBe(0)
    expect(t.ran.filter((line) => line !== '')).toHaveLength(1)
  })
})

// HOLD-C R1 F2: a record of an agent typed over one never seen ended (limitLook.ts noteEnteredLine, a terminal that can't show an exit) may be
// a line the agent before took into itself: the switch from it types nothing, whatever the screen shows, and on the user's word that it
// exited resumes no conversation, neither the one a hint on screen names nor the one Termpolis launched, and carries no flags.
describe('a record typed over one never seen ended (HOLD-C R1 F2)', () => {
  const over = (t: FakeTerminal) => ({ at: t.launchedAt, commands: ['claude'], unsure: true as const, overUnended: true as const })

  it('types nothing without the user\'s word, even where the screen shows the shell back with an exit hint', async () => {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'gone-hint', exit: 'hint' })
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'gitbash' }, {
      io: t.io(), agent: 'claude', start: over(t), target: TARGET, sessionId: ID, hasTranscript: () => true, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome).toEqual({ kind: 'unknown-exit' })
    expect(t.writes).toEqual([])
  })

  it('on the user\'s word starts a new session, bare, resuming neither the hint\'s conversation nor the launch\'s', async () => {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'gone-hint', exit: 'hint' })
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'gitbash', assumeExited: true }, {
      io: t.io(), agent: 'claude', start: over(t), target: TARGET, sessionId: '33333333-4444-4555-8666-777777777777', hasTranscript: () => true,
      newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome).toEqual({ kind: 'fresh', why: 'no-session', unseenStart: true })
    expect(t.ran.join('\n')).not.toContain(ID)
    expect(t.ran.join('\n')).not.toContain('33333333-4444-4555-8666-777777777777')
    expect(t.ran.join('\n')).toContain(`--session-id ${NEW_ID}`)
  })
})
