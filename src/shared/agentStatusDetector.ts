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

function detectInText(tail: string, agentName: string, previousStatus: AgentStatus): AgentStatusResult {
  // --- Priority 1: Blocked — agent is dead/stalled, needs restart ---
  // Must outrank waiting_for_input: a "please re-authenticate" or
  // "gemini auth"-hint message contains auth keywords but the agent
  // process isn't actually alive to receive terminal input — the user
  // has to relaunch the CLI. Also precedes isIdle for the same reason.
  if (isBlocked(tail, agentName)) {
    const summary = extractBlockedSummary(tail, agentName)
    return { status: 'blocked', summary }
  }

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
const OPTION_ROW = /^(?:│\s)?[❯>›]\s?\d+\.\s/
/** A status line led by a spinner frame or a bullet: Claude Code's "✢ Doing…", agy's "⡿ Generating...",
 *  Codex's "• Working (31s • esc to interrupt)". */
const STATUS_ROW = /^\s*(?:[\u2800-\u28ff]|[✢✳✶✻✽*·•◦])\s+(\S.*)$/

function detectOnScreen(screen: string, agentName: string, previousStatus: AgentStatus, title: string): AgentStatusResult {
  const rows = screen.split('\n')
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  const bottom = rows.slice(-SCREEN_BOTTOM_ROWS)
  const text = bottom.join('\n')
  // An input box says the CLI is up and taking input, whatever its history above says about an
  // expired session or a restart: those words are a worker's answer or a file it showed.
  const atPrompt = inputBoxRow(bottom) >= 0
  if (isBlocked(text, agentName, atPrompt)) return { status: 'blocked', summary: extractBlockedSummary(text, agentName) }
  if (BUSY_TITLE.test(title) || BUSY_ON_SCREEN.some((p) => p.test(text))) {
    return { status: 'working', summary: busySummary(bottom) }
  }
  if (atPrompt) return { status: 'idle', summary: 'Waiting at prompt' }
  // Not one of the three agents' screens (a shell, a dialog): read it as text.
  return detectInText(text, agentName, previousStatus)
}

/** The row of an agent's input box, or -1. Claude Code's ❯ and agy's > sit right under the box's
 *  top rule (an older Claude Code drew a ╭ box with │ > in it); Codex's › is the last such row, at
 *  the bottom. Their history repeats each prompt the same way, which is why it is the lowest one. */
export function inputBoxRow(rows: readonly string[]): number {
  for (let i = rows.length - 1; i > 0; i--) {
    const row = rows[i]
    // Claude Code puts a no-break space after its ❯, so any space will do.
    const boxed = (/^[❯>](?:\s|$)/.test(row) && RULE.test(rows[i - 1])) || (/^│\s[❯>](?:\s|$)/.test(row) && /^╭/.test(rows[i - 1]))
    if (boxed) return OPTION_ROW.test(row) ? -1 : i
  }
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 6); i--) {
    if (/^›(?:\s|$)/.test(rows[i])) return OPTION_ROW.test(rows[i]) ? -1 : i
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
// the CLI that prints them: a loose keyword is how "done" on a worker's screen came to end a swarm
// (item 3). And only where the CLI puts it: at the start of a row, after nothing but an indent and
// the CLI's own mark (Claude Code's ⎿ and its status line's spinner frame, Codex's ■, agy's and
// Gemini CLI's ✕, the frame of Gemini CLI's dialog), with the words the CLI follows it with. A
// worker's answer, a diff, a log line, a grep hit or a message bridged from another worker that
// mentions a limit has other words first, a list's or a table's mark, or goes on with words of
// its own ("you've hit your rate limit at 5,000 requests"), and is no limit; that includes the
// phrase quoted in code or prose. Sources:
//  - Claude Code 2.1.302 (its claude.exe): "You've hit your " + session limit, weekly limit, Opus
//    limit, Sonnet limit, Fable limit, usage limit, limit, monthly spend limit, team's shared
//    budget..., then " · resets 3pm (America/New_York)", or "."; its status line "Usage limit
//    reached · continuing automatically..."; "You're out of usage credits", "You're out of extra
//    usage", "Your org is out of usage · add funds to continue". Not "You've hit your fast limit ·
//    resets in 4h 59m": fast mode turns itself off, and the session goes on.
//  - Codex 0.153.4 (codex.exe): "You've hit your usage limit. Upgrade to Plus to continue using Codex
//    (https://chatgpt.com/explore/plus), or try again at 3:04 PM.", "You've hit your usage limit
//    for <model>. Switch to another model now, ..."; for a workspace "Your workspace is out of
//    credits.", "You hit your spend cap set in your workspace.", "You've reached your workspace
//    credit limit", "Request a limit increase from your owner to continue using codex."
//  - Antigravity CLI 1.4.0 (agy.exe): "You have exhausted your quota on this model.", "Your AI
//    credits balance is too low to continue."
//  - Gemini CLI 0.59.0 (bundle/interactiveCli-*.js): "Usage limit reached for <model>.", then
//    "Access resets at <time>." when it knows, then always "/stats model for usage details", in
//    its quota dialog and in its history alike.
const ROW_START = String.raw`^[ \t]*(?:[⎿■✕✗⚠][ \t]+)?`
/** Claude Code's status line: its spinner's frame first, which can be a · or a *. */
const STATUS_ROW_START = String.raw`^[ \t]*(?:[✢✳✶✻✽·*][ \t]+)?`
/** Gemini CLI's quota dialog, inside its frame, or the same lines in its history. */
const DIALOG_ROW_START = String.raw`^[ \t]*(?:[✕│][ \t]+)?`
const USAGE_LIMIT: readonly RegExp[] = [
  new RegExp(`${ROW_START}You['’]ve hit your (?!fast limit)[\\w'’ ]{0,40}?(?:limit|budget)(?: for [\\w.-]+?)?(?:\\.(?:\\s|$)|\\s+·|\\s*$)`, 'gm'),
  new RegExp(`${STATUS_ROW_START}Usage limit reached(?: again)? · `, 'gm'),
  // Its "/stats model for usage details" two rows on at most, however wide the dialog's rows are.
  new RegExp(`${DIALOG_ROW_START}Usage limit reached for \\S+\\.[^\\n]*\\n(?:[^\\n]*\\n){0,2}?[^\\n]*/stats model for usage details`, 'gm'),
  new RegExp(`${ROW_START}You['’]re out of (?:usage credits|extra usage)\\b`, 'gm'),
  new RegExp(`${ROW_START}Your org is out of usage\\b`, 'gm'),
  new RegExp(`${ROW_START}Your workspace is out of credits\\.`, 'gm'),
  new RegExp(`${ROW_START}You hit your spend cap set (?:in|by the owner of) your workspace\\.`, 'gm'),
  new RegExp(`${ROW_START}You['’]ve reached your workspace credit limit\\b`, 'gm'),
  new RegExp(`${ROW_START}Request a limit increase from your owner to continue using codex\\.`, 'gm'),
  new RegExp(`${ROW_START}You have exhausted your quota on this model\\.`, 'gm'),
  new RegExp(`${ROW_START}Your AI credits balance is too low to continue\\.`, 'gm'),
]
/** When the limit lifts, as the CLI put it: Claude Code's "resets 3pm (America/New_York)", Gemini
 *  CLI's "Access resets at 5:00 PM.", on the limit's own row or its dialog's next one; Codex's "or
 *  try again at 3:04 PM.", which a narrow screen wraps. agy names no time. */
const RESETS_AT = /\bresets (?:at )?([^·│\n]{1,48}?)\.?\s*(?:·|│|$)/m
const TRY_AGAIN_AT = /\btry again at (.{1,48}?)\.(?:\s|$)/

// Menus that hold a worker until someone answers: Termpolis never picks a numbered option.
//  - Codex 0.153.4's rate-limit prompt (codex.exe): "Approaching rate limits", "Switch to <model>
//    for lower credit usage?", "Keep current model".
//  - Codex's update offer, as it drew it at startup in a real session (GitHub #36): "✨ Update
//    available! 0.153.4 -> 0.163.0", "› 1. Update now (runs `npm install -g @openai/codex`)",
//    "2. Skip", "3. Skip until next version".
const MENUS: ReadonlyArray<{ pattern: RegExp; summary: string }> = [
  { pattern: /Approaching rate limits[\s\S]*Keep current model/, summary: 'Codex asks whether to switch to a model that uses fewer credits' },
  { pattern: /Update available! \S+ -> \S+[\s\S]*Skip until next version/, summary: 'Codex offers to update itself' },
]

const LIMIT_SUMMARY = 'usage limit reached'
const MENU_SUMMARY = 'waiting on a menu'

/** A worker its plan's usage limit stopped, or one waiting on a menu: what the swarm tells the
 *  conductor about, so it can give the task to another agent (GitHub #36 item 5). */
export function isLimitOrMenu(result: AgentStatusResult): boolean {
  return result.status === 'blocked' && (result.summary.startsWith(LIMIT_SUMMARY) || result.summary.startsWith(MENU_SUMMARY))
}

function limitSummary(tail: string): string | null {
  let at = -1
  for (const p of USAGE_LIMIT) {
    for (const m of tail.matchAll(p)) at = Math.max(at, m.index!)
  }
  if (at < 0) return null
  // The latest limit message, and the reset time that follows it.
  const after = tail.slice(at)
  const reset = RESETS_AT.exec(after) ?? TRY_AGAIN_AT.exec(after.replace(/\s*\n\s*/g, ' '))
  return reset ? `${LIMIT_SUMMARY} (resets ${reset[1].trim()})` : LIMIT_SUMMARY
}

function menuSummary(tail: string): string | null {
  const menu = MENUS.find((m) => m.pattern.test(tail))
  return menu ? `${MENU_SUMMARY}: ${menu.summary}` : null
}

/** `alive`: the screen shows the agent's input box, so the CLI is running, and only a limit or a
 *  menu can be holding it. The rest say the CLI exited or needs relaunching. */
function isBlocked(tail: string, agentName: string, alive = false): boolean {
  if (limitSummary(tail) !== null || menuSummary(tail) !== null) return true
  if (alive) return false
  // Codex self-update completed — the CLI exits and leaves this banner.
  // Without a restart the terminal is back to a plain shell prompt and
  // will silently ignore every MCP/swarm instruction sent to it.
  if (/update ran successfully.*please restart codex/i.test(tail)) return true
  if (/please restart codex/i.test(tail)) return true
  // Claude Code equivalent — it prints this when an in-place upgrade
  // finishes or when the account session has been invalidated.
  if (/claude/i.test(agentName) && /please restart claude|please re-?launch/i.test(tail)) return true
  // Gemini CLI rejects every command until auth is provided. The explicit
  // "gemini auth" hint is what the CLI prints when it detects no creds.
  if (/gemini/i.test(agentName) && /gemini\s+auth|run.*gemini auth|not authenticated/i.test(tail)) return true
  // Any agent: "session expired / please re-authenticate" messages.
  if (/session (?:has )?expired|please (?:re-?)?authenticate/i.test(tail)) return true
  // npm/pnpm installed new agent binary behind agent's back — another
  // "you need to restart" signal seen in the wild with auto-update paths.
  if (/restart (?:the )?(?:agent|cli|process) to (?:apply|continue|use)/i.test(tail)) return true
  return false
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

function extractBlockedSummary(tail: string, agentName: string): string {
  const stopped = limitSummary(tail) ?? menuSummary(tail)
  if (stopped !== null) return stopped
  if (/update ran successfully.*please restart codex/i.test(tail)) {
    return 'Codex self-updated — needs restart to resume'
  }
  if (/please restart codex/i.test(tail)) return 'Codex needs restart'
  if (/claude/i.test(agentName) && /please restart claude|please re-?launch/i.test(tail)) {
    return 'Claude Code needs restart'
  }
  if (/gemini/i.test(agentName) && /gemini\s+auth|run.*gemini auth|not authenticated/i.test(tail)) {
    return 'Gemini CLI not authenticated — run: gemini auth'
  }
  if (/session (?:has )?expired|please (?:re-?)?authenticate/i.test(tail)) {
    return 'Session expired — re-authenticate required'
  }
  if (/restart (?:the )?(?:agent|cli|process) to (?:apply|continue|use)/i.test(tail)) {
    return 'Agent needs restart to apply update'
  }
  return 'Agent blocked — manual intervention required'
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
