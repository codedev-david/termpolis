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

/** `stops`: false when a screen was read for what holds the agent already (detectOnScreen). */
function detectInText(tail: string, agentName: string, previousStatus: AgentStatus, stops = true): AgentStatusResult {
  // --- Priority 1: Blocked — agent is dead/stalled, needs restart ---
  // Must outrank waiting_for_input: a "please re-authenticate" or
  // "gemini auth"-hint message contains auth keywords but the agent
  // process isn't actually alive to receive terminal input — the user
  // has to relaunch the CLI. Also precedes isIdle for the same reason.
  const stopped = stops ? stopSummary(tail, agentName) : null
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
/** A window title led by a spinner: Claude Code's ◐◓◑◒ and Codex's braille frames, redrawn while
 *  they work, so the title is current even after their footer has left the buffer. */
const BUSY_TITLE = /^[\u2800-\u28ff\u25d0-\u25d3]/
const RULE = /^[─━]{20,}$/
/** A menu's cursor on a numbered option ("› 1. Update now", "❯ 1. Yes"): no input box. */
export const OPTION_ROW = /^(?:│\s)?[❯>›]\s?\d+\.\s/
/** A status line led by a spinner frame or a bullet: Claude Code's "✢ Doing…", agy's "⡿ Generating...",
 *  Codex's "• Working (31s • esc to interrupt)". */
const STATUS_ROW = /^\s*(?:[\u2800-\u28ff]|[✢✳✶✻✽*·•◦])\s+(\S.*)$/
/** A box's corners, as Gemini CLI's dialogs and Codex's header draw them. */
const BOX_TOP = /^\s*╭/
const BOX_BOTTOM = /^\s*╰/
/** A row that starts something new in an agent's transcript: an answer or a tool call (Claude Code's
 *  ●, Codex's •, Gemini CLI's ✦), or a prompt it was sent. */
const ITEM_ROW = /^(?:[●⏺•✦]|[❯›>](?:\s|$))/

function detectOnScreen(screen: string, agentName: string, previousStatus: AgentStatus, title: string): AgentStatusResult {
  const rows = screen.split('\n')
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  // Over the whole screen: a long prompt typed into the box makes it taller than the bottom rows.
  const box = inputBoxRow(rows)
  const from = bottomStart(rows)
  const bottom = rows.slice(from)
  const text = bottom.join('\n')
  const busy = BUSY_TITLE.test(title) || BUSY_ON_SCREEN.some((p) => p.test(text))
  const stopped = stopOnScreen(rows, from, box, busy, text)
  if (stopped !== null) return { status: 'blocked', summary: stopped }
  // An input box says the CLI is up and taking input, whatever its history above says about an
  // expired session or a restart: those words are a worker's answer or a file it showed.
  const restart = box < 0 ? restartSummary(text, agentName) : null
  if (restart !== null) return { status: 'blocked', summary: restart }
  if (busy) return { status: 'working', summary: busySummary(bottom) }
  if (box >= 0) return { status: 'idle', summary: 'Waiting at prompt' }
  // Not one of the three agents' screens (a shell, a dialog): read it as text.
  return detectInText(text, agentName, previousStatus, false)
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

/** What holds the agent, read off its screen: a usage limit or a menu, or null. In its transcript,
 *  the rows down to its input box, a limit is the agent's only as what it shows last (shownLast), and
 *  while it works only its status line says it waits on one; under the box's closing rule every row
 *  is the CLI's own. `text` is the bottom rows, from `from` on. */
function stopOnScreen(rows: readonly string[], from: number, box: number, busy: boolean, text: string): string | null {
  const transcript = rows.slice(from, box < 0 ? rows.length : Math.max(box, from))
  const closing = box < 0 ? -1 : rows.findIndex((row, i) => i > box && (RULE.test(row) || BOX_BOTTOM.test(row)))
  const footer = closing < 0 ? [] : rows.slice(Math.max(closing + 1, from))
  return limitSummary(footer.join('\n'), ANY_ROW_LIMITS)
    ?? limitSummary(transcript.join('\n'), busy ? TRANSCRIPT_WAITS : TRANSCRIPT_LIMITS, (row) => shownLast(transcript, row))
    ?? menuSummary(text)
}

/** Whether nothing new starts in the transcript after its row `row`: a CLI's limit message ends its
 *  turn. One with an answer, a tool call or a prompt after it is history (the agent went on), or is
 *  in a file or a log the agent showed. */
function shownLast(transcript: readonly string[], row: number): boolean {
  return !transcript.slice(row + 1).some((r) => ITEM_ROW.test(r))
}

/** The row of an agent's input box, or -1. Claude Code's ❯ and agy's > sit right under the box's
 *  top rule (an older Claude Code drew a ╭ box with │ > in it); Codex's › is the lowest such row,
 *  with nothing under it but the rows its text wraps onto and its footer. Their history repeats
 *  each prompt the same way, which is why it is the lowest one. */
export function inputBoxRow(rows: readonly string[]): number {
  for (let i = rows.length - 1; i > 0; i--) {
    const row = rows[i]
    // Claude Code puts a no-break space after its ❯, so any space will do.
    const boxed = (/^[❯>](?:\s|$)/.test(row) && RULE.test(rows[i - 1])) || (/^│\s[❯>](?:\s|$)/.test(row) && /^╭/.test(rows[i - 1]))
    if (boxed) return OPTION_ROW.test(row) ? -1 : i
  }
  // Codex's composer: under it only what its text wraps onto, blank rows and its footer, all
  // indented. In its history a prompt has its answer under it, at the start of a row.
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!/^›(?:\s|$)/.test(rows[i])) continue
    if (OPTION_ROW.test(rows[i])) return -1
    return rows.slice(i + 1).every((row) => row === '' || /^\s/.test(row)) ? i : -1
  }
  return -1
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

// A plan's usage limit, in each CLI's own words (GitHub #36 item 5). Full phrases only, copied from
// the CLI that prints them, each with the words the CLI goes on with: a loose keyword is how "done"
// on a worker's screen came to end a swarm (item 3). And only where the CLI puts it: at the start of
// a row, or after the CLI's own mark (Claude Code's ⎿ and its status line's spinner frame, Codex's ■,
// agy's and Gemini CLI's ✕, the frame of Gemini CLI's dialog). The three agents indent the rows of
// an answer and of a file or a log they show, and a worker's sentence that starts like a limit goes
// on with words of its own ("you've hit your rate limit at 5,000 requests"); the phrase quoted in
// code or prose has other words first, or a list's or a table's mark. Sources:
//  - Claude Code 2.1.302 (its claude.exe): "You've hit your " + session limit, weekly limit, Opus
//    limit, Sonnet limit, Fable limit, usage limit, limit, monthly spend limit, team's shared
//    budget..., then " · resets 3pm (America/New_York)" or nothing, or a sentence of what to do:
//    ". Switch to another model to continue.", ". Run /usage-credits ...", ". /model to switch
//    models."; its monthly spend limit alone, with what to do on the row under it; "You've reached
//    your Fable limit." and "Opus requires usage credits." with those sentences; its status line
//    "Usage limit reached · continuing automatically..."; "You're out of usage credits" and "You're
//    out of extra usage", as "You've hit your"; "Your org is out of usage · add funds to continue".
//    Not "You've hit your fast limit · resets in 4h 59m": fast mode turns itself off, and the
//    session goes on.
//  - Codex 0.153.4 (codex.exe): "You've hit your usage limit." then "Upgrade to Plus to continue
//    using Codex (https://chatgpt.com/explore/plus), or try again at 3:04 PM.", "Upgrade to Pro
//    ...", "Visit https://chatgpt.com/codex/settings/usage ...", "To get more access now, send a
//    request to your admin ..." or "Try again at 3:04 PM."; "You've hit your usage limit for
//    <model>. Switch to another model now, ..."; "You've reached your usage limit. Increase your
//    limits to continue using codex."; for a workspace "Your workspace is out of credits. Ask your
//    workspace owner ...", "You hit your spend cap set in your workspace.", "You've reached your
//    workspace credit limit", "Request a limit increase from your owner to continue using codex."
//  - Antigravity CLI 1.4.0 (agy.exe): "You have exhausted your quota on this model.", "Your AI
//    credits balance is too low to continue."
//  - Gemini CLI 0.59.0 (bundle/interactiveCli-*.js): "Usage limit reached for <model>.", which is
//    "all Pro models" for any Pro model, then "Access resets at <time>." when it knows, then always
//    "/stats model for usage details", in its quota dialog and in its history alike.
/** Where a limit message starts in an agent's transcript: at the start of a row, or after the CLI's
 *  own mark, however far that is indented. An indent alone is an answer, a file or a log. */
const TRANSCRIPT_ROW = String.raw`^(?:[ \t]*[⎿■✕✗⚠][ \t]+)?`
/** Under an agent's input box, where every row is the CLI's own, and in a raw tail, whose rows'
 *  starts can't be told apart: after an indent too. */
const ANY_ROW = String.raw`^[ \t]*(?:[⎿■✕✗⚠][ \t]+)?`
/** Claude Code's status line: its spinner's frame first, which can be a · or a *. */
const TRANSCRIPT_STATUS_ROW = String.raw`^(?:[✢✳✶✻✽·*][ \t]+)?`
const ANY_STATUS_ROW = String.raw`^[ \t]*(?:[✢✳✶✻✽·*][ \t]+)?`
/** Gemini CLI's quota dialog, inside its frame, or the same lines in its history. */
const DIALOG_ROW_START = String.raw`^[ \t]*(?:[✕│][ \t]+)?`
/** What the CLIs go on with after a limit's sentence: Claude Code's and Codex's next sentence. */
const GOES_ON = String.raw`Switch to another model|Run /usage-credits|/model to switch models|Upgrade to (?:Plus|Pro)\b|Visit https?://|To get more access now|Try again (?:at|later)\b`

/** The messages a CLI stops with, each where it starts a row (`row`). */
function limitMessages(row: string): RegExp[] {
  // Claude Code's " · resets ...", the message alone on its row, or a sentence of what to do.
  const after = String.raw`(?:\s+·\s|[ \t]*$|\.\s+(?:${GOES_ON}))`
  return [
    new RegExp(`${row}You['’]ve hit your (?!fast limit)[\\w'’ ]{0,40}?(?:limit|budget)(?: for [\\w.-]+?)?${after}`, 'gm'),
    new RegExp(`${row}You['’]ve hit your (?:channel['’]s )?monthly spend limit\\.[ \\t]*$`, 'gm'),
    new RegExp(`${row}You['’]ve reached your (?!workspace)[\\w ]{1,20}? limit\\.\\s+(?:${GOES_ON}|Increase your limits)`, 'gm'),
    new RegExp(`${row}(?:Fable|Haiku|Mythos|Opus|Sonnet)(?: [^·\\n]{1,40}?)? requires usage credits\\.\\s+(?:${GOES_ON})`, 'gm'),
    new RegExp(`${row}You['’]re out of (?:usage credits|extra usage)${after}`, 'gm'),
    new RegExp(`${row}Your org is out of usage\\s+·\\s`, 'gm'),
    new RegExp(`${row}Your workspace is out of credits\\.\\s+(?:Ask your workspace owner|Add credits)`, 'gm'),
    new RegExp(`${row}You hit your spend cap set (?:in|by the owner of) your workspace\\.`, 'gm'),
    new RegExp(`${row}You['’]ve reached your workspace credit limit\\b`, 'gm'),
    new RegExp(`${row}Request a limit increase from your owner to continue using codex\\.`, 'gm'),
    new RegExp(`${row}You have exhausted your quota on this model\\.`, 'gm'),
    new RegExp(`${row}Your AI credits balance is too low to continue\\.`, 'gm'),
  ]
}

/** A CLI waiting on a limit, which it shows while it works: Claude Code's status line, and Gemini
 *  CLI's dialog, its "/stats model for usage details" two rows on at most, however wide its rows. */
function limitWaits(statusRow: string): RegExp[] {
  return [
    new RegExp(`${statusRow}Usage limit reached(?: again)? · `, 'gm'),
    new RegExp(`${DIALOG_ROW_START}Usage limit reached for (?:all Pro models|\\S+)\\.[^\\n]*\\n(?:[^\\n]*\\n){0,2}?[^\\n]*/stats model for usage details`, 'gm'),
  ]
}

const TRANSCRIPT_WAITS = limitWaits(TRANSCRIPT_STATUS_ROW)
const TRANSCRIPT_LIMITS = [...limitMessages(TRANSCRIPT_ROW), ...TRANSCRIPT_WAITS]
const ANY_ROW_LIMITS = [...limitMessages(ANY_ROW), ...limitWaits(ANY_STATUS_ROW)]
/** When the limit lifts, as the CLI put it: Claude Code's "resets 3pm (America/New_York)", Gemini
 *  CLI's "Access resets at 5:00 PM.", on the limit's own row or its dialog's next one; Codex's "or
 *  try again at 3:04 PM." or "Try again at 3:04 PM.", which a narrow screen wraps. agy names no time. */
const RESETS_AT = /\bresets (?:at )?([^·│\n]{1,48}?)\.?\s*(?:·|│|$)/m
const TRY_AGAIN_AT = /\b[Tt]ry again at (.{1,48}?)\.(?:\s|$)/

// Menus that hold a worker until someone answers. Termpolis never picks an option: the conductor
// is told which one to (swarmStopReports.ts), and with which keys, the cursor on the first option.
//  - Codex 0.153.4's rate-limit prompt (codex.exe): "Approaching rate limits", "Switch to <model>
//    for lower credit usage?", "› 1. Switch to <model>", "2. Keep current model".
//  - Codex's update offer, as it drew it at startup in a real session (GitHub #36): "✨ Update
//    available! 0.153.4 -> 0.163.0", "› 1. Update now (runs `npm install -g @openai/codex`)",
//    "2. Skip", "3. Skip until next version". A swarm starts Codex with its update check off.
const MENUS: ReadonlyArray<{ pattern: RegExp; summary: string; answer: string }> = [
  {
    pattern: /Approaching rate limits[\s\S]*Keep current model/,
    summary: 'Codex asks whether to switch to a model that uses fewer credits',
    answer: '"Keep current model" is the second option (Down, then Enter: \\u001b[B\\r)',
  },
  {
    pattern: /Update available! \S+ -> \S+[\s\S]*Skip until next version/,
    summary: 'Codex offers to update itself',
    answer: '"Skip until next version" is the third option (Down, Down, then Enter: \\u001b[B\\u001b[B\\r)',
  },
]

const LIMIT_SUMMARY = 'usage limit reached'
const MENU_SUMMARY = 'waiting on a menu'

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

/** The latest limit message in `text` that `shown` takes for the agent's, and when it lifts. */
function limitSummary(text: string, patterns: readonly RegExp[], shown: (row: number) => boolean = () => true): string | null {
  let at = -1
  for (const p of patterns) {
    for (const m of text.matchAll(p)) {
      if (shown(text.slice(0, m.index).split('\n').length - 1)) at = Math.max(at, m.index!)
    }
  }
  if (at < 0) return null
  // The latest limit message, and the reset time that follows it.
  const after = text.slice(at)
  const reset = RESETS_AT.exec(after) ?? TRY_AGAIN_AT.exec(after.replace(/\s*\n\s*/g, ' '))
  return reset ? `${LIMIT_SUMMARY} (resets ${reset[1].trim()})` : LIMIT_SUMMARY
}

function menuSummary(tail: string): string | null {
  const menu = MENUS.find((m) => m.pattern.test(tail))
  return menu ? `${MENU_SUMMARY}: ${menu.summary}` : null
}

/** What holds the agent, read off a raw tail: a usage limit, a menu, or a CLI that exited or needs
 *  relaunching (restartSummary); null for none. */
function stopSummary(tail: string, agentName: string): string | null {
  return limitSummary(tail, ANY_ROW_LIMITS) ?? menuSummary(tail) ?? restartSummary(tail, agentName)
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
