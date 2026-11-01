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
  ASKS_USER, CLEAR_BOX_KEYS, EXIT_COMMAND, LINE_CLEAR, RELAUNCH_HELD, RESUME_NOT_FOUND, SIGN_IN_SCREEN, carriedFlags, exitHintOf,
  otherShellReported, relaunchCommand,
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
/** How long the shell gets to answer the sacrificial Enter: its prompt report, or quiet. */
export const PROMPT_WAIT_MS = 1500
/** How long after the Enter the relaunch gets to show what it did (step 10). */
export const OUTCOME_MS = 30_000

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
}

/** Where a terminal's agent was started, and the line that started it (accountsIpc.ts). */
export interface AgentStartRecord {
  at: number
  commands: string[]
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
}

/** What a terminal with no output shows: nothing, and no box. */
const BLANK: Look = { lines: [], title: '', raw: '', end: 0, box: -1 }

export function look(io: SwitchIO, id: string): Look {
  const out = io.output(id)
  if (!out) return BLANK
  const { lines, title } = drawn(out.raw, io.size(id))
  return { lines, title, raw: out.raw, end: out.end, box: inputBoxRow(lines) }
}

/** Where the absolute offset `at` falls in a look's text. */
export const indexOf = (l: Look, at: number): number => Math.max(0, l.raw.length - (l.end - at))

/** Letters and digits: how a typed text is matched on a screen, which wraps and colours it. */
const bare = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, '')

/** Escape sequences out, for the CLIs' own words in raw output. */
export const plain = (s: string): string => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '')

/** The first words of each CLI's exit hint, as it prints them when it exits. */
export const HINT_HEAD: Readonly<Record<AccountAgent, RegExp>> = {
  claude: /Resume this session with:/,
  codex: /To continue this session, run|Session ID:/,
  agy: /Resume with -c \(or command below\):/,
}

/** The exit hint at the screen's foot with no input box under it (R3): one quoted in an answer,
 *  or redrawn by ConPTY, has the agent's box under it. */
export function hintAtFoot(l: Look, agent: AccountAgent): ExitHint | null {
  const hint = exitHintOf(l.lines, agent)
  return hint && (l.box < 0 || l.box < hint.row) ? hint : null
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

export type Liveness = { state: 'live' } | { state: 'gone'; hint: ExitHint | null } | { state: 'unknown' }

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
async function askOs(io: SwitchIO, id: string, memo?: OsMemo): Promise<boolean | null> {
  const alone = await aloneNow(osOf(io, id))
  if (alone === false && memo) memo.known = true
  return alone === null && memo?.known ? false : alone
}

/**
 * Waits for the agent's process to go, when the OS says it is still running: 	rue once it has
 * (the shell then needs a moment to draw its prompt), alse if it is still there at the ceiling.
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
 * terminal (quit by hand a moment ago, its hooks still going) is waited for before anything is typed.
 */
export async function livenessNow(io: SwitchIO, id: string, agent: AccountAgent, start: AgentStartRecord | undefined, memo?: OsMemo): Promise<Liveness> {
  const alone = await askOs(io, id, memo)
  const alive = liveness(io, id, agent, start)
  if (alone === true && alive.state !== 'gone') return { state: 'gone', hint: hintAtFoot(look(io, id), agent) }
  if (alone === false && alive.state === 'gone') await processGone(io, id)
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
  const hint = hintAtFoot(l, agent)
  if (hint && HINT_HEAD[agent].test(plain(io.outputFrom(id, mark)))) return { hint }
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
 * ceiling; what the screen proved stands if the process never goes, and with nothing proved the exit
 * is not confirmed. It cannot tell: the screen's word, as ever.
 */
export async function exitConfirmed(io: SwitchIO, id: string, agent: AccountAgent, mark: number, memo?: OsMemo): Promise<{ hint: ExitHint | null } | null> {
  const screen = await exitOnScreen(io, id, agent, mark)
  const alone = await askOs(io, id, memo)
  if (alone === null) return screen
  if (alone === false && !(await processGone(io, id))) return screen
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

export type Typed = { outcome: 'entered'; enterAt: number } | { outcome: 'agent-alive' | 'didnt-start' | 'mismatch' }

/** Types an account line at the shell's prompt (step 8): the line cleared, a sacrificial Enter and
 *  the shell's answer to it, then the line without its Enter, which is pressed only once the line
 *  shows outside every agent box. `enterAt` is where the output ended before that Enter. */
export async function typeAtPrompt(io: SwitchIO, id: string, family: ShellFamily, line: string, mark: number): Promise<Typed> {
  io.write(id, LINE_CLEAR[family])
  const before = io.end(id)
  io.write(id, '\r')
  // The prompt's report, or the shell gone quiet: input is being read (ConPTY can drop the first
  // byte typed before that, aiProfiles.ts).
  let last = -1
  await waitFor(io, PROMPT_WAIT_MS, () => {
    const out = io.outputFrom(id, before)
    if (out.search(PROMPT_REPORT) >= 0) return true
    const quiet = out.length > 0 && out.length === last
    last = out.length
    return quiet
  })
  // A shell of another family reported since: a shell started inside this one, which the line
  // built for this terminal's shell doesn't fit (R1: only such a positive mismatch refuses).
  if (otherShellReported(io.outputFrom(id, mark), family)) return { outcome: 'mismatch' }
  const typedAt = io.end(id)
  io.write(id, line)
  const where = await waitFor(io, ECHO_MS, () => landed(look(io, id), line, io.outputFrom(id, typedAt)))
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
  for (let t = 0; t < OUTCOME_MS && io.now() < until; t += POLL_MS * 2) {
    await io.sleep(POLL_MS * 2)
    const since = io.outputFrom(id, mark)
    const words = plain(since)
    if (RESUME_NOT_FOUND[agent].test(words)) {
      if (agent !== 'agy') return { seen: 'not-found', notFound: true }
      notFound = true
    }
    const screen = drawn(since, io.size(id)).lines.join('\n')
    if (SIGN_IN_SCREEN[agent].test(screen)) return { seen: 'sign-in', notFound }
    const asks = ASKS_USER.exec(screen)
    if (asks) return { seen: { asks: asks[0] }, notFound }
    const l = look(io, id)
    if (l.box >= 0 && sinceStarted(l.raw, indexOf(l, mark), false, io.size(id), [line]).started) return { seen: 'switched', notFound }
  }
  return { seen: 'no-outcome', notFound }
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

/** A line typed and never entered, as the switch's outcome. */
function notEntered(typed: { outcome: 'agent-alive' | 'didnt-start' | 'mismatch'; line: string }): SwitchOutcome {
  if (typed.outcome === 'mismatch') return { kind: 'refused', why: 'a shell of another kind runs in this terminal now (one started inside it), so the account line wouldn\'t take: exit it, then switch again' }
  return typed.outcome === 'agent-alive' ? { kind: 'agent-alive' } : { kind: 'didnt-start', line: typed.line }
}

async function switchLocked(req: SwitchRequest, ctx: SwitchContext, family: ShellFamily): Promise<SwitchOutcome> {
  const { io, target, agent } = ctx
  const id = req.terminalId
  const until = io.now() + LOCK_MS - 1000
  const mark = io.end(id)
  const os: OsMemo = { known: false }
  let hint: ExitHint | null = null

  if (req.assumeExited) {
    // The user's word that it exited: an exit hint on screen still names the session.
    hint = hintAtFoot(look(io, id), agent)
  } else {
    const alive = await livenessNow(io, id, agent, ctx.start, os)
    if (alive.state === 'unknown') return { kind: 'unknown-exit' }
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
      if (!idle) return { kind: 'unknown-exit' }
      // Step 3: its own exit command, entered only once its box shows it.
      io.progress?.({ terminalId: id, step: 'exiting' })
      const exitMark = io.end(id)
      const typed = await typeIntoBox(io, id, EXIT_COMMAND[agent], idle)
      if (typed === 'held') return { kind: 'refused', why: `${ACCOUNT_AGENT_LABEL[agent]}'s input held text that clearing it didn't remove, so nothing was typed` }
      if (typed === 'not-shown') return { kind: 'exit-unconfirmed' }
      // Step 4: the exit, shown.
      io.progress?.({ terminalId: id, step: 'confirming' })
      const shown = await exitConfirmed(io, id, agent, exitMark, os)
      if (!shown) return { kind: 'exit-unconfirmed' }
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
  const flags = carriedFlags(agent, ctx.start?.commands[0])
  const fresh = agent === 'claude' && !sessionId ? ctx.newSessionId() : undefined
  const spec: RelaunchSpec = { agent, id: sessionId, ...flags, ...(worktree ? { worktree } : {}), ...(fresh ? { sessionId: fresh } : {}) }
  if (agent === 'codex' && req.instructions) spec.instructions = req.instructions
  const run = async (s: RelaunchSpec): Promise<Typed & { line: string; at: number }> => {
    // Never refused here: the same line, with the agent's name for its command, was built before
    // anything was done, and the command is made of checked tokens only (relaunchCommand), none of
    // them a control character, a % or a !.
    const line = (accountLine(family, accountEnv(target, agent, ctx.extraUnset ?? []), relaunchCommand(s)) as { line: string }).line
    io.progress?.({ terminalId: id, step: 'typing' })
    const at = io.end(id)
    return { ...(await typeAtPrompt(io, id, family, line, mark)), line, at }
  }
  let typed = await run(spec)
  if (typed.outcome !== 'entered') return notEntered(typed)
  // Step 9: the terminal runs on the target from here, whatever the agent does next.
  const enterAt = (typed as { enterAt: number }).enterAt
  ctx.record({ accountId: target.id, start: { at: typed.at, commands: [typed.line] }, sessionId: sessionId ?? fresh ?? null })
  // Step 10: what the relaunch did.
  io.progress?.({ terminalId: id, step: 'waiting' })
  let watched = await watchOutcome(io, id, agent, enterAt, typed.line, until)
  if (watched.seen === 'not-found' && agent === 'codex') {
    // Codex's path (c): the target can't see the session. A new session in place, and said so.
    await shellBack(io, id, enterAt)
    const freshSpec: RelaunchSpec = { ...spec, id: null }
    typed = await run(freshSpec)
    if (typed.outcome !== 'entered') return notEntered(typed)
    ctx.record({ accountId: target.id, start: { at: typed.at, commands: [typed.line] }, sessionId: null })
    watched = await watchOutcome(io, id, agent, typed.enterAt, typed.line, until)
    if (watched.seen === 'switched') return { kind: 'fresh', why: 'not-found' }
  }
  if (watched.seen === 'not-found') return { kind: 'resume-not-found' }
  if (watched.seen === 'sign-in') return { kind: 'sign-in' }
  if (watched.seen === 'no-outcome') return { kind: 'no-outcome' }
  if (typeof watched.seen === 'object') return { kind: 'asks-user', what: watched.seen.asks }
  if (watched.notFound) return { kind: 'fresh', why: 'not-found' }
  if (!sessionId) return { kind: 'fresh', why: req.fresh ? 'asked' : 'no-session' }
  const switched: SwitchOutcome = { kind: 'switched', resumed: true, sessionId }
  if (carried.carried) switched.carried = true
  if (carried.kept) switched.kept = carried.kept
  return switched
}
