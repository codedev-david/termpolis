/**
 * Swarm Bridge — what a worker's screen shows, as messages for the swarm bus.
 *
 * Codex and Gemini workers' terminals are read every few seconds and what they show is posted for
 * the conductor (swarmBridgeManager.ts). It used to post the raw output since the last read: for a
 * TUI agent that is a stream of redraws, so a message was spinner frames and lines cut short
 * ("⣽ Reading fil⣾ Reading file..."), labelled result or error by guessing at its words (GitHub
 * #36 item 7). The output is replayed into a screen now (src/shared/terminalScreen.ts), and a
 * message carries only what the screen settled on: rows of the worker's transcript that stayed the
 * same for a whole read or scrolled off the top, its status line without the spinner, and a hint
 * when it finished a turn. Every message is typed info: only swarm_update_task completes a task.
 */

import { TerminalScreen, screenSizeOf, type ScreenSize } from '../../../shared/terminalScreen'
import { detectAgentStatus, inputBoxRow, type AgentStatus } from '../../../shared/agentStatusDetector'

/** What the bridge says when a worker is back at its prompt after working on a prompt (item 3). */
export const DONE_HINT = 'screen suggests it may be done; check with read_output'

/** How much of a worker's transcript one message carries, at most: the end of it. */
const MAX_LINES = 20
const MAX_CHARS = 2000
/** How many posted rows are remembered, so a row is posted once. */
const SEEN_MAX = 2000

const RULE = /^[─━═]{20,}$/
/** Block elements: Claude Code's and agy's logos. */
const LOGO = /[▀-▟]/
/** A box's frame: Codex's header, an older Claude Code's input box. */
const BOX = /^[╭╰│]/
/** A prompt as the agents echo it in their history: ❯ (Claude Code), › (Codex), > (agy). */
const PROMPT_ECHO = /^[❯›>]\s/
/** A shell's prompt, with or without the command typed at it: the agent's launch, or its exit. */
const SHELL_PROMPT = /^PS [A-Za-z]:\\[^>]*>|^[\w.-]+@[\w.-]+:\S*[$#](?:\s|$)|^[$#%](?:\s|$)/
/** Codex's startup tips ("Tip: Type / to open the command popup..."). */
const TIP = /^\s*Tip: /
/** A status line: led by a spinner frame (agy's braille, Claude Code's ✢✳✶✻✽ and · *), or Codex's
 *  "• Working (31s • esc to interrupt)". Not its notice of queued input, two rows that begin
 *  "• Messages to be submitted after next tool call (press esc to interrupt and send": content. */
const SPINNER_ROW = /^\s*(?:[⠀-⣿]|[✢✳✶✻✽◐◑◒◓])\s/
const CLAUDE_FRAME_ROW = /^\s*[*·]\s.*…$/
const CODEX_STATUS_ROW = /^\s*[•◦]\s.*\besc to (?:interrupt|cancel)\)\s*$/

/** What one read of a worker's screen shows. */
export interface WorkerView {
  /** The rows above its input box, top to bottom, chrome left out. */
  transcript: string[]
  /** Prompts it was sent, as its history shows them. */
  prompts: string[]
  /** Its status line, spinner and timer left out; '' with none. */
  status: string
  agent: AgentStatus
}

function isStatusRow(row: string): boolean {
  return SPINNER_ROW.test(row) || CLAUDE_FRAME_ROW.test(row) || CODEX_STATUS_ROW.test(row)
}

/** A status line as it reads without its spinner frame and its "(31s • esc to interrupt)". */
export function statusText(row: string): string {
  return row
    .replace(/^\s*(?:[⠀-⣿]|[✢✳✶✻✽◐◑◒◓*·•◦])\s+/, '')
    .replace(/\s*\([^()]*(?:\besc to \w+|\b\d+(?:m \d+)?s\b)[^()]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isChrome(row: string): boolean {
  return row.trim() === '' || RULE.test(row.trim()) || LOGO.test(row) || BOX.test(row) || TIP.test(row)
}

/** Rows without the agent's furniture, its shell's prompts, or the rest of a command typed at
 *  one, which a full row wraps onto the rows below it (`& 'C:\Users\...\agy.exe' --danger...`). */
function withoutChrome(rows: readonly string[], cols: number): string[] {
  const kept: string[] = []
  let wrapsOn = false
  for (const row of rows) {
    const atPrompt: boolean = wrapsOn || SHELL_PROMPT.test(row)
    wrapsOn = atPrompt && row.length >= cols
    if (!atPrompt && !isChrome(row)) kept.push(row)
  }
  return kept
}

export function readWorkerScreen(screen: TerminalScreen, agentName: string, previous: AgentStatus): WorkerView {
  const rows = screen.lines()
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  const agent = detectAgentStatus(rows.join('\n'), agentName, previous, { screen: true, title: screen.title }).status
  // Everything from the input box down is the agent's own furniture: the box, its rules, the footer.
  const box = inputBoxRow(rows)
  const above = box < 0 ? rows : rows.slice(0, box)
  const transcript: string[] = []
  const prompts: string[] = []
  let status = ''
  for (const row of withoutChrome(above, screen.cols)) {
    if (isStatusRow(row)) status = statusText(row)
    else if (PROMPT_ECHO.test(row)) prompts.push(row)
    else transcript.push(row)
  }
  return { transcript, prompts, status, agent }
}

function isBusy(agent: AgentStatus): boolean {
  return agent === 'working' || agent === 'thinking' || agent === 'starting'
}

/** One read of a terminal's output (window.termpolis.readTerminalBuffer). The size, preamble and
 *  skip come only with a read from the start of what main still holds, a replay. */
export interface TerminalRead {
  output: string
  missed?: number
  cols?: number
  rows?: number
  preamble?: string
  skip?: number
}

/**
 * One worker's screen, read after read: turns what each read adds into at most one message.
 *
 * A row is posted once, when it is final: it scrolled off the top, or it read the same on two
 * reads in a row (a line still being written, or redrawn, reads differently each time). The first
 * read, and the first after a gap in the output or a resize, only sets aside what is there: the
 * shell starting, the agent's banner, what it showed before the bridge looked.
 */
export class WorkerFeed {
  private screen: TerminalScreen | null = null
  private size: ScreenSize | null = null
  private last: WorkerView | null = null
  private seen = new Map<string, true>()
  private postedStatus = ''
  /** A prompt it was sent is in its history, and it hasn't finished working on it yet. */
  private prompted = false
  private worked = false

  constructor(private readonly agentName: string) {}

  /** Whether this output draws past the screen: the terminal was resized larger, and only a replay
   *  read, which says how large, can rebuild the screen. */
  outgrows(output: string): boolean {
    const wanted = screenSizeOf(output)
    return this.size !== null && (wanted.cols > this.size.cols || wanted.rows > this.size.rows)
  }

  /** What the terminal printed since the last read, turned into a message, or null. */
  update(read: TerminalRead): string | null {
    const { output } = read
    const size = read.cols && read.rows ? { cols: read.cols, rows: read.rows } : null
    const resized = size !== null && this.size !== null && (size.cols !== this.size.cols || size.rows !== this.size.rows)
    const fresh = this.screen === null || (read.missed ?? 0) > 0 || resized || this.outgrows(output)
    if (fresh) {
      this.size = size ?? (this.outgrows(output) || !this.size ? screenSizeOf(output) : this.size)
      this.screen = new TerminalScreen(this.size)
    }
    const screen = this.screen!
    // A replay starts where main's window does: the modes the output before it left, then the rest
    // of the sequence the window's start cut in half, which is no text.
    if (fresh && read.preamble) screen.write(read.preamble)
    screen.write(fresh && read.skip ? output.slice(read.skip) : output)
    const offTop = withoutChrome(screen.takeScrolledOff(), screen.cols)
    const view = readWorkerScreen(screen, this.agentName, this.last?.agent ?? 'starting')
    const last = this.last
    this.last = view
    if (fresh || !last) {
      for (const row of [...offTop, ...view.transcript, ...view.prompts]) this.remember(row)
      this.postedStatus = view.status
      return null
    }

    // A prompt it hadn't been sent before: it is working for the swarm from here.
    for (const row of [...offTop.filter((r) => PROMPT_ECHO.test(r)), ...view.prompts]) {
      if (this.seen.has(row)) continue
      this.remember(row)
      this.prompted = true
      this.worked = false
    }
    if (isBusy(view.agent)) this.worked = true
    const done = this.prompted && this.worked && view.agent === 'idle'
    if (done) this.prompted = false

    // A worker at rest (at its prompt, asking, stopped) draws nothing more, so all it shows is final.
    const before = new Set(last.transcript)
    const visible = isBusy(view.agent) ? view.transcript.filter((r) => before.has(r)) : view.transcript
    const settled = [...offTop.filter((r) => !PROMPT_ECHO.test(r) && !isStatusRow(r)), ...visible]
    const lines: string[] = []
    for (const row of settled) {
      if (this.seen.has(row)) continue
      this.remember(row)
      lines.push(row)
    }
    // A status line once it holds for a whole read, and again on a later turn.
    const status = view.status && view.status === last.status && view.status !== this.postedStatus ? view.status : ''
    if (status) this.postedStatus = status
    else if (!view.status) this.postedStatus = ''

    const parts = [...(done ? [DONE_HINT] : []), ...clip(lines), ...(status ? [`Status: ${status}`] : [])]
    return parts.length > 0 ? `[${this.agentName}] ${parts.join('\n')}` : null
  }

  private remember(row: string): void {
    this.seen.delete(row)
    this.seen.set(row, true)
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string)
  }
}

/** The end of a long run of lines: what the worker did last explains where it is. A row is never
 *  longer than the screen is wide (screenSizeOf caps that at 1,000), so one row always fits. */
function clip(lines: string[]): string[] {
  let kept = lines.slice(-MAX_LINES)
  while (kept.length > 1 && kept.join('\n').length > MAX_CHARS) kept = kept.slice(1)
  return kept.length < lines.length ? ['…', ...kept] : kept
}

/**
 * Format an incoming swarm message for injection into a terminal.
 */
export function formatIncomingMessage(from: string, content: string): string {
  return `\n--- Message from ${from} ---\n${content}\n--- End message ---\n`
}
