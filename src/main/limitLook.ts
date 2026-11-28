// The usage-limit chooser's look at a terminal (§8.1), main's side, beside the buffers: one replay
// of a screen the renderer's 2 s loop saw change, what the agent on it shows (detectAgentStatus),
// the CLI's own words for a limit (limitWords), and where the agent Termpolis started there stands
// (R5). A limit counts only while that agent is live, and only once it has taken a turn: the CLI
// hits its limit answering one, and a screen showing a limit before that is the old limit of a
// session resumed there (R4: Claude Code keeps it in the transcript, and draws it again), a
// screen a shell printed (`cat` of a capture), or the last frame an exited agent left above the
// prompt.
//
// The agent is gone, and stays gone until the next start (a new agent typed there), only on the
// shell's own word, as the switch reads it (accountSwitch.ts promptSince): its prompt reported since
// the start, with no box drawn after it; on macOS and Linux, the shell back in the PTY's foreground;
// the OS's last answer that only the shell is left, from an ask something needed after the start.
// An exit hint, a footer or a closing rule not drawn yet, a quiet screen are never an exit (HOLD-C).
// In a terminal that shows none of these, an agent typed later is recorded over the one before,
// never seen ended, with its options unknown (noteEnteredLine, HOLD-C R1).
import { boxAtFoot, detectAgentStatus, inputBoxRows, limitWords, stopKind } from '../shared/agentStatusDetector'
import { ACCOUNT_AGENT_LABEL } from '../shared/agentAccounts'
import type { AccountAgent } from '../shared/agentAccounts'
import type { LimitLook } from '../shared/accountLimits'
import { agentOfLaunch } from '../shared/launchCarry'
import { CODEX_STARTING } from '../shared/accountSwitch'
import { PROMPT_REPORT, sinceStarted } from './mcpServer'
import { indexOf, look, plain, shellBackSince } from './accountSwitch'
import type { Look, SwitchIO } from './accountSwitch'

/** Where a terminal's agent was started, as main recorded it (accountsIpc.ts AgentStart). */
export interface LiveStart {
  /** Where in its output the line that started it was entered. */
  at: number
  commands: string[]
  /** The agent the line started, as the line names it. */
  agent?: AccountAgent
  /** When main saw the line entered (epoch ms). */
  time?: number
  /** The line was made with the shell's own editing (a history recall, Tab completion, a cursor move), so what ran can differ
   *  from the keys Termpolis saw: `commands` name only the agent, and its model and flags are not known (MODELS-R2-4). */
  unsure?: boolean
  /** No start was seen at all: an edited line after the agent's exit may have run it again (accountsIpc.ts noteUnseenLaunch).
   *  Kept for the switch; the chooser counts it only where this terminal can show the agent's exit (CH4-1). */
  unseen?: boolean
  /** Seen gone since: latched until the next start. */
  ended?: boolean
  /** The shell had reported a prompt when the line was entered, a look has seen its first prompt since (accountSwitch.ts
   *  notePrompted), or the agent's own /resume moved `at`: the first prompt report since `shellFrom` is the shell back
   *  (accountSwitch.ts promptSince). */
  prompted?: true
  /** Where the shell's first prompt after the line, seen by a look, ended: kept for when the line has scrolled out of the window. */
  shellFrom?: number
  /** Typed while the agent before was never seen gone, in a terminal that can't show its exit (no prompt report, no foreground read):
   *  the line may have gone into that agent. Recorded so the chip names the agent typed, with its options unknown (`unsure`); the
   *  switch from it types nothing, and on the user's word carries nothing and resumes no conversation (HOLD-C R1). */
  overUnended?: true
  /** When a look first saw it running (epoch ms): its box drawn since the start, at the screen's foot, or a turn entered in it. The
   *  OS's last answer that only the shell is left counts only if it was asked after this (HOLD-C R2-2). */
  seenUpAt?: number
  /** Took a turn since: a prompt entered in its box, or seen at work. */
  turned?: boolean
  /** Where in its output that turn began (the Enter, or the first look that saw it at work). */
  turnedAt?: number
  /** Its account's recorded limit was looked at once, for this start (R15). */
  healed?: boolean
  /** Termpolis relaunched the agent here (an account switch, a swarm worker's restart): the conversation
   *  it resumed shows the limit it stopped at again, which is no stop of this run until it takes a turn. */
  relaunched?: boolean
}

/** Letters and digits only: how the CLI's words are matched in raw output, which colours and wraps them. */
const bareText = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, '')

/** Were the limit's words printed since `from`? Between the Enter that submits a prompt and the CLI's
 *  redraw, the screen still shows the conversation that was resumed, ending at its old limit (R4):
 *  that limit was printed before the turn began, and is no answer to it. */
function printedSince(io: SwitchIO, id: string, from: number, words: string): boolean {
  const head = bareText(words).slice(0, 40)
  return head.length > 0 && bareText(plain(io.outputFrom(id, from))).includes(head)
}

/** How long after its start a shell still in the PTY's foreground is no sign of an exit: the moment
 *  the shell takes to start the agent. */
export const FOREGROUND_GRACE_MS = 3000

/** The agent a typed line starts, or null (src/shared/launchCarry.ts: the one reading of such a line,
 *  as the launch audit reads one too, index.ts auditLaunchPattern). */
export { agentOfLaunch }

/** Has the agent `start` recorded exited (or never started)? The look `l` is the screen now. Past the moment the shell takes to start
 *  it, the OS's word counts too: the PTY's foreground (macOS, Linux), or the last answer the OS gave an ask that something needed (a
 *  switch's exit, the model switch, a submit), asked after that moment. The OS is never asked from here (HOLD-C R1, v1.54.3). */
export function agentGone(io: SwitchIO, id: string, start: LiveStart, now: number, l: Look = look(io, id)): boolean {
  if (start.ended || shellBackSince(io, id, l, start)) return true
  const ready = (start.time ?? 0) + FOREGROUND_GRACE_MS
  if (now < ready) return false
  if (io.atShell?.(id) === true) return true
  // The OS's answer asked before the agent was seen running may be of the moment before it was up, the shell alone (HOLD-C R2-2).
  return start.seenUpAt !== undefined && io.aloneSince?.(id, Math.max(ready, start.seenUpAt)) === true
}

/** Can this terminal show an agent's exit? Not where its shell has never reported a prompt (none kept, none in the window, none before
 *  the line) and the PTY's foreground can't be read (Windows): Git Bash whose rc sets a PROMPT_COMMAND of its own, WSL, a shell with no
 *  integration. */
export function showsExit(io: SwitchIO, id: string, start: LiveStart, l: Look): boolean {
  if (start.prompted || typeof io.atShell?.(id) === 'boolean') return true
  const kept = io.reported?.(id)
  return kept?.posix === true || kept?.windows === true || l.raw.search(PROMPT_REPORT) >= 0
}


/** What a look reads off the terminal itself; accountsIpc.ts adds main's account record. */
export type LimitLookResult = Omit<LimitLook, 'accountId' | 'byHand'>

/**
 * Looks at a terminal for the chooser: the screen, judged once; the agent's lifecycle, latched gone
 * at the shell's or the OS's word of its exit; a turn, once it is seen at work. `start` is main's record of the
 * agent started there, or undefined for none: then nothing counts.
 */
export function lookForLimit(io: SwitchIO, id: string, start: LiveStart | undefined, now: number): LimitLookResult {
  const l = look(io, id)
  const status = detectAgentStatus(l.lines.join('\n'), start?.agent ? ACCOUNT_AGENT_LABEL[start.agent] : '', 'idle', { screen: true, title: l.title })
  if (!start) return { agent: null, live: false, turned: false, startAt: null, status, words: null }
  if (agentGone(io, id, start, now, l)) start.ended = true
  const live = !start.ended
  // Its box drawn since its start, at the screen's foot: it runs (the OS's answer counts from here, HOLD-C R2-2).
  if (live && start.seenUpAt === undefined && boxAtFoot(l.lines, l.cols) && sinceStarted(l.raw, indexOf(l, start.at), false, io.size(id), start.commands).started) {
    start.seenUpAt = now
  }
  // Codex says "model: loading" in its header until it is up, with its box already drawn, and the detector reads
  // that as work (the real fresh-launch streams do, at 0.7 s): no prompt was taken, so it is no turn.
  const starting = start.agent === 'codex' && CODEX_STARTING.test(l.lines.join('\n'))
  if (live && status.status === 'working' && !start.turned && !starting) {
    start.turned = true
    start.turnedAt = io.end(id)
  }
  const words = stopKind(status) === 'limit' ? limitWords(l.lines.join('\n')) : null
  // A limit on screen that the CLI did not print since the turn began is the old one of the conversation
  // it resumed, drawn again: not this turn's answer. The Enter that submits a prompt lands before the
  // CLI redraws, and a /resume or a pasted block flips nothing that tells the two apart.
  const fresh = !words || start.turnedAt === undefined || printedSince(io, id, start.turnedAt, words)
  return {
    agent: start.agent ?? null,
    live,
    turned: start.turned === true && fresh,
    startAt: start.at,
    status,
    words,
  }
}

/**
 * A line entered by hand (main's terminal:write watch, accountsIpc.ts noteLine): an agent typed at
 * the shell once the one before is gone, which starts a new record (R5: watched from now on); or,
 * while the agent runs with its box on screen, a prompt entered in it, which is a turn (R4). A slash
 * command is the CLI's own (/exit, /model) and no turn. Returns the start to record, if any.
 * The screen is looked at (`lookNow`, which one write's lines share) only when that could change
 * something: a pasted block of lines is no replay per line on main's thread.
 */
export function noteEnteredLine(
  io: SwitchIO, id: string, start: LiveStart | undefined, line: string, at: number, now: number, lookNow: () => Look = () => look(io, id), edited = false,
): LiveStart | null {
  const launched = agentOfLaunch(line)
  // /resume and /continue put another conversation on screen: like a relaunch, it may end in an old
  // limit, drawn again, and that is no stop of this agent until it takes a turn on it (R4).
  if (!launched && start && !start.ended && /^\/(?:resume|continue)\b/.test(line)) {
    start.turned = false
    start.turnedAt = undefined
    start.at = at
    start.time = now
    start.prompted = true
    delete start.shellFrom
    return null
  }
  if (!launched && (!start || start.ended || start.turned || line.startsWith('/'))) return null
  const l = lookNow()
  // A guessed start (unseen) is made only where the agent before it was seen gone (accountsIpc.ts noteUnseenLaunch): its own
  // exit is read as any start's, and in a terminal that never shows an exit no guess is made (HOLD-C).
  const gone = !start || agentGone(io, id, start, now, l)
  if (start && gone) start.ended = true
  // A line the shell edited is an agent started, but not the one the keys say: its flags are left as unknown.
  if (launched && gone) return edited ? { at, commands: [launched], agent: launched, time: now, unsure: true } : { at, commands: [line], agent: launched, time: now }
  if (!start || gone) return null
  // An agent typed in a terminal that can't show the agent before it exited (no prompt report, no foreground read; the OS's last
  // answer said nothing), not into that agent's box: the record must not stay that agent's for ever. Claude Code leaves its last
  // frame, box and all, above the shell's prompt, so a box on screen says nothing there; the line drawn in it does (HOLD-C R1).
  const over = launched !== null && !showsExit(io, id, start, l) && !inBox(l, line)
  // Typed in the live agent's box, at the screen's foot: a prompt, a turn; and the agent seen running.
  if (boxAtFoot(l.lines, l.cols) && !over) {
    start.turned = true
    start.turnedAt = at
    if (start.seenUpAt === undefined) start.seenUpAt = now
    return null
  }
  // The record becomes the agent typed, with its options unknown, over a record never seen ended: the line may have gone into that
  // agent, so the switch from it types nothing without the user's word, and with it carries nothing and resumes nothing.
  if (over) return { at, commands: [launched], agent: launched, time: now, unsure: true, overUnended: true }
  return null
}

/** Is `line` drawn in the agent's live box, at the screen's foot (its first 40 characters, as the switch reads a line it typed)? Never
 *  in the last frame an exited agent left above the shell's prompt: a draft there is no line typed into an agent (HOLD-C R2, C3). */
function inBox(l: Look, line: string): boolean {
  const box = boxAtFoot(l.lines, l.cols) ? inputBoxRows(l.lines) : null
  return box !== null && bareText(box.join('')).includes(bareText(line.slice(0, 40)))
}
