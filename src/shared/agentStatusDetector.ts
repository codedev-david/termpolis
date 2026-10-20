/**
 * Agent Status Detector — real-time status detection for swarm agent terminals.
 *
 * Analyzes terminal output to determine what an AI agent is currently doing.
 * Used by the swarm monitoring loop to update dashboard status indicators.
 */

// 'blocked' = agent process has exited or is stalled and needs manual restart
// (e.g. Codex printed "Please restart Codex" after a self-update, the CLI
// segfaulted silently, or the shell is back at a plain prompt with no agent
// running). Distinct from 'errored' (fatal error message) and
// 'waiting_for_input' (agent is alive and asking the user something) — a
// blocked agent will silently ignore swarm tasks until someone relaunches it.
export type AgentStatus = 'starting' | 'thinking' | 'waiting_for_input' | 'working' | 'idle' | 'errored' | 'completed' | 'blocked'

export interface AgentStatusResult {
  status: AgentStatus
  /** One-line summary of what the agent is doing (shown in dashboard) */
  summary: string
}

export interface DetectOptions {
  /** The input is a rendered screen (TerminalScreen's lines joined with '\n', src/shared/
   *  terminalScreen.ts), not a raw tail. What it shows is current, so an agent's input box and
   *  busy line can be read off it; in a raw tail they linger after they are gone. */
  screen?: boolean
  /** With `screen`: the window title the output last set. */
  title?: string
}

// Strip ANSI escape codes for clean pattern matching. A cursor-forward is a run of spaces: ConPTY
// moves over every cell that didn't change, so on Windows "You've ESC[1C hit" reads "You've hit".
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
}

/**
 * Detect the current status of a swarm agent from its terminal output.
 *
 * @param recentOutput - The last ~2-4KB of the terminal's output buffer, or with `screen` a
 *   rendered screen
 * @param agentName - The agent type (e.g. "Claude", "Codex", "Gemini")
 * @param previousStatus - The agent's previous status (for hysteresis)
 */
export function detectAgentStatus(
  recentOutput: string,
  agentName: string,
  previousStatus: AgentStatus = 'starting',
  options: DetectOptions = {},
): AgentStatusResult {
  if (options.screen) return detectOnScreen(recentOutput, agentName, previousStatus, options.title ?? '')
  const clean = stripAnsi(recentOutput)
  // Focus on the tail for recency — most signals are at the end
  return detectInText(clean.slice(-1500), agentName, previousStatus)
}

/** `stops`: false when a screen was read for what holds the agent already (detectOnScreen). A raw
 *  tail is read for a CLI that exited or needs relaunching only, never for a usage limit or a menu:
 *  its rows can't be told apart, and a worker's answers and the files it shows hold the same words
 *  as a CLI's own message (GitHub #36). */
function detectInText(tail: string, agentName: string, previousStatus: AgentStatus, stops = true): AgentStatusResult {
  // --- Priority 1: Blocked — agent is dead/stalled, needs restart ---
  // Must outrank waiting_for_input: a "please re-authenticate" or
  // "gemini auth"-hint message contains auth keywords but the agent
  // process isn't actually alive to receive terminal input — the user
  // has to relaunch the CLI. Also precedes isIdle for the same reason.
  const stopped = stops ? restartSummary(tail, agentName) : null
  if (stopped !== null) return { status: 'blocked', summary: stopped }

  // --- Priority 2: Waiting for user input (needs attention) ---
  if (isWaitingForInput(tail, agentName)) {
    const summary = extractInputPrompt(tail, agentName)
    return { status: 'waiting_for_input', summary }
  }

  // --- Priority 3: Error state ---
  if (isErrored(tail)) {
    const summary = extractErrorSummary(tail)
    return { status: 'errored', summary }
  }

  // --- Priority 3: Completed ---
  if (isCompleted(tail, agentName)) {
    const summary = extractCompletionSummary(tail)
    return { status: 'completed', summary }
  }

  // --- Priority 4: Actively working (writing files, running commands) ---
  if (isWorking(tail)) {
    const summary = extractWorkSummary(tail)
    return { status: 'working', summary }
  }

  // --- Priority 5: Still starting (check before thinking — startup output looks like thinking) ---
  if (isStarting(tail, previousStatus)) {
    return { status: 'starting', summary: 'Agent initializing...' }
  }

  // --- Priority 6: Thinking (agent is generating output) ---
  if (isThinking(tail, agentName)) {
    return { status: 'thinking', summary: 'Analyzing and generating response...' }
  }

  // --- Priority 7: Idle (prompt visible, nothing happening) ---
  if (isIdle(tail, agentName)) {
    return { status: 'idle', summary: 'Waiting at prompt' }
  }

  // Default: keep previous status if we can't determine
  return { status: previousStatus, summary: '' }
}

// ---- A rendered screen ----

/** The rows at the bottom of a screen, where each agent draws its input box, footer and status
 *  line, and where a limit message or a dialog appears. What is above them is history: what the
 *  agent did, not what it is doing. */
const SCREEN_BOTTOM_ROWS = 12

// What the three agents show while they work, all seen on real screens (GitHub #36). Claude Code
// 2.1.302's footer and Codex 0.153.4's status line say "esc to interrupt", agy 1.4.0's footer "esc to
// cancel". Codex's header says "model: loading" until it is up: its input box is already drawn then,
// and an Enter only queues the prompt, which it lists above the box.
const BUSY_ON_SCREEN: readonly RegExp[] = [
  /\besc to interrupt\b/,
  /\besc to cancel\b/,
  /\bmodel:\s+loading\b/,
  /\bQueued follow-up inputs\b|\bMessages to be submitted after next tool call\b/,
]
/** The same, where each agent draws them with its input box on the screen: in its footer under the
 *  box, on a status line led by its spinner or bullet that ends in its key ("• Working (31s • esc to
 *  interrupt)", Gemini CLI's "⠼ Reading files... (esc to cancel, 12s)"), Codex's notices of queued
 *  input on rows of their own, and its header while the model loads. The transcript between them
 *  can hold the same words, in an answer about the agent's footer or a file a worker shows, and an
 *  idle worker read as at work: submit waited 3 minutes for it (R3-2). */
const BUSY_FOOTER = /\besc to (?:interrupt|cancel)\b/
const BUSY_ROWS: readonly RegExp[] = [
  /^\s*(?:[⠀-⣿]|[✢✳✶✻✽*·•◦])\s.*\([^()]*\besc to (?:interrupt|cancel)\b[^()]*\)\s*$/,
  /^•\s+Queued follow-up inputs\s*$/,
  /^•\s+Messages to be submitted after next tool call\b/,
  /^│\s*model:\s+loading\b/,
]
/** A window title led by a spinner: Claude Code's ◐◓◑◒ and Codex's braille frames, redrawn while
 *  they work, so the title is current even after their footer has left the buffer. */
const BUSY_TITLE = /^[⠀-⣿◐-◓]/
const RULE = /^[─━]{20,}$/
/** A cursor on a numbered option ("❯ 1. Yes"): under a rule near the bottom, a dialog's, so no box
 *  taller than the screen (tallBoxRow). A row like it can be a task typed into a box, starting
 *  "1. ": a menu is told by its keys (isMenuCursor). */
const OPTION_ROW = /^(?:│\s)?[❯>›]\s?\d+\.\s/
/** The row under a menu that says how to answer it, as each CLI draws it: Codex 0.153.4's "Press
 *  enter to continue" and "Press enter to confirm or esc to go back", agy's "↑/↓ Navigate · enter
 *  Confirm", Claude Code 2.1.302's "Enter to confirm · Esc to cancel" (all from their binaries). At
 *  the start of a row, and in their case: agy's busy footer says "esc to cancel". */
const MENU_KEYS = /^\s*(?:Press enter to (?:continue|confirm)\b|Enter to confirm\b|↑\/↓ Navigate\b)/
/** A status line led by a spinner frame or a bullet: Claude Code's "✢ Doing…", agy's "⡿ Generating...",
 *  Codex's "• Working (31s • esc to interrupt)". */
const STATUS_ROW = /^\s*(?:[⠀-⣿]|[✢✳✶✻✽*·•◦])\s+(\S.*)$/
/** A box's corners, as Gemini CLI's dialogs and Codex's header draw them. */
const BOX_TOP = /^\s*╭/
const BOX_BOTTOM = /^\s*╰/
/** The glyph an input box's first row starts with: Claude Code's ❯ (an older one's │ >), agy's >,
 *  Codex's ›. */
const INPUT_GLYPH = /^(?:│\s)?[❯>›]/
/** What an empty input box shows until something is typed: Claude Code 2.1.302's 'Try "…"' (one of
 *  a few examples, some naming a file of the project), Codex 0.153.4's "Ask Codex to do anything"
 *  and "Ask a follow-up question" (from their binaries). agy shows its > alone. */
const PLACEHOLDER = /^(?:Try "[^"]*"|Ask Codex to do anything|Ask a follow-up question)$/
/** How many rows Claude Code's footer takes under its box, at most: what tallBoxRow allows under
 *  the closing rule. Its own three rows, and one to spare. */
const FOOTER_ROWS = 4
/** Claude Code's mode row, the last of its footer but for the effort row a narrow screen wraps under
 *  it: a footer that ends in it is Claude Code's however tall, a status line of the user's own over
 *  it (R3-6: with four rows of one, a box taller than the screen read as none). */
const MODE_ROW = /^\s*(?:⏵⏵|⏸|\? for shortcuts)/

function detectOnScreen(screen: string, agentName: string, previousStatus: AgentStatus, title: string): AgentStatusResult {
  const rows = screen.split('\n')
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  // Over the whole screen: a long prompt typed into the box makes it taller than the bottom rows.
  const box = inputBoxRow(rows)
  const from = bottomStart(rows)
  const bottom = rows.slice(from)
  const text = bottom.join('\n')
  const stopped = box >= 0 ? stopAroundBox(rows, box) : stopInPlaceOfBox(rows)
  if (stopped !== null) return { status: 'blocked', summary: stopped }
  // An input box says the CLI is up and taking input, whatever its history above says about an
  // expired session or a restart: those words are a worker's answer or a file it showed.
  const restart = box < 0 ? restartSummary(text, agentName) : null
  if (restart !== null) return { status: 'blocked', summary: restart }
  if (isBusy(rows, box, from, title)) return { status: 'working', summary: busySummary(bottom) }
  if (box >= 0) {
    // At rest: a CLI that ended its turn on its plan's limit shows it last, right above the box.
    const limit = turnEndLimit(rows, box)
    return limit !== null ? { status: 'blocked', summary: limit } : { status: 'idle', summary: 'Waiting at prompt' }
  }
  // Not one of the three agents' screens (a shell, a dialog): read it as text.
  return detectInText(text, agentName, previousStatus, false)
}

/** Whether a screen shows its agent at work: a spinner in its window title, or a busy line in its
 *  own rows. write_to_terminal's submit counts that as its prompt taken. */
export function isBusyOnScreen(lines: readonly string[], title: string): boolean {
  const rows = lines.slice()
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  return isBusy(rows, inputBoxRow(rows), bottomStart(rows), title)
}

/** A busy line in the bottom rows, from `from` on: with the agent's input box at row `box`, only one
 *  the agent draws itself (BUSY_FOOTER, BUSY_ROWS); with none, anywhere in them. */
function isBusy(rows: readonly string[], box: number, from: number, title: string): boolean {
  if (BUSY_TITLE.test(title)) return true
  const bottom = rows.slice(from)
  if (box < 0) {
    const text = bottom.join('\n')
    return BUSY_ON_SCREEN.some((p) => p.test(text))
  }
  return bottom.some((row) => BUSY_ROWS.some((p) => p.test(row))) || footerOf(rows, box).some((row) => BUSY_FOOTER.test(row))
}

/** Where the bottom rows start: SCREEN_BOTTOM_ROWS up, or higher, at the top of a box that ends in
 *  them. A dialog is read whole: Gemini CLI's quota dialog is 15 rows for a Google login. A box
 *  whose top went off the screen is read from the screen's top, not from another box above it. */
function bottomStart(rows: readonly string[]): number {
  const start = Math.max(0, rows.length - SCREEN_BOTTOM_ROWS)
  const end = rows.findIndex((row, i) => i >= start && BOX_BOTTOM.test(row))
  for (let top = end - 1; top >= 0 && !BOX_BOTTOM.test(rows[top]); top--) {
    if (BOX_TOP.test(rows[top])) return Math.min(start, top)
  }
  return start
}

/** The row of an agent's input box, or -1. Claude Code's ❯ and agy's > sit right under the box's
 *  top rule (an older Claude Code drew a ╭ box with │ > in it); Codex's › is the lowest such row,
 *  with nothing under it but the rows its text wraps onto and its footer. Their history repeats
 *  each prompt the same way, which is why it is the lowest one. A box taller than the screen starts
 *  at the screen's top (tallBoxRow). */
export function inputBoxRow(rows: readonly string[]): number {
  for (let i = rows.length - 1; i > 0; i--) {
    const row = rows[i]
    // Claude Code puts a no-break space after its ❯, so any space will do.
    const boxed = (/^[❯>](?:\s|$)/.test(row) && RULE.test(rows[i - 1])) || (/^│\s[❯>](?:\s|$)/.test(row) && /^╭/.test(rows[i - 1]))
    if (boxed) return isMenuCursor(rows, i) ? -1 : i
  }
  // Codex's composer: under it only what its text wraps onto, blank rows and its footer, all
  // indented. In its history a prompt has its answer under it, at the start of a row.
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!/^›(?:\s|$)/.test(rows[i])) continue
    if (isMenuCursor(rows, i)) return -1
    return rows.slice(i + 1).every((row) => row === '' || /^\s/.test(row)) ? i : -1
  }
  return tallBoxRow(rows)
}

/** Whether a row that starts like a prompt (› 1. …, > Yes, I trust this folder) is a menu's cursor:
 *  its options under it, indented, run down to the menu's keys (MENU_KEYS), which every CLI draws
 *  under a menu. A task typed into the box can start "1. " too, and was read as a menu: it was never
 *  sent, and the agent read as thinking (GitHub #36). */
export function isMenuCursor(rows: readonly string[], i: number): boolean {
  for (let j = i + 1, blanks = 0; j < rows.length && blanks < 2; j++) {
    if (MENU_KEYS.test(rows[j])) return true
    if (rows[j].trim() === '') blanks++
    else if (!/^\s+[^\s⎿]/.test(rows[j])) return false
  }
  return false
}

/** 0 for Claude Code's box when what is typed into it is taller than the screen, else -1. Its top
 *  rule and ❯ went off the top, and what is left is the text's rows, indented under the ❯, the
 *  closing rule, and the footer under that (agy's box stops growing and Codex's composer scrolls,
 *  so both keep their glyph on screen). Not a dialog: no option and no menu keys under the rule. */
function tallBoxRow(rows: readonly string[]): number {
  let rule = rows.length - 1
  while (rule >= 0 && !RULE.test(rows[rule])) rule--
  if (rule < 1 || !footerFits(rows, rule)) return -1
  const above = rows.slice(0, rule)
  if (!above.some((row) => row.trim() !== '') || !above.every((row) => row === '' || /^\s/.test(row))) return -1
  return rows.slice(rule + 1).some((row) => MENU_KEYS.test(row) || OPTION_ROW.test(row.trimStart())) ? -1 : 0
}

/** Whether the rows under the rule at row `rule` can be Claude Code's footer: FOOTER_ROWS at most, or
 *  any number that ends in its mode row (MODE_ROW). */
function footerFits(rows: readonly string[], rule: number): boolean {
  return rows.length - 1 - rule <= FOOTER_ROWS || rows.slice(-2).some((row) => MODE_ROW.test(row))
}

/** The row of the rule that closes the input box at row `top` (Claude Code, agy), or -1 for one
 *  with none (Codex's composer). */
const closingRule = (rows: readonly string[], top: number): number => rows.findIndex((row, i) => i > top && (RULE.test(row) || BOX_BOTTOM.test(row)))
/** Whether the screen's last row is Codex's footer under a box with no closing rule: Codex draws it
 *  under a blank row. A last row right under the text is the text, wrapped. */
const codexFooter = (rows: readonly string[], top: number): boolean => rows.length - 2 > top && rows[rows.length - 2].trim() === ''

/** The rows an agent's input box takes: from its first row (the screen's top for one taller than
 *  the screen) to its closing rule (Claude Code, agy) or, for a box with none (Codex's composer), to
 *  the screen's end, less Codex's footer; null with no input box. */
export function inputBoxRows(rows: readonly string[]): string[] | null {
  const top = inputBoxRow(rows)
  if (top < 0) return null
  const close = closingRule(rows, top)
  if (close > top) return rows.slice(top, close)
  return rows.slice(top, codexFooter(rows, top) ? rows.length - 1 : rows.length)
}

/** The rows under the input box at row `box`: its footer, under its closing rule, or Codex's. */
function footerOf(rows: readonly string[], box: number): readonly string[] {
  const close = closingRule(rows, box)
  if (close > box) return rows.slice(close + 1)
  return codexFooter(rows, box) ? rows.slice(-1) : []
}

/** Whether the agent's input box is empty, ready for a prompt: its glyph alone, or with the
 *  placeholder the CLI shows until something is typed, on one row at any size. What
 *  write_to_terminal's submit sees go once the text it typed shows. */
export function emptyInputBox(rows: readonly string[]): boolean {
  const box = inputBoxRows(rows)
  if (box === null || box.slice(1).some((row) => row.trim() !== '')) return false
  const shown = box[0].replace(INPUT_GLYPH, '').trim()
  return shown === '' || PLACEHOLDER.test(shown)
}

function busySummary(rows: readonly string[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = STATUS_ROW.exec(rows[i])
    if (m) return m[1].replace(/\s*\([^()]*\besc to \w+[^()]*\)\s*$/, '').slice(0, 120)
  }
  return 'Working...'
}

// ---- Detection helpers ----

function isWaitingForInput(tail: string, agentName: string): boolean {
  // Trust folder prompts. Codex 0.153.4 and agy 1.4.0 ask "Do you trust the contents of this
  // directory?" / "... of this project?" (both seen on real screens).
  if (/do you trust.*files|trust this folder|allow access|do you trust the contents of this/i.test(tail)) return true
  // Auth prompts
  if (/sign in|log in|authenticate|visit.*to sign in|enter.*api.?key/i.test(tail)) return true
  // Interactive questions from agents
  if (/\(y\/n\)|yes\/no|\[Y\/n\]|\[y\/N\]/i.test(tail)) return true
  // Agent-specific prompts
  if (/claude/i.test(agentName) && /Do you want to proceed|Allow|Deny/i.test(tail)) return true
  if (/codex/i.test(agentName) && /press.*to confirm|select.*option/i.test(tail)) return true
  if (/gemini/i.test(agentName) && /\?\s*$/m.test(tail.slice(-200))) return true
  return false
}

// ---- What holds a worker: its plan's usage limit, or a menu (GitHub #36 item 5) ----
//
// Only what a CLI draws in its own rows counts, in each CLI's own layout: in place of its input box
// (a menu, a limit's prompt, a dialog), under the box (Claude Code's footer), Claude Code's status
// line right above it, and the limit message a CLI ends its turn with, the last thing above its box,
// in the cell only that CLI draws there (turnEndLimit). Never the same words elsewhere in the
// transcript, however much they look like the CLI's own message: a worker's answer, and a file, a
// diff or a log it shows, can hold them row for row, and each such reading told the conductor to
// close a healthy worker. Missed, a limit leaves the worker waiting, as 1.53.0 did; read wrongly, it
// closes a worker at work. Either way the report has the conductor look at the screen first.

/** Claude Code 2.1.302's limit messages (claude.exe), at the start of a row, after an indent and its
 *  ⎿: "You've hit your " + session limit, weekly limit, Opus limit, Sonnet limit, Fable limit, usage
 *  limit, limit, monthly spend limit, team's shared budget...; "You've reached your Fable limit.",
 *  "Opus requires usage credits.", "You're out of usage credits" and "... extra usage", "Your org
 *  is out of usage". Not "You've hit your fast limit · resets in 4h 59m": fast mode turns itself
 *  off, and the session goes on. */
const CLAUDE_LIMIT_MESSAGES: readonly RegExp[] = [
  /^[ \t]*(?:⎿[ \t\u00a0]+)?You['’]ve hit your (?!fast limit)[\w'’ ]{0,40}?(?:limit|budget)\b/,
  /^[ \t]*(?:⎿[ \t\u00a0]+)?You['’]ve reached your (?!workspace)[\w ]{1,20}? limit\./,
  /^[ \t]*(?:⎿[ \t\u00a0]+)?(?:Fable|Haiku|Mythos|Opus|Sonnet)(?: [^·\n]{1,40}?)? requires usage credits\./,
  /^[ \t]*(?:⎿[ \t\u00a0]+)?You['’]re out of (?:usage credits|extra usage)\b/,
  /^[ \t]*(?:⎿[ \t\u00a0]+)?Your org is out of usage\b/,
]
/** Claude Code's, and Antigravity 1.4's two, which its footer could show. */
const LIMIT_MESSAGES: readonly RegExp[] = [
  ...CLAUDE_LIMIT_MESSAGES,
  /^[ \t]*You have exhausted your quota on this model\./,
  /^[ \t]*Your AI credits balance is too low to continue\./,
]
/** Claude Code waiting out a limit (claude.exe): "Usage limit reached · continuing automatically at
 *  3pm · esc to cancel", "Usage limit reached again · ...", "Continuing automatically at 3pm · esc to
 *  cancel". On its status line, after its spinner's frame; in its footer, indented. */
const WAITING_STATUS = /^[✢✳✶✻✽·*][ \t]+(?:Usage limit reached(?: again)? · c|C)ontinuing automatically\b/
const WAITING_FOOTER = /^[ \t]*(?:Usage limit reached(?: again)? · c|C)ontinuing automatically\b/
/** When the limit lifts, as the CLI put it: Claude Code's "resets 3pm (America/New_York)",
 *  "continuing automatically at 3pm" and its menu's "continue automatically at 3pm", Gemini CLI's
 *  "Access resets at 5:00 PM.", which a narrow screen can wrap after "resets" or "at", and Codex's
 *  "or try again at 3:04 PM.", read with its rows run together. agy names no time. */
const RESETS_AT = /\bresets\s+(?:at\s+)?([^·│\n]{1,48}?)\.?\s*(?:·|│|$)/m
const CONTINUES_AT = /\bcontinu(?:e|ing) automatically at\s+([^·│\n]{1,48}?)\s*(?:·|│|$)/im
const TRY_AGAIN_AT = /\b[Tt]ry again at (.{1,48}?)\.(?:\s|$)/
/** When the limit lifts, as Claude Code's limit reply words it: "resets 3pm (America/New_York)",
 *  "resets Oct 20, 9am (UTC)". claude.exe 2.1.302 to 2.1.304 put the time zone after every reset
 *  time in the message (zT(time, true)), so the reset ends at its bracket, whatever its su() draws
 *  under the message, in the same column: a note of the server's, "Press ⏎ to continue after reset",
 *  a checkpoint, the hint for the account ("/upgrade to increase your usage limit."), an offer of
 *  usage credits. Their words are the account's and the release's, and some are the server's. The
 *  time, then the zone in its brackets: the system's name for it, which runs to 32 characters
 *  (America/Argentina/ComodRivadavia) and has no space in it. */
const CLAUDE_RESETS_AT = /\bresets ([^()]{1,40})\(([^()]{1,40})\)/

const LIMIT_SUMMARY = 'usage limit reached'
const MENU_SUMMARY = 'waiting on a menu'

const SWITCH_MENU = 'Codex asks whether to switch to a model that uses fewer credits'
const UPDATE_MENU = 'Codex offers to update itself'
/** The menus that hold a worker until someone answers, and which option to pick with which keys,
 *  the cursor on the first option. Termpolis never answers one: the conductor is told to
 *  (swarmStopReports.ts). */
const MENUS: ReadonlyArray<{ summary: string; answer: string }> = [
  { summary: SWITCH_MENU, answer: '"Keep current model" is the second option (Down, then Enter: \\u001b[B\\r)' },
  { summary: UPDATE_MENU, answer: '"Skip until next version" is the third option (Down, Down, then Enter: \\u001b[B\\u001b[B\\r)' },
]
const menuStop = (summary: string): string => `${MENU_SUMMARY}: ${summary}`

/** What stopped a worker: its plan's usage limit, or a menu it waits on; null for anything else.
 *  These are what the swarm tells the conductor about (GitHub #36 item 5). */
export function stopKind(result: AgentStatusResult): 'limit' | 'menu' | null {
  if (result.status !== 'blocked') return null
  if (result.summary.startsWith(LIMIT_SUMMARY)) return 'limit'
  return result.summary.startsWith(MENU_SUMMARY) ? 'menu' : null
}

/** A worker its plan's usage limit stopped, or one waiting on a menu (stopKind). */
export function isLimitOrMenu(result: AgentStatusResult): boolean {
  return stopKind(result) !== null
}

/** Which option to pick on the menu a summary names, and the keys; null for any other summary. */
export function menuAnswer(summary: string): string | null {
  return MENUS.find((m) => summary === `${MENU_SUMMARY}: ${m.summary}`)?.answer ?? null
}

/** "usage limit reached", with when it lifts if `text`, from the limit message on, says. */
function limitSummary(text: string): string {
  const reset = RESETS_AT.exec(text) ?? CONTINUES_AT.exec(text) ?? TRY_AGAIN_AT.exec(text.replace(/\s*\n\s*/g, ' '))
  return reset ? `${LIMIT_SUMMARY} (resets ${reset[1].trim()})` : LIMIT_SUMMARY
}

/** The first of `rows` that starts one of `patterns`, read with the rows under it; null for none. */
function limitIn(rows: readonly string[], patterns: readonly RegExp[]): string | null {
  const at = rows.findIndex((row) => patterns.some((p) => p.test(row)))
  return at < 0 ? null : limitSummary(rows.slice(at).join('\n'))
}

/** A limit in the CLI's own rows around its input box: under its closing rule (Claude Code's
 *  footer), and its status line, which starts with its spinner's frame a few rows above the box's
 *  top rule (a blank row between, and one more where a narrow screen wraps it), where Claude Code
 *  says it waits out a limit. Not the rows of the transcript above. */
function stopAroundBox(rows: readonly string[], box: number): string | null {
  let close = rows.length - 1
  while (close > box && !RULE.test(rows[close]) && !BOX_BOTTOM.test(rows[close])) close--
  const footer = close > box && footerFits(rows, close) ? rows.slice(close + 1) : []
  const fromFooter = limitIn(footer, [...LIMIT_MESSAGES, WAITING_FOOTER])
  if (fromFooter !== null || box < 2 || !RULE.test(rows[box - 1])) return fromFooter
  return limitIn(rows.slice(Math.max(0, box - 4), box - 1), [WAITING_STATUS])
}

// The limit message a CLI ends its turn with when its plan's limit stops it, printed as the last
// thing above its input box, the box back under it (R3-1), each in the cell only that CLI draws:
//  - Codex 0.153.4's error cell (codex.exe), at the start of a row, the rows it wraps onto too: "■
//    You've hit your usage limit. Upgrade to Plus ... or try again at 3:04 PM.", and "■ You've hit
//    your usage limit for gpt-5.6-sol. Switch to another model now, or try again at 4:15 PM.".
//  - Antigravity 1.4's, at the start of a row: "✕ You have exhausted your quota on this model.".
//  - Claude Code 2.1.302's reply to the prompt it stopped, when no rate-limit menu opens (Max 20x, an
//    API key, a Team plan): "  ⎿  You've hit your session limit · resets 3pm" right under the
//    prompt's echo, whose rows are indented under its ❯ (or >). Its ⎿ and the gap after it are
//    MessageResponse's, a space and a no-break space; other rows of its have two spaces (BEH-1: no
//    real reply was read).
// An answer or a tool's output indents what it quotes, or puts its own mark first; a prompt or an
// answer after the message makes it history. Read only with the agent at rest: while it works, the
// echo of the prompt it was just sent can end in anything.
const CODEX_LIMIT_CELL = /^■ You['’]ve hit your usage limit\b/
const AGY_LIMIT_CELL = /^✕ You have exhausted your quota on this model\./
/** A row that starts a cell of its own in an agent's transcript: not the rest of a wrapped one. */
const CELL_START = /^(?:[•■⚠✕›>❯●]|\s*⎿)/
const CLAUDE_REPLY = /^[ \t]+⎿[ \t\u00a0]+\S/

function turnEndLimit(rows: readonly string[], box: number): string | null {
  // The last thing above the box: up past its top rule and the blank rows under the transcript.
  let end = box - 1
  if (end >= 0 && RULE.test(rows[end])) end--
  while (end >= 0 && rows[end].trim() === '') end--
  if (end < 0) return null
  // Up to the blank row above it, or the screen's top: the cell, however many rows a narrow screen
  // wrapped it onto, and its message read with those rows run together.
  let start = end
  while (start > 0 && rows[start - 1].trim() !== '') start--
  const cell = rows.slice(start, end + 1)
  const message = runTogether(cell)
  if ((CODEX_LIMIT_CELL.test(message) || AGY_LIMIT_CELL.test(message)) && !cell.slice(1).some((row) => CELL_START.test(row))) {
    return limitSummary(cell.join('\n'))
  }
  return claudeLimitReply(rows, end)
}

/** Claude Code's limit reply ending on row `end`: its ⎿ row and every row a narrow screen wrapped it
 *  onto, indented under its text, right under the echo of the prompt it stopped. */
function claudeLimitReply(rows: readonly string[], end: number): string | null {
  let at = end
  while (at > 0 && /^\s{4,}[^\s⎿]/.test(rows[at])) at--
  const reply = runTogether(rows.slice(at, end + 1))
  if (!CLAUDE_REPLY.test(rows[at]) || !CLAUDE_LIMIT_MESSAGES.some((p) => p.test(reply))) return null
  // Up through the rows the prompt wraps onto, indented two under its glyph, and its blank lines.
  let up = at - 1
  while (up >= 0 && (rows[up].trim() === '' || /^ {2}[^\s⎿]/.test(rows[up]))) up--
  return up >= 0 && /^[❯>] \S/.test(rows[up]) ? claudeLimitSummary(reply) : null
}

/** "usage limit reached", with when it lifts if Claude Code's limit reply says it as it does
 *  (CLAUDE_RESETS_AT): a reset in any other form, or none, is no time. A zone too long for the row
 *  is broken where the row ends, and read without the break. */
function claudeLimitSummary(reply: string): string {
  const reset = CLAUDE_RESETS_AT.exec(reply)
  return reset ? `${LIMIT_SUMMARY} (resets ${reset[1]}(${reset[2].replace(/\s/g, '')}))` : LIMIT_SUMMARY
}

/** Rows as one line, each run of spaces one space: a message a narrow screen wrapped, read whole. */
function runTogether(rows: readonly string[]): string {
  return rows.join(' ').replace(/\s+/g, ' ')
}

/** What a CLI draws in place of its input box that holds the worker: a menu, a limit's own prompt,
 *  a dialog. Each found by its layout at the bottom of the screen, its title on a row of its own and
 *  the keys that answer it under its options. */
function stopInPlaceOfBox(rows: readonly string[]): string | null {
  return claudeLimitMenu(rows) ?? codexPopup(rows) ?? geminiQuotaDialog(rows)
}

/** The row of a menu's keys (MENU_KEYS) on the screen's last rows, or -1. */
function keysRow(rows: readonly string[]): number {
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 3); i--) if (MENU_KEYS.test(rows[i])) return i
  return -1
}

/** How far above its keys a popup's title can be: its subtitle, options and blank rows between. */
const POPUP_ROWS = 12

/** The row of the title of the popup whose keys are on row `keys`: the nearest row above them that
 *  `title` matches, at most POPUP_ROWS up; -1 for none. */
function titleRow(rows: readonly string[], keys: number, title: RegExp): number {
  for (let i = keys - 1; i >= Math.max(0, keys - POPUP_ROWS); i--) if (title.test(rows[i])) return i
  return -1
}

// Claude Code 2.1.302's /rate-limit-options menu (claude.exe), in place of its input box: a rule,
// "What do you want to do?", its options, "Enter to confirm · Esc to cancel". It is about the limit
// alone: Claude Code opens it by itself when a limit with a reset time stops a session below Max
// 20x (Pro, Max 5x), submitting the command under the limit's message, which then heads the menu,
// the command's echo between them (R2-1). So the menu is the limit, read as a menu, an Esc would
// close it and leave the worker limited, with its task sent again to it. When it lifts: in the limit
// message right above the echo, or in the option "Wait here, then continue automatically at 3pm".
// Its options are the account's, among these.
const CLAUDE_LIMIT_TITLE = /^\s*What do you want to do\?/
const CLAUDE_LIMIT_OPTION = /^\s*(?:❯\s+)?\d+\.\s+(?:Stop and wait for limit to reset|Wait here, then continue automatically|Don['’]t continue automatically|Upgrade your plan|Add funds to continue with|Switch to (?:usage credits|extra usage)|Ask your admin for more usage)/
const CLAUDE_LIMIT_ECHO = /^[❯>] \/rate-limit-options\s*$/

function claudeLimitMenu(rows: readonly string[]): string | null {
  const keys = keysRow(rows)
  const title = keys < 0 ? -1 : titleRow(rows, keys, CLAUDE_LIMIT_TITLE)
  if (title < 1 || !RULE.test(rows[title - 1]) || !rows.slice(title + 1, keys).some((row) => CLAUDE_LIMIT_OPTION.test(row))) return null
  // Above its rule, past blank rows: the command's echo, then the limit message that opened it, on
  // a row or two (a narrow screen wraps it).
  let at = title - 2
  while (at >= 0 && rows[at].trim() === '') at--
  if (at >= 0 && CLAUDE_LIMIT_ECHO.test(rows[at])) at--
  while (at >= 0 && rows[at].trim() === '') at--
  let start = at
  while (start > 0 && at - start < 1 && /^\s{3,}[^\s⎿]/.test(rows[start])) start--
  const message = start < 0 ? null : limitIn([rows.slice(start, at + 1).join('\n')], LIMIT_MESSAGES)
  return message !== null && message !== LIMIT_SUMMARY ? message : limitSummary(rows.slice(title, keys).join('\n'))
}

// Codex 0.153.4's popups in place of its composer (codex.exe): a title on a row of its own, a few
// rows under it, its options with the › cursor on one, and under them its keys. Two are menus: its
// offer of a cheaper model near a limit ("rate-limit-switch-prompt") and its offer to update itself,
// which a real session drew at startup (GitHub #36); a swarm starts Codex with its update check off.
// Two are a workspace's limits ("workspace-usage-nudge").
const CODEX_POPUPS: ReadonlyArray<{ title: RegExp; shows: RegExp; stop: string }> = [
  { title: /^\s*Approaching rate limits\s*$/, shows: /^(?:›|\s)\s?\d+\. Keep current model\b/, stop: menuStop(SWITCH_MENU) },
  { title: /^\s*(?:✨\s*)?Update available! \S+ -> \S+\s*$/, shows: /^(?:›|\s)\s?\d+\. Skip until next version\s*$/, stop: menuStop(UPDATE_MENU) },
  { title: /^\s*You['’]ve reached your workspace credit limit\s*$/, shows: /^\s*Your workspace is out of credits\./, stop: LIMIT_SUMMARY },
  { title: /^\s*Usage limit reached\s*$/, shows: /^\s*Request a limit increase from your owner\b/, stop: LIMIT_SUMMARY },
]
const CODEX_CURSOR = /^›\s?\d+\.\s/

function codexPopup(rows: readonly string[]): string | null {
  const keys = keysRow(rows)
  if (keys < 0) return null
  for (const popup of CODEX_POPUPS) {
    const title = titleRow(rows, keys, popup.title)
    if (title < 0) continue
    // Only its own rows between its title and its keys: indented, but for its cursor.
    const own = rows.slice(title + 1, keys)
    if (!own.every((row) => row === '' || /^\s/.test(row) || CODEX_CURSOR.test(row))) continue
    if (own.some((row) => CODEX_CURSOR.test(row)) && own.some((row) => popup.shows.test(row))) return popup.stop
  }
  return null
}

// Gemini CLI 0.59.0's quota dialog (bundle/interactiveCli-*.js, ProQuotaDialog), in place of its
// input: a round frame at the bottom of the screen, "Usage limit reached for <model>." ("all Pro
// models" for any Pro model), "Access resets at <time>." when it knows, then "/stats model for
// usage details" two rows on at most, however wide or tall the frame is drawn.
const GEMINI_QUOTA = /^│[ \t]+Usage limit reached for (?:all Pro models|\S+)\.[^\n]*\n(?:[^\n]*\n){0,2}?│[ \t]+\/stats model for usage details/m

function geminiQuotaDialog(rows: readonly string[]): string | null {
  let end = rows.length - 1
  while (end >= Math.max(0, rows.length - 3) && !BOX_BOTTOM.test(rows[end])) end--
  let top = end - 1
  while (top >= 0 && !BOX_TOP.test(rows[top])) top--
  if (end < 0 || top < 0 || !BOX_BOTTOM.test(rows[end])) return null
  const dialog = rows.slice(top + 1, end).map((row) => row.trimStart()).join('\n')
  const m = GEMINI_QUOTA.exec(dialog)
  return m ? limitSummary(dialog.slice(m.index)) : null
}

/** A CLI that exited or needs relaunching, in its words, or null. Only a screen without the agent's
 *  input box can show one: a box says the CLI is up. */
function restartSummary(tail: string, agentName: string): string | null {
  // Codex self-update completed — the CLI exits and leaves this banner.
  // Without a restart the terminal is back to a plain shell prompt and
  // will silently ignore every MCP/swarm instruction sent to it.
  if (/update ran successfully.*please restart codex/i.test(tail)) return 'Codex self-updated — needs restart to resume'
  if (/please restart codex/i.test(tail)) return 'Codex needs restart'
  // Claude Code equivalent — it prints this when an in-place upgrade
  // finishes or when the account session has been invalidated.
  if (/claude/i.test(agentName) && /please restart claude|please re-?launch/i.test(tail)) return 'Claude Code needs restart'
  // Gemini CLI rejects every command until auth is provided. The explicit
  // "gemini auth" hint is what the CLI prints when it detects no creds.
  if (/gemini/i.test(agentName) && /gemini\s+auth|run.*gemini auth|not authenticated/i.test(tail)) {
    return 'Gemini CLI not authenticated — run: gemini auth'
  }
  // Any agent: "session expired / please re-authenticate" messages.
  if (/session (?:has )?expired|please (?:re-?)?authenticate/i.test(tail)) return 'Session expired — re-authenticate required'
  // npm/pnpm installed new agent binary behind agent's back — another
  // "you need to restart" signal seen in the wild with auto-update paths.
  if (/restart (?:the )?(?:agent|cli|process) to (?:apply|continue|use)/i.test(tail)) return 'Agent needs restart to apply update'
  return null
}

function isErrored(tail: string): boolean {
  // Fatal/crash errors — not just any "error" word in output
  if (/(?:fatal|panic|unhandled|uncaught).*(?:error|exception)/i.test(tail)) return true
  if (/process.*(?:exit|crash|killed)|segmentation fault|SIGKILL|SIGTERM/i.test(tail)) return true
  if (/token.*(?:limit|exceeded|budget)|context.*(?:limit|exceeded|full)/i.test(tail)) return true
  if (/rate.?limit.*exceeded|429.*too many/i.test(tail)) return true
  if (/ECONNREFUSED|ETIMEDOUT|network.*error/i.test(tail)) return true
  // Windows shell launch failures — the stub-claude.exe case produces this exact
  // wording; the "recognized as an internal or external command" is cmd.exe's
  // version of the same; "cannot find the path" is PowerShell's missing-binary
  // error. Catching these as errored surfaces a clear signal to the dashboard
  // instead of leaving the status stuck at "thinking" or "starting".
  if (/not a valid application for this OS platform/i.test(tail)) return true
  if (/is not recognized as an internal or external command/i.test(tail)) return true
  if (/cannot find the path specified|The system cannot find the (?:file|path)/i.test(tail)) return true
  if (/ApplicationFailedException|NativeCommandFailed/i.test(tail)) return true
  // Claude's own stub shim prints this exact message when the native binary
  // wasn't installed (postinstall skipped or --ignore-scripts).
  if (/claude native binary not installed/i.test(tail)) return true
  if (/command not found.*(?:claude|codex|gemini)/i.test(tail)) return true
  return false
}

function isCompleted(tail: string, _agentName: string): boolean {
  // Agent explicitly signals done
  if (/SWARM COMPLETE|TASK COMPLETE|all tasks.*complet/i.test(tail)) return true
  // Agent returned to prompt after doing work (not just starting)
  if (/(?:completed|finished|done)[.!]?\s*$/im.test(tail.slice(-300))) return true
  return false
}

function isWorking(tail: string): boolean {
  // File operations
  if (/(?:creating|writing|updating|modifying|deleting|reading)\s+(?:file|directory)/i.test(tail)) return true
  if (/(?:wrote|created|updated|modified|deleted)\s+\S+\.\w{1,10}/i.test(tail)) return true
  // Running commands
  if (/(?:running|executing|installing|building|compiling|testing)\b/i.test(tail)) return true
  // Git operations
  if (/git\s+(?:add|commit|push|pull|checkout|merge|rebase)/i.test(tail)) return true
  // npm/package operations
  if (/npm\s+(?:install|run|test|build)|yarn\s+(?:add|install|build)/i.test(tail)) return true
  // Tool use indicators from Claude/Codex
  if (/(?:Read|Write|Edit|Bash|Grep|Glob)\s*\(/i.test(tail.slice(-500))) return true
  return false
}

function isThinking(tail: string, agentName: string): boolean {
  // Claude thinking indicators
  if (/claude/i.test(agentName) && /thinking|analyzing|planning/i.test(tail.slice(-500))) return true
  // Streaming indicators (partial lines, ellipsis)
  if (/\.{3}\s*$|…\s*$/m.test(tail.slice(-200))) return true
  // Active output without a prompt (agent is in the middle of generating)
  const lines = tail.split('\n').filter(l => l.trim().length > 0)
  const lastLine = lines[lines.length - 1] || ''
  // If the last line doesn't look like a prompt and there's recent content, agent is thinking
  if (lastLine.length > 20 && !/[$>#%]\s*$/.test(lastLine) && !/^\s*$/.test(lastLine)) return true
  return false
}

function isIdle(tail: string, agentName: string): boolean {
  const trimmed = tail.trimEnd()
  const lastChars = trimmed.slice(-50)
  // Shell prompt patterns
  if (/[$>#%]\s*$/.test(lastChars)) return true
  // Claude Code prompt (> at start of line)
  if (/claude/i.test(agentName) && /^>\s*$/m.test(trimmed.slice(-100))) return true
  // Codex prompt
  if (/codex/i.test(agentName) && /^>\s*$/m.test(trimmed.slice(-100))) return true
  return false
}

function isStarting(tail: string, previousStatus: AgentStatus): boolean {
  // Only stay in starting if we were starting and haven't seen much output
  if (previousStatus !== 'starting') return false
  if (tail.trim().length < 100) return true
  // Still loading
  if (/loading|initializing|connecting|starting|resolving/i.test(tail.slice(-500))) return true
  // Agent version output (still in startup phase)
  if (/version\s+\d+\.\d+/i.test(tail) && tail.trim().length < 500) return true
  return false
}

// ---- Summary extractors ----

function extractInputPrompt(tail: string, _agentName: string): string {
  // Find the last question or prompt in the output
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim()
    if (/\?|trust|sign in|log in|allow|confirm|y\/n/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Agent needs input'
}

function extractErrorSummary(tail: string): string {
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const line = lines[i].trim()
    if (/error|fatal|panic|fail|crash|limit|exceeded|refused/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Agent encountered an error'
}

function extractCompletionSummary(tail: string): string {
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim()
    if (/complete|finished|done|success/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Task completed'
}

function extractWorkSummary(tail: string): string {
  const lines = tail.split('\n').filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim()
    if (/(?:creat|writ|updat|modif|delet|read|running|executing|install|build|compil|test|git |npm |yarn )/i.test(line)) {
      return line.slice(0, 120)
    }
  }
  return 'Working...'
}
