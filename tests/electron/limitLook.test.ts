// @vitest-environment node
//
// The usage-limit chooser's look at a terminal, main's side (src/main/limitLook.ts): what the
// screen shows, judged once, and where the agent Termpolis started there stands (R5). A limit
// counts only while that agent is live, and only once it has taken a turn (R4). The terminal is the
// scripted one of _switchTerminal.ts: a shell and the agent in it, each drawn as it draws itself.
import { describe, it, expect } from 'vitest'
import { FOREGROUND_GRACE_MS, agentGone, agentOfLaunch, lookForLimit, noteEnteredLine } from '../../src/main/limitLook'
import type { LiveStart } from '../../src/main/limitLook'
import type { SwitchIO } from '../../src/main/accountSwitch'
import { liveness, livenessNow } from '../../src/main/accountSwitch'
import type { AccountAgent } from '../../src/shared/agentAccounts'
import { stopKind } from '../../src/shared/agentStatusDetector'
import { FakeTerminal, ID, RULE } from './_switchTerminal'
import type { TermScript } from './_switchTerminal'

const E = '\x1b'
const LIMIT = '  ⎿ \u00a0You\'ve hit your session limit · resets 3pm (America/New_York)'
/** A screen as ConPTY paints it: cleared, then each row at its place. */
const paint = (rows: string[]): string => `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')
const CLAUDE_LIMIT = paint(['❯ Build the login page.', LIMIT, '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'])

function setup(over: Partial<TermScript> = {}): { t: FakeTerminal; start: LiveStart } {
  const t = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', ...over })
  return { t, start: { at: t.launchedAt, commands: [t.launchLine()], agent: t.s.agent, time: 0 } }
}


describe('agentOfLaunch: an agent typed with its path or extension (MODELS-R1-1)', () => {
  it('reads claude.exe, codex.cmd and a full path as the agent they start', () => {
    expect(agentOfLaunch('claude.exe --model opus')).toBe('claude')
    expect(agentOfLaunch('C:\\tools\\codex.cmd -m gpt-5.6-sol')).toBe('codex')
    expect(agentOfLaunch('/usr/local/bin/agy')).toBe('agy')
    expect(agentOfLaunch('cd proj && C:\\Tools\\Claude.EXE --resume x')).toBe('claude')
    expect(agentOfLaunch("& { $env:CLAUDE_CONFIG_DIR = 'C:\\h\\.claude-b'; claude.exe --resume x }")).toBe('claude')
  })

  it('still reads a word that only ends like an agent, or a path through one, as none', () => {
    expect(agentOfLaunch('myclaude')).toBeNull()
    expect(agentOfLaunch('claude-code --help')).toBeNull()
    expect(agentOfLaunch('cat /usr/share/claude/notes.txt')).toBeNull()
    expect(agentOfLaunch('echo claude.exe')).toBeNull()
  })
})
describe('agentOfLaunch', () => {
  it('reads the agent a line starts, as Termpolis types it in each shell, or as typed by hand', () => {
    expect(agentOfLaunch('claude')).toBe('claude')
    expect(agentOfLaunch(`claude --model opus --session-id ${ID}`)).toBe('claude')
    expect(agentOfLaunch("export CLAUDE_CONFIG_DIR='/home/u/.claude-b' && claude --resume x")).toBe('claude')
    expect(agentOfLaunch('unset CLAUDE_CONFIG_DIR && claude')).toBe('claude')
    expect(agentOfLaunch("& { $env:CODEX_HOME = 'C:\\Users\\u\\.codex-b'; codex -m gpt-5.6-sol }")).toBe('codex')
    expect(agentOfLaunch('& { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue; codex }')).toBe('codex')
    expect(agentOfLaunch('set "CLAUDE_CONFIG_DIR=C:\\Users\\u\\.claude-b" && call claude')).toBe('claude')
    expect(agentOfLaunch('agy')).toBe('agy')
    expect(agentOfLaunch(`agy --conversation=${ID}`)).toBe('agy')
    expect(agentOfLaunch('cd app | codex')).toBe('codex')
  })

  it('reads no launch in a prompt or another command', () => {
    for (const line of ['ls', 'please run claude now', 'recall claude', 'claude, fix the test', 'codexes', '']) {
      expect(agentOfLaunch(line), line).toBeNull()
    }
  })
})

describe('lookForLimit', () => {
  it('reads nothing as counting with no agent started there', () => {
    const { t } = setup()
    t.out += CLAUDE_LIMIT
    expect(lookForLimit(t.io(), 't', undefined, 0)).toMatchObject({ agent: null, live: false, turned: false, startAt: null, words: null })
  })

  it('reads a live agent that has taken no turn yet, then one at work as having taken it', () => {
    const { t, start } = setup()
    expect(lookForLimit(t.io(), 't', start, 0)).toMatchObject({ agent: 'claude', live: true, turned: false, startAt: t.launchedAt })
    t.agentState = 'busy'
    t.out += t.frame()
    expect(lookForLimit(t.io(), 't', start, 0)).toMatchObject({ live: true, turned: true })
    t.agentState = 'idle'
    t.out += t.frame()
    // The turn stays taken.
    expect(lookForLimit(t.io(), 't', start, 0)).toMatchObject({ live: true, turned: true })
  })

  it("reads a limit on a live agent's screen, with the CLI's own words", () => {
    const { t, start } = setup()
    start.turned = true
    t.out += CLAUDE_LIMIT
    const seen = lookForLimit(t.io(), 't', start, 0)
    expect(stopKind(seen.status)).toBe('limit')
    expect(seen).toMatchObject({ live: true, turned: true, words: "You've hit your session limit · resets 3pm (America/New_York)" })
  })

  it('reads the agent gone at its exit hint, and keeps it gone whatever the screen shows after (R5)', () => {
    const { t, start } = setup()
    t.type('/exit')
    t.type('\r')
    expect(lookForLimit(t.io(), 't', start, 0)).toMatchObject({ live: false })
    expect(start.ended).toBe(true)
    // `cat` of a captured limit screen, in the shell: a limit on screen, the agent gone.
    t.out += CLAUDE_LIMIT
    const seen = lookForLimit(t.io(), 't', start, 0)
    expect(stopKind(seen.status)).toBe('limit')
    expect(seen.live).toBe(false)
  })

  it("reads the agent gone at its shell's prompt report, an exit that printed no hint", () => {
    const { t, start } = setup({ exit: 'no-hint' })
    t.type('/exit')
    t.type('\r')
    expect(lookForLimit(t.io(), 't', start, 0).live).toBe(false)
  })

  it('reads the shell back in the PTY\'s foreground as the agent gone, once past the moment it takes to start one', () => {
    const { t, start } = setup({ exit: 'no-hint', reports: false, foreground: true })
    t.type('/exit')
    t.type('\r')
    expect(agentGone(t.io(), 't', start, FOREGROUND_GRACE_MS - 1)).toBe(false)
    expect(agentGone(t.io(), 't', start, FOREGROUND_GRACE_MS)).toBe(true)
    // With no time recorded, the start is old.
    expect(agentGone(t.io(), 't', { ...start, time: undefined }, FOREGROUND_GRACE_MS)).toBe(true)
  })

  it('reads no exit from a hint printed before the agent was started, or one quoted above its box', () => {
    const { t } = setup()
    t.type('/exit')
    t.type('\r')
    // A new launch after the old one's hint, before it draws: the old hint is still at the foot.
    const at = t.out.length
    t.out += `claude --resume ${ID}\r\n`
    const next = { at, commands: [`claude --resume ${ID}`], agent: 'claude' as const, time: 0 }
    expect(agentGone(t.io(), 't', next, 0)).toBe(false)
    t.out += t.frame()
    t.mode = 'agent'
    expect(agentGone(t.io(), 't', next, 0)).toBe(false)
    const quoted = setup({ quoteHint: true })
    expect(lookForLimit(quoted.t.io(), 't', quoted.start, 0).live).toBe(true)
  })

  it("can't tell an exit with no hint in a shell that reports nothing, on Windows: the agent stays live", () => {
    // David's Git Bash, and a session with no turns, which Claude Code prints no hint for.
    const { t, start } = setup({ exit: 'no-hint', reports: false })
    t.type('/exit')
    t.type('\r')
    expect(lookForLimit(t.io(), 't', start, 0).live).toBe(true)
  })

  it('never reads a start of an agent it doesn\'t name for its hint', () => {
    // A shell that reports nothing: the hint is the only sign.
    const { t, start } = setup({ reports: false })
    t.type('/exit')
    t.type('\r')
    expect(agentGone(t.io(), 't', { ...start, agent: undefined }, 0)).toBe(false)
    expect(lookForLimit(t.io(), 't', { ...start, agent: undefined }, 0).agent).toBeNull()
  })
})

describe('noteEnteredLine', () => {
  it('starts a record for an agent typed at the shell, with none started there before', () => {
    const { t } = setup({ start: 'gone-quiet' })
    expect(noteEnteredLine(t.io(), 't', undefined, 'codex -m gpt-5.6-sol', 120, 7)).toEqual({ at: 120, commands: ['codex -m gpt-5.6-sol'], agent: 'codex', time: 7 })
    expect(noteEnteredLine(t.io(), 't', undefined, 'ls', 120, 7)).toBeNull()
  })

  it('counts a prompt entered in the live agent\'s box as a turn (R4), never a slash command', () => {
    const { t, start } = setup()
    expect(noteEnteredLine(t.io(), 't', start, '/model sonnet', 500, 0)).toBeNull()
    expect(start.turned).toBeUndefined()
    // A prompt that reads like a launch is a prompt while the agent runs.
    expect(noteEnteredLine(t.io(), 't', start, 'claude fix the login test', 500, 0)).toBeNull()
    expect(start).toMatchObject({ turned: true })
    expect(start.ended).toBeUndefined()
  })

  it('counts no turn where the agent shows no box (a question of its own in its place)', () => {
    const { t, start } = setup({ start: 'question' })
    expect(noteEnteredLine(t.io(), 't', start, 'y', 500, 0)).toBeNull()
    expect(start.turned).toBeUndefined()
  })

  it('starts a new record for an agent typed once the one before exited, and marks that one gone', () => {
    const { t, start } = setup()
    t.type('/exit')
    t.type('\r')
    const next = noteEnteredLine(t.io(), 't', start, `claude --resume ${ID}`, 900, 5)
    expect(next).toEqual({ at: 900, commands: [`claude --resume ${ID}`], agent: 'claude', time: 5 })
    expect(start.ended).toBe(true)
    // A command at the shell after it is nobody's turn.
    const other = setup()
    other.t.type('/exit')
    other.t.type('\r')
    expect(noteEnteredLine(other.t.io(), 't', other.start, 'git status', 900, 5)).toBeNull()
    expect(other.start).toMatchObject({ ended: true })
    expect(other.start.turned).toBeUndefined()
  })
})

// ── round 1 ────────────────────────────────────────────────────────────────────────────────

/** A terminal showing Claude Code at rest (a real frame: input box, no exit hint, no prompt report), on a
 *  platform that cannot tell the foreground process (Windows): atShell answers null. */
function windowsLike(): SwitchIO {
  const t = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint' })
  return { ...t.io(), atShell: () => null }
}

describe('a live agent on a platform that cannot tell the foreground process', () => {
  it('is not read as exited once past the start grace (Windows reports no foreground)', () => {
    const io = windowsLike()
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0, turned: true }
    const now = FOREGROUND_GRACE_MS + 7000
    expect(agentGone(io, 't1', start, now)).toBe(false)
    const seen = lookForLimit(io, 't1', start, now)
    expect(seen.live).toBe(true)
    expect(start.ended).toBeUndefined()
  })

  it('stays gone once an exit was seen, after its evidence has scrolled away: the next launch typed by hand starts a record', () => {
    const io = windowsLike()
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0, turned: true, ended: true }
    expect(agentGone(io, 't1', start, 10_000)).toBe(true)
    const next = noteEnteredLine(io, 't1', start, 'claude', 500, 10_000)
    expect(next).toMatchObject({ at: 500, agent: 'claude', commands: ['claude'] })
  })
})

describe('where a turn began (R4): an old limit is not the answer to it', () => {
  const OLD = "You've hit your session limit · resets 3pm (America/New_York)"
  const screen = (words: string): string => paint(['❯ Build the login page.', `  ⎿ \u00a0${words}`, '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'])

  /** The terminal's output is `out`; its end is where output stands now. */
  function ioOver(out: { text: string }): SwitchIO {
    const t = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint' })
    const base = t.io()
    return {
      ...base,
      output: () => ({ raw: out.text, end: out.text.length }),
      outputFrom: (_id, from) => out.text.slice(Math.max(0, from)),
      end: () => out.text.length,
      atShell: () => false,
    }
  }

  it('counts a limit printed after the turn began, and not one printed before it', () => {
    const out = { text: screen(OLD) }
    const io = ioOver(out)
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0 }
    // The Enter that submits a prompt lands now; the CLI has not redrawn.
    expect(noteEnteredLine(io, 't1', start, 'continue', out.text.length, 1)).toBeNull()
    expect(start).toMatchObject({ turned: true, turnedAt: out.text.length })
    expect(lookForLimit(io, 't1', start, 1)).toMatchObject({ turned: false, words: OLD })
    out.text += screen(OLD)
    expect(lookForLimit(io, 't1', start, 2)).toMatchObject({ turned: true, words: OLD })
  })

  it('keeps a turn with no limit on screen a turn', () => {
    const io = ioOver({ text: '' })
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0, turned: true, turnedAt: 0 }
    expect(lookForLimit(io, 't1', start, 1).turned).toBe(true)
  })

  // CHOOSER-R1-5 (K06): the words matched against what was printed since the turn began are the limit's first 40
  // letters. Anything else printed since is no redraw of the old limit.
  it('counts other text printed since the turn began as no redraw of the old limit', () => {
    const out = { text: screen(OLD) }
    const io = ioOver(out)
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0 }
    noteEnteredLine(io, 't1', start, 'continue', out.text.length, 1)
    // Text with the letters of the old limit's start in it, but not its words.
    out.text += 'You asked your assistant to review the session now'
    expect(lookForLimit(io, 't1', start, 2)).toMatchObject({ turned: false, words: OLD })
  })

  // CHOOSER-R1-4: Codex 0.153's header says "model: loading" until it is up, with its box already drawn, and the
  // detector reads that as at work. The 45 real fresh-launch streams of the #36 runs latch a turn at 0.7 s that
  // way, before any prompt. A resumed conversation's old limit drawn after that would then count as fresh.
  it('does not take Codex\'s start-up "model: loading" for a turn, and takes the first real one', () => {
    const LOADING = ['╭──────────────────────────────────────────╮', '│ >_ OpenAI Codex (v0.153.4)               │', '│ model:     loading   /model to change    │', '╰──────────────────────────────────────────╯', '', '› Ask Codex to do anything', '', '  ? for shortcuts']
    const out = { text: paint(LOADING) }
    const io = ioOver(out)
    const start: LiveStart = { at: 0, commands: ['codex resume x'], agent: 'codex', time: 0 }
    expect(lookForLimit(io, 't1', start, 1)).toMatchObject({ live: true, turned: false })
    expect(start.turnedAt).toBeUndefined()
    // It is up, idle: still no turn.
    out.text += paint(['› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~/repo'])
    expect(lookForLimit(io, 't1', start, 2).turned).toBe(false)
    // The first turn the user takes.
    out.text += paint(['› go on', '• Working (3s • esc to interrupt)', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~/repo'])
    expect(lookForLimit(io, 't1', start, 3).turned).toBe(true)
    expect(start.turnedAt).toBe(out.text.length)
  })

  // F-R2-4 (P08, P09, C06): Codex 0.164 draws its composer while it still looks for the session ("Resuming session…"), and
  // the detector reads the row it draws there as at work. That is the same start-up as "model: loading": no prompt was taken,
  // so it is no turn, and the old limit its resumed session draws after is not a fresh one.
  it('does not take Codex\'s "Resuming session…" start-up for a turn either, and takes the first real one', () => {
    const RESUMING = ['  Resuming session…', '• Working (1s • esc to interrupt)', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~/repo']
    const out = { text: paint(RESUMING) }
    const io = ioOver(out)
    const start: LiveStart = { at: 0, commands: ['codex resume x'], agent: 'codex', time: 0 }
    expect(lookForLimit(io, 't1', start, 1)).toMatchObject({ live: true, turned: false })
    expect(start.turnedAt).toBeUndefined()
    // Up, with no such row any more: still no turn until the user takes one.
    out.text += paint(['› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~/repo'])
    expect(lookForLimit(io, 't1', start, 2).turned).toBe(false)
    out.text += paint(['› go on', '• Working (3s • esc to interrupt)', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~/repo'])
    expect(lookForLimit(io, 't1', start, 3).turned).toBe(true)
  })

  it('does not take either start-up of Claude Code or agy for anything but a turn at work', () => {
    // Only Codex's own start-up words are no turn; the same row on another agent's screen is work.
    for (const agent of ['claude', 'agy'] as const) {
      const io = ioOver({ text: paint(['  Resuming session…', '✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ ', RULE]) })
      const start: LiveStart = { at: 0, commands: [agent], agent, time: 0 }
      expect(lookForLimit(io, 't1', start, 1).turned, agent).toBe(true)
    }
  })

  it('still takes a turn at work from Claude Code and agy as before', () => {
    for (const agent of ['claude', 'agy'] as const) {
      // Even with the words Codex's loading screen uses in what it quoted: only Codex's own header means "starting".
      const io = ioOver({ text: paint(['● Resuming session… and model: loading are what Codex draws', '❯ go on', '✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ ', RULE]) })
      const start: LiveStart = { at: 0, commands: [agent], agent, time: 0 }
      expect(lookForLimit(io, 't1', start, 1).turned, agent).toBe(true)
    }
  })

  it('takes a turn seen at work from the look that saw it', () => {
    const out = { text: paint(['❯ go on', '✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ ', RULE]) }
    const io = ioOver(out)
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0 }
    expect(lookForLimit(io, 't1', start, 1)).toMatchObject({ turned: true })
    expect(start.turnedAt).toBe(out.text.length)
    // A turn already begun keeps its place when it is seen at work again.
    const earlier = out.text.length
    out.text += paint(['❯ go on', '✻ Thinking… (9s · esc to interrupt)', '', RULE, '❯ ', RULE])
    lookForLimit(io, 't1', start, 2)
    expect(start.turnedAt).toBe(earlier)
  })

  it('has no turn in a start with none: a limit on screen is not counted, with or without words', () => {
    const out = { text: screen(OLD) }
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0 }
    expect(lookForLimit(ioOver(out), 't1', start, 1)).toMatchObject({ turned: false, words: OLD })
  })

  it('matches the words in raw output by their letters and digits, through colour and cursor moves', () => {
    const out = { text: '' }
    const io = ioOver(out)
    const start: LiveStart = { at: 0, commands: ['claude'], agent: 'claude', time: 0, turned: true, turnedAt: 0 }
    out.text = `${E}[1;31m  ⎿ ${E}[0m${E}[2;5HYou've hit your ${E}[5;9Hsession limit · resets 3pm (America/New_York)${E}[H`
    out.text += screen(OLD)
    expect(lookForLimit(io, 't1', start, 1)).toMatchObject({ turned: true })
  })

  it('treats /resume and /continue typed in a live agent like a relaunch, and no other slash command', () => {
    const io = ioOver({ text: 'x'.repeat(50) })
    for (const line of ['/resume', '/continue', '/resume 3f2a']) {
      const start: LiveStart = { at: 5, commands: ['claude'], agent: 'claude', time: 1, turned: true, turnedAt: 9 }
      expect(noteEnteredLine(io, 't1', start, line, 77, 1234)).toBeNull()
      expect(start).toMatchObject({ turned: false, at: 77, time: 1234 })
      expect(start.turnedAt).toBeUndefined()
    }
    for (const line of ['/model', '/clear', '/resumed', '/exit']) {
      const start: LiveStart = { at: 5, commands: ['claude'], agent: 'claude', time: 1, turned: true, turnedAt: 9 }
      expect(noteEnteredLine(io, 't1', start, line, 77, 1234)).toBeNull()
      expect(start).toMatchObject({ turned: true, turnedAt: 9, at: 5 })
    }
  })

  it('leaves an agent that has exited, and a terminal with none, alone for /resume', () => {
    const io = ioOver({ text: '' })
    const gone: LiveStart = { at: 5, commands: ['claude'], agent: 'claude', time: 1, turned: true, ended: true }
    expect(noteEnteredLine(io, 't1', gone, '/resume', 77, 1234)).toBeNull()
    expect(gone).toMatchObject({ turned: true, at: 5 })
    expect(noteEnteredLine(io, 't1', undefined, '/resume', 77, 1234)).toBeNull()
  })
})

describe('a long launch line Git Bash on Windows echoes late (the CI run of 2026-11-07)', () => {
  const LINE = `unset CODEX_HOME && codex -c "developer_instructions='${'Termpolis project memory: saved background context exists. '.repeat(12)}'"`
  const report = `${E}]7;file://host/tmp/project\x07`
  const prompt = `${E}[32m\r\nrunner@host ${E}[35mUCRT64 ${E}[33m/tmp/project${E}[m\r\n$ `
  /** Bash at its prompt when the line is entered (at), one more prompt it prints before the echo, then the echo. */
  const BEFORE = `${report}${prompt}${E}[?2004h`
  const AFTER = `${E}[?2004l${report}${prompt}`
  function io(out: string): SwitchIO {
    return {
      output: () => ({ raw: out, end: out.length }),
      outputFrom: (_id, from) => out.slice(from),
      end: () => out.length,
      size: () => ({ cols: 98, rows: 36 }),
      write: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    }
  }
  const start: LiveStart = { at: BEFORE.length, commands: [LINE], agent: 'codex', time: 0 }

  // A prompt with nothing printed before it since the start is the shell's extra one, no word that the agent ran and exited, at any
  // moment: the screen's timing is never evidence (HOLD-C, signoff-decisions.md 2026-11-28).
  it('is no exit at the prompt printed before the echo, at any moment', () => {
    for (const now of [FOREGROUND_GRACE_MS - 1, FOREGROUND_GRACE_MS, FOREGROUND_GRACE_MS * 100]) expect(agentGone(io(BEFORE + AFTER), 't', start, now)).toBe(false)
  })

  it('is no exit with the line half echoed, at any moment', () => {
    for (const cut of [40, 100, LINE.length - 5]) {
      expect(agentGone(io(BEFORE + AFTER + LINE.slice(0, cut)), 't', start, FOREGROUND_GRACE_MS * 10)).toBe(false)
    }
    expect(agentGone(io(BEFORE + AFTER + LINE + '\r\n'), 't', start, FOREGROUND_GRACE_MS * 10)).toBe(false)
  })

  it('still reads an agent that printed something and exited in that moment as gone', () => {
    expect(agentGone(io(`${BEFORE}${LINE}\r\nError: no such model${AFTER}`), 't', start, 0)).toBe(true)
  })

  it('reads a prompt after the agent ran that only ends like the line, or like a line too short to tell, as the shell back', () => {
    const ran = `${BEFORE}${LINE}\r\nError: no such model${AFTER}`
    expect(agentGone(io(ran + LINE.slice(0, 20)), 't', start, FOREGROUND_GRACE_MS)).toBe(true)
    const brief: LiveStart = { ...start, commands: ['codex -m o3'] }
    expect(agentGone(io(ran + 'codex -m'), 't', brief, FOREGROUND_GRACE_MS)).toBe(true)
    // The line's head twice, the second time not followed by the rest of it.
    expect(agentGone(io(ran + LINE.slice(0, 40) + ' ' + LINE.slice(0, 30) + 'zzz'), 't', start, FOREGROUND_GRACE_MS)).toBe(true)
  })
})

describe('a launch line typed before Git Bash printed its first prompt (the loaded laptop of 2026-11-26)', () => {
  // What ConPTY sent before the shell's first prompt (its modes), then, after the line was entered: bash's first prompt
  // report, ConPTY's first paint (a wipe), the prompt with the line echoed at it, and the agent's box.
  const LINE = 'unset CLAUDE_CONFIG_DIR && claude --session-id 3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
  const report = `${E}]7;file://host/tmp/project\x07`
  const BEFORE = `${E}[?9001h${E}[?1004h`
  const FIRST = `${report}${E}[?25l${E}[2J${E}[m${E}[H${E}]0;C:\\Program Files\\Git\\bin\\bash.exe\x07${E}[?25h${E}[?2004hbash-5.3$ `
  const ECHO = `${LINE}${E}[?2004l\r\n`
  const BOX = `${E}[?25l${E}[H${E}[?25h${E}[2J${E}[?25l▐▛███▜▌ Claude Code v2.1.309 (mock)${E}[K\r\n\r\n${RULE}\r\n❯${E}[K\r\n${RULE}\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)${E}[K\r\n`
  const AGAIN = `${report}${E}[?2004hbash-5.3$ `
  function io(out: string, clock = { t: 0 }): SwitchIO {
    return {
      output: () => ({ raw: out, end: out.length }),
      outputFrom: (_id, from) => out.slice(from),
      end: () => out.length,
      size: () => ({ cols: 120, rows: 30 }),
      write: () => undefined,
      sleep: async (ms) => { clock.t += ms },
      now: () => clock.t,
    }
  }
  const start = (): LiveStart => ({ at: BEFORE.length, commands: [LINE], agent: 'claude', time: 0 })

  it('is no exit at that first prompt once the line is echoed after it, however long the agent takes to start', () => {
    for (const now of [FOREGROUND_GRACE_MS, FOREGROUND_GRACE_MS * 10]) {
      expect(agentGone(io(BEFORE + FIRST + ECHO), 't', start(), now)).toBe(false)
      expect(agentGone(io(BEFORE + FIRST + ECHO + BOX), 't', start(), now)).toBe(false)
      expect(lookForLimit(io(BEFORE + FIRST + ECHO + BOX), 't', start(), now).live).toBe(true)
    }
  })

  it('still reads the agent as gone once the shell reports a prompt after it', () => {
    expect(agentGone(io(BEFORE + FIRST + ECHO + BOX + '\r\n' + AGAIN), 't', start(), FOREGROUND_GRACE_MS * 10)).toBe(true)
  })

  // HOLD-C R1 F3: after a minute of the agent's output its launch, and the shell's first prompt after it, have scrolled out of the
  // 32 KB window main keeps, and the first report left in it is the exit's. Once a look has seen that first prompt, it is kept as
  // seen, so the exit's report still counts; a start no look saw it for can't tell, and stays live (no exit without evidence).
  it('reads the shell\'s report after the agent as its exit once the launch has scrolled out of the window, the first prompt kept as seen', () => {
    const WORK = ('Reading src/main/accountSwitch.ts and the tests beside it, one at a time.\r\n').repeat(500)
    const all = BEFORE + FIRST + ECHO + BOX + WORK + '\r\n' + AGAIN
    const SIZE = 32_000
    const windowed: SwitchIO = { ...io(all), output: () => ({ raw: all.slice(-SIZE), end: all.length }), outputFrom: (_id, from) => all.slice(Math.max(from, all.length - SIZE)) }
    const s = start()
    const rec: { at: number; commands: string[]; prompted?: true } = { at: BEFORE.length, commands: [LINE] }
    // The looks while the launch was in the window: the agent runs.
    expect(agentGone(io(BEFORE + FIRST + ECHO + BOX), 't', s, FOREGROUND_GRACE_MS * 10)).toBe(false)
    expect(liveness(io(BEFORE + FIRST + ECHO + BOX), 't', 'claude', rec)).toEqual({ state: 'live' })
    expect(all.length - s.at).toBeGreaterThan(SIZE)
    expect(agentGone(windowed, 't', s, FOREGROUND_GRACE_MS * 10)).toBe(true)
    expect(lookForLimit(windowed, 't', start(), FOREGROUND_GRACE_MS * 10).live).toBe(true)
    expect(liveness(windowed, 't', 'claude', rec)).toEqual({ state: 'gone', hint: null })
    // No look saw the first prompt: nothing tells which report is the exit's, and nothing is read as one.
    expect(agentGone(windowed, 't', start(), FOREGROUND_GRACE_MS * 10)).toBe(false)
    expect(liveness(windowed, 't', 'claude', { at: BEFORE.length, commands: [LINE] }).state).not.toBe('gone')
  })

  it('keeps the first prompt as seen only once its row is entered, and never past a report the shell made before the line', () => {
    // The first prompt's row not ended yet: a second report on it would be the same prompt's, so nothing is kept.
    const s = start()
    expect(agentGone(io(BEFORE + FIRST), 't', s, FOREGROUND_GRACE_MS * 10)).toBe(false)
    expect(s.prompted).toBeUndefined()
    // A second report on the same row is still that first prompt's, once its row is entered.
    expect(agentGone(io(BEFORE + FIRST + `${E}]9;9;C:\\tmp\x07` + ECHO + BOX), 't', s, FOREGROUND_GRACE_MS * 10)).toBe(false)
    expect(s.prompted).toBe(true)
    expect(agentGone(io(BEFORE + FIRST + `${E}]9;9;C:\\tmp\x07` + ECHO + BOX + '\r\n' + AGAIN), 't', s, FOREGROUND_GRACE_MS * 10)).toBe(true)
    // A shell that reported a prompt before the line: its first report since is the shell back, as before (#106 does not apply).
    const before = { at: (report + 'bash-5.3$ ').length, commands: [LINE], agent: 'claude' as const, time: 0 }
    const out = report + 'bash-5.3$ ' + ECHO + BOX + '\r\n' + AGAIN
    expect(agentGone(io(out), 't', before, FOREGROUND_GRACE_MS * 10)).toBe(true)
  })

  // That first prompt is the shell's first, on its way when the line was typed, and the agent runs after it: whatever follows it
  // (part of the line, another line, nothing), it is no exit at any moment, only the shell's next report is (HOLD-C).
  it('reads that first prompt as no exit whatever follows it, at any moment', () => {
    for (const after of ['', LINE.slice(0, 30), 'ls -la\r\n', LINE.slice(0, -1), LINE.slice(0, -1) + `${E}[?2004l\r\n`]) {
      for (const now of [FOREGROUND_GRACE_MS, FOREGROUND_GRACE_MS * 100]) expect(agentGone(io(BEFORE + FIRST + after), 't', start(), now)).toBe(false)
    }
  })

  // The switch reads the same output for its first step (liveness): read as the shell back, it pressed the shell's line clear
  // and a sacrificial Enter in the live agent's box, which confirmed the option a rate-limit menu had picked (the full run
  // of 2026-11-26).
  it('is the agent live to the switch too, and gone once the shell reports a prompt after it', () => {
    const rec = { at: BEFORE.length, commands: [LINE] }
    expect(liveness(io(BEFORE + FIRST + ECHO + BOX), 't', 'claude', rec)).toEqual({ state: 'live' })
    expect(liveness(io(BEFORE + FIRST + ECHO + BOX + '\r\n' + AGAIN), 't', 'claude', rec)).toEqual({ state: 'gone', hint: null })
    // And a repaint after that prompt (a resize) that draws the line again where it still shows is no echo at a first prompt.
    const repaint = `${E}[H${E}[2Jbash-5.3$ ${LINE}\r\nbash-5.3$ `
    expect(liveness(io(BEFORE + FIRST + ECHO + BOX + '\r\n' + AGAIN + repaint), 't', 'claude', rec)).toEqual({ state: 'gone', hint: null })
    // That first prompt, whatever follows it, is no exit: nothing on screen says the agent runs either.
    expect(liveness(io(BEFORE + FIRST + 'ls -la\r\n'), 't', 'claude', rec)).toEqual({ state: 'unknown' })
    expect(liveness(io(BEFORE + FIRST + 'claude\r\n'), 't', 'claude', { at: BEFORE.length, commands: ['claude'] })).toEqual({ state: 'unknown' })
  })

  // Two looks at the same output, `gap` ms apart, nothing printed between, as the limit look and the switch each take them: what
  // each reads the second time.
  function twoLooks(out: string, gap: number): { gone: boolean; state: string } {
    const clock = { t: 0 }
    const t = io(BEFORE + out, clock)
    const s = start()
    const rec = { at: BEFORE.length, commands: [LINE] }
    agentGone(t, 't', s, FOREGROUND_GRACE_MS * 10)
    liveness(t, 't', 'claude', rec)
    clock.t += gap
    return { gone: agentGone(t, 't', s, FOREGROUND_GRACE_MS * 10 + gap), state: liveness(t, 't', 'claude', rec).state }
  }
  /** A prompt drawn like an agent's box: powerlevel10k's ruler over its ❯. */
  const RULED = `${report}${E}[2J${E}[H${RULE}\r\n❯ `

  // A prompt drawn like an agent's box (powerlevel10k's ruler over its ❯, starship's ❯) at the first prompt, the line lost, is no
  // exit however long it stays, and nor is one with a wrapped line, output or a status row under it: a second look is no evidence
  // (HOLD-C). Only the shell's next report, or the OS, tells the agent gone there.
  it('reads a first prompt drawn like a box, whatever is under it, as no exit on any look', () => {
    const rec = { at: BEFORE.length, commands: [LINE] }
    expect(liveness(io(BEFORE + RULED), 't', 'claude', rec).state).toBe('live')
    const wrapped = RULED + 'x'.repeat(130)
    const output = RULED + `ls${E}[?2004l\r\nfile1  file2\r\n`
    const status = RULED + `${E}7\r\n  main ✔ 12:04${E}8`
    for (const out of [RULED, wrapped, output, status]) {
      for (const gap of [100, 60_000]) {
        const second = twoLooks(out, gap)
        expect(second.gone).toBe(false)
        expect(second.state).not.toBe('gone')
      }
    }
    expect(liveness(io(BEFORE + FIRST + BOX), 't', 'claude', rec)).toEqual({ state: 'live' })
    expect(twoLooks(output + AGAIN, 0)).toEqual({ gone: true, state: 'gone' })
  })

  // An agent's first frame caught before it was all drawn, the launch echo gone from the window: Claude Code's box before its
  // closing rule, Codex's composer before its footer, agy's > before its closing rule. One look read each as the shell back: on
  // Windows nothing else told, so the switch skipped its exit step and typed its line clear, the relaunch line and Enter into the
  // live agent, and the limit look latched it gone for good (holdb-review R2-2, holdb-codex-review round 2).
  const WIPE = `${report}${E}[?25l${E}[H${E}[?25h${E}[2J`
  const CLAUDE_HALF = `${WIPE}▐▛███▜▌ Claude Code v2.1.309 (mock)${E}[K\r\n\r\n${RULE}\r\n❯${E}[K\r\n`
  const CLAUDE_REST = `${RULE}\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)${E}[K\r\n`
  const CODEX_HALF = `${WIPE}╭──────────────────────────────────────╮\r\n│ >_ OpenAI Codex (v0.164.0)           │\r\n╰──────────────────────────────────────╯\r\n\r\n› Ask Codex to do anything${E}[K`
  const CODEX_REST = `\r\n\r\n  gpt-5.6 · 100% left · ~/project\r\n  ⏎ send   ⇧⏎ newline   ⌃T transcript${E}[K`
  const AGY_HALF = `${WIPE}      ▄▀▀▄        Antigravity CLI 1.4.3${E}[K\r\n     a@example.com (Google AI Pro)${E}[K\r\n\r\n${RULE}\r\n> ${E}[K`
  const AGY_REST = `\r\n${RULE}\r\n? for shortcuts${E}[K\r\n`
  const HALVES: [AccountAgent, string, string][] = [['claude', CLAUDE_HALF, CLAUDE_REST], ['codex', CODEX_HALF, CODEX_REST], ['agy', AGY_HALF, AGY_REST]]

  it('is an agent whose first frame is caught half drawn no exit on one look, to the limit look or the switch', () => {
    for (const [agent, half, rest] of HALVES) {
      const rec = { at: BEFORE.length, commands: [LINE] }
      const s: LiveStart = { ...start(), agent }
      expect(agentGone(io(BEFORE + half), 't', s, FOREGROUND_GRACE_MS * 10)).toBe(false)
      expect(lookForLimit(io(BEFORE + half), 't', s, FOREGROUND_GRACE_MS * 10).live).toBe(true)
      expect(s.ended).toBeUndefined()
      expect(liveness(io(BEFORE + half), 't', agent, rec).state).not.toBe('gone')
      // Drawn whole, its closing structure says it runs, however long after.
      expect(twoLooks(half + rest, 60_000)).toEqual({ gone: false, state: 'live' })
    }
  })

  it('reads the agent at that first prompt on one look, never a second, to the switch', async () => {
    for (const [agent, half] of HALVES) {
      const clock = { t: 0 }
      expect((await livenessNow(io(BEFORE + half, clock), 't', agent, { at: BEFORE.length, commands: [LINE] }, { known: false })).state).not.toBe('gone')
      expect(clock.t).toBe(0)
    }
    // The drawn box is live only on the OS's word that a program runs; with no word it is unknown, as a key typed there needs the OS
    // (HOLD-C R3, H3-1).
    expect((await livenessNow(io(BEFORE + RULED), 't', 'claude', { at: BEFORE.length, commands: [LINE] }, { known: false })).state).toBe('unknown')
    expect((await livenessNow({ ...io(BEFORE + RULED), shellAlone: async () => false }, 't', 'claude', { at: BEFORE.length, commands: [LINE] }, { known: false })).state).toBe('live')
  })

  // agy is started by its name alone, and no echo of a name can be told from a prompt that shows it: the box agy draws after that
  // first prompt is what tells it runs. Read as the shell back, the switch's exit step typed no /exit, read agy as gone already and
  // named no conversation to resume (accountsChooserE2eMock loaded at 6 copies, 2026-11-26).
  it('is an agent started by its name alone live once it draws its box after that first prompt, to the switch and the limit look', () => {
    const AGY = `${E}[?25l${E}[H${E}[?25h${E}[2J      ▄▀▀▄        Antigravity CLI 1.4.3${E}[K\r\n     a@example.com (Google AI Pro)${E}[K\r\n\r\n${RULE}\r\n> ${E}[K\r\n${RULE}\r\n? for shortcuts${E}[K\r\n`
    const rec = { at: BEFORE.length, commands: ['agy'] }
    const agy: LiveStart = { ...rec, agent: 'agy', time: 0 }
    expect(liveness(io(BEFORE + FIRST + 'agy\r\n' + AGY), 't', 'agy', rec)).toEqual({ state: 'live' })
    for (const now of [FOREGROUND_GRACE_MS, FOREGROUND_GRACE_MS * 10]) {
      expect(agentGone(io(BEFORE + FIRST + 'agy\r\n' + AGY), 't', agy, now)).toBe(false)
    }
    // Gone once the shell reports a prompt after it; where nothing agy drew follows that first prompt, unknown, and no exit.
    expect(liveness(io(BEFORE + FIRST + 'agy\r\n' + AGY + '\r\n' + AGAIN), 't', 'agy', rec)).toEqual({ state: 'gone', hint: null })
    expect(agentGone(io(BEFORE + FIRST + 'agy\r\n' + AGY + '\r\n' + AGAIN), 't', agy, FOREGROUND_GRACE_MS)).toBe(true)
    expect(liveness(io(BEFORE + FIRST + 'agy\r\n'), 't', 'agy', rec)).toEqual({ state: 'unknown' })
    expect(agentGone(io(BEFORE + FIRST + 'agy\r\n'), 't', agy, FOREGROUND_GRACE_MS)).toBe(false)
  })
})

// HOLD-C R1 F2: a shell that never shows an agent's exit (Git Bash whose rc sets a PROMPT_COMMAND of its own, WSL, a shell with no
// integration), on Windows, which reads no foreground. The record must not stay the first agent's for ever: the OS's last answer,
// asked by something that needed it (a switch, the model switch, a submit), ends it where it says only the shell was left after the
// agent's start; and where nothing can tell, an agent typed later replaces it as one started with unknown options, over a record
// never seen ended, which the switch types nothing for (signoff-decisions.md, HOLD-C R1).
describe('a terminal that never shows an exit (HOLD-C R1 F2)', () => {
  /** Claude Code started at 1000, seen up by a look at `seenAt` (none for null), exited printing no hint at a shell that reports
   *  nothing, on Windows. */
  function silentExit(over: Partial<SwitchIO> = {}, seenAt: number | null = 1500): { t: FakeTerminal; io: SwitchIO; start: LiveStart } {
    const { t, start } = setup({ exit: 'no-hint', reports: false })
    start.time = 1000
    const io: SwitchIO = { ...t.io(), atShell: () => null, ...over }
    if (seenAt !== null) expect(lookForLimit({ ...io, aloneSince: () => null }, 't', start, seenAt).live).toBe(true)
    t.type('/exit')
    t.type('\r')
    return { t, start, io }
  }

  // HOLD-C R2-2 (signoff-decisions.md): the OS's "only the shell is left" counts only if it was asked after the agent was seen running.
  // Asked between the agent's start and its first frame (a slow start), the shell was alone because the agent was not up yet.
  it('reads the OS\'s answer only where it was asked after a look saw the agent running', () => {
    /** The OS's last answer, asked at `askedAt`: given for a `since` no later than that, as terminalManager.ts shellAloneSince. */
    const askedAt = (at: number) => ({ aloneSince: (_id: string, since: number) => (at >= since ? true : null) })
    const late = silentExit(askedAt(7000), 6000)
    expect(late.start.seenUpAt).toBe(6000)
    expect(agentGone(late.io, 't', late.start, 9000)).toBe(true)
    const early = silentExit(askedAt(5000), 6000)
    expect(agentGone(early.io, 't', early.start, 9000)).toBe(false)
    // Never seen running: no answer counts, however late it was asked.
    const unseen = silentExit(askedAt(8000), null)
    expect(unseen.start.seenUpAt).toBeUndefined()
    expect(agentGone(unseen.io, 't', unseen.start, 9000)).toBe(false)
    expect(lookForLimit(unseen.io, 't', unseen.start, 9000).live).toBe(true)
  })

  it('reads the agent seen running at its first turn, the Enter of a prompt in its box', () => {
    const { t, start } = setup({ reports: false })
    const io = { ...t.io(), atShell: () => null }
    t.type('fix the test')
    expect(noteEnteredLine(io, 't', start, 'fix the test', 500, 2500)).toBeNull()
    expect(start).toMatchObject({ turned: true, seenUpAt: 2500 })
  })

  it('reads the agent gone on the OS\'s last answer that only the shell was left, asked once the agent had started, and on no other', () => {
    const asked: number[] = []
    const seen = silentExit({ aloneSince: (_id, since) => { asked.push(since); return since <= 5000 ? true : null } })
    expect(agentGone(seen.io, 't', seen.start, 9000)).toBe(true)
    expect(asked).toEqual([1000 + FOREGROUND_GRACE_MS])
    expect(lookForLimit(seen.io, 't', silentExit({ aloneSince: () => true }).start, 9000).live).toBe(false)
    // An answer from before the agent was past its start (the cache gives none for it), or one that something still runs: no exit.
    expect(agentGone(silentExit({ aloneSince: () => null }).io, 't', silentExit().start, 9000)).toBe(false)
    const running = silentExit({ aloneSince: () => false })
    expect(agentGone(running.io, 't', running.start, 9000)).toBe(false)
    // Within the moment the shell takes to start the agent, no answer is read.
    const early = silentExit({ aloneSince: () => true })
    expect(agentGone(early.io, 't', early.start, 1000 + FOREGROUND_GRACE_MS - 1)).toBe(false)
  })

  it('replaces the record with one of an agent typed later, its options unknown, over a record never seen ended; the chip shows the new agent', () => {
    const { io, start } = silentExit()
    expect(agentGone(io, 't', start, 9000)).toBe(false)
    const next = noteEnteredLine(io, 't', start, 'codex -m gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox', 900, 9000)
    expect(next).toEqual({ at: 900, commands: ['codex'], agent: 'codex', time: 9000, unsure: true, overUnended: true })
    // The first is not read as ended: nothing said so.
    expect(start.ended).toBeUndefined()
    expect(lookForLimit(io, 't', next!, 9000)).toMatchObject({ agent: 'codex', live: true, startAt: 900 })
    // A command that starts no agent changes nothing.
    expect(noteEnteredLine(io, 't', start, 'git status', 900, 9000)).toBeNull()
  })

  it('keeps an agent named in the live agent\'s box a prompt, a turn, in such a terminal', () => {
    const { t, start } = setup({ reports: false })
    const io = { ...t.io(), atShell: () => null }
    t.type('codex review the diff')
    expect(noteEnteredLine(io, 't', start, 'codex review the diff', 500, 9000)).toBeNull()
    expect(start).toMatchObject({ turned: true, turnedAt: 500 })
    // Not yet drawn in it (pasted with its Enter), it can't be told from a line typed at the shell under the last frame an agent left:
    // the record is the agent typed, over one never seen ended, which the switch types nothing for.
    const pasted = setup({ reports: false })
    expect(noteEnteredLine({ ...pasted.t.io(), atShell: () => null }, 't', pasted.start, 'codex review the diff', 500, 9000)).toMatchObject({ agent: 'codex', overUnended: true })
  })

  it('starts nothing over a record a shell that reports its prompts, or the PTY\'s foreground, still shows running', () => {
    // An agent asking something of its own (no box): the line answers it.
    const reporting = setup({ start: 'question' })
    expect(noteEnteredLine(reporting.t.io(), 't', reporting.start, 'codex', 500, 9000)).toBeNull()
    const foreground = setup({ start: 'question', reports: false, foreground: true })
    expect(noteEnteredLine(foreground.t.io(), 't', foreground.start, 'codex', 500, 9000)).toBeNull()
    // A shell that reported a prompt once (SW2-10), though not in the window: the same.
    const once = setup({ start: 'question', reports: false })
    expect(noteEnteredLine({ ...once.t.io(), reported: () => ({ posix: true, windows: false }) }, 't', once.start, 'codex', 500, 9000)).toBeNull()
    const prompted = setup({ start: 'question', reports: false })
    expect(noteEnteredLine(prompted.t.io(), 't', { ...prompted.start, prompted: true }, 'codex', 500, 9000)).toBeNull()
  })
})
