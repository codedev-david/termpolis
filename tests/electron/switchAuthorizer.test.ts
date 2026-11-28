// @vitest-environment node
//
// HOLD-C R3 (signoff-decisions.md 'HOLD-C R3'): screen content may only veto, never authorize. A key goes to a terminal only on the OS's
// word (it sees the agent running, for its exit command; it sees only the shell, for a line at the prompt) or the shell's own (its prompt
// report the latest thing in the terminal, nothing an agent draws after it). A box at the foot, a prompt drawn, a box showing a text: a
// veto at most. With neither word, nothing is typed (unknown-exit). The probes are Codex R2's (/tmp/hc2/tests/probe/hold-c-round2.test.ts
// :73, :79, :87, :95, :115, :132) rebuilt by name, and Opus R3's (holdc-review.md '## Round 3').
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetSwitchLocksForTest, exitConfirmed, livenessNow, runAccountSwitch } from '../../src/main/accountSwitch'
import type { SwitchContext, SwitchIO } from '../../src/main/accountSwitch'
import { runAgyStep } from '../../src/main/agySwitch'
import { noteEnteredLine } from '../../src/main/limitLook'
import type { LiveStart } from '../../src/main/limitLook'
import { PROMPT_REPORT as MAIN_REPORT, promptLatest, promptsIn } from '../../src/main/mcpServer'
import { LINE_CLEAR, PROMPT_REPORT, lastPromptReport } from '../../src/shared/accountSwitch'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import { agentUiAtFoot } from '../../src/shared/agentStatusDetector'
import type { AccountAgent, AgentAccount } from '../../src/shared/agentAccounts'
import { atShellPrompt, promptReported } from '../../src/renderer/src/lib/promptReport'
import { FakeTerminal, ID } from './_switchTerminal'

const E = '\x1b'
const REPORT = `${E}]7;file://host/tmp/project\x07`
const OSC133 = `${E}]133;A\x07`
const OSC633 = `${E}]633;A\x07`
const WIPE = `${E}[H${E}[2J`
const RULE = '─'.repeat(20)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
/** Claude Code's box, as Codex's probes draw it. */
const FRAME = 'Claude Code\r\n' + RULE + '\r\n❯ \r\n' + RULE
/** Its box, live at the screen's foot. */
const LIVE = 'claude\r\n' + FRAME + '\r\n' + FOOTER
const LIVE_EXIT = WIPE + 'Claude Code\r\n' + RULE + '\r\n❯ /exit\r\n' + RULE + '\r\n' + FOOTER
/** Claude Code's rate-limit menu, laid out as the real capture (agentScreensInput.json rateLimitMenu): under a rule, its box gone. */
const LIMIT_MENU = ['❯ hi', "  ⎿ \u00a0You've hit your session limit · resets 3pm (America/New_York)", '', '❯ /rate-limit-options', '', RULE, '  What do you want to do?', '', '  ❯ 1. Stop and wait for limit to reset', '    2. Add funds to continue with usage credits', '', '  Enter to confirm · Esc to cancel']
const NEW_ID = '00000000-0000-4000-8000-000000000000'

const TARGET: AgentAccount = { id: 'g2', agent: 'claude', label: 'work', profile: null, autoOffer: true, order: 1, connect: false, origin: 'label', links: [] }
const CODEX_TARGET: AgentAccount = { id: 'b', agent: 'codex', label: 'work', profile: 'C:\\work', autoOffer: true, order: 1, connect: true, origin: 'created', links: [] }

interface Probe {
  io: SwitchIO
  keys: string[]
  raw: () => string
}

/** A terminal whose output is `initial`; `onWrite` answers a key with output, `alone` is the OS's word (absent: it has none). */
function probe(initial: string, opts: { onWrite?: (key: string, raw: string) => string; alone?: () => boolean | null; cols?: number; rows?: number } = {}): Probe {
  let raw = initial
  let now = 0
  const keys: string[] = []
  const io: SwitchIO = {
    output: () => ({ raw, end: raw.length }),
    outputFrom: (_id, at) => raw.slice(at),
    end: () => raw.length,
    size: () => ({ cols: opts.cols ?? 120, rows: opts.rows ?? 30 }),
    write: (_id, key) => {
      keys.push(key)
      if (opts.onWrite) raw = opts.onWrite(key, raw)
    },
    sleep: async (ms) => { now += ms },
    now: () => now,
    ...(opts.alone ? { shellAlone: async () => opts.alone!() } : {}),
  }
  return { io, keys, raw: () => raw }
}

function switchOf(io: SwitchIO, agent: AccountAgent = 'claude', start: SwitchContext['start'] = { at: 0, commands: [agent] }, assumeExited = false): Promise<SwitchOutcome> {
  return runAccountSwitch({ terminalId: 'probe', targetId: TARGET.id, shellType: 'gitbash', ...(assumeExited ? { assumeExited: true } : {}) }, {
    io, agent, start, target: agent === 'codex' ? CODEX_TARGET : TARGET, newSessionId: () => NEW_ID, record: () => {},
  })
}

beforeEach(() => _resetSwitchLocksForTest())

describe('H3-1: the screen authorizes no key (Codex R2 :73, Opus R3-2, R3-4)', () => {
  it.each([
    ['an indented prompt under it', '  user@host:~$ '],
    ['a second box drawn under it', RULE + '\r\n❯ \r\n' + RULE],
    ['nothing under it', ''],
  ])('Codex R2 :73: a Claude Code frame with %s, no report and no OS answer, is sent nothing', async (_name, suffix) => {
    const p = probe('claude\r\n' + FRAME + '\r\n' + suffix)
    expect(await switchOf(p.io)).toEqual({ kind: 'unknown-exit' })
    expect(p.keys).toEqual([])
  })

  it('R3-4: Claude Code\'s box at the foot with its footer, no report and no OS answer, is sent nothing', async () => {
    const p = probe(LIVE)
    expect(await switchOf(p.io)).toEqual({ kind: 'unknown-exit' })
    expect(p.keys).toEqual([])
  })

  it('the same box, the OS seeing the agent run, is sent /exit and its Enter', async () => {
    const p = probe(LIVE, { alone: () => false, onWrite: (key, raw) => (key === '/exit' ? raw + LIVE_EXIT : raw) })
    await switchOf(p.io)
    expect(p.keys.slice(0, 2)).toEqual(['/exit', '\r'])
  })

  it('R3-2: Claude Code\'s limit menu left with no box above a plain prompt, no report and no OS answer, gets no Esc', async () => {
    const p = probe('claude\r\n' + LIMIT_MENU.join('\r\n') + '\r\nuser@host:~$ ')
    expect(await switchOf(p.io)).toEqual({ kind: 'unknown-exit' })
    expect(p.keys).toEqual([])
  })

  it('R3-2: the same frame, the OS seeing a program run, gets no Esc either: a shell row is at the foot, not the menu', async () => {
    const p = probe('claude\r\n' + LIMIT_MENU.join('\r\n') + '\r\nuser@host:~$ ', { alone: () => false })
    expect(await switchOf(p.io)).toEqual({ kind: 'unknown-exit' })
    expect(p.keys).toEqual([])
  })

  it('the live limit menu at the foot, the OS seeing the agent run, is still closed with Esc', async () => {
    const p = probe('claude\r\n' + LIMIT_MENU.join('\r\n'), { alone: () => false })
    await switchOf(p.io)
    expect(p.keys[0]).toBe(E)
  })

  it('livenessNow reads a live screen with no OS answer as unknown', async () => {
    expect(await livenessNow(probe(LIVE).io, 'probe', 'claude', { at: 0, commands: ['claude'] }, { known: false })).toEqual({ state: 'unknown' })
  })

  it('exitConfirmed takes no shell report an agent drew over as the exit, with no OS answer; the report alone, latest, is', async () => {
    // Something printed since the exit was typed, then the shell's report (promptSince's word).
    const over = probe(LIVE + '\r\nGoodbye!\r\n' + REPORT + 'user@host:~$ ' + WIPE + FRAME + '\r\n' + FOOTER)
    expect(await exitConfirmed(over.io, 'probe', 'claude', LIVE.length, { known: false })).toBeNull()
    const latest = probe(LIVE + '\r\nGoodbye!\r\n' + REPORT + 'user@host:~$ ')
    expect(await exitConfirmed(latest.io, 'probe', 'claude', LIVE.length, { known: false })).toEqual({ hint: null })
  })
})

describe('H3-1, H3-2: a stale frame, and the Enter after /exit (Codex R2 :79)', () => {
  it('Codex R2 :79: a stale compositor that echoes "❯ /exit", then the shell\'s report and prompt, gets no key at all with no OS answer', async () => {
    const p = probe(LIVE, { onWrite: (key, raw) => (key === '/exit' ? raw + LIVE_EXIT + '\r\n' + REPORT + 'user@host:~$ ' : raw) })
    expect(await switchOf(p.io)).toEqual({ kind: 'unknown-exit' })
    expect(p.keys).toEqual([])
    expect(p.keys).not.toContain('\r')
  })

  it('H3-2: the OS seeing the agent at the start and only the shell once /exit is typed: no Enter', async () => {
    let typed = false
    const p = probe(LIVE, { alone: () => typed, onWrite: (key, raw) => { if (key === '/exit') { typed = true; return raw + LIVE_EXIT } return raw } })
    expect(await switchOf(p.io)).toEqual({ kind: 'exit-unconfirmed', osSees: true })
    expect(p.keys).toEqual(['/exit'])
  })

  it('H3-2: the OS still seeing a program, but the shell\'s report arriving with the echo: no Enter', async () => {
    const p = probe(LIVE, { alone: () => false, onWrite: (key, raw) => (key === '/exit' ? raw + LIVE_EXIT + '\r\n' + REPORT + 'user@host:~$ ' : raw) })
    expect(await switchOf(p.io)).toEqual({ kind: 'exit-unconfirmed', osSees: true })
    expect(p.keys).toEqual(['/exit'])
  })

  it('H3-2: agy\'s Enter after /exit is withheld the same way, with the existing why', async () => {
    let typed = false
    const t = new FakeTerminal({ agent: 'agy', family: 'posix', start: 'idle', exit: 'hint', os: 'tells' })
    const base = t.io()
    const io: SwitchIO = { ...base, shellAlone: async () => (typed ? true : base.shellAlone!('t1')), write: (id, key) => { base.write(id, key); if (key === '/exit') typed = true } }
    const outcome = await runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'exit' }, { io, start: { at: t.launchedAt, commands: [t.launchLine()] }, env: {}, record: () => {} })
    expect(outcome).toEqual({ kind: 'not-exited', why: 'Termpolis couldn\'t type /exit into agy\'s input, so it typed nothing more' })
    expect(t.writes).toEqual(['/exit'])
  })
})

describe('H3-3: "it has exited" is vetoed by the OS or the agent\'s own UI (Codex R2 :87)', () => {
  it('Codex R2 :87: the user\'s word over Claude Code\'s live box, no report and no OS answer, types nothing', async () => {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', reports: false, os: 'none', start: 'idle', exit: 'hint' })
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'gitbash', assumeExited: true }, {
      io: t.io(), agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, target: TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(t.writes).toEqual([])
  })

  it('the user\'s word over a plain prompt, the OS seeing a program still running past its teardown, types nothing', async () => {
    const p = probe('claude\r\nGoodbye!\r\nuser@host:~$ ', { alone: () => false })
    expect(await switchOf(p.io, 'claude', { at: 0, commands: ['claude'] }, true)).toEqual({ kind: 'exit-unconfirmed', osSees: true })
    expect(p.keys).toEqual([])
  })

  it('the user\'s word over a permission dialog at the foot, no OS answer, types nothing', async () => {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', reports: false, os: 'none', start: 'question', exit: 'hint' })
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'gitbash', assumeExited: true }, {
      io: t.io(), agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, target: TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(t.writes).toEqual([])
  })

  it('agy: the user\'s word over its live box, no OS answer, is not-exited with nothing typed', async () => {
    const t = new FakeTerminal({ agent: 'agy', family: 'posix', reports: false, os: 'none', start: 'idle', exit: 'hint' })
    const outcome = await runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'exit', assumeExited: true }, { io: t.io(), start: { at: t.launchedAt, commands: [t.launchLine()] }, env: {}, record: () => {} })
    expect(outcome).toEqual({ kind: 'not-exited', why: 'agy didn\'t confirm it exited, so Termpolis typed nothing more' })
    expect(t.writes).toEqual([])
  })
})

describe('H3-1: a cwd report followed by an agent\'s output is void (Codex R2 :95)', () => {
  it('Codex R2 :95: Codex that says "No saved session found", then a report, then "Still working…", is sent nothing after it', async () => {
    const t = new FakeTerminal({ agent: 'codex', family: 'posix', os: 'none', start: 'gone-hint', exit: 'hint', relaunch: ['nothing'] })
    const base = t.io()
    const after: string[] = []
    let said = false
    const io: SwitchIO = {
      ...base,
      write: (id, key) => {
        if (said) after.push(key)
        base.write(id, key)
        if (!said && key === '\r' && t.ran.some((line) => line.includes(' resume '))) {
          said = true
          t.mode = 'agent'
          t.out += '\r\nNo saved session found with ID 123\r\n' + `${E}]7;file://host/c/repo\x07`
          t.late = { at: t.clock + 100, text: '\r\nStill working…\r\n' }
        }
      },
    }
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: CODEX_TARGET.id, shellType: 'gitbash' }, {
      io, agent: 'codex', start: { at: t.launchedAt, commands: [t.launchLine()] }, target: CODEX_TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(said).toBe(true)
    expect(after).toEqual([])
    expect(outcome).toEqual({ kind: 'exit-unconfirmed', relaunched: true })
  })
})

describe('H3-1, H3-4: the shell\'s word still switches over a retained frame (Codex R2 :115)', () => {
  const PROMPTS = { bash: 'user@host:~$ ', zsh: 'host% ' } as const
  const EVIDENCE = { cwd: REPORT, os: '', osc133: OSC133, osc633: OSC633 } as const
  const cases = (['bash', 'zsh'] as const).flatMap((shell) => (['cwd', 'os', 'osc133', 'osc633'] as const).map((ev) => [shell, ev] as const))

  it.each(cases)('Codex R2 :115: Claude Code gone, its frame left above a %s prompt, told by %s, is relaunched fresh with no /exit', async (shell, ev) => {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', reports: false, start: 'gone-quiet', relaunch: ['box'], os: ev === 'os' ? 'tells' : 'none' })
    const head = EVIDENCE[ev] + PROMPTS[shell]
    t.out = head + t.launchLine() + '\r\n' + t.frame() + '\r\n' + EVIDENCE[ev] + PROMPTS[shell]
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'gitbash' }, {
      io: t.io(), agent: 'claude', start: { at: head.length, commands: [t.launchLine()] }, target: TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome.kind).toBe('fresh')
    expect(t.writes).not.toContain('/exit')
    expect(t.ran).toContainEqual(expect.stringMatching(/(?:^| )claude --model opus --session-id /))
  })
})

describe('Codex R2 :132: a draft echoed by the shell under a stale frame is no line typed into a box', () => {
  it('a launch whose text matches a draft in the frame above an indented prompt is a new start, over a record never seen ended', () => {
    const draft = 'codex --model example'
    const screen = RULE + '\r\n❯ ' + draft + '\r\n' + RULE + '\r\n  host% ' + draft
    const p = probe(screen, { cols: 80, rows: 24 })
    const start: LiveStart = { at: 0, agent: 'claude', commands: ['claude'], time: 0 }
    expect(noteEnteredLine(p.io, 'probe', start, draft, screen.length, 9000)).toMatchObject({ overUnended: true })
    expect(start.turned).not.toBe(true)
  })
})

describe('H3-4: one report matcher, OSC 133 and 633 included', () => {
  const ACCEPTED = [`${E}]7;file://h/x\x07`, `${E}]9;9;C:\\x\x07`, `${E}]133;A\x07`, `${E}]133;B\x07`, `${E}]133;D;0\x07`, `${E}]133;A${E}\\`, `${E}]633;A\x07`, `${E}]633;D\x07`, `${E}]633;B;x\x07`]
  const REJECTED = [`${E}]133;C\x07`, `${E}]633;E;ls\x07`, `${E}]633;P;Cwd=/x\x07`, `${E}]1337;CurrentDir=/x\x07`, `${E}]7501;x\x07`, `${E}]133;AB\x07`, `${E}]0;title\x07`]

  it.each(ACCEPTED.map((r) => [JSON.stringify(r), r]))('accepts %s in main, the renderer and the switch', (_n, report) => {
    expect(MAIN_REPORT).toBe(PROMPT_REPORT)
    expect(lastPromptReport('x' + report + '$ ')).toBe(1)
    expect(promptReported(report)).toBe(true)
    expect(atShellPrompt(report + '$ ')).toBe(true)
    expect(promptsIn(report + '$ ')).toEqual([0])
  })

  it.each(REJECTED.map((r) => [JSON.stringify(r), r]))('rejects %s everywhere', (_n, report) => {
    expect(lastPromptReport(report + '$ ')).toBe(-1)
    expect(promptReported(report)).toBe(false)
    expect(promptsIn(report + '$ ')).toEqual([])
  })

  it('takes reports on one line (133 A, then OSC 7) as one prompt start', () => {
    expect(promptsIn(`${OSC133}${E}]7;file://h/x\x07$ `)).toHaveLength(1)
  })
})

describe('promptLatest: the shell\'s report is the latest thing there', () => {
  it.each([
    ['a prompt drawn after it', REPORT + 'user@host:~$ ', true],
    ['a two-line prompt', REPORT + 'me@host MINGW64 /c/repo\r\n$ ', true],
    ['no report', 'user@host:~$ ', false],
    ['a bare report', REPORT, false],
    ['output that ends a line after it', REPORT + 'user@host:~$ \r\nStill working…\r\n', false],
    ['an agent\'s frame after it', REPORT + 'user@host:~$ ' + WIPE + 'Claude Code\r\n' + RULE + '\r\n❯ \r\n' + RULE + '\r\n' + FOOTER, false],
    ['many rows after it', REPORT + 'a\r\nb\r\nc\r\nd', false],
    ['a busy line after it', REPORT + '✻ Thinking… (2s · esc to interrupt)', false],
    ['the alternate screen entered after it', REPORT + 'user@host:~$ ' + `${E}[?1049h` + 'x', false],
    ['the alternate screen left after it', REPORT + `${E}[?1049h${E}[?1049l` + 'user@host:~$ ', true],
  ])('%s: %s', (_name, raw, latest) => {
    expect(promptLatest(raw, 0, { cols: 80, rows: 24 })).toBe(latest)
  })
})

describe('agentUiAtFoot: a veto only', () => {
  it.each([
    ['a box at the foot', ['Claude Code', RULE, '❯ ', RULE, FOOTER], true],
    ['a box with a shell row under it', ['Claude Code', RULE, '❯ ', RULE, 'user@host:~$'], false],
    ['the limit menu at the foot', LIMIT_MENU, true],
    ['the limit menu with a shell row under it', [...LIMIT_MENU, 'user@host:~$'], false],
    ['a permission dialog', ['● I will edit the file.', '', RULE, ' Do you want to make this edit to app.ts?', ' ❯ 1. Yes', '   2. No'], true],
    ['a picker', ['  Resume Session', '', '❯ Fix the login bug', '  2 hours ago · 14 messages', '  Add tests', '', '  ↑↓ to navigate · Enter to select · Esc to exit'], true],
    ['a busy line', ['✻ Thinking… (2s · esc to interrupt)', ''], true],
    ['plain output', ['hello', 'world'], false],
    ['nothing', [], false],
  ])('%s: %s', (_name, rows, atFoot) => {
    expect(agentUiAtFoot(rows as string[], 'Claude Code', '', 80)).toBe(atFoot)
  })
})

describe('the shell\'s word: a report as the latest event still switches, with no OS answer', () => {
  it('a frame left above a reported prompt, typed nothing into, switches by the line at the prompt', async () => {
    const before = REPORT + '$ '
    const p = probe(before + 'claude\r\n' + FRAME + '\r\n' + REPORT + 'user@host:~$ ')
    await switchOf(p.io, 'claude', { at: before.length, commands: ['claude'] })
    expect(p.keys).not.toContain('/exit')
    expect(p.keys.slice(0, 2)).toEqual([LINE_CLEAR.posix, '\r'])
  })

  it('the same report followed by Claude Code\'s frame again (it ran after the prompt) is no word: nothing is typed', async () => {
    const before = REPORT + '$ '
    const p = probe(before + 'claude\r\n' + FRAME + '\r\n' + REPORT + 'user@host:~$ claude\r\n' + WIPE + FRAME + '\r\n' + FOOTER)
    expect(await switchOf(p.io, 'claude', { at: before.length, commands: ['claude'] })).toEqual({ kind: 'unknown-exit' })
    expect(p.keys).toEqual([])
  })

  it('names the session the exit hint holds where the shell reported its prompt after it', async () => {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'gone-hint', exit: 'hint', relaunch: ['box'] })
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: TARGET.id, shellType: 'gitbash' }, {
      io: t.io(), agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, target: TARGET, newSessionId: () => NEW_ID, record: () => {},
    })
    expect(outcome).toMatchObject({ kind: 'switched', sessionId: ID })
  })
})
