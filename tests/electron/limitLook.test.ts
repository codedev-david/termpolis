// @vitest-environment node
//
// The usage-limit chooser's look at a terminal, main's side (src/main/limitLook.ts): what the
// screen shows, judged once, and where the agent Termpolis started there stands (R5). A limit
// counts only while that agent is live, and only once it has taken a turn (R4). The terminal is the
// scripted one of _switchTerminal.ts: a shell and the agent in it, each drawn as it draws itself.
import { describe, it, expect } from 'vitest'
import { FOREGROUND_GRACE_MS, agentGone, agentOfLaunch, lookForLimit, noteEnteredLine } from '../../src/main/limitLook'
import type { LiveStart } from '../../src/main/limitLook'
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
    for (const line of ['ls', 'claude.exe', 'please run claude now', 'recall claude', 'claude, fix the test', 'codexes', '']) {
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
