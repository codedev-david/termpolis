// Moving a running agent to another account in place (§7.2), main's side: it runs beside the
// terminals' buffers and types through the PTY itself. The design's rules, in the order they act:
//
//   R2  Exit keys go only to an agent live on screen, and none at all: the agent is exited with its
//       own command (EXIT_COMMAND), typed into its own box and entered only once the box shows it,
//       so no key is ever left over for the shell, where Ctrl+D closes a bash terminal.
//   R3  "Exited" is what the screen proves: the agent's exit hint as the last thing on it, with no
//       input box under it, or its shell's prompt report after the exit, with no box drawn since.
//       The account line is then typed WITHOUT Enter, and entered only once it shows on the shell's
//       last rows, outside every agent box: in a box, the agent never exited, and it is taken back
//       out; nowhere, nothing is entered.
//   R7  While it runs, the terminal's relaunch lock is held: main drops the renderer's keys for it,
//       and MCP's write_to_terminal and run_command (the phone's too) are refused, so nothing sits
//       on the shell's line for the Enter to run. The line is cleared before it is typed all the
//       same. The lock is let go on every outcome, and after LOCK_MS whatever happens.
//   R8  The session is resumed by its exact id: the one in the exit hint, or the one Termpolis
//       started a Claude Code session with. Never --continue or resume --last.
//   R25 A Claude Code transcript the target can't see is carried there first (accountCarry.ts).
//   OS  Where the OS can say whether only the shell is left in the terminal (shellAlone.ts), it has
//       the last word on the agent being gone, as it has in the model switch (modelRelaunch.ts), whose
//       live runs found Claude Code takes 4 to 11 s to hand the terminal back and that what is typed
//       meanwhile is lost. Both wait with the same clock (shared/agentExit.ts). Where it cannot say
//       (WSL, a shell it doesn't know), the screen's word stands, as it always did.
//
// Anything it can't confirm ends the switch with nothing more typed, and its outcome says so; the
// dialog asks the user, and runs it again with their answer (assumeExited, stopBusy, fresh).
import { randomUUID } from 'crypto'
import { isBusyOnScreen, inputBoxRow, inputBoxRows, emptyInputBox, detectAgentStatus, stopKind } from '../shared/agentStatusDetector'
import type { ScreenSize } from '../shared/terminalScreen'
import {
  ASKS_USER, CLEAR_BOX_KEYS, CODEX_STARTING, EXIT_COMMAND, LINE_CLEAR, RELAUNCH_HELD, RESUME_NOT_FOUND, SIGN_IN_SCREEN, carryForSwitch, exitHintOf,
  nestedShellReported, ownReport, relaunchCommand,
} from '../shared/accountSwitch'
import type { ExitHint, RelaunchHold, RelaunchSpec, SwitchOutcome, SwitchProgress, SwitchRequest } from '../shared/accountSwitch'
import { PROMPT_SETTLE_MS, aloneNow, waitForExit } from '../shared/agentExit'
import type { ExitWatch } from '../shared/agentExit'
import { ACCOUNT_AGENT_LABEL, accountEnv, accountLine, familyOf } from '../shared/agentAccounts'
import type { AccountAgent, AgentAccount, ShellFamily } from '../shared/agentAccounts'
import { PROMPT_REPORT, drawn, sinceStarted } from './mcpServer'

/** A switch holds its terminal at most this long, whatever happens. A slow teardown of the agent
 *  (up to EXIT_CEILING_MS), the exit, the line and the 30 s the relaunch gets to come up add up to
 *  more than a minute in the worst case. */
export const LOCK_MS = 120_000
/** The model picker's hold, at most. Its relaunch (modelRelaunch.ts) waits for the agent to hand the
 *  terminal back for up to 30 s (Claude Code took 4 to 11 s to), settles, and may give a resume of "the
 *  latest" 8 s to fail before it starts a new session: about 45 s at the very most. A renderer that
 *  stops halfway leaves the terminal held no longer than this; one that finishes lets it go itself. */
export const MODEL_HOLD_MS = 60_000
/** How often the screen is looked at while waiting. */
export const POLL_MS = 250
/** How long an exit gets to show (§7.2 step 4). */
export const EXIT_CONFIRM_MS = 8000
/** How long a menu or a dialog gets to close after Esc (step 2). */
export const ESC_WAIT_MS = 2000
/** How long a turn gets to stop after Esc, when the user asked for that. */
export const STOP_WAIT_MS = 5000
/** How long the box gets to empty after its text is cleared. */
export const CLEAR_WAIT_MS = 3000
/** How long a typed command or line gets to show (steps 3 and 8). */
export const ECHO_MS = 2000
/** A line typed at a shell goes in two parts: its first ECHO_PROBE_CHARS characters, then the rest
 *  once those showed. Git Bash on a ConPTY reads typed text one character at a time, 40 ms each on
 *  an idle laptop and 100 ms and more on a busy one, and draws a line only once it has read all of
 *  it (measured with a real one on node-pty: 140 characters took 5.5 s idle and over 12 s busy;
 *  PowerShell took 5 ms a character, cmd none). A flat 2 s typed an account line, took it back out
 *  and said it never started. How long the first part took says how long the rest will, and
 *  nothing is entered before all of the line shows. */
export const ECHO_PROBE_CHARS = 16
/** What each character of the first part may take before the shell is taken to be not reading at
 *  all, on top of ECHO_MS: a shell that echoes nothing costs this much once. */
export const ECHO_SLOW_CHAR_MS = 150
/** How long the shell gets to answer the sacrificial Enter: its prompt report, or quiet. */
export const PROMPT_WAIT_MS = 1500
/** The same where the terminal's own shell reports its prompts: its report says when the prompt is drawn, and silence
 *  does not (Git Bash with a git-aware PROMPT_COMMAND was silent for seconds while it built one, and read nothing typed
 *  meanwhile), so the report is waited for this long, and the keys typed anyway at the end of it (SW2-5). */
export const PROMPT_REPORT_WAIT_MS = 12_000
/** The most the first part of the account line gets to show in all, while the shell keeps printing (SW2-5). */
export const ECHO_MAX_MS = 30_000
/** How long after the Enter the relaunch gets to show what it did (step 10). */
export const OUTCOME_MS = 30_000
/** How long Codex's composer must stand on screen, with no "Resuming session…" row over it, before the
 *  relaunch counts as up: the real 0.164 draws its composer while it still looks for the session, and
 *  prints "No saved session found" and exits about 0.3 s later (SWITCH-R1 C2). */
export const CODEX_DWELL_MS = 2500

const ESC = '\u001b'

/** What the switch reads and writes a terminal with: main's buffers and PTYs (index.ts). */
export interface SwitchIO {
  /** The terminal's output main holds (its tail), and where its output ends now, counting what
   *  the buffer let go; null for a terminal with none. */
  output(terminalId: string): { raw: string; end: number } | null
  /** Its output from the absolute offset `from` on. */
  outputFrom(terminalId: string, from: number): string
  /** Where its output ends now (0 for a terminal with none). */
  end(terminalId: string): number
  size(terminalId: string): ScreenSize | null
  /** The screen main keeps for a terminal an agent runs in (terminalOutputBuffer.ts watchScreen), as its
   *  output has drawn it: the window above holds only the last 32 KB, and Claude Code paints its input box
   *  once, so a replay of the window has no box after a minute of work (F-R2-2). Null or absent where none
   *  is kept (an unwatched terminal, a test): the window is replayed then. */
  screen?(terminalId: string): { lines: string[]; title: string } | null
  /** Starts keeping that screen: the terminal's agent was just started (accountsIpc.ts records it). */
  watch?(terminalId: string): void
  write(terminalId: string, data: string): void
  sleep(ms: number): Promise<void>
  now(): number
  progress?(p: SwitchProgress): void
  /** macOS and Linux: whether the terminal's own shell is its PTY's foreground process again
   *  (terminalManager.ts); null, or absent, where that can't be told (Windows). The cheap read the
   *  usage-limit look polls (limitLook.ts); the OS's full answer below is asked only at the moments
   *  that need it, never on a timer (endpoint security reads a process query on a loop as discovery). */
  atShell?(terminalId: string): boolean | null
  /** Whether nothing runs in the terminal but its shell, as the OS tells (shellAlone.ts): true once
   *  the agent's process is gone, false while it runs, null where main can't tell. Absent: the
   *  screen alone decides. */
  shellAlone?(terminalId: string): Promise<boolean | null>
  /** Which shells have printed a prompt report in this terminal, ever (terminalOutputBuffer.ts reportedFamilies), which
   *  the 32 KB window the reads above replay does not keep. Absent: the window is all there is to go on. */
  reported?(terminalId: string): { posix: boolean; windows: boolean }
  /** Whether the terminal printed the line of David's own wrapper (~/.claude/claude-run.sh) that says it starts Claude Code again on
   *  another profile, since this was last asked (terminalOutputBuffer.ts takeRestarted): the one sign that something moved the terminal's
   *  agent to another account without a line Termpolis typed (SW3-3). The answer is given up once. Absent: no such sign is read. */
  restarted?(terminalId: string): boolean
}

/** Where a terminal's agent was started, and the line that started it (accountsIpc.ts). */
export interface AgentStartRecord {
  at: number
  commands: string[]
  /** The line was edited by the shell as it was typed, so `commands` name only the agent (limitLook.ts LiveStart.unsure). */
  unsure?: boolean
}

export interface SwitchContext {
  io: SwitchIO
  target: AgentAccount
  /** The terminal's agent: the target's. */
  agent: AccountAgent
  /** The account the terminal runs on now, as main knows it; undefined when it doesn't. */
  source?: AgentAccount
  /** Where the agent was started (main's own launch line), when main typed it. */
  start?: AgentStartRecord
  /** Claude Code: the session Termpolis started it with, which it resumes when no hint names one. */
  sessionId?: string
  /** Claude Code: whether a transcript of that id exists where the source can see it. */
  hasTranscript?: (id: string) => boolean
  /** Claude Code: makes the session resumable on the target (accountCarry.ts). */
  carry?: (id: string) => { carried: boolean; kept?: string }
  /** Variables the account line unsets besides the profile's (the proxy's, §5.2). */
  extraUnset?: string[]
  /** What the lock says to the conductor meanwhile: a swarm worker's restart is said as one (§9). */
  lockKind?: 'account' | 'worker'
  newSessionId: () => string
  /** What main records once the line ran: the terminal's account, start and session. */
  record: (r: { accountId: string; start: AgentStartRecord; sessionId: string | null }) => void
}

// ── The lock ───────────────────────────────────────────────────────────────────────────

/** The terminals held, by a switch (LOCK_MS at most) or the model picker (MODEL_HOLD_MS). */
export const locks = new Map<string, Hold>()

/** What holds a terminal, until when: an account switch (a swarm worker's restart among them), which
 *  main types itself, or the model picker, whose own writes carry the key it was given (§7.5). */
export interface Hold {
  until: number
  kind: RelaunchHold
  key?: string
}

/** Why nothing may be typed into the terminal now, or null. A write carrying the model picker's
 *  key is the picker's own, and passes. */
export function relaunchLockReason(terminalId: string, now: number = Date.now(), key?: string): string | null {
  const hold = locks.get(terminalId)
  if (hold === undefined) return null
  if (hold.until <= now) {
    locks.delete(terminalId)
    return null
  }
  return key && key === hold.key ? null : RELAUNCH_HELD[hold.kind]
}

/** The model picker's hold on a terminal while it relaunches the agent there (§7.5): the key its
 *  writes carry, or null while anything holds the terminal. */
export function holdForModel(terminalId: string, now: number = Date.now()): string | null {
  if (relaunchLockReason(terminalId, now)) return null
  const key = randomUUID()
  locks.set(terminalId, { until: now + MODEL_HOLD_MS, kind: 'model', key })
  return key
}

/** Lets the model picker's hold go: its own, and no other. */
export function releaseModelHold(terminalId: string, key: string): void {
  if (locks.get(terminalId)?.key === key) locks.delete(terminalId)
}

/** Does `key` open the model picker's live hold on this terminal? What is typed under it is the
 *  picker's own relaunch (the writes of anything else are dropped meanwhile). */
export function holdsModelKey(terminalId: string, key: string | undefined, now: number = Date.now()): boolean {
  const hold = locks.get(terminalId)
  return !!key && hold !== undefined && hold.kind === 'model' && hold.until > now && hold.key === key
}

export function _resetSwitchLocksForTest(): void {
  locks.clear()
}

// ── Reading the screen ─────────────────────────────────────────────────────────────────

export interface Look {
  lines: string[]
  title: string
  raw: string
  end: number
  /** The agent's input box row, or -1. */
  box: number
  /** The terminal's width in columns, when it is known: a row this wide may go on in the next. */
  cols?: number
  /** Its height in rows, when known: a line longer than that has scrolled its start off the top. */
  rows?: number
}

/** What a terminal with no output shows: nothing, and no box. */
const BLANK: Look = { lines: [], title: '', raw: '', end: 0, box: -1 }

/** `rows` without the blank ones at the foot, as drawn() cuts a replay's. */
function withoutBlankFoot(rows: readonly string[]): string[] {
  let end = rows.length
  while (end > 0 && rows[end - 1].trim() === '') end--
  return rows.slice(0, end)
}

export function look(io: SwitchIO, id: string): Look {
  const out = io.output(id)
  if (!out) return BLANK
  const size = io.size(id)
  // The kept screen is what the user sees; the window's replay is the same screen only while its box is
  // still in the last 32 KB. Its rows are cut at the last one drawn, as a replay's are (drawn).
  const live = io.screen?.(id)
  const { lines, title } = live ? { lines: withoutBlankFoot(live.lines), title: live.title } : drawn(out.raw, size)
  return { lines, title, raw: out.raw, end: out.end, box: inputBoxRow(lines), ...(size?.cols ? { cols: size.cols } : {}), ...(size?.rows ? { rows: size.rows } : {}) }
}

/** Where the absolute offset `at` falls in a look's text. */
export const indexOf = (l: Look, at: number): number => Math.max(0, l.raw.length - (l.end - at))

/** Letters and digits: how a typed text is matched on a screen, which wraps and colours it. */
const bare = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, '')

/** Escape sequences out, for the CLIs' own words in raw output. A cursor-forward stands for the spaces
 *  it moves over: Claude Code draws its "No conversation found with session ID" line with one for each
 *  space, so no space is in its bytes (SWITCH-R1 N1). */
export const plain = (s: string): string => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n) || 1, 8)))
  .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
  .replace(/\x1b./g, '')

/** The first words of each CLI's exit hint, as it prints them when it exits. */
export const HINT_HEAD: Readonly<Record<AccountAgent, RegExp>> = {
  claude: /Resume this session with:/,
  codex: /To continue this session, run|Session ID:/,
  agy: /Resume with -c \(or command below\):/,
}

/** The exit hint at the screen's foot with no input box under it (R3): one quoted in an answer,
 *  or redrawn by ConPTY, has the agent's box under it. */
export function hintAtFoot(l: Look, agent: AccountAgent): ExitHint | null {
  // The rows as drawn; and, if they name no hint, with each full-width row joined to the one under it: a
  // pane narrower than the hint's command row wraps it, and the id (or the worktree) is cut in two.
  const drawnHint = exitHintOf(l.lines, agent)
  const joined = l.cols && (!drawnHint || drawnHint.id === null) ? exitHintOf(joinWrapped(l.lines, l.cols), agent) : null
  const hint = joined?.id ? joined : drawnHint ?? joined
  return hint && (l.box < 0 || l.box < hint.row) ? hint : null
}

/** `rows` with each row as wide as the terminal joined to the next, which it may go on in; the rows
 *  taken in stay as empty ones, so every row keeps its place. */
export function joinWrapped(rows: readonly string[], cols: number): string[] {
  const out = [...rows]
  for (let i = 0; i < rows.length - 1; i++) {
    let j = i
    while (j < rows.length - 1 && rows[j].length >= cols) {
      out[i] += rows[j + 1]
      out[j + 1] = ''
      j++
    }
    i = j
  }
  return out
}

/** The shell printed its prompt after `at`, and no agent box was drawn after it. */
function shellSince(io: SwitchIO, id: string, l: Look, at: number, commands: readonly string[] = []): boolean {
  return sinceStarted(l.raw, indexOf(l, at), false, io.size(id), commands).shell
}

/** Claude Code waiting out its limit, the user's choice on its menu, on its status line over the
 *  box: Esc stops the wait. */
const WAITING_OUT = /continuing automatically at.*\besc to cancel\b/
/** How many of the screen's last rows hold the box, its status line and its footer. */
const STATUS_ROWS = 8

export type Liveness = { state: 'live' } | { state: 'gone'; hint: ExitHint | null } | { state: 'unknown'; os?: true }

/** Is the agent live on screen (R2)? Gone: its exit hint at the foot, a prompt since it was
 *  started, or (macOS and Linux) its shell in the PTY's foreground. Live: its box, a menu or a busy
 *  line on screen. Neither: unknown. */
export function liveness(io: SwitchIO, id: string, agent: AccountAgent, start: AgentStartRecord | undefined): Liveness {
  const l = look(io, id)
  const hint = hintAtFoot(l, agent)
  if (hint) return { state: 'gone', hint }
  if (start && shellSince(io, id, l, start.at, start.commands)) return { state: 'gone', hint: null }
  // The last frame an agent left, box and all, stays on screen above the shell's prompt.
  if (io.atShell?.(id) === true) return { state: 'gone', hint: null }
  const status = detectAgentStatus(l.lines.join('\n'), ACCOUNT_AGENT_LABEL[agent], 'idle', { screen: true, title: l.title })
  if (l.box >= 0 || status.status === 'blocked' || status.status === 'waiting_for_input' || isBusyOnScreen(l.lines, l.title)) return { state: 'live' }
  return { state: 'unknown' }
}

/** What the shared exit wait (agentExit.ts) asks the OS with, for this terminal. */
function osOf(io: SwitchIO, id: string): ExitWatch {
  return { sleep: (ms) => io.sleep(ms), now: () => io.now(), ...(io.shellAlone ? { shellAlone: () => io.shellAlone!(id) } : {}) }
}

/** What the OS has said during one switch. Once it has said "still running" it can tell for this
 *  terminal, so a later "cannot tell" is a hiccup to ask again about, not a reason to go on while
 *  the agent may still be tearing down (agentExit.ts waitForExit). */
export interface OsMemo {
  known: boolean
}

/** The OS's word now, with what it said before in this switch taken into account. */
async function askOs(io: SwitchIO, id: string, memo: OsMemo): Promise<boolean | null> {
  const alone = await aloneNow(osOf(io, id))
  if (alone === false) memo.known = true
  return alone === null && memo.known ? false : alone
}

/**
 * Waits for the agent's process to go, when the OS says it is still running: `true` once it has
 * (the shell then needs a moment to draw its prompt), `false` if it is still there at the ceiling.
 * The screen's word, where there is any, is what a caller falls back on then: an exit it showed
 * stands, and the line is entered only once it shows at the shell (R3), so a program that really is
 * still running (a background job in the same terminal) costs the wait, not a wrong action.
 */
async function processGone(io: SwitchIO, id: string): Promise<boolean> {
  const gone = await waitForExit(osOf(io, id), true, 0)
  if (gone) await io.sleep(PROMPT_SETTLE_MS)
  return gone
}

/**
 * liveness (the screen's word) with the OS's (step 0). An agent the OS says is gone is gone, though
 * its last frame, input box and all, is still on the screen: on Windows nothing else shows it, and no
 * exit key is sent to a shell. An agent the screen shows gone while a program still runs in the
 * terminal (quit by hand a moment ago, its hooks still going) is waited for before anything is typed;
 * if that program is still there at the ceiling, Termpolis can't tell and types nothing: the user's
 * word that it exited is the way on (SWITCH-R1 B1).
 */
export async function livenessNow(io: SwitchIO, id: string, agent: AccountAgent, start: AgentStartRecord | undefined, memo: OsMemo): Promise<Liveness> {
  const alone = await askOs(io, id, memo)
  const alive = liveness(io, id, agent, start)
  if (alone === true && alive.state !== 'gone') return { state: 'gone', hint: hintAtFoot(look(io, id), agent) }
  // `os`: it is the OS that still shows a program, so the card can say that and not only that nothing was readable.
  if (alone === false && alive.state === 'gone' && !(await processGone(io, id))) return { state: 'unknown', os: true }
  return alive
}

// ── The steps ──────────────────────────────────────────────────────────────────────────

/** Polls `test` every POLL_MS for up to `ms`; its first truthy answer, or null. */
export async function waitFor<T>(io: SwitchIO, ms: number, test: () => T | null | false): Promise<T | null> {
  for (let t = 0; t < ms; t += POLL_MS) {
    await io.sleep(POLL_MS)
    const r = test()
    if (r) return r
  }
  return null
}

/** The agent at its idle box: a box on screen, and no busy line. */
export function atIdleBox(io: SwitchIO, id: string): Look | null {
  const l = look(io, id)
  return l.box >= 0 && !isBusyOnScreen(l.lines, l.title) ? l : null
}

/** The first row of the agent's box shows `text`, and only it: its glyph and the text. Codex lists
 *  its commands under the row, so only the first row is read. */
function boxShows(l: Look, text: string): boolean {
  const rows = inputBoxRows(l.lines)
  return !!rows && bare(rows[0].replace(/^\s*(?:│\s)?[❯>›]?\s*/, '')) === bare(text)
}

/** Types `text` into the agent's own box, at its idle box `l`, and presses Enter only once its box
 *  shows it: what an agent is exited with (step 3). The box is emptied first (Ctrl+U, as submit
 *  clears one). */
export async function typeIntoBox(io: SwitchIO, id: string, text: string, l: Look): Promise<'entered' | 'not-shown' | 'held'> {
  if (!emptyInputBox(l.lines)) {
    io.write(id, CLEAR_BOX_KEYS)
    const cleared = await waitFor(io, CLEAR_WAIT_MS, () => {
      const now = atIdleBox(io, id)
      return now && emptyInputBox(now.lines)
    })
    if (!cleared) return 'held'
  }
  io.write(id, text)
  const shown = await waitFor(io, ECHO_MS, () => {
    const now = look(io, id)
    return now.box >= 0 && boxShows(now, text)
  })
  if (!shown) {
    // Never shown in the box: taken back out, wherever it went.
    io.write(id, CLEAR_BOX_KEYS)
    return 'not-shown'
  }
  io.write(id, '\r')
  return 'entered'
}

/** What shows the exit, from `mark` on (step 4): the hint at the screen's foot, printed since; or
 *  the shell's prompt since, with no box drawn after it. */
export function exitShown(io: SwitchIO, id: string, agent: AccountAgent, mark: number): { hint: ExitHint | null } | null {
  const l = look(io, id)
  const printed = plain(io.outputFrom(id, mark))
  let hint = hintAtFoot(l, agent)
  // agy prints its hint at the top of a block it repaints, so a pane that holds the block has it above the foot's rows,
  // and one that doesn't has scrolled it off (or wrapped its command row): it is read from the text agy printed since
  // its exit command, which has neither problem (SW2-6). The text is its own: nothing but its exit follows the command.
  if (!hint && agent === 'agy') hint = exitHintOf(printed.split(/\r\n|\r|\n/), agent, true)
  if (hint && HINT_HEAD[agent].test(printed)) return { hint }
  return shellSince(io, id, l, mark) ? { hint: null } : null
}

/** How long the shell must be the PTY's foreground, with no hint on screen, before that counts as
 *  the exit by itself: an agent's last words reach the buffer a moment after it is gone. */
export const HINT_GRACE_MS = 1000

/** Waits up to EXIT_CONFIRM_MS for the exit to show (step 4): exitShown, or on macOS and Linux
 *  the shell back in the PTY's foreground (R3), once that held HINT_GRACE_MS with no hint. */
function exitOnScreen(io: SwitchIO, id: string, agent: AccountAgent, mark: number): Promise<{ hint: ExitHint | null } | null> {
  let foregroundAt: number | null = null
  return waitFor(io, EXIT_CONFIRM_MS, () => {
    const shown = exitShown(io, id, agent, mark)
    if (shown) return shown
    if (io.atShell?.(id) !== true) {
      foregroundAt = null
      return null
    }
    if (foregroundAt === null) foregroundAt = io.now()
    return io.now() - foregroundAt >= HINT_GRACE_MS ? { hint: null } : null
  })
}

/**
 * Step 4: the exit, confirmed. The screen's evidence (exitOnScreen) and then the OS's word, which
 * has the last say where it can speak. It says the agent is gone: that is an exit even where the
 * screen showed nothing (Windows shows no foreground, and a session with no turns prints no hint).
 * It says a program still runs: Claude Code's teardown took 4 to 11 s, and the screen shows its
 * goodbye at the start of it or only at the end, so the wait goes on past the screen's 8 s, up to the
 * ceiling; if it never goes the exit is not confirmed, whatever the screen showed. It cannot tell: the
 * screen's word, as ever.
 */
export async function exitConfirmed(io: SwitchIO, id: string, agent: AccountAgent, mark: number, memo: OsMemo): Promise<{ hint: ExitHint | null } | null> {
  const screen = await exitOnScreen(io, id, agent, mark)
  const alone = await askOs(io, id, memo)
  if (alone === null) return screen
  // A program still runs after the ceiling: the exit is not confirmed, whatever the screen showed (a hint
  // printed at once, or a teardown that outlasts the ceiling, or a background job keeping the console busy).
  // What would be typed next reaches whatever holds the terminal; "It has exited" is the user's word for it.
  if (alone === false && !(await processGone(io, id))) return null
  // Gone by the OS's word: what the screen shows now names the session, if it names one.
  return screen ?? exitShown(io, id, agent, mark) ?? { hint: null }
}

/** Where a typed line shows: inside the agent's box (it is live), on the screen's last rows outside
 *  every box (the shell has it), or nowhere. A wrapped line is matched by its first 40 characters,
 *  and the shell's copy only once its echo is in what was written since it was typed (`echo`): a
 *  line typed before with the same start, still on the screen, is no echo of this one. */
function landed(l: Look, line: string, echo: string): 'box' | 'shell' | null {
  const key = bare(line.slice(0, 40))
  const box = inputBoxRows(l.lines)
  if (box && bare(box.join('')).includes(key)) return 'box'
  return bare(plain(echo)).includes(key) && bare(l.lines.slice(-6).join('')).includes(key) ? 'shell' : null
}

/** Is the whole of `line` drawn at the shell: the end of it, as well as the start `landed` read? A
 *  shell that reads slowly draws it all at once, but one that draws as it reads shows the start while
 *  the rest is still on its way. */
function lineShown(l: Look, line: string, echo: string): boolean {
  const key = bare(line.slice(-24))
  if (!(bare(plain(echo)).includes(key) && bare(l.lines.slice(-6).join('')).includes(key))) return false
  // And the whole of it, not only its two ends: a character dropped in the middle (a path) would be caught
  // here and not by them. The rows it can take up on this width, and the prompt's, are the window read.
  const window = Math.ceil(line.length / (l.cols ?? 80)) + 3
  // A pane too short to hold the line has scrolled its start off the top: its two ends are all there is
  // to compare, and they showed (SWITCH-R1 G1).
  if (l.rows !== undefined && window > l.rows) return true
  return bare(l.lines.slice(-window).join('')).includes(bare(line))
}

export type Typed = { outcome: 'entered'; enterAt: number } | { outcome: 'agent-alive' | 'didnt-start' | 'mismatch' }

/** The terminal's output as far as main still holds it: what the shell wrote before the switch is in it. */
function heardBefore(io: SwitchIO, id: string): string {
  return io.output(id)?.raw ?? ''
}

/** Whether this terminal's own shell family has ever reported a prompt: what main kept of output the window lost, else
 *  what the window holds. */
function ownShellHeard(io: SwitchIO, id: string, family: ShellFamily): boolean {
  const kept = io.reported?.(id)
  if (kept && (family === 'posix' ? kept.posix : kept.windows)) return true
  return ownReport(heardBefore(io, id), family)
}

/** Types an account line at the shell's prompt (step 8): the line cleared, a sacrificial Enter and
 *  the shell's answer to it, then the line without its Enter, which is pressed only once the line
 *  shows outside every agent box. `enterAt` is where the output ended before that Enter. */
export async function typeAtPrompt(io: SwitchIO, id: string, family: ShellFamily, line: string, mark: number, until = Infinity, sacrifice = true): Promise<Typed> {
  // No wait here outlasts the lock the switch holds the terminal under: a shell that reads a long line
  // very slowly is given up on at its end, not minutes later (SWITCH-R1 G1).
  const wait = (ms: number): number => Math.min(ms, until - io.now())
  // Where the screen still draws an agent's box and shows nothing of the shell (SW2-7, MODELS-R2-1), the receiver of a key is
  // not known: a sacrificial Enter would submit a draft in a live agent's box, and the line clear PowerShell and cmd use (Esc)
  // interrupts a turn at work. The first part of the line alone is typed and looked at. Where it lands in an agent's box it is
  // taken back out of it (the draft with it, never submitted). Where it lands at the shell, the receiver is proven to be the
  // shell, which a clear and an Enter are safe for: the line is cleared (what was left on it goes with the probe) and the
  // ordinary steps run, from the start.
  if (!sacrifice) {
    const at = io.end(id)
    const probe = line.slice(0, ECHO_PROBE_CHARS)
    io.write(id, probe)
    const where = await waitFor(io, wait(ECHO_MS + probe.length * ECHO_SLOW_CHAR_MS), () => landed(look(io, id), probe, io.outputFrom(id, at)))
    if (where === 'box') {
      io.write(id, CLEAR_BOX_KEYS)
      return { outcome: 'agent-alive' }
    }
    io.write(id, LINE_CLEAR[family])
    return where === 'shell' ? typeAtPrompt(io, id, family, line, mark, until, true) : { outcome: 'didnt-start' }
  }
  // Whether this terminal's own shell reports its prompts: its report is then what says the prompt is drawn.
  const reporting = ownShellHeard(io, id, family)
  io.write(id, LINE_CLEAR[family])
  const before = io.end(id)
  const askedAt = io.now()
  io.write(id, '\r')
  // The prompt's report, or the shell gone quiet: input is being read (ConPTY can drop the first
  // byte typed before that, aiProfiles.ts). Where the shell reports, silence only means it is busy
  // drawing its prompt, so the report is waited for (SW2-5).
  let last = -1
  await waitFor(io, wait(reporting ? PROMPT_REPORT_WAIT_MS : PROMPT_WAIT_MS), () => {
    const out = io.outputFrom(id, before)
    if (out.search(PROMPT_REPORT) >= 0) return true
    if (reporting) return false
    const quiet = out.length > 0 && out.length === last
    last = out.length
    return quiet
  })
  // How long the shell took to answer the Enter: it is as slow, or slower, to read what is typed next.
  const answeredIn = io.now() - askedAt
  // A shell of another family reported since: a shell started inside this one, which the line
  // built for this terminal's shell doesn't fit (R1: only such a positive mismatch refuses).
  if (nestedShellReported(io.outputFrom(id, mark), family, reporting)) return { outcome: 'mismatch' }
  const typedAt = io.end(id)
  const probe = line.slice(0, ECHO_PROBE_CHARS)
  const started = io.now()
  io.write(id, probe)
  // The first part gets ECHO_MS and a slow shell's time a character, and while the shell is still PRINTING it is not stalled
  // (Git Bash right after an agent exits, building a git-aware prompt, took 5 to 15 s to read what was typed): the wait
  // goes on while the output grows, ends after a quiet spell, and ends at ECHO_MAX_MS in any case (SW2-5). The quiet spell
  // is that long, or three times the time the shell took to answer its Enter, when that is more (a loaded machine's shell).
  const quietMs = Math.max(ECHO_MS + probe.length * ECHO_SLOW_CHAR_MS, Math.min(ECHO_MAX_MS, answeredIn * 3))
  let seenEnd = io.end(id)
  let movedAt = io.now()
  const first = await waitFor(io, wait(ECHO_MAX_MS), () => {
    const at = landed(look(io, id), probe, io.outputFrom(id, typedAt))
    if (at) return at
    const end = io.end(id)
    if (end !== seenEnd) {
      seenEnd = end
      movedAt = io.now()
    }
    return io.now() - movedAt >= quietMs ? ('stalled' as const) : null
  })
  let where: 'box' | 'shell' | null = first === 'stalled' ? null : first
  if (where === 'shell' && line.length > probe.length) {
    // The shell reads what is typed (the first part is not in an agent's box): it took this long a
    // character, and the rest is given twice as long before it is given up on.
    const perChar = Math.max(1, Math.ceil((io.now() - started) / probe.length))
    io.write(id, line.slice(probe.length))
    const whole = await waitFor(io, wait(ECHO_MS + (line.length - probe.length) * perChar * 2), () => lineShown(look(io, id), line, io.outputFrom(id, typedAt)))
    if (!whole) where = null
  }
  if (where === 'box') {
    io.write(id, CLEAR_BOX_KEYS)
    return { outcome: 'agent-alive' }
  }
  if (where === 'shell') {
    const enterAt = io.end(id)
    io.write(id, '\r')
    return { outcome: 'entered', enterAt }
  }
  io.write(id, LINE_CLEAR[family])
  return { outcome: 'didnt-start' }
}

export type Watched = 'switched' | 'not-found' | 'sign-in' | 'no-outcome' | { asks: string }

/** What the relaunch did, from `mark` (its Enter) on (step 10): its box back, the CLI's "no such
 *  session", its sign-in screen, or a question only the user answers. agy says it found no such
 *  conversation and starts a new one: that is noted, and its box is waited for. */
export async function watchOutcome(io: SwitchIO, id: string, agent: AccountAgent, mark: number, line: string, until: number): Promise<{ seen: Watched; notFound: boolean }> {
  let notFound = false
  let upSince: number | null = null
  let signInLooks = 0
  for (let t = 0; t < OUTCOME_MS && io.now() < until; t += POLL_MS * 2) {
    await io.sleep(POLL_MS * 2)
    const since = io.outputFrom(id, mark)
    const rows = drawn(since, io.size(id)).lines
    const screen = rows.join('\n')
    const l = look(io, id)
    const drewBox = sinceStarted(l.raw, indexOf(l, mark), false, io.size(id), [line]).started
    if (RESUME_NOT_FOUND[agent].test(plain(since)) || RESUME_NOT_FOUND[agent].test(screen)) {
      // Claude Code prints its line and exits: no box is drawn since the Enter, in the program that said it. A box drawn
      // since is a conversation that resumed, whose history quotes the line (SW2-4). Codex draws its composer first, so a
      // box says nothing of it, and agy only warns.
      if (!(agent === 'claude' && drewBox)) {
        if (agent !== 'agy') return { seen: 'not-found', notFound: true }
        notFound = true
      }
    }
    // The words of a sign-in screen or a question are read where the target's own screen is: below the
    // box when one is drawn. A resumed conversation redraws its history above it, and that can hold the
    // CLI's own error text ("Please run /login") on a target that is fine (SWITCH-R1 H).
    const judged = ownScreen(rows, agent)
    // A question is read before a sign-in screen: a one-time dialog replaces the box (so the whole screen is judged, the
    // resumed history above it included), and a history that ends "Please run /login" is no word on the target (SW2-3).
    const asks = ASKS_USER.exec(judged)
    if (asks) return { seen: { asks: asks[0] }, notFound }
    if (SIGN_IN_SCREEN[agent].test(judged)) {
      // With a box drawn the words are the ones under it, at once. With none, they may be the history's own, drawn a
      // moment before the dialog or the box that follows: a sign-in screen stands, and counts at the second look.
      if (inputBoxRow(rows) >= 0 || ++signInLooks >= 2) return { seen: 'sign-in', notFound }
    } else signInLooks = 0
    const up = l.box >= 0 && drewBox
    // Codex draws its composer while it still looks for the session and then exits if it is not there:
    // its composer under "Resuming session…" is not up, and one with no such row gets a moment too.
    if (up && !(agent === 'codex' && CODEX_STARTING.test(screen))) {
      if (agent !== 'codex') return { seen: 'switched', notFound }
      upSince ??= io.now()
      if (io.now() - upSince >= CODEX_DWELL_MS) return { seen: 'switched', notFound }
    } else upSince = null
  }
  return { seen: 'no-outcome', notFound }
}

/** The rows of a screen that a sign-in screen's or a question's words are judged in: from the agent's
 *  box row down (Claude Code's "Not logged in · Run /login" footer is under its box), with the three
 *  rows over a Codex menu's › row, which holds its title; the whole screen when no box is drawn. */
export function ownScreen(rows: readonly string[], agent: AccountAgent): string {
  const box = inputBoxRow(rows)
  if (box < 0) return rows.join('\n')
  return rows.slice(agent === 'codex' ? Math.max(0, box - 3) : box).join('\n')
}

/** Waits for the shell after an agent quit by itself (Codex's "no such session"): its report, or
 *  quiet. */
async function shellBack(io: SwitchIO, id: string, mark: number): Promise<void> {
  let last = -1
  await waitFor(io, PROMPT_WAIT_MS * 2, () => {
    const out = io.outputFrom(id, mark)
    if (out.search(PROMPT_REPORT) >= 0) return true
    const quiet = out.length === last
    last = out.length
    return quiet
  })
}

// ── The switch ─────────────────────────────────────────────────────────────────────────

/**
 * Moves the agent in `req.terminalId` to `ctx.target`, in place: Claude Code and Codex (agy
 * switches through its own sign-in, agySwitch.ts). Takes the terminal's relaunch lock for its whole
 * run. Never throws: an unexpected error is a refusal, with nothing more typed after it.
 */
export async function runAccountSwitch(req: SwitchRequest, ctx: SwitchContext): Promise<SwitchOutcome> {
  const { io, target, agent } = ctx
  const id = req.terminalId
  if (relaunchLockReason(id, io.now())) return { kind: 'refused', why: 'a switch is already running in this terminal' }
  const family = familyOf(req.shellType)
  if (!family) return { kind: 'refused', why: 'Termpolis can\'t type an account line into this terminal\'s shell' }
  const env = accountEnv(target, agent, ctx.extraUnset ?? [])
  // The line must be one Termpolis can type here before anything is done to the agent.
  const probe = accountLine(family, env, agent)
  if ('refused' in probe) return { kind: 'refused', why: probe.refused }
  locks.set(id, { until: io.now() + LOCK_MS, kind: ctx.lockKind ?? 'account' })
  try {
    return await switchLocked(req, ctx, family)
  } catch (e) {
    return { kind: 'refused', why: e instanceof Error ? e.message : String(e) }
  } finally {
    locks.delete(id)
  }
}

/** A line typed and never entered (or never built), as the switch's outcome. A shell of another kind
 *  (one started inside the terminal) has no line to type: the agent has exited and nothing was entered. */
function notEntered(typed: { outcome: 'agent-alive' | 'didnt-start' | 'mismatch'; line: string } | { outcome: 'refused'; why: string }): SwitchOutcome {
  if (typed.outcome === 'refused') return { kind: 'refused', why: typed.why }
  if (typed.outcome === 'mismatch') return { kind: 'didnt-start', line: typed.line, otherShell: true }
  return typed.outcome === 'agent-alive' ? { kind: 'agent-alive' } : { kind: 'didnt-start', line: typed.line }
}

/** The account line for a relaunch: the shell's syntax around the agent's command, or why this shell
 *  or this command can't take it (cmd would expand a % or ! in a carried flag). */
function lineFor(ctx: SwitchContext, family: ShellFamily, spec: RelaunchSpec): { line: string } | { refused: string } {
  try {
    return accountLine(family, accountEnv(ctx.target, ctx.agent, ctx.extraUnset ?? []), relaunchCommand(spec))
  } catch (e) {
    // relaunchCommand throws an Error about the one token it refused.
    return { refused: (e as Error).message }
  }
}

/** A session id of the right shape, for building a line to check before the real one is known. */
const PROBE_ID = '00000000-0000-4000-8000-000000000000'

async function switchLocked(req: SwitchRequest, ctx: SwitchContext, family: ShellFamily): Promise<SwitchOutcome> {
  const { io, target, agent } = ctx
  const id = req.terminalId
  const until = io.now() + LOCK_MS - 1000
  const mark = io.end(id)
  const os: OsMemo = { known: false }
  let hint: ExitHint | null = null
  // The user's word that it exited, with an agent's box still drawn and nothing on screen that shows the shell is back
  // (see typeAtPrompt): no sacrificial key goes in there.
  let boxStillDrawn = false

  // What the agent was started with is decided before anything is typed: a relaunch that could not
  // repeat it would come back without it, and some of it is a restriction (carryForSwitch).
  const carry = carryForSwitch(agent, ctx.start?.commands[0])
  // Where Termpolis saw no line start the agent (a start by a history recall or a reverse search), or one the shell edited as
  // it was typed (Tab completion, which names only the agent), the relaunch is bare, and the outcome says its model and options
  // were not carried (MODELS-R2-4).
  const unseen = !ctx.start || ctx.start.unsure === true ? { unseenStart: true as const } : {}
  if (!carry.ok) return { kind: 'refused', why: carry.why }
  // The same goes for the line itself: this shell must be able to take it with everything the relaunch
  // adds (cmd would expand a % in a carried flag), or the agent would be exited for nothing (SWITCH-R1 G2).
  const probeSpec: RelaunchSpec = { agent, id: PROBE_ID, ...(carry.model ? { model: carry.model } : {}), extra: carry.extra, ...(agent === 'codex' && req.instructions ? { instructions: req.instructions } : {}) }
  const probe = lineFor(ctx, family, probeSpec)
  if ('refused' in probe) return { kind: 'refused', why: probe.refused }

  if (req.assumeExited) {
    // The user's word that it exited: an exit hint on screen still names the session. It replaces the exit check (the
    // OS is not asked, and not waited for), not the screen: a box still drawn with no hint, no prompt since the start
    // and no foreground word for the shell is an agent that may be live (SW2-7, MODELS-R2-1).
    hint = hintAtFoot(look(io, id), agent)
    boxStillDrawn = liveness(io, id, agent, ctx.start).state === 'live'
  } else {
    const alive = await livenessNow(io, id, agent, ctx.start, os)
    if (alive.state === 'unknown') return { kind: 'unknown-exit', ...(alive.os ? { osSees: true as const } : {}) }
    if (alive.state === 'gone') hint = alive.hint
    else {
      // Step 2: what holds the box out of the way. Claude Code's rate-limit menu and a Codex popup
      // close on Esc, and so does Claude Code's wait for its limit to reset; a turn at work stops on
      // it only with the user's leave. Any other question is the user's to answer (an approval,
      // folder trust): Termpolis presses nothing on it.
      const l = look(io, id)
      const status = detectAgentStatus(l.lines.join('\n'), ACCOUNT_AGENT_LABEL[agent], 'idle', { screen: true, title: l.title })
      if (l.lines.slice(-STATUS_ROWS).some((row) => WAITING_OUT.test(row))) io.write(id, ESC)
      else if (isBusyOnScreen(l.lines, l.title)) {
        if (!req.stopBusy) return { kind: 'busy' }
        io.write(id, ESC)
        if (!(await waitFor(io, STOP_WAIT_MS, () => atIdleBox(io, id)))) return { kind: 'busy' }
      } else if (l.box < 0) {
        if (stopKind(status) === null) return { kind: 'refused', why: `${ACCOUNT_AGENT_LABEL[agent]} is asking something on its screen: answer it there, then switch again` }
        io.write(id, ESC)
      }
      const idle = await waitFor(io, ESC_WAIT_MS, () => atIdleBox(io, id))
      if (!idle) return { kind: 'unknown-exit', ...(os.known ? { osSees: true as const } : {}) }
      // Step 3: its own exit command, entered only once its box shows it.
      io.progress?.({ terminalId: id, step: 'exiting' })
      const exitMark = io.end(id)
      const typed = await typeIntoBox(io, id, EXIT_COMMAND[agent], idle)
      if (typed === 'held') return { kind: 'refused', why: `${ACCOUNT_AGENT_LABEL[agent]}'s input held text that clearing it didn't remove, so nothing was typed` }
      if (typed === 'not-shown') return { kind: 'exit-unconfirmed', ...(os.known ? { osSees: true as const } : {}) }
      // Step 4: the exit, shown.
      io.progress?.({ terminalId: id, step: 'confirming' })
      const shown = await exitConfirmed(io, id, agent, exitMark, os)
      if (!shown) return { kind: 'exit-unconfirmed', ...(os.known ? { osSees: true as const } : {}) }
      hint = shown.hint
    }
  }

  // Step 5: the session, by its exact id (R8).
  let sessionId: string | null = req.fresh ? null : hint?.id ?? null
  const worktree = req.fresh ? undefined : hint?.worktree
  if (!sessionId && !req.fresh && agent === 'claude' && ctx.sessionId && ctx.hasTranscript?.(ctx.sessionId)) sessionId = ctx.sessionId
  // Step 6: the transcript, where the target can see it (Claude Code).
  let carried: { carried: boolean; kept?: string } = { carried: false }
  if (sessionId && agent === 'claude' && ctx.carry) {
    io.progress?.({ terminalId: id, step: 'carrying' })
    // A copy that fails is no reason to stop here, the agent exited: the target says if it can't
    // find the session, and a new one is offered.
    try { carried = ctx.carry(sessionId) } catch { /* resumed without it */ }
  }
  // Step 8: the line, typed at the prompt and entered once it shows there.
  const fresh = agent === 'claude' && !sessionId ? ctx.newSessionId() : undefined
  const spec: RelaunchSpec = { agent, id: sessionId, ...(carry.model ? { model: carry.model } : {}), extra: carry.extra, ...(worktree ? { worktree } : {}), ...(fresh ? { sessionId: fresh } : {}) }
  if (agent === 'codex' && req.instructions) spec.instructions = req.instructions
  const run = async (s: RelaunchSpec): Promise<(Typed & { line: string; at: number }) | { outcome: 'refused'; why: string }> => {
    // Refused here only for what the probe could not know: a session id that is not one (Termpolis's own
    // record), since the rest of the line was built and checked before the agent was touched.
    const built = lineFor(ctx, family, s)
    if ('refused' in built) return { outcome: 'refused', why: built.refused }
    io.progress?.({ terminalId: id, step: 'typing' })
    const at = io.end(id)
    return { ...(await typeAtPrompt(io, id, family, built.line, mark, until, !boxStillDrawn)), line: built.line, at }
  }
  let typed = await run(spec)
  if (typed.outcome !== 'entered') return notEntered(typed)
  // Step 9: the terminal runs on the target from here, whatever the agent does next.
  const enterAt = (typed as { enterAt: number }).enterAt
  ctx.record({ accountId: target.id, start: { at: typed.at, commands: [typed.line] }, sessionId: sessionId ?? fresh ?? null })
  // Step 10: what the relaunch did.
  io.progress?.({ terminalId: id, step: 'waiting' })
  let watched = await watchOutcome(io, id, agent, enterAt, typed.line, until)
  // The conversation the line resumed; none once Codex's path (c) starts a new session instead.
  let relaunched = sessionId
  if (watched.seen === 'not-found' && agent === 'codex') {
    // Codex's path (c): the target can't see the session. A new session in place, and said so.
    await shellBack(io, id, enterAt)
    const freshSpec: RelaunchSpec = { ...spec, id: null }
    typed = await run(freshSpec)
    if (typed.outcome !== 'entered') return notEntered(typed)
    ctx.record({ accountId: target.id, start: { at: typed.at, commands: [typed.line] }, sessionId: null })
    relaunched = null
    watched = await watchOutcome(io, id, agent, typed.enterAt, typed.line, until)
    if (watched.seen === 'switched') return { kind: 'fresh', why: 'not-found', ...unseen }
  }
  if (watched.seen === 'not-found') return { kind: 'resume-not-found' }
  if (watched.seen === 'sign-in') return { kind: 'sign-in', ...(relaunched ? { sessionId: relaunched } : {}) }
  if (watched.seen === 'no-outcome') return { kind: 'no-outcome' }
  if (typeof watched.seen === 'object') return { kind: 'asks-user', what: watched.seen.asks }
  if (watched.notFound) return { kind: 'fresh', why: 'not-found', ...unseen }
  // A worktree the line named and the relaunch did not go back into: the exit named none (a session with no turns prints
  // no hint) or a new session was asked for. It is not re-added on a guess (an orphan directory EBUSYs Claude Code on
  // Windows), so the outcome says so (MODELS-R2-3).
  if (!sessionId) return { kind: 'fresh', why: req.fresh ? 'asked' : 'no-session', ...(carry.worktree && !worktree ? { leftWorktree: carry.worktree } : {}), ...unseen }
  const switched: SwitchOutcome = { kind: 'switched', resumed: true, sessionId, ...unseen }
  if (carried.carried) switched.carried = true
  if (carried.kept) switched.kept = carried.kept
  return switched
}
