// @vitest-environment node
//
// The in-place account switch (src/main/accountSwitch.ts, §7.2), against a scripted terminal that
// draws each agent and shell as they draw themselves (_switchTerminal.ts). What it pins, by the
// design's rules:
//   R2  no exit key, ever: each agent exits with its own command, entered once its box shows it;
//       nothing goes to an agent that is already gone, and no Ctrl+D or Ctrl+C at all.
//   R3  the exit counts only as the hint at the screen's foot, or a prompt report since; the line is
//       entered only once it shows on the shell's rows: in an agent's box it is taken back out.
//   R7  the terminal's lock, held for the run and let go on every outcome.
//   R8  the exact id: the hint's, or the one Termpolis started the session with; never
//       --continue or resume --last.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  ECHO_MAX_MS, ECHO_MS, ECHO_PROBE_CHARS, ECHO_SLOW_CHAR_MS, EXIT_CONFIRM_MS, LOCK_MS, MODEL_HOLD_MS, OUTCOME_MS, POLL_MS, PROMPT_REPORT_WAIT_MS, _resetSwitchLocksForTest, holdForModel, holdsModelKey, relaunchLockReason,
  exitShown, hintAtFoot, look, ownScreen, plain, releaseModelHold, runAccountSwitch, typeAtPrompt, watchOutcome,
} from '../../src/main/accountSwitch'
import type { Look, SwitchContext, SwitchIO } from '../../src/main/accountSwitch'
import { BLIND_EXIT_WAIT_MS, EXIT_CEILING_MS, PROMPT_SETTLE_MS, RESUME_PROBE_MS } from '../../src/renderer/src/lib/modelRelaunch'
import { HINT_FROM_FOOT_ROWS, LINE_CLEAR, exitHintOf } from '../../src/shared/accountSwitch'
import type { SwitchOutcome, SwitchRequest } from '../../src/shared/accountSwitch'
import type { AgentAccount } from '../../src/shared/agentAccounts'
import { AGY_CONVERSATION_ID, AGY_EXIT_AFTER_A_TURN } from '../fixtures/agentExitOutput'
import { FakeTerminal, ID, ID2, keys } from './_switchTerminal'
import type { TermScript } from './_switchTerminal'

const B: AgentAccount = { id: 'acc_b', agent: 'claude', label: 'codedev', profile: 'C:\\Users\\me\\.claude-b', autoOffer: true, order: 1, connect: true, origin: 'created', links: [] }
const CODEX_B: AgentAccount = { ...B, id: 'acc_cb', agent: 'codex', profile: 'C:\\Users\\me\\.codex-b' }
const NEW_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'

interface Run {
  t: FakeTerminal
  outcome: SwitchOutcome
  recorded: Array<{ accountId: string; start: { at: number; commands: string[] }; sessionId: string | null }>
  progress: string[]
}

async function run(script: TermScript, over: Partial<SwitchContext> = {}, req: Partial<SwitchRequest> = {}, prep?: (t: FakeTerminal) => void): Promise<Run> {
  const t = new FakeTerminal(script)
  prep?.(t)
  const recorded: Run['recorded'] = []
  const progress: string[] = []
  const target = script.agent === 'codex' ? CODEX_B : B
  const io = t.io()
  const outcome = await runAccountSwitch(
    { terminalId: 't1', targetId: target.id, shellType: script.family === 'posix' ? 'gitbash' : script.family, ...req },
    {
      io: { ...io, progress: (p) => progress.push(p.step) },
      target,
      agent: script.agent,
      start: { at: t.launchedAt, commands: [t.launchLine()] },
      newSessionId: () => NEW_ID,
      record: (r) => recorded.push(r),
      ...over,
    },
  )
  return { t, outcome, recorded, progress }
}

const claude = (over: Partial<TermScript> = {}): TermScript => ({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', ...over })
const codex = (over: Partial<TermScript> = {}): TermScript => ({ agent: 'codex', family: 'powershell', start: 'idle', exit: 'hint', ...over })

/** No key the shell would act on but its line, and nothing sent to the agent as a prompt. */
function cleanRun(r: Run): void {
  expect(keys(r.t)).not.toMatch(/[\u0003\u0004]/)
  expect(r.t.closed).toBe(false)
  expect(r.t.sentPrompts).toEqual([])
  for (const line of r.t.ran) expect(line).not.toMatch(/--continue|resume --last|\b(?:claude|agy)\b.*\s-c(?:\s|$)/)
}

beforeEach(() => _resetSwitchLocksForTest())

describe("a pane too narrow for the exit hint's command row (round 1)", () => {
  const look = (lines: string[], cols: number, box = -1): Look => ({ lines, title: '', raw: '', end: 0, box, cols })
  const wrap = (text: string, cols: number): string[] => text.match(new RegExp(`.{1,${cols}}`, 'g')) as string[]

  it.each([50, 40, 30])('reads the session id of a Claude Code hint that wraps at %i columns', (cols) => {
    const rows = ['', 'Resume this session with:', ...wrap(`claude --resume ${ID}`, cols), '']
    expect(rows.length).toBeGreaterThan(4)
    expect(hintAtFoot(look(rows, cols), 'claude')).toMatchObject({ id: ID, row: 1 })
  })

  it('reads a worktree hint that wraps, and a Codex one, an agy one', () => {
    const cols = 36
    expect(hintAtFoot(look(['Resume this session with:', ...wrap(`claude --worktree "feat-x" --resume ${ID}`, cols)], cols), 'claude')).toMatchObject({ id: ID, worktree: 'feat-x' })
    expect(hintAtFoot(look(['To continue this session, run:', ...wrap(`  codex resume ${ID2}`, cols)], cols), 'codex')).toMatchObject({ id: ID2 })
    expect(hintAtFoot(look(['Resume with -c (or command below):', ...wrap(`agy --conversation=${ID}`, cols)], cols), 'agy')).toMatchObject({ id: ID })
  })

  it('still reads rows that are not wrapped, whatever the width says, and joins nothing it does not need to', () => {
    const rows = ['Resume this session with:', `  claude --resume ${ID}`]
    expect(hintAtFoot(look(rows, 80), 'claude')).toMatchObject({ id: ID })
    expect(hintAtFoot(look(rows, undefined as unknown as number), 'claude')).toMatchObject({ id: ID })
    // A full-width row that merely ends there is not joined to the next, and what follows does not spoil it.
    const full = 'x'.repeat(40)
    expect(hintAtFoot(look([full, 'Resume this session with:', `  claude --resume ${ID}`], 40), 'claude')).toMatchObject({ id: ID, row: 1 })
  })

  it('names no id for a hint cut short with nothing under it, as before', () => {
    expect(hintAtFoot(look(['Resume this session with:', 'claude --resume 3f2a9c1e-5b7d'], 29), 'claude')).toMatchObject({ id: null })
  })

  it('keeps the box rule: a hint above the input box is history, not an exit', () => {
    const rows = ['Resume this session with:', ...wrap(`claude --resume ${ID}`, 40), '', '─'.repeat(40), '❯ ', '─'.repeat(40)]
    expect(hintAtFoot(look(rows, 40, 4), 'claude')).toBeNull()
  })
})

describe('Claude Code: the whole switch (§7.2)', () => {
  it('exits with /exit, resumes the hint\'s session on the target, and records it', async () => {
    const r = await run(claude())
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    // The exact order: the empty box gets /exit, then Enter; the shell's line is cleared, a
    // sacrificial Enter, then the line in two parts (its first characters, then the rest once those
    // showed), then its Enter.
    const line = `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${ID}`
    expect(r.t.writes).toEqual(['/exit', '\r', '\u0005\u0015', '\r', line.slice(0, ECHO_PROBE_CHARS), line.slice(ECHO_PROBE_CHARS), '\r'])
    expect(r.t.ran).toEqual(['', line])
    expect(r.recorded).toEqual([{ accountId: 'acc_b', start: { at: expect.any(Number), commands: [line] }, sessionId: ID }])
    expect(r.progress).toEqual(['exiting', 'confirming', 'typing', 'waiting'])
    cleanRun(r)
    expect(relaunchLockReason('t1', r.t.clock)).toBeNull()
  })

  it('in PowerShell and cmd, clears the line with Esc and types the line in their own form', async () => {
    const ps = await run(claude({ family: 'powershell' }))
    const psLine = `& { $env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-b'; claude --model opus --resume ${ID} }`
    expect(ps.t.writes.slice(2, 6)).toEqual(['\u001b', '\r', psLine.slice(0, ECHO_PROBE_CHARS), psLine.slice(ECHO_PROBE_CHARS)])
    expect(ps.outcome.kind).toBe('switched')
    const cmd = await run(claude({ family: 'cmd' }))
    expect(cmd.t.ran[1]).toBe(`set "CLAUDE_CONFIG_DIR=C:\\Users\\me\\.claude-b" && call claude --model opus --resume ${ID}`)
    expect(cmd.outcome.kind).toBe('switched')
  })

  it('works in David\'s Git Bash, which reports no prompt: the hint at the foot carries it', async () => {
    const r = await run(claude({ reports: false }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    cleanRun(r)
  })

  it('clears what the box held before typing /exit, and resumes in a worktree as the hint printed it', async () => {
    const t0: TermScript = claude({ worktree: 'feat-x' })
    const r = await run(t0, {}, {})
    expect(r.t.ran[1]).toBe(`export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --worktree "feat-x" --model opus --resume ${ID}`)
    const held = new FakeTerminal(claude())
    held.box = 'half a prompt'
    held.out += held.frame()
    const recorded: unknown[] = []
    const outcome = await runAccountSwitch({ terminalId: 't9', targetId: 'acc_b', shellType: 'bash' }, {
      io: held.io(), target: B, agent: 'claude', start: { at: held.launchedAt, commands: [held.launchLine()] },
      newSessionId: () => NEW_ID, record: (x) => recorded.push(x),
    })
    expect(outcome.kind).toBe('switched')
    expect(held.writes.slice(0, 3)).toEqual(['\u0015'.repeat(20), '/exit', '\r'])
    expect(held.sentPrompts).toEqual([])
  })

  it('types nothing when clearing the box doesn\'t empty it', async () => {
    const t = new FakeTerminal(claude({ clearFails: true }))
    t.box = 'kept'
    t.out += t.frame()
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: 'acc_b', shellType: 'bash' }, {
      io: t.io(), target: B, agent: 'claude', newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(outcome).toEqual({ kind: 'refused', why: 'Claude Code\'s input held text that clearing it didn\'t remove, so nothing was typed' })
    expect(t.writes).toEqual(['\u0015'.repeat(20)])
  })
})

describe('R2: nothing goes to an agent that is gone', () => {
  it('reads the hint already on screen and types only the line', async () => {
    const r = await run(claude({ start: 'gone-hint' }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.t.writes[0]).toBe('\u0005\u0015')
    expect(keys(r.t)).not.toContain('/exit')
    cleanRun(r)
  })

  it('reads a prompt report since the agent started as gone, and resumes the session Termpolis started', async () => {
    const r = await run(claude({ start: 'gone-quiet' }), { sessionId: ID2, hasTranscript: (id) => id === ID2 })
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID2 })
    expect(keys(r.t)).not.toContain('/exit')
    expect(r.t.ran[1]).toContain(`--resume ${ID2}`)
  })

  it('reads the shell in the PTY\'s foreground as gone on macOS and Linux, where no hint or report shows it', async () => {
    const r = await run(claude({ start: 'gone-quiet', reports: false, foreground: true }), { sessionId: ID2, hasTranscript: (id) => id === ID2 })
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID2 })
    expect(keys(r.t)).not.toContain('/exit')
    expect(r.t.closed).toBe(false)
  })

  it('starts a new session, with an id of its own, when the session Termpolis started has no transcript', async () => {
    const r = await run(claude({ start: 'gone-quiet' }), { sessionId: ID2, hasTranscript: () => false })
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'no-session' })
    expect(r.t.ran[1]).toBe(`export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --session-id ${NEW_ID}`)
    expect(r.recorded[0].sessionId).toBe(NEW_ID)
  })

  it('asks the user when it can\'t tell, typing nothing; their word starts it at the line', async () => {
    const quiet = await run(claude({ start: 'blank' }))
    expect(quiet.outcome).toEqual({ kind: 'unknown-exit' })
    expect(quiet.t.writes).toEqual([])
    // Their word: the hint on screen still names the session.
    const said = await run(claude({ start: 'gone-hint' }), { start: undefined }, { assumeExited: true })
    // No record of how it was started: the conversation is resumed, and the outcome says its flags were not carried.
    expect(said.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID, unseenStart: true })
    expect(keys(said.t)).not.toContain('/exit')
  })

  it('reads a terminal with no output, or none since a start main doesn\'t know, as unknown', async () => {
    const t = new FakeTerminal(claude({ start: 'blank' }))
    t.out = ''
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: 'acc_b', shellType: 'bash' }, {
      io: t.io(), target: B, agent: 'claude', newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(outcome).toEqual({ kind: 'unknown-exit' })
  })
})

describe('step 2: what holds the box', () => {
  it('closes Claude Code\'s rate-limit menu with Esc first', async () => {
    const r = await run(claude({ start: 'menu' }))
    expect(r.t.writes.slice(0, 3)).toEqual(['\u001b', '/exit', '\r'])
    expect(r.outcome.kind).toBe('switched')
  })

  it('closes a Codex popup with Esc first', async () => {
    const r = await run(codex({ start: 'menu' }))
    expect(r.t.writes.slice(0, 3)).toEqual(['\u001b', '/quit', '\r'])
    expect(r.outcome.kind).toBe('switched')
  })

  it('stops Claude Code\'s wait for its limit with Esc, without asking', async () => {
    const r = await run(claude({ start: 'waiting' }))
    expect(r.t.writes.slice(0, 2)).toEqual(['\u001b', '/exit'])
    expect(r.outcome.kind).toBe('switched')
  })

  it('asks before stopping a turn at work, and stops it only with the user\'s leave', async () => {
    const asked = await run(claude({ start: 'busy', escStops: true }))
    expect(asked.outcome).toEqual({ kind: 'busy' })
    expect(asked.t.writes).toEqual([])
    const stopped = await run(claude({ start: 'busy', escStops: true }), {}, { stopBusy: true })
    expect(stopped.t.writes.slice(0, 2)).toEqual(['\u001b', '/exit'])
    expect(stopped.outcome.kind).toBe('switched')
    const stuck = await run(claude({ start: 'busy', escStops: false }), {}, { stopBusy: true })
    expect(stuck.outcome).toEqual({ kind: 'busy' })
    expect(stuck.t.writes).toEqual(['\u001b'])
  })

  it('presses nothing on a question only the user answers', async () => {
    const r = await run(claude({ start: 'question' }))
    expect(r.outcome).toEqual({ kind: 'refused', why: 'Claude Code is asking something on its screen: answer it there, then switch again' })
    expect(r.t.writes).toEqual([])
  })

  it('gives up, typing nothing more, when a menu doesn\'t close', async () => {
    const r = await run(claude({ start: 'menu', escCloses: false }))
    expect(r.outcome).toEqual({ kind: 'unknown-exit' })
    expect(r.t.writes).toEqual(['\u001b'])
  })
})

describe('steps 3-4 (R3): the exit, shown', () => {
  it('stops when the agent ignores its exit command: nothing more is typed', async () => {
    const r = await run(claude({ exit: 'ignore' }))
    expect(r.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(r.t.writes).toEqual(['/exit', '\r'])
    expect(r.t.clock).toBeGreaterThanOrEqual(EXIT_CONFIRM_MS)
  })

  it('takes its exit command back out of a box that never shows it', async () => {
    const r = await run(claude({ exit: 'no-echo' }))
    expect(r.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(r.t.writes).toEqual(['/exit', '\u0015'.repeat(20)])
    expect(r.t.clock).toBeGreaterThanOrEqual(ECHO_MS)
  })

  it('counts an exit with no hint by its prompt report, and resumes the session Termpolis started', async () => {
    const r = await run(claude({ exit: 'no-hint' }), { sessionId: ID2, hasTranscript: () => true })
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID2 })
  })

  it('counts the shell back in the PTY\'s foreground as the exit on macOS and Linux, where nothing else shows it', async () => {
    // A session with no turns prints no hint, and zsh, fish and an rc file's PROMPT_COMMAND leave
    // no prompt report: before this read, all the switch could do was ask the user.
    const r = await run(claude({ exit: 'no-hint', reports: false, foreground: true }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'no-session' })
    expect(r.t.ran).toEqual(['', `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --session-id ${NEW_ID}`])
    expect(r.t.sentPrompts).toEqual([])
    // Without the read (Windows), the same screen confirms nothing, and nothing more is typed.
    const blind = await run(claude({ exit: 'no-hint', reports: false }))
    expect(blind.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(blind.t.ran).toEqual([])
  })

  it('waits for the hint that lands after the shell is back, and resumes the session it names', async () => {
    const r = await run(claude({ reports: false, foreground: true, exitOutputLateMs: 600 }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.t.ran).toEqual(['', `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${ID}`])
  })

  it('never reads a shell in the foreground while the agent is still up as its exit', async () => {
    const r = await run(claude({ exit: 'ignore', reports: false, foreground: true }))
    expect(r.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(r.t.writes).toEqual(['/exit', '\r'])
  })

  it('reads a hint quoted above a live box as no exit, before and after the exit command', async () => {
    // An answer that quotes the hint, the agent's box still under it: the agent is live, and gets
    // its exit command; it ignores it, and the quote still on screen proves nothing.
    const r = await run(claude({ exit: 'ignore', quoteHint: true }))
    expect(r.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(r.t.writes).toEqual(['/exit', '\r'])
  })
})

describe('step 8 (R3, R7, R1): the line, typed, looked at, then entered', () => {
  it('takes the line back out of a live agent\'s box, never entering it', async () => {
    const r = await run(claude(), { start: undefined }, { assumeExited: true })
    expect(r.outcome).toEqual({ kind: 'agent-alive' })
    expect(r.t.writes.slice(-1)).toEqual(['\u0015'.repeat(20)])
    expect(r.t.sentPrompts).toEqual([])
    expect(r.recorded).toEqual([])
  })

  // SW2-7, MODELS-R2-1: "It has exited, switch now" replaces the exit check, not the screen. An agent's box still drawn, with
  // nothing to show the shell is back (no hint, no prompt since the start, no foreground word), is an agent that may well be
  // live with a draft in it, and a sacrificial Enter SUBMITS that draft where Esc does not clear it (PowerShell, cmd). So no
  // sacrificial key is sent there: the first part of the line is typed and looked at, and if it lands in the box it is taken
  // back out (the draft goes with it: nothing is submitted).
  describe.each([['powershell'], ['cmd'], ['posix']] as const)('at the user\'s word with an agent\'s box still on screen (%s)', (family) => {
    const DRAFT = 'refactor the whole module'
    const draft = (t: FakeTerminal): void => { t.box = DRAFT }

    it('submits no draft: the sacrificial Enter is not sent into a box that may be live', async () => {
      const r = await run(claude({ family }), { start: undefined }, { assumeExited: true }, draft)
      expect(r.outcome).toEqual({ kind: 'agent-alive' })
      expect(r.t.sentPrompts).toEqual([])
      expect(r.t.writes).not.toContain('\r')
      expect(r.t.writes[0]).toHaveLength(ECHO_PROBE_CHARS)
      expect(r.t.box).toBe('')
      expect(r.recorded).toEqual([])
    })

    it('still sends it where the screen shows the shell is back: the hint at the foot, or a prompt since the start', async () => {
      const hint = await run(claude({ family, start: 'gone-hint' }), { start: undefined }, { assumeExited: true })
      expect(hint.outcome).toMatchObject({ kind: 'switched', resumed: true })
      expect(hint.t.writes.slice(0, 2)).toEqual([family === 'posix' ? '\u0005\u0015' : '\u001b', '\r'])
      // No hint on this screen, so the conversation starts new: what matters here is that the line was entered.
      const prompt = await run(claude({ family, start: 'gone-quiet' }), {}, { assumeExited: true })
      expect(prompt.outcome).toMatchObject({ kind: 'fresh', why: 'no-session' })
      expect(prompt.t.writes.slice(0, 2)).toEqual([family === 'posix' ? '\u0005\u0015' : '\u001b', '\r'])
    })
  })

  it('sends it where the PTY\'s foreground says the shell is back, though a box is still drawn above', async () => {
    const r = await run(claude({ start: 'gone-hint', foreground: true }), { start: undefined }, { assumeExited: true })
    expect(r.t.writes.slice(0, 2)).toEqual(['\u0005\u0015', '\r'])
    expect(r.outcome).toMatchObject({ kind: 'switched' })
  })

  // SW2-8: Ctrl+U kills only what is LEFT of readline's cursor, so text the user left to the right of it stayed on the line,
  // and the sacrificial Enter ran it. The end of the line first, then the kill: the whole line goes. (PowerShell and cmd use Esc,
  // which clears the whole line.)
  it('clears a bash line from its end, so text right of the cursor is not left to run', () => {
    expect(LINE_CLEAR.posix).toBe('\u0005\u0015')
    expect(LINE_CLEAR.powershell).toBe('\u001b')
    expect(LINE_CLEAR.cmd).toBe('\u001b')
  })

  it('enters nothing when the line never shows', async () => {
    const r = await run(claude({ start: 'gone-hint', shellDead: true }))
    expect(r.outcome).toEqual({ kind: 'didnt-start', line: `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${ID}` })
    expect(r.t.writes.slice(-1)).toEqual(['\u0005\u0015'])
    expect(r.recorded).toEqual([])
  })

  // Measured with a real Git Bash on a ConPTY: it reads typed text one character at a time, 39 ms
  // each when the laptop is idle and over 100 ms when it is busy, and draws the line only once it has
  // read all of it. The 100-character account line below shows after 4 s idle and 10 s busy, and a
  // real profile path makes it more. The wait for it to show was a flat 2 s, so the switch typed the
  // line, took it back out and said it never started.
  const LINE = `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${ID}`

  it('types a long line in two parts, the first few characters, then the rest once those showed', async () => {
    const r = await run(claude({ shellCharMs: 5 }))
    expect(r.outcome).toMatchObject({ kind: 'switched', resumed: true, sessionId: ID })
    const at = r.t.writes.indexOf(LINE.slice(0, ECHO_PROBE_CHARS))
    expect(r.t.writes[at + 1]).toBe(LINE.slice(ECHO_PROBE_CHARS))
    expect(r.t.ran.filter(Boolean)).toEqual([LINE])
  })

  it.each([39, 100, 250])('gives a shell that reads %i ms a character the time it needs, and enters the whole line', async (ms) => {
    const r = await run(claude({ shellCharMs: ms }))
    expect(r.outcome).toMatchObject({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.t.ran.filter(Boolean)).toEqual([LINE])
  })

  it('does not type the rest of the line into an agent\'s box, and takes the first part back out', async () => {
    // The user said it exited, but the agent is up: the first part lands in its box, and that is all
    // the box is given before it is cleared.
    const r = await run(claude(), { start: undefined }, { assumeExited: true })
    expect(r.outcome).toEqual({ kind: 'agent-alive' })
    expect(r.t.writes).toContain(LINE.slice(0, ECHO_PROBE_CHARS))
    expect(r.t.writes).not.toContain(LINE.slice(ECHO_PROBE_CHARS))
    expect(r.t.writes.slice(-1)).toEqual(['\u0015'.repeat(20)])
    expect(r.t.sentPrompts).toEqual([])
  })

  it('gives up on a shell that echoes nothing of the first part after one wait, and types no more', async () => {
    const r = await run(claude({ shellCharMs: 5000 }))
    expect(r.outcome).toMatchObject({ kind: 'didnt-start' })
    expect(r.t.writes).not.toContain(LINE.slice(ECHO_PROBE_CHARS))
    const typedAt = r.t.writeClocks[r.t.writes.indexOf(LINE.slice(0, ECHO_PROBE_CHARS))]
    const wait = r.t.clock - typedAt
    expect(wait).toBeGreaterThanOrEqual(ECHO_MS + ECHO_PROBE_CHARS * ECHO_SLOW_CHAR_MS)
    expect(wait).toBeLessThanOrEqual(ECHO_MS + ECHO_PROBE_CHARS * ECHO_SLOW_CHAR_MS + 2 * POLL_MS)
    expect(r.t.ran.filter(Boolean)).toEqual([])
  })

  it('gives up on a shell that read the first part and stopped, after a wait that follows how long that took', async () => {
    const r = await run(claude({ shellCharMs: 40, shellStallsAfter: ECHO_PROBE_CHARS }))
    expect(r.outcome).toMatchObject({ kind: 'didnt-start' })
    // The rest was typed, never shown, and taken back out with the line's clear: nothing ran.
    expect(r.t.writes).toContain(LINE.slice(ECHO_PROBE_CHARS))
    expect(r.t.ran.filter(Boolean)).toEqual([])
    const typedAt = r.t.writeClocks[r.t.writes.indexOf(LINE.slice(ECHO_PROBE_CHARS))]
    // ECHO_MS, and for each of the rest twice the time the first part took a character (as the
    // 250 ms polling saw it: 40 ms a character, and up to one poll more for all of them).
    const rest = LINE.length - ECHO_PROBE_CHARS
    const perChar = Math.ceil((ECHO_PROBE_CHARS * 40 + POLL_MS) / ECHO_PROBE_CHARS)
    const wait = r.t.clock - typedAt
    expect(wait).toBeGreaterThanOrEqual(ECHO_MS + rest * 2 * 40)
    expect(wait).toBeLessThanOrEqual(ECHO_MS + rest * 2 * perChar + 2 * POLL_MS)
  })

  it('refuses when a shell of another family reported since: one started inside this one', async () => {
    const r = await run(claude({ nestedReport: 'powershell' }))
    expect(r.outcome).toEqual({ kind: 'didnt-start', line: expect.stringContaining('claude'), otherShell: true })
    expect(r.t.ran).toEqual([''])
  })

  it("is not refused by a prompt that writes the other family's report beside its own (oh-my-posh in Git Bash, OSC 7 from PowerShell)", async () => {
    for (const [script, over] of [
      [claude({ alsoReports: 'powershell' }), {}],
      [claude({ family: 'powershell', alsoReports: 'posix' }), { shellType: 'powershell' }],
    ] as const) {
      const r = await run(script, {}, over)
      expect(r.outcome.kind, JSON.stringify(over)).toBe('switched')
    }
  })

  it('refuses, before touching the agent, a line it can\'t build for this shell', async () => {
    const odd = await run(claude(), {}, { shellType: 'fish' })
    expect(odd.outcome).toEqual({ kind: 'refused', why: 'Termpolis can\'t type an account line into this terminal\'s shell' })
    const pct = await run(claude({ family: 'cmd' }), { target: { ...B, profile: 'C:\\100%' } })
    expect(pct.outcome).toEqual({ kind: 'refused', why: 'cmd would expand a % or ! in the line' })
    expect(pct.t.writes).toEqual([])
  })
})

describe('step 10: what the relaunch did', () => {
  it('says when Claude Code can\'t find the conversation on the target', async () => {
    const r = await run(claude({ relaunch: ['not-found'] }))
    expect(r.outcome).toEqual({ kind: 'resume-not-found' })
    expect(r.recorded).toHaveLength(1)
  })

  it('never answers the target\'s sign-in screen, or a question only the user answers', async () => {
    // It names the conversation that was being relaunched, for a new terminal to pick up once signed in.
    expect((await run(claude({ relaunch: ['sign-in'] }))).outcome).toEqual({ kind: 'sign-in', sessionId: ID })
    expect((await run(claude({ relaunch: ['asks'] }))).outcome).toEqual({ kind: 'asks-user', what: 'Bypass Permissions mode' })
    expect((await run(codex({ relaunch: ['sign-in'] }))).outcome).toEqual({ kind: 'sign-in', sessionId: expect.any(String) })
  })

  // SW2-2: a switch made at a usage limit resumes exactly the old, large sessions that make Claude Code ask how to resume
  // them. The dialog is the user's to answer; without it among the questions the switch held the user's keys for the whole
  // 30 s watch and ended with "nothing showed", with the dialog on screen.
  it('stops at Claude Code\'s resume-size dialog and says it is the user\'s to answer, at once', async () => {
    const r = await run(claude({ relaunch: ['resume-size'] }))
    expect(r.outcome).toEqual({ kind: 'asks-user', what: 'Resume from summary' })
    expect(r.t.clock).toBeLessThan(5000)
    // Nothing was pressed on it: the line's own Enter is the last key, and an Enter on it would have chosen for the user.
    expect(r.t.writes.slice(-1)).toEqual(['\r'])
    expect(r.t.ran.filter(Boolean)).toHaveLength(1)
  })

  it('gives up after 30 s with nothing shown', async () => {
    const r = await run(claude({ relaunch: ['nothing'] }))
    expect(r.outcome).toEqual({ kind: 'no-outcome' })
    expect(r.t.clock).toBeLessThan(LOCK_MS)
  })

  it('starts a new session when the user asked for one', async () => {
    const r = await run(claude({ start: 'gone-hint' }), {}, { fresh: true })
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'asked' })
    expect(r.t.ran[1]).toContain(`--session-id ${NEW_ID}`)
    expect(r.t.ran[1]).not.toContain('--resume')
  })
})

describe('Codex', () => {
  it('exits with /quit and resumes by its hint\'s id, global options first, its instruction on the line', async () => {
    const r = await run(codex(), {}, { instructions: 'Use the memory tools.' })
    expect(r.t.writes.slice(0, 2)).toEqual(['/quit', '\r'])
    expect(r.t.ran[1]).toBe(`& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -m gpt-5.6-sol -c "developer_instructions='Use the memory tools.'" resume ${ID} }`)
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.recorded[0].sessionId).toBe(ID)
    cleanRun(r)
  })

  it('reads its hint on one row, and its session line alone as a session with nothing to resume', async () => {
    expect((await run(codex({ codexHint: 'one-row' }))).outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    const none = await run(codex({ codexHint: 'session-only' }))
    expect(none.outcome).toEqual({ kind: 'fresh', why: 'no-session' })
    expect(none.t.ran[1]).toBe(`& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -m gpt-5.6-sol }`)
  })

  it('falls back to a new session in place when the target can\'t see this one (path (c), F6)', async () => {
    const r = await run(codex({ relaunch: ['not-found', 'box'] }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'not-found' })
    expect(r.t.ran).toEqual(['', expect.stringContaining(`resume ${ID}`), '', `& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -m gpt-5.6-sol }`])
    expect(r.recorded.map((x) => x.sessionId)).toEqual([ID, null])
  })

  it('reports what the new session showed when it didn\'t come up either', async () => {
    // Its second try is a new session: no conversation to name.
    expect((await run(codex({ relaunch: ['not-found', 'sign-in'] }))).outcome).toEqual({ kind: 'sign-in' })
    const dead = await run(codex({ relaunch: ['not-found'] }), {}, {})
    expect(dead.outcome).toEqual({ kind: 'resume-not-found' })
  })

  it('waits for a shell that reports no prompt to go quiet before the new session', async () => {
    const r = await run(codex({ family: 'posix', reports: false, relaunch: ['not-found', 'box'] }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'not-found' })
  })

  it("says the new session didn't start when its line never showed", async () => {
    const r = await run(codex({ relaunch: ['not-found', 'box'], deadAfterRelaunches: 1 }))
    expect(r.outcome).toEqual({ kind: 'didnt-start', line: `& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -m gpt-5.6-sol }` })
  })

  it('keeps a worker\'s approval and sandbox flags', async () => {
    const t = new FakeTerminal(codex({ start: 'gone-hint' }))
    const outcome = await runAccountSwitch({ terminalId: 't1', targetId: 'acc_cb', shellType: 'powershell' }, {
      io: t.io(), target: CODEX_B, agent: 'codex', start: { at: t.launchedAt, commands: ['codex -a never -s workspace-write --model gpt-5.6-sol'] },
      newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(outcome.kind).toBe('switched')
    expect(t.ran[1]).toContain(`codex -m gpt-5.6-sol -a never -s workspace-write resume ${ID}`)
  })
})


// What the REAL CLIs drew, run through the engine (SWITCH-R1): the scripted terminal's defaults were friendlier than
// the real thing, and the suite stayed green while the real Codex switch was refused and the real Claude not-found
// was missed. Each of these failed before its fix.
describe('Codex 0.164 as it really draws (SWITCH-R1 C1, C2)', () => {
  it('switches a settled composer, whose status line and hint row stand under its blank row (C1)', async () => {
    const r = await run(codex({ codexStatus: true }))
    // Its box is empty: the exit command goes in with no Ctrl+U before it (which a held box would have sent twenty of).
    expect(r.t.writes.slice(0, 2)).toEqual(['/quit', '\r'])
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(keys(r.t)).not.toContain('\u0015'.repeat(20))
    cleanRun(r)
  })

  it('still clears text it finds in a settled composer, and refuses when that stays (C1)', async () => {
    const hold = async (script: TermScript): Promise<{ t: FakeTerminal; outcome: SwitchOutcome }> => {
      const t = new FakeTerminal(script)
      t.box = 'half a prompt'
      t.out += t.frame()
      const outcome = await runAccountSwitch({ terminalId: 't1', targetId: CODEX_B.id, shellType: 'powershell' }, {
        io: t.io(), target: CODEX_B, agent: 'codex', start: { at: t.launchedAt, commands: [t.launchLine()] }, newSessionId: () => NEW_ID, record: () => undefined,
      })
      return { t, outcome }
    }
    const cleared = await hold(codex({ codexStatus: true }))
    expect(cleared.t.writes.slice(0, 3)).toEqual(['\u0015'.repeat(20), '/quit', '\r'])
    expect(cleared.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    const held = await hold(codex({ codexStatus: true, clearFails: true }))
    expect(held.outcome).toEqual({ kind: 'refused', why: 'Codex\'s input held text that clearing it didn\'t remove, so nothing was typed' })
    expect(held.t.writes).toEqual(['\u0015'.repeat(20)])
  })

  it('does not call a switch done on the composer it draws while still "Resuming session…" (C2)', async () => {
    // The real 0.164: the composer shows under the loading row about 2 s after the Enter, and 0.3 s later it
    // prints that the session isn't there and exits to the shell.
    const r = await run(codex({ codexStatus: true, relaunch: ['loading-then-not-found', 'box'] }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'not-found' })
    expect(r.t.ran[3]).toBe(`& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -m gpt-5.6-sol }`)
    // The terminal is recorded on the target both times, and the second try names no conversation.
    expect(r.recorded.map((x) => x.sessionId)).toEqual([ID, null])
  })

  it('waits as long as the loading row shows, however long the lookup takes (C2)', async () => {
    const r = await run(codex({ relaunch: ['loading-then-not-found', 'box'], resumeErrorMs: 20_000 }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'not-found' })
  })

  it('gives a composer with no loading row a moment to turn into the error before calling it up (C2)', async () => {
    const r = await run(codex({ relaunch: ['box-then-not-found', 'box'], resumeErrorMs: 1500 }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'not-found' })
    // And a switch that does come up costs that moment and no more.
    const up = await run(codex())
    expect(up.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(up.t.clock).toBeLessThan(10_000)
  })

  it('starts the moment again whenever the loading row comes back, before calling it up (C2)', async () => {
    // Up at once, the loading row back at 1 s and gone again at 3 s, the error at 4.5 s: the 0.5 s the composer
    // stood up front is not the moment the last stretch has to stand.
    const r = await run(codex({ relaunch: ['flicker-then-not-found', 'box'], resumeErrorMs: 4500 }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'not-found' })
  })

  it('says it took no outcome when Codex stays on its loading screen (C2)', async () => {
    const r = await run(codex({ relaunch: ['loading-then-not-found'], resumeErrorMs: 10 * 60_000 }))
    expect(r.outcome).toEqual({ kind: 'no-outcome' })
  })

  it('reports its Windows sandbox set-up menu as a question only the user answers (C2)', async () => {
    const r = await run(codex({ relaunch: ['sandbox-menu'] }))
    expect(r.outcome).toEqual({ kind: 'asks-user', what: 'Set up default sandbox' })
  })
})

describe('Claude Code 2.1.316 as it really draws (SWITCH-R1 N1, H)', () => {
  it('reads "No conversation found" drawn with a cursor-forward for each space (N1)', async () => {
    const r = await run(claude({ relaunch: ['not-found'], cursorForward: true }))
    expect(r.outcome).toEqual({ kind: 'resume-not-found' })
  })

  it('reads it from the bytes when a narrow pane wraps the line across rows (N1)', async () => {
    const r = await run(claude({ relaunch: ['not-found'], cursorForward: true, cols: 30 }))
    expect(r.outcome).toEqual({ kind: 'resume-not-found' })
  })

  it('reads it from the screen when each word is placed at its column (N1)', async () => {
    const r = await run(claude({ relaunch: ['not-found'], cursorForward: 'absolute' }))
    expect(r.outcome).toEqual({ kind: 'resume-not-found' })
  })

  it('is not taken in by a resumed conversation whose history holds the CLI\'s own error words (H)', async () => {
    for (const history of [
      ['● Invalid API key · Please run /login'],
      ['  Select login method:', '  ❯ 1. Claude account with subscription'],
      ['  New MCP servers found in .mcp.json'],
      ['  Do you trust the files in this folder?'],
    ]) {
      const r = await run(claude({ history }))
      expect(r.outcome, history.join(' / ')).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    }
  })

  // SW2-4: Claude Code prints "No conversation found with session ID" and EXITS, so no box is ever drawn under it. A healthy
  // resume whose HISTORY quotes the line (a conversation about this feature) has its box under it: it is history, and the
  // user is not offered "Start a new session" for a conversation that resumed.
  it('is not taken in by a resumed conversation whose history quotes Claude Code\'s own "no such session" line (SW2-4)', async () => {
    for (const history of [
      ['● Claude prints: No conversation found with session ID: 3f2a9c1e-5b7d-4e8f-a012-3456789abcde'],
      ['❯ what happens when the target cannot see the session?', '● It says "No conversation found with session ID" and exits.'],
    ]) {
      const r = await run(claude({ history }))
      expect(r.outcome, history.join(' / ')).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    }
    // The real thing is still read: no box under it, the shell back.
    expect((await run(claude({ relaunch: ['not-found'] }))).outcome).toEqual({ kind: 'resume-not-found' })
  })

  it('still reads a sign-in expired in the target: its footer under the box, or its sign-in screen (H)', async () => {
    const footer = await run(claude({ footer: '  ? for shortcuts      Not logged in · Run /login' }))
    expect(footer.outcome).toEqual({ kind: 'sign-in', sessionId: ID })
    const screen = await run(claude({ relaunch: ['sign-in'] }))
    expect(screen.outcome).toEqual({ kind: 'sign-in', sessionId: ID })
    const dialog = await run(claude({ relaunch: ['asks'] }))
    expect(dialog.outcome.kind).toBe('asks-user')
  })

  it('reads a Codex sign-in menu whose options draw a › row as a sign-in, not a box (H)', async () => {
    const r = await run(codex({ relaunch: ['sign-in'] }))
    expect(r.outcome).toEqual({ kind: 'sign-in', sessionId: ID })
  })
})
describe('ownScreen: where a sign-in screen\'s or a question\'s words are judged (SWITCH-R1 H)', () => {
  const RULE = '─'.repeat(40)

  it('is the whole screen when no box is drawn', () => {
    const rows = ['  Select login method:', '', '  ❯ 1. Claude account with subscription']
    expect(ownScreen(rows, 'claude')).toBe(rows.join('\n'))
    expect(ownScreen([], 'codex')).toBe('')
  })

  it('is Claude Code\'s box row and what is under it, never the history above', () => {
    const rows = ['● Invalid API key · Please run /login', '', RULE, '❯ ', RULE, '  ? for shortcuts      Not logged in · Run /login']
    expect(ownScreen(rows, 'claude')).toBe(['❯ ', RULE, '  ? for shortcuts      Not logged in · Run /login'].join('\n'))
    expect(ownScreen(rows, 'agy')).toBe(['❯ ', RULE, '  ? for shortcuts      Not logged in · Run /login'].join('\n'))
  })

  it('takes three rows over Codex\'s › row, which hold a menu\'s title, and stops at the top of the screen', () => {
    const rows = ['old history', 'more history', '  Sign in with ChatGPT to use Codex', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol medium · ~/repo']
    expect(ownScreen(rows, 'codex')).toBe(rows.slice(1).join('\n'))
    expect(ownScreen(['› Ask Codex to do anything', ''], 'codex')).toBe(['› Ask Codex to do anything', ''].join('\n'))
  })
})

describe('plain, and typing at a terminal main holds nothing for', () => {
  it('turns a cursor-forward into the spaces it moves over, one by default', () => {
    expect(plain('a\u001b[1Cb\u001b[3Cc\u001b[Cd')).toBe('a b   c d')
    // A huge move is capped: it can't build a megabyte of spaces.
    expect(plain('a\u001b[999999Cb')).toBe('a        b')
  })

  it('enters nothing at a terminal with no output held', async () => {
    const t = new FakeTerminal(claude({ start: 'gone-hint' }))
    const io = { ...t.io(), output: () => null }
    const typed = await typeAtPrompt(io, 't1', 'posix', 'claude --resume x', 0, io.now() + 3000)
    expect(typed.outcome).toBe('didnt-start')
  })
})

describe('B1 and MODELS-R1-3: the agent is gone on screen while a program still runs in the terminal', () => {
  it.each([45_000, 90_000])('types nothing into it, and does not guess it has gone (teardown %i ms)', async (teardownMs) => {
    // The agent was quit by hand a moment ago; the OS says a program has held the terminal ever since.
    const r = await run(claude({ start: 'gone-hint', reports: false, os: 'tells', teardownMs }))
    expect(r.outcome).toEqual({ kind: 'unknown-exit', osSees: true })
    expect(r.t.writes).toEqual([])
    expect(r.t.ran).toEqual([])
    expect(r.t.clock).toBeGreaterThanOrEqual(EXIT_CEILING_MS)
  })

  it('goes on once that program is gone within the wait (a slow teardown)', async () => {
    const r = await run(claude({ start: 'gone-hint', os: 'tells', teardownMs: 6000 }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
  })

  it('waits through a moment the OS cannot answer, and types nothing before the process is gone (MODELS-R1-5)', async () => {
    const r = await run(claude({ start: 'gone-hint', reports: false, os: 'flaky', teardownMs: 6000, relaunch: ['box'] }))
    expect(r.t.writeClocks.length).toBeGreaterThan(0)
    expect(Math.min(...r.t.writeClocks), 'the first key was typed while a program still ran in the terminal').toBeGreaterThanOrEqual(6000)
    expect(r.outcome.kind).toBe('switched')
  })

  it('gives the shell a moment to draw its prompt once the process is gone, before it types (MODELS-R1-5)', async () => {
    // The shell reads keys only 550 ms after the process is gone: a line typed at once would be lost.
    const r = await run(claude({ start: 'gone-hint', reports: false, os: 'tells', teardownMs: 6000, shellLateMs: PROMPT_SETTLE_MS - 50, relaunch: ['box'] }))
    expect(r.outcome.kind).toBe('switched')
    expect(Math.min(...r.t.writeClocks)).toBeGreaterThanOrEqual(6000 + PROMPT_SETTLE_MS - 50)
  })

  it('does not ask the OS at all at the user\'s word that it has exited', async () => {
    const r = await run(claude({ start: 'gone-hint', reports: false, os: 'tells', teardownMs: 90_000 }), {}, { assumeExited: true })
    expect(r.t.osAsked).toBe(0)
  })
})

describe('the lock outlasts the longest chain of waits a switch makes (MODELS-R1-5)', () => {
  it('is longer than the screen\'s exit window, the OS\'s ceiling, the prompt\'s settle and the relaunch\'s watch together', () => {
    expect(LOCK_MS).toBeGreaterThan(EXIT_CONFIRM_MS + EXIT_CEILING_MS + PROMPT_SETTLE_MS + OUTCOME_MS)
  })

  it('is not shorter than the model picker\'s hold', () => {
    expect(LOCK_MS).toBeGreaterThanOrEqual(MODEL_HOLD_MS)
  })
})

describe('G1: a line longer than the pane can show', () => {
  const line = `& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -c "developer_instructions='${'Termpolis memory for this folder; '.repeat(45)}'" resume ${ID} }`

  it('is entered once both its ends show, though its start has scrolled off the top of a short pane', async () => {
    const t = new FakeTerminal(codex({ start: 'gone-hint', cols: 60, rows: 10 }))
    expect(line.length).toBeGreaterThan(1400)
    const io = t.io()
    const typed = await typeAtPrompt(io, 't1', 'powershell', line, io.end('t1'))
    expect(typed.outcome).toBe('entered')
  })

  it('is still compared whole where the pane is tall enough to show it', async () => {
    // A character dropped from the middle of a line a tall pane can show is caught.
    const t = new FakeTerminal(codex({ start: 'gone-hint', cols: 80, rows: 40 }))
    const io = t.io()
    const typed = await typeAtPrompt(io, 't1', 'powershell', line.slice(0, 300), io.end('t1'))
    expect(typed.outcome).toBe('entered')
  })

  it('gives up at the lock\'s end, not minutes later, on a shell that reads a line very slowly', async () => {
    // 150 ms a character, a 1.5k line: twice that is nearly 8 minutes, far past the lock.
    const t = new FakeTerminal(codex({ start: 'gone-hint', shellCharMs: 150 }))
    const io = t.io()
    const until = io.now() + LOCK_MS
    const typed = await typeAtPrompt(io, 't1', 'powershell', line, io.end('t1'), until)
    expect(typed.outcome).toBe('didnt-start')
    expect(t.clock).toBeLessThanOrEqual(LOCK_MS + 2 * POLL_MS)
  })

  it('bounds the short waits before the line too: a shell that echoes nothing costs the deadline, not seconds past it', async () => {
    const t = new FakeTerminal(claude({ start: 'gone-hint', family: 'powershell', shellDead: true }))
    const io = t.io()
    const typed = await typeAtPrompt(io, 't1', 'powershell', 'a short line', io.end('t1'), io.now() + 300)
    expect(typed.outcome).toBe('didnt-start')
    expect(t.clock).toBeLessThanOrEqual(300 + 2 * POLL_MS)
    // Without a deadline the same shell costs the full waits.
    const open = new FakeTerminal(claude({ start: 'gone-hint', family: 'powershell', shellDead: true }))
    await typeAtPrompt(open.io(), 't1', 'powershell', 'a short line', open.io().end('t1'))
    expect(open.clock).toBeGreaterThan(2000)
  })

  it('is given up on at the lock\'s end through the whole switch too, not minutes later (the engine hands its deadline on)', async () => {
    const instructions = 'Termpolis memory for this folder; '.repeat(40).trim()
    const r = await run(codex({ start: 'gone-hint', shellCharMs: 150 }), {}, { instructions })
    expect(r.outcome.kind).toBe('didnt-start')
    expect(r.t.clock).toBeLessThanOrEqual(LOCK_MS + 2 * POLL_MS)
  })
})

describe('G2: a flag the shell cannot carry is refused before the agent is asked to exit', () => {
  it('cmd would expand a % in a carried flag', async () => {
    const r = await run({ agent: 'claude', family: 'cmd', start: 'idle', exit: 'hint', launch: 'claude --add-dir %USERPROFILE%\\docs' })
    expect(r.outcome.kind).toBe('refused')
    expect((r.outcome as { why: string }).why).toMatch(/cmd/)
    expect(r.t.writes).toEqual([])
  })

  it('and so would a ! in the instructions Codex is given', async () => {
    const r = await run(codex({ family: 'cmd', start: 'idle' }), {}, { instructions: 'Use the memory tools (ask!)' })
    expect(r.outcome).toEqual({ kind: 'refused', why: 'not a shell-safe instruction' })
    expect(r.t.writes).toEqual([])
  })

  it('a session id that is not one is refused as such, not thrown as a TypeError after the exit', async () => {
    const r = await run(claude({ exit: 'no-hint' }), { sessionId: 'not-a-session-id', hasTranscript: () => true })
    expect(r.outcome).toEqual({ kind: 'refused', why: 'not a session id' })
  })

  it('a % stays fine in PowerShell and Git Bash', async () => {
    for (const family of ['powershell', 'posix'] as const) {
      const r = await run(claude({ family, launch: 'claude --add-dir %USERPROFILE%\\docs' }))
      expect(r.outcome.kind, family).toBe('switched')
    }
  })
})

// MODELS-R2-4: Termpolis carries a relaunch's model and options from the line it saw the agent started with. Where it saw none
// (a start by a history recall, a reverse search), or saw one the shell edited as it was typed (Tab completion), the relaunch is
// bare and the user is told so, since a restriction (Codex's -s read-only, a permission mode) is among what is not carried.
describe('a start Termpolis did not follow (MODELS-R2-4)', () => {
  it('flags a switch that had no record of the start, whether it resumed or began anew', async () => {
    const resumed = await run(claude({ start: 'gone-hint' }), { start: undefined })
    expect(resumed.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID, unseenStart: true })
    const fresh = await run(claude({ start: 'gone-hint' }), { start: undefined }, { fresh: true })
    expect(fresh.outcome).toEqual({ kind: 'fresh', why: 'asked', unseenStart: true })
    const none = await run(claude({ exit: 'no-hint' }), { start: undefined })
    expect(none.outcome).toEqual({ kind: 'fresh', why: 'no-session', unseenStart: true })
  })

  it('flags a start the shell edited, which names only the agent, and carries none of what the keys said', async () => {
    const r = await run(claude(), { start: { at: 0, commands: ['claude'], unsure: true } })
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID, unseenStart: true })
    expect(r.recorded[0].start.commands[0]).toBe(`export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --resume ${ID}`)
  })

  it('flags nothing of a start it followed: its flags came back, and a bare one has none to lose', async () => {
    const withFlags = await run(claude({ launch: 'claude --model opus' }))
    expect(withFlags.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    const bare = await run(claude({ launch: 'claude' }))
    expect(bare.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
  })

  it('says so for Codex too, whose -s read-only is a restriction that would be dropped', async () => {
    const r = await run(codex(), { start: undefined })
    expect(r.outcome).toMatchObject({ unseenStart: true })
  })
})

// MODELS-R2-3: a Claude Code session in a worktree that ended with NO hint (zero turns print none) comes back in the main
// folder, as it always did: re-adding `--worktree` is not safe (exiting a zero-turn worktree session on Windows leaves an
// orphan directory, and `claude --worktree <name>` over it stops with "Cannot self-heal orphaned worktree … EBUSY"). So the
// outcome says which worktree it did not go back into, and the toast says so.
describe('a worktree session that exited with no hint (MODELS-R2-3)', () => {
  it.each([
    ['--worktree "feat-x"', 'claude --worktree "feat-x" --model opus'],
    ['--worktree feat-x', 'claude --worktree feat-x --model opus'],
    ['-w feat-x', 'claude -w feat-x --model opus'],
    ['--worktree=feat-x', 'claude --worktree=feat-x --model opus'],
  ])('says it started in the main folder, not in the worktree named by %s', async (_what, launch) => {
    const r = await run(claude({ exit: 'no-hint', launch }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'no-session', leftWorktree: 'feat-x' })
    // As before: the model comes back, the worktree does not (nothing is re-added on a guess).
    expect(r.recorded[0].start.commands[0]).toBe(`export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --session-id ${NEW_ID}`)
  })

  it('says the same when the user asked for a new session, which leaves the worktree behind too', async () => {
    const r = await run(claude({ worktree: 'feat-x', launch: `claude --worktree "feat-x" --model opus --session-id ${ID}` }), {}, { fresh: true })
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'asked', leftWorktree: 'feat-x' })
  })

  it('says nothing of a worktree the exit named, though it named no session id to resume in it', async () => {
    // An id that is no session id is none, and the worktree it named is still gone back into, in a new session.
    const r = await run(claude({ worktree: 'feat-x', id: 'not-an-id', launch: 'claude --worktree "feat-x" --model opus' }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'no-session' })
    expect(r.recorded[0].start.commands[0]).toContain('claude --worktree "feat-x" --model opus --session-id')
  })

  it('says nothing of one when the exit named it, the session had none, or the worktree has no name', async () => {
    const named = await run(claude({ worktree: 'feat-x', launch: `claude --worktree "feat-x" --session-id ${ID}` }))
    expect(named.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    const none = await run(claude({ exit: 'no-hint', launch: 'claude --model opus' }))
    expect(none.outcome).toEqual({ kind: 'fresh', why: 'no-session' })
    const generated = await run(claude({ exit: 'no-hint', launch: 'claude -w --model opus' }))
    expect(generated.outcome).toEqual({ kind: 'fresh', why: 'no-session' })
  })
})

describe('MODELS-R1-2: a worktree session, switched and switched back', () => {
  it('carries the quoted --worktree the first switch typed through the second and the third', async () => {
    let line = `claude --worktree "feat-x" --model opus --session-id ${ID}`
    for (let hop = 1; hop <= 3; hop++) {
      const r = await run(claude({ worktree: 'feat-x', launch: line }))
      expect(r.outcome, `hop ${hop}`).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
      line = r.recorded[0].start.commands[0]
      expect(line).toContain(`claude --worktree "feat-x" --model opus --resume ${ID}`)
    }
  })
})

describe('a shell of another kind (SWITCH-R1 F2, UI-R1-H)', () => {
  it('is refused with a card of its own once the agent is gone, with nothing entered', async () => {
    const r = await run(claude({ nestedReport: 'powershell' }))
    expect(r.outcome).toEqual({ kind: 'didnt-start', line: expect.stringContaining('claude'), otherShell: true })
    expect(r.t.ran).toEqual([''])
  })

  it('is not guessed at from a prompt that only ever writes the other family\'s marker (oh-my-posh in Git Bash)', async () => {
    const r = await run(claude({ reportsOnly: 'powershell' }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
  })
})

describe('agy, through the same steps', () => {
  const agy = (over: Partial<TermScript> = {}): TermScript => ({ agent: 'agy', family: 'posix', start: 'idle', exit: 'hint', ...over })
  const G: AgentAccount = { id: 'g2', agent: 'agy', label: 'work', profile: null, autoOffer: true, order: 1, connect: false, origin: 'label', links: [] }

  it('exits with /exit, never Ctrl+C, and resumes by --conversation', async () => {
    const r = await run(agy(), { target: G })
    expect(r.t.writes.slice(0, 2)).toEqual(['/exit', '\r'])
    expect(r.t.ran[1]).toBe(`agy --conversation=${ID}`)
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.recorded[0].sessionId).toBe(ID)
    cleanRun(r)
  })

  it('reads agy\'s "not found" as a new conversation it started by itself', async () => {
    const r = await run(agy({ relaunch: ['not-found'] }), { target: G })
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'not-found' })
  })
})

describe('R25: the transcript carried, and what is said of it', () => {
  it('carries before typing, and says it kept an older copy', async () => {
    const order: string[] = []
    const r = await run(claude(), { carry: (id) => { order.push(`carry ${id}`); return { carried: true, kept: `${id}.jsonl.bak-5` } } })
    expect(order).toEqual([`carry ${ID}`])
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID, carried: true, kept: `${ID}.jsonl.bak-5` })
    expect(r.progress).toContain('carrying')
  })

  it('goes on when the copy fails: the target says if it can\'t find the session', async () => {
    const r = await run(claude(), { carry: () => { throw new Error('EACCES') } })
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
  })

  it('carries nothing for a new session', async () => {
    let carried = 0
    await run(claude({ start: 'gone-hint' }), { carry: () => { carried++; return { carried: false } } }, { fresh: true })
    expect(carried).toBe(0)
  })
})

describe('a swarm worker restarted on another account (§9)', () => {
  it('Claude Code: closes its rate-limit menu, exits, and resumes with the worker\'s own command, the lock saying it is a worker\'s', async () => {
    let held: string | null = null
    const t0 = new FakeTerminal(claude({ start: 'menu', launch: 'claude --dangerously-skip-permissions' }))
    const io = t0.io()
    const outcome = await runAccountSwitch({ terminalId: 'tW', targetId: B.id, shellType: 'gitbash', reason: 'usage limit' }, {
      io: { ...io, write: (id, d) => { held ??= relaunchLockReason('tW', t0.clock); io.write(id, d) } },
      target: B, agent: 'claude', lockKind: 'worker',
      start: { at: t0.launchedAt, commands: [t0.launchLine()] }, newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(held).toBe('Termpolis is restarting this worker; wait for system\'s next message')
    expect(relaunchLockReason('tW', t0.clock)).toBeNull()
    // Esc closed the menu; the line keeps the worker's flag, and never --continue.
    expect(t0.writes[0]).toBe('\u001b')
    expect(t0.ran).toEqual(['', `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --dangerously-skip-permissions --resume ${ID}`])
    expect(t0.sentPrompts).toEqual([])
  })

  it('Codex: resumes with the worker\'s -a, -s and update check off, before resume', async () => {
    const r = await run(codex({ launch: 'codex -a never -s workspace-write -c check_for_update_on_startup=false' }), { lockKind: 'worker' })
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.t.ran).toEqual(['', `& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -a never -s workspace-write -c check_for_update_on_startup=false resume ${ID} }`])
    cleanRun(r)
  })
})

describe('R7: the lock', () => {
  it('holds the terminal for the run, refuses a second switch, and lets go on every outcome', async () => {
    const t = new FakeTerminal(claude({ relaunch: ['nothing'] }))
    let seenLocked: string | null = null
    const io = t.io()
    const p = runAccountSwitch({ terminalId: 'tL', targetId: 'acc_b', shellType: 'bash' }, {
      io: { ...io, write: (id, d) => { seenLocked = relaunchLockReason('tL', t.clock); io.write(id, d) } },
      target: B, agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, newSessionId: () => NEW_ID, record: () => undefined,
    })
    const second = await runAccountSwitch({ terminalId: 'tL', targetId: 'acc_b', shellType: 'bash' }, {
      io, target: B, agent: 'claude', newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(second).toEqual({ kind: 'refused', why: 'a switch is already running in this terminal' })
    await p
    expect(seenLocked).toBe('Termpolis is switching this agent\'s account; wait for system\'s next message')
    expect(relaunchLockReason('tL', t.clock)).toBeNull()
  })

  it('lets a lock go once LOCK_MS have passed, whatever happens', async () => {
    const t = new FakeTerminal(claude({ relaunch: ['nothing'] }))
    const io = t.io()
    let held: number | null = null
    const p = runAccountSwitch({ terminalId: 'tX', targetId: 'acc_b', shellType: 'bash' }, {
      io: { ...io, write: (id, d) => { if (held === null) held = t.clock; io.write(id, d) } },
      target: B, agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(relaunchLockReason('tX', LOCK_MS + 1)).toBeNull()
    await p
  })

  it('answers a thrown error as a refusal, and lets the lock go', async () => {
    const t = new FakeTerminal(claude())
    const outcome = await runAccountSwitch({ terminalId: 'tE', targetId: 'acc_b', shellType: 'bash' }, {
      io: { ...t.io(), outputFrom: () => { throw new Error('buffer gone') } }, target: B, agent: 'claude',
      start: { at: t.launchedAt, commands: [t.launchLine()] }, newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(outcome).toEqual({ kind: 'refused', why: 'buffer gone' })
    expect(relaunchLockReason('tE')).toBeNull()
    const odd = await runAccountSwitch({ terminalId: 'tE', targetId: 'acc_b', shellType: 'bash' }, {
      io: { ...t.io(), output: () => { throw 'odd' } }, target: B, agent: 'claude', newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(odd).toEqual({ kind: 'refused', why: 'odd' })
  })

  it('gives the model picker its own hold (§7.5): its keyed writes pass, nothing else does, and it lapses', () => {
    const key = holdForModel('tM', 1000) as string
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    expect(relaunchLockReason('tM', 1000)).toBe('Termpolis is changing this agent\'s model; wait for system\'s next message')
    expect(relaunchLockReason('tM', 1000, 'k-other')).toBe('Termpolis is changing this agent\'s model; wait for system\'s next message')
    expect(relaunchLockReason('tM', 1000, key)).toBeNull()
    // One hold at a time: a second pick, or a switch, while it holds.
    expect(holdForModel('tM', 1001)).toBeNull()
    // Another's key lets nothing go; its own does.
    releaseModelHold('tM', 'k-other')
    expect(relaunchLockReason('tM', 1002)).not.toBeNull()
    releaseModelHold('tM', key)
    expect(relaunchLockReason('tM', 1002)).toBeNull()
    // Nothing held: nothing to let go.
    expect(() => releaseModelHold('tM', key)).not.toThrow()
    // A renderer that stops halfway leaves it held no longer than MODEL_HOLD_MS.
    const again = holdForModel('tM', 2000) as string
    expect(relaunchLockReason('tM', 2000 + MODEL_HOLD_MS - 1)).not.toBeNull()
    expect(relaunchLockReason('tM', 2000 + MODEL_HOLD_MS)).toBeNull()
    expect(holdForModel('tM', 2000 + MODEL_HOLD_MS)).not.toBe(again)
  })

  it('tells the key of the picker\'s live hold from every other: no hold, another key, a lapsed hold, a switch\'s hold', async () => {
    expect(holdsModelKey('tK', 'any', 1000)).toBe(false)
    const key = holdForModel('tK', 1000) as string
    expect(holdsModelKey('tK', key, 1000)).toBe(true)
    expect(holdsModelKey('tK', key)).toBe(false) // the real clock is long past a hold taken at 1000
    expect(holdsModelKey('tK', 'k-other', 1000)).toBe(false)
    expect(holdsModelKey('tK', undefined, 1000)).toBe(false)
    expect(holdsModelKey('tK', '', 1000)).toBe(false)
    expect(holdsModelKey('tK', key, 1000 + MODEL_HOLD_MS - 1)).toBe(true)
    expect(holdsModelKey('tK', key, 1000 + MODEL_HOLD_MS)).toBe(false)
    expect(holdsModelKey('tOther', key, 1000)).toBe(false)
    releaseModelHold('tK', key)
    expect(holdsModelKey('tK', key, 1000)).toBe(false)
    // A switch's hold has no key anyone could hold.
    const t = new FakeTerminal(claude({ relaunch: ['nothing'] }))
    const io = t.io()
    let during: boolean | null = null
    await runAccountSwitch({ terminalId: 'tK', targetId: 'acc_b', shellType: 'bash' }, {
      io: { ...io, write: (id, d) => { during = holdsModelKey('tK', 'any', t.clock); io.write(id, d) } },
      target: B, agent: 'claude', start: { at: t.launchedAt, commands: ['claude'] }, newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(during).toBe(false)
  })

  it('holds the picker\'s terminal for longer than the longest relaunch the picker can make (modelRelaunch.ts)', () => {
    // The picker's relaunch waits up to EXIT_CEILING_MS for the agent to hand the prompt back (after
    // a first answer and a settle), reads, types, and gives a resume of "the latest" RESUME_PROBE_MS
    // to fail; the hold has to outlast all of it, or main would drop the picker's own last keys.
    expect(MODEL_HOLD_MS).toBeGreaterThan(EXIT_CEILING_MS + BLIND_EXIT_WAIT_MS + PROMPT_SETTLE_MS + RESUME_PROBE_MS)
    expect(MODEL_HOLD_MS).toBeLessThanOrEqual(LOCK_MS)
  })

  it('refuses the picker a terminal a switch holds, and a switch one the picker holds; no key opens a switch\'s', async () => {
    const t = new FakeTerminal(claude({ relaunch: ['nothing'] }))
    let pickerKey: string | null = 'unset'
    let keyed: string | null = 'unset'
    const io = t.io()
    const p = runAccountSwitch({ terminalId: 'tS', targetId: 'acc_b', shellType: 'bash' }, {
      io: { ...io, write: (id, d) => { pickerKey = holdForModel('tS', t.clock); keyed = relaunchLockReason('tS', t.clock, 'any'); io.write(id, d) } },
      target: B, agent: 'claude', start: { at: t.launchedAt, commands: ['claude'] }, newSessionId: () => NEW_ID, record: () => undefined,
    })
    await p
    expect(pickerKey).toBeNull()
    expect(keyed).toBe('Termpolis is switching this agent\'s account; wait for system\'s next message')
    const key = holdForModel('tS', t.clock) as string
    const refused = await runAccountSwitch({ terminalId: 'tS', targetId: 'acc_b', shellType: 'bash' }, {
      io: t.io(), target: B, agent: 'claude', newSessionId: () => NEW_ID, record: () => undefined,
    })
    expect(refused).toEqual({ kind: 'refused', why: 'a switch is already running in this terminal' })
    releaseModelHold('tS', key)
  })
})

// The OS's word (shellAlone.ts) on whether only the shell is left in the terminal has the last say,
// as it has in the model switch (modelRelaunch.ts), whose live runs found: Claude Code takes 4 to 11 s
// to hand the terminal back on a machine with SessionEnd hooks, and what is typed meanwhile is lost
// without a sound. The screen shows the goodbye at once, and on Windows nothing else shows the end.
describe('the OS has the last word on whether the agent is gone', () => {
  const LINE = (id: string) => `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${id}`

  it('types nothing until the process is gone, though its exit hint shows at once', async () => {
    const r = await run(claude({ reports: false, os: 'tells', teardownMs: 6000 }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.t.ran).toEqual(['', LINE(ID)])
    // The sacrificial Enter and the line itself came after the process was gone, not while it was going.
    const exitAt = r.t.writeClocks[r.t.writes.indexOf('\r', r.t.writes.indexOf('/exit') + 1)]
    expect(r.t.writeClocks[r.t.writes.length - 1]).toBeGreaterThanOrEqual(exitAt + 6000)
    cleanRun(r)
  })

  it('loses the line typed during the teardown, and says the switch did not start, where the OS cannot be asked', async () => {
    // The contrast: without the OS's word the screen says "gone" at once, the line goes to a shell
    // that is not reading yet, and nothing is entered.
    const r = await run(claude({ reports: false, teardownMs: 6000 }))
    expect(r.outcome).toMatchObject({ kind: 'didnt-start' })
    expect(r.t.ran).toEqual([])
  })

  it('waits on past the screen\'s 8 s for an exit that only shows at the end of a slow teardown', async () => {
    const r = await run(claude({ reports: false, os: 'tells', teardownMs: 12_000, hintAfterTeardown: true }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.t.clock).toBeGreaterThanOrEqual(12_000)
    // ...where without the OS the same 8 s window ends with nothing confirmed and nothing more typed.
    const blind = await run(claude({ reports: false, teardownMs: 12_000, hintAfterTeardown: true }))
    expect(blind.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(blind.t.ran).toEqual([])
  })

  it('confirms an exit that printed no hint at all (a session with no turns), on Windows too', async () => {
    const r = await run(claude({ exit: 'no-hint', reports: false, os: 'tells' }))
    expect(r.outcome).toEqual({ kind: 'fresh', why: 'no-session' })
    expect(r.t.ran).toEqual(['', `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --session-id ${NEW_ID}`])
  })

  it('sends no exit key to an agent the OS says is gone, though its last frame is still on the screen', async () => {
    const r = await run(claude({ start: 'gone-quiet', reports: false, os: 'tells' }), { sessionId: ID2, hasTranscript: (id) => id === ID2 })
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID2 })
    expect(keys(r.t)).not.toContain('/exit')
    expect(r.t.ran).toEqual(['', LINE(ID2)])
    // ...where the same screen with no OS to ask is an agent live on screen, and gets its exit command.
    const blind = await run(claude({ start: 'gone-quiet', reports: false }), { sessionId: ID2, hasTranscript: (id) => id === ID2 })
    expect(keys(blind.t)).toContain('/exit')
  })

  it('waits for an agent the user quit by hand a moment ago, whose process is still going', async () => {
    const r = await run(claude({ start: 'gone-hint', reports: false, os: 'tells', teardownMs: 5000 }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(keys(r.t)).not.toContain('/exit')
    expect(r.t.ran).toEqual(['', LINE(ID)])
    expect(r.t.writeClocks[0]).toBeGreaterThanOrEqual(5000)
  })

  it('types nothing but its exit command, and says it could not confirm, when the process outlives the ceiling', async () => {
    const r = await run(claude({ exit: 'ignore', reports: false, os: 'tells' }))
    expect(r.outcome).toEqual({ kind: 'exit-unconfirmed', osSees: true })
    expect(r.t.writes).toEqual(['/exit', '\r'])
    expect(r.t.clock).toBeGreaterThanOrEqual(EXIT_CONFIRM_MS + EXIT_CEILING_MS)
    expect(r.t.ran).toEqual([])
  })

  // The OS answered "a program still runs" for the whole ceiling, though the exit hint is on screen (a
  // teardown that outlasts it, or a background job in the shell that keeps the console busy). The model
  // switch types nothing then, and neither does this one: its keys would reach whatever still holds the
  // terminal. The card's "It has exited, switch now" is the user's word that it has.
  it.each([45_000, 90_000])('types nothing more when the process outlives the ceiling, though its hint shows (teardown %i ms)', async (teardownMs) => {
    const r = await run(claude({ reports: false, os: 'tells', teardownMs }))
    expect(r.outcome).toEqual({ kind: 'exit-unconfirmed', osSees: true })
    expect(r.t.writes).toEqual(['/exit', '\r'])
    expect(r.t.ran).toEqual([])
    expect(keys(r.t)).not.toMatch(/[\u0003\u0004]/)
  })


  it('goes on the screen\'s word where the OS cannot tell, as before it was asked', async () => {
    const blind = await run(claude({ os: 'blind' }))
    expect(blind.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    const none = await run(claude({ exit: 'ignore', reports: false, os: 'blind' }))
    expect(none.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(none.t.writes).toEqual(['/exit', '\r'])
  })

  it('treats a question it cannot answer after "still running" as a hiccup, and goes on waiting', async () => {
    const r = await run(claude({ reports: false, os: 'flaky', teardownMs: 6000 }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(r.t.ran).toEqual(['', LINE(ID)])
  })

  it('asks the OS nothing when the user said the agent exited: their word replaces the check', async () => {
    const r = await run(claude({ start: 'gone-hint', reports: false, os: 'tells' }), {}, { assumeExited: true })
    expect(r.t.osAsked).toBe(0)
    expect(r.outcome).toMatchObject({ kind: 'switched' })
  })

  it('keeps the terminal\'s lock through a long teardown, and still has time to watch the relaunch come up', async () => {
    const r = await run(claude({ reports: false, os: 'tells', teardownMs: 28_000, hintAfterTeardown: true }))
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    expect(relaunchLockReason('t1', r.t.clock)).toBeNull()
  })
})

// Three guards that defend in depth and that no test pinned (found by mutation): each is what keeps a
// leftover on the screen from passing for this switch's own evidence.
describe('what on the screen is not this switch\'s own evidence', () => {
  const LINE = `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${ID}`

  it('an exit hint printed before the exit command was typed is no exit (the hint must be printed since)', async () => {
    const t = new FakeTerminal(claude({ start: 'gone-hint' }))
    const io = t.io()
    // The hint is at the screen's foot, a leftover of an earlier exit: nothing was printed since this mark.
    const mark = io.end('t1')
    expect(hintAtFoot(look(io, 't1'), 'claude')).not.toBeNull()
    expect(exitShown(io, 't1', 'claude', mark)).toBeNull()
    // Printed after the mark, the same hint is the exit.
    expect(exitShown(io, 't1', 'claude', 0)?.hint?.id).toBe(ID)
  })

  it("an exit hint far above the screen's foot is history, not this exit", () => {
    // 14 rows from the foot is as far as a hint counts (HINT_FROM_FOOT_ROWS); these are literal rows, not that constant.
    const filler = (n: number): string[] => Array.from({ length: n }, () => 'x')
    expect(exitHintOf(['Resume this session with:', `  claude --resume ${ID}`, ...filler(10)], 'claude')?.id).toBe(ID)
    expect(exitHintOf(['Resume this session with:', `  claude --resume ${ID}`, ...filler(20)], 'claude')).toBeNull()
  })

  it('the same account line still on the screen from an earlier switch is no echo of this one', async () => {
    // The screen's last rows still hold the very line, typed before; what the shell wrote since is nothing.
    const raw = `\x1b]7;file://host/c/repo\x07me@host MINGW64 /c/repo\r\n$ ${LINE}\r\nsome output\r\n\x1b]7;file://host/c/repo\x07me@host MINGW64 /c/repo\r\n$ `
    let clock = 0
    const io: SwitchIO = {
      output: () => ({ raw, end: raw.length }),
      outputFrom: () => '',
      end: () => raw.length,
      size: () => ({ cols: 120, rows: 24 }),
      write: () => undefined,
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
    }
    const typed = await typeAtPrompt(io, 't1', 'posix', LINE, raw.length)
    expect(typed.outcome).toBe('didnt-start')
    // A line no longer than the first part typed has only that one look to pass: its echo must be in what was written since.
    const short = 'claude --x'
    const raw2 = `$ ${short}\r\nsome output\r\n\x1b]7;file://host/c/repo\x07me@host MINGW64 /c/repo\r\n$ `
    const io2: SwitchIO = { ...io, output: () => ({ raw: raw2, end: raw2.length }), end: () => raw2.length }
    expect((await typeAtPrompt(io2, 't1', 'posix', short, raw2.length)).outcome).toBe('didnt-start')
  })

  it('presses no Enter on a line that came back with a character dropped from its middle, though both its ends show', async () => {
    const at = LINE.indexOf('claude-b') + 3
    const dropped = LINE.slice(0, at) + LINE.slice(at + 1)
    expect(dropped).not.toBe(LINE)
    const prompt = '\x1b]7;file://host/c/repo\x07me@host MINGW64 /c/repo\r\n$ '
    let raw = prompt
    let clock = 0
    const writes: string[] = []
    const io: SwitchIO = {
      output: () => ({ raw, end: raw.length }),
      outputFrom: (_id, from) => raw.slice(Math.max(0, from)),
      end: () => raw.length,
      size: () => ({ cols: 120, rows: 24 }),
      // The shell echoes what it is given, but loses a character of the path in the middle.
      write: (_id, data) => {
        writes.push(data)
        if (data === LINE.slice(0, 16)) raw += data
        else if (data === LINE.slice(16)) raw += dropped.slice(16)
      },
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
    }
    const typed = await typeAtPrompt(io, 't1', 'posix', LINE, raw.length)
    expect(typed.outcome).toBe('didnt-start')
    // One Enter only: the sacrificial one before the line. None for the line.
    expect(writes.filter((w) => w === '\r')).toHaveLength(1)
  })

  it('shows a long line whole on a narrow pane, wrapped over several rows', async () => {
    const long = `& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -m gpt-5.6-sol resume ${ID2} }`
    const cols = 40
    expect(Math.ceil(long.length / cols)).toBeGreaterThan(2)
    let raw = 'PS C:\\repo> '
    let clock = 0
    const io: SwitchIO = {
      output: () => ({ raw, end: raw.length }),
      outputFrom: (_id, from) => raw.slice(Math.max(0, from)),
      end: () => raw.length,
      size: () => ({ cols, rows: 24 }),
      write: (_id, data) => { if (data !== '\x1b' && data !== '\r') raw += data },
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
    }
    expect((await typeAtPrompt(io, 't1', 'powershell', long, raw.length)).outcome).toBe('entered')
  })

  it('reads a pane whose size nobody knows as 80 columns wide, and still sees a long line whole', async () => {
    const line = `& { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-b'; codex -m gpt-5.6-sol resume ${ID2} }`
    expect(line.length).toBeGreaterThan(80)
    let raw = 'PS C:\\repo> '
    let clock = 0
    const io: SwitchIO = {
      output: () => ({ raw, end: raw.length }),
      outputFrom: (_id, from) => raw.slice(Math.max(0, from)),
      end: () => raw.length,
      size: () => null,
      write: (_id, data) => { if (data !== '\x1b' && data !== '\r') raw += data },
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
    }
    expect(look(io, 't1').cols).toBeUndefined()
    expect((await typeAtPrompt(io, 't1', 'powershell', line, raw.length)).outcome).toBe('entered')
  })
})

// SW2-3: the words of a resumed conversation's history are not the target's own screen. The H fix reads a screen below the
// agent's box, but a one-time dialog replaces the box, and the whole screen is judged then: real Claude Code 2.1.316 draws
// "Try the new fullscreen renderer?" under the history on a profile never used before, and a history whose last message is
// "Please run /login" (the switch was made from an account whose sign-in expired) read as the target's sign-in screen,
// with a false "signed out" for a healthy account. These rows are the real frame.
describe('a question drawn under the resumed history (SW2-3)', () => {
  const E = '\u001b'
  const RULE = '─'.repeat(100)
  const HISTORY = [' ▐▛███▛█   Claude Code v2.1.316', '▝▜██████▀  Sonnet 4.5 · API Usage Billing', ' ▝▝   ▝▝   C:\\work', '', '❯ hi', '', '● Hello from the synthetic transcript.', '', '❯ and now?', '', '● Invalid API key - Please run /login', '']
  const DIALOG = [RULE, '  Try the new fullscreen renderer?', '', '  · Flicker-free output — fixes the flashing you see during long responses', '  · Mouse support — click to move your cursor or expand results', '', '  ❯ 1. Yes, try it', '    2. Not now', '', '  Enter to confirm · Esc to cancel']
  const SIGN_IN = ['  Select login method:', '', '  ❯ 1. Claude account with subscription', '    2. Anthropic Console account', '', '  Enter to confirm · Esc to cancel']
  const frame = (rows: string[]): string => `${E}[H${E}[2J` + rows.map((r, i) => `${E}[${i + 1};1H${r}`).join('')
  const LINE_ = 'claude --resume 8c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'

  /** What the terminal has shown by each moment: the frames in order, each from its time on. */
  function io(frames: Array<[number, string]>): SwitchIO {
    let now = 0
    const raw = (): string => frames.filter(([at]) => at <= now).map(([, f]) => f).join('')
    return {
      output: () => ({ raw: raw(), end: raw().length }),
      outputFrom: (_id, from) => raw().slice(Math.min(from, raw().length)),
      end: () => raw().length,
      size: () => ({ cols: 120, rows: 30 }),
      write: () => undefined,
      sleep: async (ms) => { now += ms },
      now: () => now,
    }
  }

  it('is a question for the user, not the target\'s sign-in screen, when the history holds login words', async () => {
    const r = await watchOutcome(io([[0, frame([...HISTORY, ...DIALOG])]]), 'T', 'claude', 0, LINE_, Infinity)
    expect(r.seen).toEqual({ asks: 'Try the new fullscreen renderer' })
  })

  it('is the same question where the history has no login words', async () => {
    const r = await watchOutcome(io([[0, frame([...HISTORY.map((x) => x.replace('Invalid API key - Please run /login', 'Done.')), ...DIALOG])]]), 'T', 'claude', 0, LINE_, Infinity)
    expect(r.seen).toEqual({ asks: 'Try the new fullscreen renderer' })
  })

  it('waits out the moment the history is drawn and the dialog is not yet, instead of calling the history a sign-in screen', async () => {
    // The history first, the dialog 700 ms later: the look at 500 ms sees the history alone, the one at 1000 ms the dialog.
    const r = await watchOutcome(io([[0, frame(HISTORY)], [700, frame([...HISTORY, ...DIALOG])]]), 'T', 'claude', 0, LINE_, Infinity)
    expect(r.seen).toEqual({ asks: 'Try the new fullscreen renderer' })
  })

  it('still reads a real sign-in screen with no box, once it has stood for two looks', async () => {
    const shown = io([[0, frame(SIGN_IN)]])
    const r = await watchOutcome(shown, 'T', 'claude', 0, LINE_, Infinity)
    expect(r.seen).toBe('sign-in')
    // Not at the first look: that look could be a frame of the history on its way, which a second look clears.
    expect(shown.now()).toBeGreaterThanOrEqual(POLL_MS * 4)
  })

  it('reads a sign-in footer under a drawn box at the first look', async () => {
    const shown = io([[0, frame([...HISTORY, RULE, '❯ ', RULE, '  Not logged in · Run /login'])]])
    const r = await watchOutcome(shown, 'T', 'claude', 0, LINE_, Infinity)
    expect(r.seen).toBe('sign-in')
    expect(shown.now()).toBe(POLL_MS * 2)
  })
})

// SW2-6: agy prints its exit hint at the TOP of a block it repaints, 13 to 18 rows above the shell's prompt in the only
// real capture main holds. The hint is read within HINT_FROM_FOOT_ROWS of the foot, so a pane tall enough to hold the
// whole block (24 rows and more) lost the conversation's id, and each Gemini terminal came back with a NEW conversation
// instead of `agy --conversation=<id>`. The id is read from what agy printed since the exit command as well.
describe('the real agy exit, read at any pane size (SW2-6)', () => {
  const ioOfRaw = (raw: string, cols: number, rows: number): SwitchIO => ({
    output: () => ({ raw, end: raw.length }),
    outputFrom: (_id, from) => raw.slice(Math.min(from, raw.length)),
    end: () => raw.length,
    size: () => ({ cols, rows }),
    write: () => undefined,
    sleep: async () => undefined,
    now: () => 0,
  })

  it.each([[80, 24], [60, 25], [50, 30], [100, 30], [120, 45], [200, 80], [100, 14], [100, 20]])('names the conversation at %i columns by %i rows', (cols, rows) => {
    const shown = exitShown(ioOfRaw(AGY_EXIT_AFTER_A_TURN, cols, rows), 't1', 'agy', 0)
    expect(shown?.hint?.id).toBe(AGY_CONVERSATION_ID)
  })

  it('still names the conversation a hint at the foot names, and none where agy printed none', () => {
    expect(exitShown(ioOfRaw(AGY_EXIT_AFTER_A_TURN, 100, 30), 't1', 'agy', 0)?.hint?.id).toBe(AGY_CONVERSATION_ID)
    // A hint printed BEFORE the mark is no exit of this switch's: nothing since.
    expect(exitShown(ioOfRaw(AGY_EXIT_AFTER_A_TURN, 80, 24), 't1', 'agy', AGY_EXIT_AFTER_A_TURN.length)).toBeNull()
  })

  it('does not take the hint of another agent from what was printed', () => {
    expect(exitShown(ioOfRaw(AGY_EXIT_AFTER_A_TURN, 80, 24), 't1', 'claude', 0)?.hint ?? null).toBeNull()
  })
})

// SW2-5: the account line's first part had a fixed 4.4 s to show, and the shell was taken to be back after 250 ms of
// silence. Measured with real shells on this laptop (probe-out k2): right after a child exits, Git Bash with David's git-aware
// PROMPT_COMMAND took 4.9 to 15.5 s to echo 16 characters, PowerShell 1.7 to 4.3 s with one sample that never echoed. Under
// load that ended a healthy switch as "the account line never showed" (a safe failure, with Try again, but frequent). A shell
// that is still PRINTING is not stalled, so the wait goes on while its output grows and ends after a quiet spell; and where the
// terminal's shell reports its prompts, the prompt's report says when it is back, not 250 ms of silence.
describe('a shell that is slow to draw its prompt and to echo (SW2-5)', () => {
  const OSC = '\x1b]9;9;C:\repo\x07'
  const ESC_KEY = '\x1b'
  const LINE_SW = 'claude --resume 3f2a9c1e-5b7d-4e8f-a012-3456789abcde'

  interface Slow {
    /** When the shell reads keys: those typed before are lost (ConPTY drops the first byte of what is typed too early). */
    readyAt: number
    /** How long after a key is read the shell draws it. */
    echoMs: number
    /** Prints a dot this often while a key waits to be drawn: a shell that is busy, not stalled. */
    chatterMs?: number
    /** After the Enter, the prompt (and its report) comes at readyAt; without it only a newline is drawn. */
    report: boolean
    /** The terminal has printed this family's reports before. */
    knownReporting: boolean
    /** A shell of the other family took the terminal's place: it reports as bash does (OSC 7). */
    nested?: boolean
  }

  function slowShell(o: Slow) {
    let now = 0
    let raw = 'PS C:\repo> '
    const writes: Array<{ at: number; d: string }> = []
    const later: Array<{ at: number; text: string }> = []
    const settle = (): void => {
      later.sort((a, b) => a.at - b.at)
      while (later.length > 0 && later[0].at <= now) raw += later.shift()!.text
    }
    const io: SwitchIO = {
      output: () => { settle(); return { raw, end: raw.length } },
      outputFrom: (_id, from) => { settle(); return raw.slice(Math.min(from, raw.length)) },
      end: () => { settle(); return raw.length },
      size: () => ({ cols: 120, rows: 30 }),
      write: (_id, d) => {
        settle()
        writes.push({ at: now, d })
        if (d === '\r') {
          later.push({ at: now + 30, text: '\r\n' })
          if (o.nested) later.push({ at: now + 30, text: '\x1b]7;file://host/c/repo\x07me@host $ ' })
          else if (o.report) later.push({ at: Math.max(o.readyAt, now + 30), text: `${OSC}PS C:\repo> ` })
        } else if (d !== ESC_KEY && now >= o.readyAt) {
          later.push({ at: now + o.echoMs, text: d })
          if (o.chatterMs) for (let t = o.chatterMs; t < o.echoMs; t += o.chatterMs) later.push({ at: now + t, text: '.' })
        }
      },
      sleep: async (ms) => { now += ms },
      now: () => now,
      ...(o.knownReporting ? { reported: () => ({ posix: false, windows: true }) } : {}),
    }
    return { io, writes, clock: () => now }
  }
  const typed = (s: ReturnType<typeof slowShell>) => s.writes.map((w) => w.d)

  it('goes on waiting while the shell is still printing, and enters the line once it shows', async () => {
    // The shell reads at once and draws the key 8 s later, printing a dot a second meanwhile.
    const s = slowShell({ readyAt: 0, echoMs: 8000, chatterMs: 1000, report: false, knownReporting: false })
    const r = await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)
    expect(r.outcome).toBe('entered')
    expect(typed(s).slice(-1)).toEqual(['\r'])
  })

  it('gives up on a shell that draws nothing at all, after the same quiet spell as before', async () => {
    const s = slowShell({ readyAt: 0, echoMs: 60_000, report: false, knownReporting: false })
    const r = await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)
    expect(r.outcome).toBe('didnt-start')
    // The quiet spell is ECHO_MS plus the probe's characters at the slow shell's rate, as it always was.
    const probeAt = s.writes.find((w) => w.d === LINE_SW.slice(0, ECHO_PROBE_CHARS))!.at
    expect(s.clock() - probeAt).toBeGreaterThanOrEqual(ECHO_MS + ECHO_PROBE_CHARS * ECHO_SLOW_CHAR_MS)
    expect(s.clock() - probeAt).toBeLessThan(ECHO_MS + ECHO_PROBE_CHARS * ECHO_SLOW_CHAR_MS + 1000)
    expect(typed(s).slice(-1)).toEqual(['\x1b'])
  })

  it('does not wait for ever on a shell that keeps printing and never shows the line: ECHO_MAX_MS, or the lock, ends it', async () => {
    const s = slowShell({ readyAt: 0, echoMs: 600_000, chatterMs: 1000, report: false, knownReporting: false })
    expect((await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)).outcome).toBe('didnt-start')
    const probeAt = s.writes.find((w) => w.d === LINE_SW.slice(0, ECHO_PROBE_CHARS))!.at
    expect(s.clock() - probeAt).toBeGreaterThanOrEqual(ECHO_MAX_MS)
    expect(s.clock() - probeAt).toBeLessThanOrEqual(ECHO_MAX_MS + POLL_MS)
    // The lock the switch holds the terminal under ends it earlier, whatever it prints.
    const held = slowShell({ readyAt: 0, echoMs: 600_000, chatterMs: 1000, report: false, knownReporting: false })
    expect((await typeAtPrompt(held.io, 't1', 'powershell', LINE_SW, 0, held.io.now() + 20_000)).outcome).toBe('didnt-start')
    expect(held.clock()).toBeLessThanOrEqual(20_000 + POLL_MS)
  })

  it('waits for the prompt\'s report where the terminal\'s shell reports, and types the line only once it is back', async () => {
    // Silent for 3 s after the Enter (the prompt is being built), reading nothing until its report: keys typed before are lost.
    const s = slowShell({ readyAt: 3000, echoMs: 40, report: true, knownReporting: true })
    const r = await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)
    expect(r.outcome).toBe('entered')
    const probeAt = s.writes.find((w) => w.d === LINE_SW.slice(0, ECHO_PROBE_CHARS))!.at
    expect(probeAt).toBeGreaterThanOrEqual(3000)
  })

  it('takes silence for the prompt where the terminal has never reported, as before', async () => {
    const s = slowShell({ readyAt: 3000, echoMs: 40, report: true, knownReporting: false })
    const r = await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)
    // The probe went in at the first 250 ms of quiet, before the shell read: lost, so the line never showed.
    expect(r.outcome).toBe('didnt-start')
    const probeAt = s.writes.find((w) => w.d === LINE_SW.slice(0, ECHO_PROBE_CHARS))!.at
    expect(probeAt).toBeLessThan(3000)
  })

  // SW2-10: the guard against a shell of another kind (one started inside this terminal's) needs to know that the terminal's
  // OWN shell reported before. The window the engine reads holds the last 32 KB, and after an agent's work no report is in
  // it, so the guard never fired and the switch ended as "nothing showed within 30 s" instead of the card that says why.
  it('knows a nested shell by what main kept of the terminal\'s own reports, after the window lost them', async () => {
    const s = slowShell({ readyAt: 0, echoMs: 40, report: false, knownReporting: true, nested: true })
    const r = await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)
    expect(r.outcome).toBe('mismatch')
    // Nothing of the line was typed into the other shell.
    expect(typed(s).filter((d) => d.includes('claude'))).toEqual([])
  })

  it('does not take a shell for nested that never reported as its own family, in the window or kept', async () => {
    const s = slowShell({ readyAt: 0, echoMs: 40, report: false, knownReporting: false, nested: true })
    const r = await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)
    expect(r.outcome).not.toBe('mismatch')
  })

  it('gives up on a report that never comes, after the ceiling, and types the probe all the same', async () => {
    const s = slowShell({ readyAt: 0, echoMs: 40, report: false, knownReporting: true })
    const r = await typeAtPrompt(s.io, 't1', 'powershell', LINE_SW, 0)
    expect(r.outcome).toBe('entered')
    const probeAt = s.writes.find((w) => w.d === LINE_SW.slice(0, ECHO_PROBE_CHARS))!.at
    expect(probeAt).toBeGreaterThanOrEqual(PROMPT_REPORT_WAIT_MS)
    expect(probeAt).toBeLessThanOrEqual(PROMPT_REPORT_WAIT_MS + POLL_MS * 2)
  })
})

// SW2-7 / MODELS-R2-1, the other half: where no sacrificial key goes in because the screen still draws an agent's box, the
// receiver can be the SHELL (ConPTY leaves an exited agent's last frame on screen), with text the user left on its line. The
// first part of the line is then typed after it, so it is proven to be the shell that holds it, and only then is the line
// cleared and the ordinary steps run: the line entered is the account line, never what was left joined to it.
describe('the first part of the line typed at a shell that still shows the agent\'s last frame (SW2-7)', () => {
  const E_ = '\u001b'
  const LINE_S = `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --resume ${ID}`

  function staleFrameShell(leftover: string, family: 'posix' | 'powershell' | 'cmd') {
    let now = 0
    const rule = '─'.repeat(80)
    const frame = `${E_}[H${E_}[2J` + [rule, '❯ ', rule, '  ? for shortcuts'].map((r, i) => `${E_}[${i + 1};1H${r}`).join('')
    let raw = frame + `${E_}[6;1H$ ${leftover}`
    let typed = leftover
    let row = 6
    const ran: string[] = []
    const writes: string[] = []
    const clearKey = LINE_CLEAR[family]
    const io: SwitchIO = {
      output: () => ({ raw, end: raw.length }),
      outputFrom: (_id, from) => raw.slice(Math.min(from, raw.length)),
      end: () => raw.length,
      size: () => ({ cols: 80, rows: 12 }),
      write: (_id, d) => {
        writes.push(d)
        if (d === clearKey) {
          typed = ''
          raw += `${E_}[${row};1H$ ${E_}[K`
        } else if (d === '\r') {
          ran.push(typed)
          typed = ''
          row++
          raw += `\r\n${E_}[${row};1H$ `
        } else {
          typed += d
          raw += d
        }
      },
      sleep: async (ms) => { now += ms },
      now: () => now,
    }
    return { io, ran, writes }
  }

  it.each(['posix', 'powershell', 'cmd'] as const)('runs the account line clean, and the text left on the line is cleared first (%s)', async (family) => {
    const s = staleFrameShell('rm -rf ', family)
    const r = await typeAtPrompt(s.io, 't1', family, LINE_S, 0, Infinity, false)
    expect(r.outcome).toBe('entered')
    // The sacrificial Enter ran an empty line; the line that ran is the account line alone.
    expect(s.ran).toEqual(['', LINE_S])
    expect(s.ran.join('\n')).not.toContain('rm -rf')
    // The probe went in first, alone, before any key that is not text.
    expect(s.writes[0]).toBe(LINE_S.slice(0, ECHO_PROBE_CHARS))
    expect(s.writes[1]).toBe(LINE_CLEAR[family])
  })

  it('takes the probe back out, and enters nothing, when no shell line ever shows it', async () => {
    let now = 0
    const writes: string[] = []
    const rule = '─'.repeat(80)
    const raw = `${E_}[H${E_}[2J` + [rule, '❯ ', rule, '  ? for shortcuts'].map((r, i) => `${E_}[${i + 1};1H${r}`).join('')
    const io: SwitchIO = {
      output: () => ({ raw, end: raw.length }),
      outputFrom: (_id, from) => raw.slice(Math.min(from, raw.length)),
      end: () => raw.length,
      size: () => ({ cols: 80, rows: 12 }),
      write: (_id, d) => { writes.push(d) },
      sleep: async (ms) => { now += ms },
      now: () => now,
    }
    const r = await typeAtPrompt(io, 't1', 'powershell', LINE_S, 0, Infinity, false)
    expect(r.outcome).toBe('didnt-start')
    expect(writes).toEqual([LINE_S.slice(0, ECHO_PROBE_CHARS), LINE_CLEAR.powershell])
    expect(writes).not.toContain('\r')
  })
})
