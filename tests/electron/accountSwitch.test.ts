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
  ECHO_MS, ECHO_PROBE_CHARS, ECHO_SLOW_CHAR_MS, EXIT_CONFIRM_MS, LOCK_MS, MODEL_HOLD_MS, POLL_MS, _resetSwitchLocksForTest, holdForModel, holdsModelKey, relaunchLockReason,
  releaseModelHold, runAccountSwitch,
} from '../../src/main/accountSwitch'
import type { SwitchContext } from '../../src/main/accountSwitch'
import { BLIND_EXIT_WAIT_MS, EXIT_CEILING_MS, PROMPT_SETTLE_MS, RESUME_PROBE_MS } from '../../src/renderer/src/lib/modelRelaunch'
import type { SwitchOutcome, SwitchRequest } from '../../src/shared/accountSwitch'
import type { AgentAccount } from '../../src/shared/agentAccounts'
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

async function run(script: TermScript, over: Partial<SwitchContext> = {}, req: Partial<SwitchRequest> = {}): Promise<Run> {
  const t = new FakeTerminal(script)
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

describe('Claude Code: the whole switch (§7.2)', () => {
  it('exits with /exit, resumes the hint\'s session on the target, and records it', async () => {
    const r = await run(claude())
    expect(r.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
    // The exact order: the empty box gets /exit, then Enter; the shell's line is cleared, a
    // sacrificial Enter, then the line in two parts (its first characters, then the rest once those
    // showed), then its Enter.
    const line = `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${ID}`
    expect(r.t.writes).toEqual(['/exit', '\r', '\u0015', '\r', line.slice(0, ECHO_PROBE_CHARS), line.slice(ECHO_PROBE_CHARS), '\r'])
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
    expect(r.t.writes[0]).toBe('\u0015')
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
    expect(said.outcome).toEqual({ kind: 'switched', resumed: true, sessionId: ID })
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

  it('enters nothing when the line never shows', async () => {
    const r = await run(claude({ start: 'gone-hint', shellDead: true }))
    expect(r.outcome).toEqual({ kind: 'didnt-start', line: `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude --model opus --resume ${ID}` })
    expect(r.t.writes.slice(-1)).toEqual(['\u0015'])
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
    expect(r.outcome).toEqual({ kind: 'refused', why: 'a shell of another kind runs in this terminal now (one started inside it), so the account line wouldn\'t take: exit it, then switch again' })
    expect(r.t.ran).toEqual([''])
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
    expect(r.outcome).toEqual({ kind: 'exit-unconfirmed' })
    expect(r.t.writes).toEqual(['/exit', '\r'])
    expect(r.t.clock).toBeGreaterThanOrEqual(EXIT_CONFIRM_MS + EXIT_CEILING_MS)
    expect(r.t.ran).toEqual([])
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