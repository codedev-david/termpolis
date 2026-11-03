// Moving a running agent to another account, the pure parts: shared by main, which runs the switch
// (src/main/accountSwitch.ts), and the renderer, which asks for it and shows it. What each CLI
// prints when it exits, the commands that exit and resume it, what its screens say after a
// relaunch, and what a line typed by hand says about the terminal's account.
//
// Every rule here reads what a CLI draws itself, at the bottom of its own screen, or what
// Termpolis typed: never text an agent's answer could hold, which can quote any of it.
import type { AccountAgent, ShellFamily } from './agentAccounts'
import { agentCommandIn, carryLaunchArgs, isPlainLaunchWord, modelOfCommand, providerForCommand, withoutInjected } from './launchCarry'
import type { LaunchProvider } from './launchCarry'

/** The id Claude Code, Codex and agy give a session: a UUID (Codex's are version 7). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID.test(v)
}

/** A model name Termpolis puts on a command line: Claude Code's aliases, Codex's ids. */
export function isSafeModelName(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._[\]-]{1,64}$/.test(v)
}

/** The command each agent exits with. It is typed into the agent's own input box and entered only
 *  once the box shows it, so no key is ever left over for the shell: a key would do the same, one
 *  press too many. Codex 0.153.4 exits on a single Ctrl+C at an idle composer (probe), so the
 *  Ctrl+D that used to follow it reached the shell, where it is EOF and closes a bash terminal; agy
 *  exits on two presses of Ctrl+D or Ctrl+C, and its first Ctrl+C stops a running turn. Each CLI
 *  lists its command: Claude Code's /exit, Codex's /quit ("exit Codex"), agy's /exit ("Exit:
 *  Ctrl+D Ctrl+D (or /exit or /quit)"). Typed at a shell by mistake, it is an unknown command. */
export const EXIT_COMMAND: Readonly<Record<AccountAgent, string>> = { claude: '/exit', codex: '/quit', agy: '/exit' }

/** Ctrl+U: deletes what an agent's input box holds back from its cursor, in Claude Code, Codex and
 *  agy, and sends nothing (write_to_terminal's submit clears a box with the same keys). Twenty to a
 *  write: eighty read to Claude Code as a paste. At a shell's prompt it clears the line. */
export const CLEAR_BOX_KEYS = '\u0015'.repeat(20)

/** What clears a shell's line before Termpolis types on it (R7): Ctrl+E then Ctrl+U in bash, zsh and fish (Ctrl+U kills
 *  only what is left of the cursor, so the end of the line comes first: text a user left to its right would run with the
 *  Enter), Esc in PowerShell (PSReadLine's RevertLine) and cmd. Whatever was left there (a conductor's text, the phone,
 *  keys typed during the switch) would otherwise run with the Enter. */
export const LINE_CLEAR: Readonly<Record<ShellFamily, string>> = { posix: '\u0005\u0015', powershell: '\u001b', cmd: '\u001b' }

export interface ExitHint {
  /** The session the hint names, or null for one it names none of: Claude Code's `claude --resume`
   *  alone, Codex's `Session ID:` for a session with no turns (nothing to resume). */
  id: string | null
  /** Claude Code in a worktree: its `--worktree "<name>"` (or `-w`), as printed. Resuming from the
   *  main folder wouldn't find the transcript. */
  worktree?: string
  /** Where the hint starts, as a row of the screen it was read from. */
  row: number
}

/** How far from the screen's foot an exit hint can start and still be the last thing the agent
 *  printed: the hint, the blank rows around it, and a shell's prompt of two or three rows under it,
 *  with a few prompts more (a sacrificial Enter, one typed by the user). */
export const HINT_FROM_FOOT_ROWS = 14

/** A worktree name Termpolis types back as Claude Code printed it, inside its double quotes. */
const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,64}$/

const CLAUDE_HINT_HEAD = /^\s*Resume this session with:\s*$/
const CLAUDE_HINT_COMMAND = /^\s*claude(?:\s+(?:--worktree|-w)\s+"([^"]*)")?\s+(?:--resume|-r)(?:\s+(\S+))?\s*$/
const CODEX_HINT_HEAD = /To continue this session, run/
const CODEX_HINT_COMMAND = /\bcodex\s+resume\s+(\S+)/
const CODEX_SESSION_ROW = /^\s*Session ID:\s*(\S+)\s*$/
const AGY_HINT_HEAD = /^\s*Resume with -c \(or command below\):\s*$/
const AGY_HINT_COMMAND = /^\s*agy\s+--conversation=(\S+)\s*$/

/** The next row under `from` that holds something, or -1. */
function nextFilled(rows: readonly string[], from: number): number {
  for (let i = from + 1; i < rows.length; i++) if (rows[i].trim() !== '') return i
  return -1
}

/**
 * The exit hint `agent` printed last, from the rows of its screen (the screen as drawn), when it
 * starts within HINT_FROM_FOOT_ROWS of the foot; null for none. Each CLI prints its own when it
 * exits:
 *
 *   Claude Code  Resume this session with:      Codex  To continue this session, run:
 *                claude --resume <id>                  codex resume <id>
 *                (claude --worktree "<w>" --resume <id>, or -w … -r …, in a worktree)
 *                                                      (a session with no turns: Session ID: <id>)
 *   agy          Resume with -c (or command below):
 *                agy --conversation=<id>
 *
 * An id that is not a UUID is no id: it would go on a command line. A hint is evidence an agent
 * exited, not proof: an answer can quote one, which is why the caller also looks for the agent's
 * input box under it.
 */
export function exitHintOf(rows: readonly string[], agent: AccountAgent, whole = false): ExitHint | null {
  // `whole`: the rows are only what the agent printed since its exit command, so any row of them is its own.
  const foot = whole ? 0 : Math.max(0, rows.length - HINT_FROM_FOOT_ROWS)
  /** The last head in the foot's rows whose command (on its row, else the next one that holds
   *  something) matches. */
  const last = (head: RegExp, command: RegExp, sameRow: boolean): { m: RegExpExecArray; row: number } | null => {
    for (let i = rows.length - 1; i >= foot; i--) {
      if (!head.test(rows[i])) continue
      const own = sameRow ? command.exec(rows[i]) : null
      const at = nextFilled(rows, i)
      const m = own ?? (at < 0 ? null : command.exec(rows[at]))
      if (m) return { m, row: i }
    }
    return null
  }
  if (agent === 'claude') {
    const hit = last(CLAUDE_HINT_HEAD, CLAUDE_HINT_COMMAND, false)
    if (!hit) return null
    const [, worktree, id] = hit.m
    // A worktree name this can't type back safely is no worktree to resume in: from the main folder
    // the transcript isn't found, so the session goes as one with no id.
    if (worktree !== undefined && !WORKTREE_NAME.test(worktree)) return { id: null, row: hit.row }
    const hint: ExitHint = { id: isSessionId(id) ? id : null, row: hit.row }
    if (worktree !== undefined) hint.worktree = worktree
    return hint
  }
  if (agent === 'codex') {
    const hit = last(CODEX_HINT_HEAD, CODEX_HINT_COMMAND, true)
    if (hit) return { id: isSessionId(hit.m[1]) ? hit.m[1] : null, row: hit.row }
    // Its shutdown line: for a session with no turns, all it prints.
    for (let i = rows.length - 1; i >= foot; i--) if (CODEX_SESSION_ROW.test(rows[i])) return { id: null, row: i }
    return null
  }
  const hit = last(AGY_HINT_HEAD, AGY_HINT_COMMAND, false)
  return hit ? { id: isSessionId(hit.m[1]) ? hit.m[1] : null, row: hit.row } : null
}

export interface RelaunchSpec {
  agent: AccountAgent
  /** The session to resume; null starts a new one. */
  id: string | null
  /** Claude Code in a worktree (ExitHint.worktree). */
  worktree?: string
  /** The terminal's model: Claude Code's and agy's --model, Codex's -m. */
  model?: string
  /** The other flags the agent was started with, as it was started with them (carryForSwitch): each
   *  one a word a relaunch can re-type faithfully (isPlainLaunchWord). */
  extra?: string[]
  /** Codex's -c developer_instructions, when the text is shell-safe (isShellSafeInstruction). */
  instructions?: string
  /** Claude Code, a new session: the id to start it with (--session-id), so it can be resumed. */
  sessionId?: string
}

/**
 * The bare command that starts the agent again (§7.2 step 8): the account goes in front of it
 * (accountLine). Global options before Codex's subcommand. Never Claude Code's --continue or
 * Codex's resume --last, which take the newest session in the folder: in a swarm's folder another
 * agent's, and two agents then write one transcript (R8). Throws on a value that is not what it
 * should be, which a caller has checked: nothing unchecked reaches a shell.
 */
export function relaunchCommand(spec: RelaunchSpec): string {
  if (spec.id !== null && !isSessionId(spec.id)) throw new Error('not a session id')
  if (spec.model !== undefined && !isSafeModelName(spec.model)) throw new Error('not a model name')
  if (spec.extra !== undefined && !spec.extra.every(isPlainLaunchWord)) throw new Error('not a flag a relaunch can repeat')
  const extra = spec.extra ?? []
  if (spec.agent === 'claude') {
    if (spec.worktree !== undefined && !WORKTREE_NAME.test(spec.worktree)) throw new Error('not a worktree name')
    if (spec.sessionId !== undefined && !isSessionId(spec.sessionId)) throw new Error('not a session id')
    const parts = ['claude']
    if (spec.worktree !== undefined) parts.push(`--worktree "${spec.worktree}"`)
    if (spec.model) parts.push(`--model ${spec.model}`)
    parts.push(...extra)
    if (spec.id) parts.push(`--resume ${spec.id}`)
    else if (spec.sessionId) parts.push(`--session-id ${spec.sessionId}`)
    return parts.join(' ')
  }
  if (spec.agent === 'codex') {
    if (spec.instructions !== undefined && !/^[A-Za-z0-9 .,:;()_/-]{1,1500}$/.test(spec.instructions)) throw new Error('not a shell-safe instruction')
    const parts = ['codex']
    if (spec.model) parts.push(`-m ${spec.model}`)
    parts.push(...extra)
    if (spec.instructions) parts.push(`-c "developer_instructions='${spec.instructions}'"`)
    if (spec.id) parts.push(`resume ${spec.id}`)
    return parts.join(' ')
  }
  const parts = ['agy']
  if (spec.model) parts.push(`--model ${spec.model}`)
  parts.push(...extra)
  if (spec.id) parts.push(`--conversation=${spec.id}`)
  return parts.join(' ')
}

/** What a switch repeats of the line the agent was started with (carryForSwitch). */
export type SwitchCarry = { ok: true; model?: string; extra: string[] } | { ok: false; why: string }

/**
 * The flags a relaunch keeps from the line that started the agent, read by the rule the model switcher
 * uses (launchCarry.ts): its model in any spelling, and every other flag that can be re-typed word
 * for word (permission mode, effort, directories, a swarm worker's --dangerously-skip-permissions or
 * Codex's -a and -s). The conversation is named by the switch itself, and what Termpolis added to the
 * line (a primer file, Codex's developer instructions) is added again by the relaunch where it applies.
 *
 * A line it cannot repeat faithfully is refused, before anything is typed, because a relaunch would
 * come back WITHOUT what the line held, and some of that is a restriction: a prompt, a quote, an
 * operator, a flag whose value is several words, a model name with odd characters. A command that
 * is not the agent itself (a wrapper such as claude-sandbox) never gets this far: it has no account
 * (accountsView.ts agentOfCommand). Pure.
 */
export function carryForSwitch(agent: AccountAgent, line: string | undefined): SwitchCarry {
  const found = line ? agentCommandIn(line) : null
  // Nothing recorded of how it was started: the bare command, as before.
  if (found === null) return { ok: true, extra: [] }
  const provider: LaunchProvider = agent === 'agy' ? 'gemini' : agent
  const command = withoutInjected(found)
  if (providerForCommand(command) !== provider) return { ok: true, extra: [] }
  const name = agent === 'agy' ? 'agy' : agent === 'codex' ? 'Codex' : 'Claude Code'
  const refuse = (what: string): SwitchCarry => ({ ok: false, why: `${name} was started with ${what}, which switching in place would not repeat faithfully, so it would come back without it` })
  const model = modelOfCommand(provider, command)
  if (model !== undefined && !isSafeModelName(model)) return refuse('a model name Termpolis cannot repeat')
  const carry = carryLaunchArgs(provider, command)
  if (!carry.complete) return refuse('options it cannot repeat (a prompt, a quote, an operator, or a flag with several values)')
  // Claude Code's worktree is the exit hint's to name (ExitHint.worktree), once.
  const extra = agent === 'claude' ? withoutWorktree(carry.args) : carry.args
  return { ok: true, ...(model ? { model } : {}), extra }
}

/** `--worktree [name]` and `-w [name]` out of `args`: the relaunch passes the one the exit hint names. */
function withoutWorktree(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    if (w === '--worktree' || w === '-w') {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++
      continue
    }
    if (w.startsWith('--worktree=')) continue
    out.push(w)
  }
  return out
}

/** What each CLI says when the session it was told to resume isn't there (F6). Claude Code and
 *  Codex then exit; agy warns and starts a new conversation. */
export const RESUME_NOT_FOUND: Readonly<Record<AccountAgent, RegExp>> = {
  claude: /No conversation found with session ID/,
  codex: /No saved session found with ID/,
  agy: /Conversation \S+ not found, ignoring --conversation flag/,
}

/** A sign-in screen of each CLI: a relaunch into a profile whose sign-in expired lands there. Its
 *  answers decide something (which account, which method), so Termpolis never gives one (R10). */
export const SIGN_IN_SCREEN: Readonly<Record<AccountAgent, RegExp>> = {
  // The last is the footer of Claude Code 2.1.316's box in a profile that is onboarded but signed out
  // ("Not logged in · Run /login"); its separator is a middle dot, matched loosely as the terminals differ.
  claude: /Select login method:|Paste code here(?: if prompted)? >|Please run \/login|Not logged in .{1,3}Run \/login/,
  codex: /Sign in with ChatGPT|Provide your own API key/,
  agy: /You are currently not signed in|Select login method:|Paste the authorization code|Enter the authorization code|Select Google Cloud sign-in method:/,
}

/** agy's own words for a sign-in that finished (agy-signin.md): its input box comes back after. */
export const AGY_SIGNED_IN = /Authentication successful!|Successfully authenticated\./

/** A question after a relaunch that only the user can answer, which Termpolis never answers:
 *  Claude Code's bypass-permissions warning, a new MCP server to approve, the folder-trust
 *  question (answered by the prompt pollers where the user allows it, once the switch is over), the
 *  one-time "Try the new fullscreen renderer?" offer a profile never used before opens on, and the
 *  Windows sandbox set-up menu Codex opens on in a home it never ran in (its option rows draw a ›,
 *  so it reads as an input box, and no prompt poller answers it). */
export const ASKS_USER = /Bypass Permissions mode|New MCP servers? found|Do you trust the (?:files|contents)|trust this folder|Try the new fullscreen renderer|Set up default sandbox|Resume from summary|Resume full session as-is/i

/** Codex's "still starting" rows: the header line it draws while it looks for the session to resume,
 *  and Codex 0.153's "model: loading". Its composer is already on screen under them, and the lookup
 *  can still end in "No saved session found" (SWITCH-R1 C2), so the relaunch has not come up yet. */
export const CODEX_STARTING = /Resuming session|\bmodel:\s+loading\b/

/** The variables that move an agent's profile, as a typed line could set or unset them. */
const PROFILE_VARS = '(?:CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME)'

/** A line typed by hand that changes which account the terminal's shell runs agents on: a profile
 *  variable set or unset in any shell's syntax, or one of David's own ways to move a terminal:
 *  `switch-now` (also as switch-now.sh or .cmd, and as the `claude-switch` alias of his .bashrc), and
 *  `/switch-account <acct>` typed in Claude followed by /exit. ~/.claude/claude-run.sh then starts Claude again
 *  on the other profile with a prefix assignment, which passes through no line Termpolis types, so the
 *  line typed is the only sign the terminal's account changed (SW2-1). Termpolis's own lines match
 *  too; main tells them apart by remembering the line it built (R1). */
const BY_HAND: readonly RegExp[] = [
  new RegExp(`(?:^|[\\s;&|(])${PROFILE_VARS}=`, 'i'),
  new RegExp(`(?:^|[\\s;&|(])unset\\s+(?:-v\\s+)?(?:[A-Za-z_]\\w*\\s+)*${PROFILE_VARS}\\b`, 'i'),
  new RegExp(`\\benv\\s+(?:-\\S+\\s+)*-u\\s*${PROFILE_VARS}\\b`, 'i'),
  new RegExp(`\\$env:${PROFILE_VARS}\\s*=`, 'i'),
  new RegExp(`\\bRemove-Item\\s+(?:-Path\\s+)?Env:\\\\?${PROFILE_VARS}\\b`, 'i'),
  new RegExp(`(?:^|[\\s&|(])set\\s+"?${PROFILE_VARS}=`, 'i'),
  /(?:^|[\s;&|(/\\])(?:switch-now(?:\.(?:sh|cmd))?|claude-switch)(?:\s|$)/i,
  /(?:^|[\s;&|(])\/switch-account(?:\s|$)/i,
]

export function changesAccountByHand(typed: string): boolean {
  return BY_HAND.some((p) => p.test(typed))
}

// ── The switch, as the renderer asks for it and main answers ──────────────────────────────

/** What the renderer asks main to do: move the agent in `terminalId` to `targetId`, in place. Main
 *  decides the rest from its own records: the terminal's account, the line it last typed there
 *  (its flags, its model), the session it started. */
export interface SwitchRequest {
  terminalId: string
  targetId: string
  /** The terminal's shell type: which shell's syntax the account line is in. */
  shellType: string
  /** Codex: the instruction the target's prepare returned (memory:prepare-codex-context). */
  instructions?: string
  /** The user said the agent has exited, where Termpolis couldn't tell. */
  assumeExited?: boolean
  /** The user said to stop the agent's turn first. */
  stopBusy?: boolean
  /** Start a new session on the target instead of resuming this one. */
  fresh?: boolean
  /** The user's second confirmation (D14, R17), asked wherever the switch was asked for: main
   *  refuses a switch onto an account that isn't offered automatically, or carrying a conversation
   *  off one, that doesn't hold it. */
  confirmedCarry?: boolean
  /** For the app log: why ("usage limit", "by hand"). */
  reason?: string
}

/** How a switch ended. Every kind but `switched` and `fresh` typed no account line, or typed one
 *  that was never entered. */
export type SwitchOutcome =
  /** On the target, with this conversation (`resumed`) or the session id said. `kept` names the
   *  older copy of a carried transcript that was kept beside it (R25). */
  | { kind: 'switched'; resumed: boolean; sessionId?: string; carried?: boolean; kept?: string }
  /** On the target with a new session: the agent printed no id, the target can't see this one
   *  (Codex's path (c), agy's not-found warning), or the user asked for one. */
  | { kind: 'fresh'; why: 'no-session' | 'not-found' | 'asked' }
  /** The agent is at work: stop it first? Nothing was typed. */
  | { kind: 'busy' }
  /** Termpolis can't tell whether the agent still runs: has it exited? Nothing was typed. `osSees`: the operating system
   *  itself still showed a program running in the terminal (not merely nothing readable on the screen). */
  | { kind: 'unknown-exit'; osSees?: true }
  /** The exit command went in, but no exit showed within 8 s: nothing more was typed. `osSees` as above. */
  | { kind: 'exit-unconfirmed'; osSees?: true }
  /** The line landed in the agent's own box (it never exited): it was cleared, and not entered. */
  | { kind: 'agent-alive' }
  /** The line never showed: nothing was entered. `line` is what to type by hand. `otherShell`: the
   *  terminal's shell is of another kind than the one the line was built for (one was started inside
   *  it), so there is no line to type; the agent has exited. */
  | { kind: 'didnt-start'; line: string; otherShell?: true }
  /** Claude Code couldn't find the conversation on the target. */
  | { kind: 'resume-not-found' }
  /** The target shows its sign-in screen, which Termpolis never answers. */
  /** `sessionId`: the conversation that was being relaunched, which a new terminal on the account can
   *  pick up once it is signed in (the terminal itself sits at the CLI's sign-in screen). */
  | { kind: 'sign-in'; sessionId?: string }
  /** The target asks something only the user answers. */
  | { kind: 'asks-user'; what: string }
  /** Nothing showed within 30 s of the Enter. */
  | { kind: 'no-outcome' }
  /** Refused before anything was typed. */
  | { kind: 'refused'; why: string }

// ── agy's switch-all ─────────────────────────────────────────────────────────────────────

/** agy keeps one Google sign-in for the computer user, so its switch moves every agy terminal: each
 *  is exited, the sign-in itself moves in main's hidden session (signInSession.ts), then each
 *  resumes its conversation by its id. These are a terminal's two steps. */
export type AgyStep = 'exit' | 'resume'

export interface AgyStepRequest {
  terminalId: string
  targetId: string
  shellType: string
  step: AgyStep
  /** The conversation the exit read from agy's exit hint, for the resume. */
  conversationId?: string | null
  /** The user said agy has exited, where Termpolis couldn't tell. */
  assumeExited?: boolean
}

export type AgyStepOutcome =
  /** agy is out of the terminal: the conversation its hint named, or null for none. `alreadyGone`: it was not running
   *  when Termpolis looked (the user quit it by hand), so there is nothing to bring back after the sign-in change. */
  | { kind: 'exited'; conversationId: string | null; alreadyGone?: true }
  /** agy is at work, or asks something: its turn is waited for. Nothing was typed. */
  | { kind: 'busy' }
  /** Termpolis can't tell whether agy still runs here. Nothing was typed. */
  | { kind: 'unknown-exit' }
  | { kind: 'not-exited'; why: string }
  /** On the new sign-in, with the conversation (or a new one agy started, `fresh`). `shownEmail` is
   *  the address agy's own header shows, for the user to read; never what decided anything. */
  | { kind: 'resumed'; fresh: boolean; conversationId: string | null; shownEmail?: string }
  | { kind: 'not-resumed'; why: string }
  | { kind: 'refused'; why: string }

/** The model picker asks main for its half of the terminal's relaunch lock (§7.5). The line it then
 *  types to start the agent again (it comes from what the agent prints as it exits, so it isn't known
 *  yet) carries the hold's key, and main counts it as the agent's start. */
export interface ModelHoldRequest {
  terminalId: string
}

/** The hold: the key the picker's writes carry while main holds the terminal for it. */
export interface ModelHold {
  key: string
}

/** Why the model picker typed nothing: something holds the terminal already. */
export const MODEL_HELD = 'an account switch or another model change is running in this terminal'

/** What a terminal Termpolis relaunches an agent in says to anyone else who types into it meanwhile
 *  (R7): the conductor's write_to_terminal and run_command, and the phone's, are refused with these
 *  words, which every MCP client is shown as they are (mcpServer.ts). A swarm worker's restart on
 *  another account says so, and the conductor waits for system's next message about it (§9). */
export const RELAUNCH_HELD = {
  account: 'Termpolis is switching this agent\'s account; wait for system\'s next message',
  model: 'Termpolis is changing this agent\'s model; wait for system\'s next message',
  worker: 'Termpolis is restarting this worker; wait for system\'s next message',
} as const

export type RelaunchHold = keyof typeof RELAUNCH_HELD

/** main → renderer while a switch runs: which step it is at, for the dialog. */
export interface SwitchProgress {
  terminalId: string
  step: 'exiting' | 'confirming' | 'carrying' | 'typing' | 'waiting'
}

/** The prompt reports Termpolis's shells write (shellIntegration.ts): OSC 7 from bash, OSC 9;9 from
 *  PowerShell and cmd. zsh and fish write none. */
const POSIX_REPORT = /\x1b\]7;/
const WINDOWS_REPORT = /\x1b\]9;9;/

/** Whether `output` holds a prompt report of a shell of another family than `family`: a shell
 *  nested in the terminal's own, which the line built for the terminal's family doesn't fit. Only
 *  this positive mismatch refuses; a shell that reports nothing proves nothing (R1). */
export function otherShellReported(output: string, family: ShellFamily): boolean {
  return family === 'posix' ? WINDOWS_REPORT.test(output) : POSIX_REPORT.test(output)
}

/** Whether `output` holds a prompt report of this shell family's own kind. */
export const ownReport = (output: string, family: ShellFamily): boolean => (family === 'posix' ? POSIX_REPORT : WINDOWS_REPORT).test(output)

/** Whether a shell of another kind runs here now: another family reported, and the terminal's own did
 *  not. A prompt can write both (oh-my-posh's pwd=osc99 in Git Bash adds Windows Terminal's cwd marker to
 *  the bash prompt's own OSC 7; a PowerShell prompt can write OSC 7), and then no shell is nested: a line
 *  of the wrong family is harmless anyway (it fails to parse and runs nothing, verified for all nine
 *  pairs), so only this clear case, a family heard from and the own one silent, refuses. `earlier` is
 *  the terminal's output from before this: a shell that never wrote its own family's report there
 *  (oh-my-posh in Git Bash writes only OSC 9;9) is not shown nested by writing the other's. It may be
 *  given as the fact itself, whether the own family ever reported in this terminal (main keeps that after the
 *  report has left the window it retains: SW2-10). */
export function nestedShellReported(output: string, family: ShellFamily, earlier?: string | boolean): boolean {
  if (ownReport(output, family) || !otherShellReported(output, family)) return false
  if (earlier === undefined) return true
  return typeof earlier === 'boolean' ? earlier : ownReport(earlier, family)
}
