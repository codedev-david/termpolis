// Moving a running agent to another account, the pure parts: shared by main, which runs the switch
// (src/main/accountSwitch.ts), and the renderer, which asks for it and shows it. What each CLI
// prints when it exits, the commands that exit and resume it, what its screens say after a
// relaunch, and what a line typed by hand says about the terminal's account.
//
// Every rule here reads what a CLI draws itself, at the bottom of its own screen, or what
// Termpolis typed: never text an agent's answer could hold, which can quote any of it.
import type { AccountAgent, ShellFamily } from './agentAccounts'

/** The id Claude Code, Codex and agy give a session: a UUID (Codex's are version 7). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID.test(v)
}

/** A model name Termpolis puts on a command line: Claude Code's aliases, Codex's ids. */
export function isSafeModelName(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v)
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

/** What clears a shell's line before Termpolis types on it (R7): Ctrl+U in bash, zsh and fish, Esc
 *  in PowerShell (PSReadLine's RevertLine) and cmd. Whatever was left there (a conductor's text,
 *  the phone, keys typed during the switch) would otherwise run with the Enter. */
export const LINE_CLEAR: Readonly<Record<ShellFamily, string>> = { posix: '\u0015', powershell: '\u001b', cmd: '\u001b' }

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
export function exitHintOf(rows: readonly string[], agent: AccountAgent): ExitHint | null {
  const foot = Math.max(0, rows.length - HINT_FROM_FOOT_ROWS)
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
  /** The terminal's model: Claude Code's --model, Codex's -m. */
  model?: string
  /** A Claude Code swarm worker's --dangerously-skip-permissions. */
  skipPermissions?: boolean
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
  if (spec.agent === 'claude') {
    if (spec.worktree !== undefined && !WORKTREE_NAME.test(spec.worktree)) throw new Error('not a worktree name')
    if (spec.sessionId !== undefined && !isSessionId(spec.sessionId)) throw new Error('not a session id')
    const parts = ['claude']
    if (spec.worktree !== undefined) parts.push(`--worktree "${spec.worktree}"`)
    if (spec.model) parts.push(`--model ${spec.model}`)
    if (spec.skipPermissions) parts.push('--dangerously-skip-permissions')
    if (spec.id) parts.push(`--resume ${spec.id}`)
    else if (spec.sessionId) parts.push(`--session-id ${spec.sessionId}`)
    return parts.join(' ')
  }
  if (spec.agent === 'codex') {
    if (spec.instructions !== undefined && !/^[A-Za-z0-9 .,:;()_/-]{1,1500}$/.test(spec.instructions)) throw new Error('not a shell-safe instruction')
    const parts = ['codex']
    if (spec.model) parts.push(`-m ${spec.model}`)
    if (spec.instructions) parts.push(`-c "developer_instructions='${spec.instructions}'"`)
    if (spec.id) parts.push(`resume ${spec.id}`)
    return parts.join(' ')
  }
  return spec.id ? `agy --conversation=${spec.id}` : 'agy'
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
  claude: /Select login method:|Paste code here(?: if prompted)? >|Please run \/login/,
  codex: /Sign in with ChatGPT|Provide your own API key/,
  agy: /You are currently not signed in|Select login method:|Paste the authorization code|Enter the authorization code|Select Google Cloud sign-in method:/,
}

/** agy's own words for a sign-in that finished (agy-signin.md): its input box comes back after. */
export const AGY_SIGNED_IN = /Authentication successful!|Successfully authenticated\./

/** A question after a relaunch that only the user can answer, which Termpolis never answers:
 *  Claude Code's bypass-permissions warning, a new MCP server to approve, the folder-trust
 *  question (answered by the prompt pollers where the user allows it, once the switch is over). */
export const ASKS_USER = /Bypass Permissions mode|New MCP servers? found|Do you trust the (?:files|contents)|trust this folder/i

/** The variables that move an agent's profile, as a typed line could set or unset them. */
const PROFILE_VARS = '(?:CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME)'

/** A line typed by hand that changes which account the terminal's shell runs agents on: a profile
 *  variable set or unset in any shell's syntax, or David's `switch-now`. Termpolis's own lines
 *  match too; main tells them apart by remembering the line it built (R1). */
const BY_HAND: readonly RegExp[] = [
  new RegExp(`(?:^|[\\s;&|(])${PROFILE_VARS}=`, 'i'),
  new RegExp(`(?:^|[\\s;&|(])unset\\s+(?:-v\\s+)?(?:[A-Za-z_]\\w*\\s+)*${PROFILE_VARS}\\b`, 'i'),
  new RegExp(`\\benv\\s+(?:-\\S+\\s+)*-u\\s*${PROFILE_VARS}\\b`, 'i'),
  new RegExp(`\\$env:${PROFILE_VARS}\\s*=`, 'i'),
  new RegExp(`\\bRemove-Item\\s+(?:-Path\\s+)?Env:\\\\?${PROFILE_VARS}\\b`, 'i'),
  new RegExp(`(?:^|[\\s&|(])set\\s+"?${PROFILE_VARS}=`, 'i'),
  /(?:^|[\s;&|(])switch-now(?:\s|$)/i,
]

export function changesAccountByHand(typed: string): boolean {
  return BY_HAND.some((p) => p.test(typed))
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
