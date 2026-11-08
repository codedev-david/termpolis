// The usage-limit chooser's look at a terminal (§8.1), main's side, beside the buffers: one replay
// of a screen the renderer's 2 s loop saw change, what the agent on it shows (detectAgentStatus),
// the CLI's own words for a limit (limitWords), and where the agent Termpolis started there stands
// (R5). A limit counts only while that agent is live, and only once it has taken a turn: the CLI
// hits its limit answering one, and a screen showing a limit before that is the old limit of a
// session resumed there (R4: Claude Code keeps it in the transcript, and draws it again), a
// screen a shell printed (`cat` of a capture), or the last frame an exited agent left above the
// prompt.
//
// The agent is gone, and stays gone until the next start (a new agent typed there), at the first
// of: its exit hint at the screen's foot with no box under it, printed since it started; its
// shell's prompt report since, with no box drawn after it (sinceStarted, as submit reads it); on
// macOS and Linux, the shell back in the PTY's foreground. Each is what the switch reads too.
import { detectAgentStatus, limitWords, stopKind } from '../shared/agentStatusDetector'
import { ACCOUNT_AGENT_LABEL } from '../shared/agentAccounts'
import type { AccountAgent } from '../shared/agentAccounts'
import type { LimitLook } from '../shared/accountLimits'
import { agentOfLaunch } from '../shared/launchCarry'
import { CODEX_STARTING } from '../shared/accountSwitch'
import { HINT_HEAD, hintAtFoot, indexOf, look, plain } from './accountSwitch'
import type { Look, SwitchIO } from './accountSwitch'
import { PROMPT_REPORT, sinceStarted } from './mcpServer'

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

/** Has the agent `start` recorded exited (or never started)? The look `l` is the screen now. */
export function agentGone(io: SwitchIO, id: string, start: LiveStart, now: number, l: Look = look(io, id)): boolean {
  if (start.ended) return true
  if (start.agent && hintAtFoot(l, start.agent) && HINT_HEAD[start.agent].test(plain(io.outputFrom(id, start.at)))) return true
  const fresh = now - (start.time ?? 0) < FOREGROUND_GRACE_MS
  const from = indexOf(l, start.at)
  // The replay is read only once a shell reported a prompt since the start: David's Git Bash, zsh
  // and fish report none.
  const since = l.raw.slice(from)
  if (since.search(PROMPT_REPORT) >= 0 && !(fresh && quietUpToPrompt(since)) && sinceStarted(l.raw, from, false, io.size(id), start.commands).shell) return true
  return !fresh && io.atShell?.(id) === true
}

/** Nothing printed between the start and the shell's last prompt report since: the shell printed one more prompt
 *  after the line was entered and before it echoed that line (Git Bash on Windows CI did), not an agent that ran and
 *  exited. A look in that moment latched the agent gone before it started; in the moment the shell takes to start
 *  the agent (FOREGROUND_GRACE_MS) it is no exit. */
function quietUpToPrompt(since: string): boolean {
  const reports = [...since.matchAll(PROMPT_REPORT)]
  return plain(since.slice(0, reports[reports.length - 1].index)).trim() === ''
}

/** Can this terminal ever show an agent's exit? A shell that reports its prompts, or a PTY whose foreground can be read
 *  (macOS, Linux). Git Bash on Windows with a PROMPT_COMMAND of its own shows neither: a guessed start there would stay
 *  live for the life of the terminal, so a `cat` of a limit screen, or another agent's limit, would read as its stop. */
function exitVisible(io: SwitchIO, id: string): boolean {
  const r = io.reported?.(id)
  return !!(r && (r.posix || r.windows)) || io.atShell?.(id) != null
}

/** What a look reads off the terminal itself; accountsIpc.ts adds main's account record. */
export type LimitLookResult = Omit<LimitLook, 'accountId' | 'byHand'>

/**
 * Looks at a terminal for the chooser: the screen, judged once; the agent's lifecycle, latched gone
 * at the first sign of an exit; a turn, once it is seen at work. `start` is main's record of the
 * agent started there, or undefined for none: then nothing counts.
 */
export function lookForLimit(io: SwitchIO, id: string, start: LiveStart | undefined, now: number): LimitLookResult {
  const l = look(io, id)
  const status = detectAgentStatus(l.lines.join('\n'), start?.agent ? ACCOUNT_AGENT_LABEL[start.agent] : '', 'idle', { screen: true, title: l.title })
  if (!start) return { agent: null, live: false, turned: false, startAt: null, status, words: null }
  if (agentGone(io, id, start, now, l)) start.ended = true
  const live = !start.ended && !(start.unseen === true && !exitVisible(io, id))
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
    return null
  }
  if (!launched && (!start || start.ended || start.turned || line.startsWith('/'))) return null
  const l = lookNow()
  // A guessed start (unseen) gives way to a launch typed after it wherever its exit could never be seen, or no agent box is up.
  const gone = !start || (start.unseen === true && (l.box < 0 || !exitVisible(io, id))) || agentGone(io, id, start, now, l)
  if (start && gone) start.ended = true
  // A line the shell edited is an agent started, but not the one the keys say: its flags are left as unknown.
  if (launched && gone) return edited ? { at, commands: [launched], agent: launched, time: now, unsure: true } : { at, commands: [line], agent: launched, time: now }
  if (start && !gone && l.box >= 0) {
    start.turned = true
    start.turnedAt = at
  }
  return null
}
