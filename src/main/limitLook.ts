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
  /** Seen gone since: latched until the next start. */
  ended?: boolean
  /** Took a turn since: a prompt entered in its box, or seen at work. */
  turned?: boolean
}

/** How long after its start a shell still in the PTY's foreground is no sign of an exit: the moment
 *  the shell takes to start the agent. */
export const FOREGROUND_GRACE_MS = 3000

/** An agent launch in a typed line, as the launch audit reads one (index.ts auditLaunchPattern): the
 *  agent's name at the start of a command, after `;`, `&&`, `|`, a PowerShell block's `{` or cmd's
 *  `call`, as Termpolis's own account lines put it. */
const AGENT_LAUNCH = /(?:^|[;&|{]|\bcall\b)\s*(claude|codex|agy)(?=[\s}]|$)/

/** The agent a line starts, or null. */
export function agentOfLaunch(line: string): AccountAgent | null {
  const m = AGENT_LAUNCH.exec(line)
  return m ? (m[1] as AccountAgent) : null
}

/** Has the agent `start` recorded exited (or never started)? The look `l` is the screen now. */
export function agentGone(io: SwitchIO, id: string, start: LiveStart, now: number, l: Look = look(io, id)): boolean {
  if (start.ended) return true
  if (start.agent && hintAtFoot(l, start.agent) && HINT_HEAD[start.agent].test(plain(io.outputFrom(id, start.at)))) return true
  const from = indexOf(l, start.at)
  // The replay is read only once a shell reported a prompt since the start: David's Git Bash, zsh
  // and fish report none.
  if (l.raw.slice(from).search(PROMPT_REPORT) >= 0 && sinceStarted(l.raw, from, false, io.size(id), start.commands).shell) return true
  return now - (start.time ?? 0) >= FOREGROUND_GRACE_MS && io.atShell?.(id) === true
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
  const live = !start.ended
  if (live && status.status === 'working') start.turned = true
  return {
    agent: start.agent ?? null,
    live,
    turned: start.turned === true,
    startAt: start.at,
    status,
    words: stopKind(status) === 'limit' ? limitWords(l.lines.join('\n')) : null,
  }
}

/**
 * A line entered by hand (main's terminal:write watch, accountsIpc.ts noteLine): an agent typed at
 * the shell once the one before is gone, which starts a new record (R5: watched from now on); or,
 * while the agent runs with its box on screen, a prompt entered in it, which is a turn (R4). A slash
 * command is the CLI's own (/exit, /model) and no turn. Returns the start to record, if any.
 */
export function noteEnteredLine(io: SwitchIO, id: string, start: LiveStart | undefined, line: string, at: number, now: number): LiveStart | null {
  const launched = agentOfLaunch(line)
  const l = look(io, id)
  const gone = !start || agentGone(io, id, start, now, l)
  if (start && gone) start.ended = true
  if (launched && gone) return { at, commands: [line], agent: launched, time: now }
  if (start && !gone && !line.startsWith('/') && l.box >= 0) start.turned = true
  return null
}
