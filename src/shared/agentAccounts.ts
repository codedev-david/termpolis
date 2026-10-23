// Agent accounts: more than one sign-in per coding agent. Shared by main (the registry in
// src/main/agentAccounts.ts) and the renderer (Settings ▸ Accounts), so everything here is pure:
// types, IPC names and the functions that build what Termpolis types into a shell.
//
// Claude Code and Codex keep a sign-in per profile folder (CLAUDE_CONFIG_DIR, CODEX_HOME), so an
// account of theirs is a folder. The Antigravity CLI (agy, Termpolis's Gemini profile) keeps ONE
// Google sign-in per computer user, in the OS keyring, so an agy account is only a label: a name
// and the Google email it should be signed in with. Termpolis never reads, copies or stores a
// sign-in for any of them.
import { psQuote, shQuote } from './shellQuote'

export type AccountAgent = 'claude' | 'codex' | 'agy'

/** The agents whose accounts are profile folders. */
export type ProfileAgent = 'claude' | 'codex'

export const ACCOUNT_AGENTS: readonly AccountAgent[] = ['claude', 'codex', 'agy']

export const PROFILE_AGENTS: readonly ProfileAgent[] = ['claude', 'codex']

export function isProfileAgent(agent: AccountAgent): agent is ProfileAgent {
  return agent === 'claude' || agent === 'codex'
}

/** How each agent is named in the UI. agy is Termpolis's Gemini profile. */
export const ACCOUNT_AGENT_LABEL: Readonly<Record<AccountAgent, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'Gemini / Antigravity CLI',
}

/** The variable that moves an agent's whole profile, sign-in included. */
export const PROFILE_VARIABLE: Readonly<Record<ProfileAgent, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

/** The agent's default profile folder under the home folder: the one it uses with the variable unset. */
export const DEFAULT_PROFILE_FOLDER: Readonly<Record<ProfileAgent, string>> = {
  claude: '.claude',
  codex: '.codex',
}

/** Subfolders a new profile can share with the default one through a link, and whether each is
 *  ticked by default. `projects` holds Claude Code's conversations and its own memory, so sharing it
 *  is what lets a conversation continue on another account; Codex's `sessions` does the same for
 *  Codex (verified: `codex resume <id>` finds a rollout through a linked sessions folder). */
export const SHAREABLE_FOLDERS: Readonly<Record<ProfileAgent, ReadonlyArray<{ name: string; on: boolean }>>> = {
  claude: [
    { name: 'projects', on: true },
    { name: 'commands', on: true },
    { name: 'skills', on: true },
    { name: 'agents', on: true },
    { name: 'plugins', on: false },
    { name: 'hooks', on: false },
  ],
  codex: [{ name: 'sessions', on: true }],
}

export interface AccountLink {
  /** The subfolder of the profile that is a link. */
  name: string
  /** What it points at. */
  target: string
}

export interface AgentAccount {
  /** 'acc_' + 12 hex: stable, what terminals, workspaces and swarms store. */
  id: string
  agent: AccountAgent
  /** "personal", "codedev", "work": shown everywhere. Unique per agent. */
  label: string
  /** The address this account should be signed in with. */
  email?: string
  /** The launch string: exactly what goes into CLAUDE_CONFIG_DIR / CODEX_HOME, never realpath'd.
   *  null is the agent's default profile, with the variable unset (deleted, never ''). Always
   *  null for agy, which has no profiles. */
  profile: string | null
  /** false: never offered automatically when another account runs out ("work"). */
  autoOffer: boolean
  /** Place in the failover order within the agent. */
  order: number
  color?: string
  /** The user wants this profile connected to Termpolis. Effective only with Agent Integration
   *  on. The default profile is connected through Agent Integration itself, and agy has none. */
  connect: boolean
  origin: 'created' | 'adopted' | 'accounts-sh' | 'label'
  /** The ~/.claude/accounts.sh key it was imported as: for .limited-<key> lookups. */
  importedAs?: string
  /** Links Termpolis made in a folder it created. */
  links: AccountLink[]
  /** When its settings were last copied from the main profile (epoch ms), if they were. */
  copiedAt?: number
}

export interface AccountLimit {
  seenAt: number
  resetsAt: number | null
  text: string
  scope: 'account' | 'model'
  window?: 'session' | 'weekly' | 'monthly' | 'other'
  email?: string
}

export interface AccountIdentity {
  email: string | null
  signedIn: boolean | null
  plan?: string
  checkedAt: number
  /** Where it was read; 'sign-in-screen': a relaunch on the account landed on the CLI's sign-in
   *  screen, so its stored sign-in no longer works (§7.2 step 10). */
  source: 'claude.json' | 'auth-status' | 'login-status' | 'account-read' | 'sign-in-screen'
}

export interface AccountsFile {
  version: 1
  accounts: AgentAccount[]
  /** The account new terminals launch on, per agent. */
  preferred: Partial<Record<AccountAgent, string>>
  /** Open the account chooser by itself when an agent runs out of usage. */
  chooser: boolean
  /** How long an account stays out of usage when no reset time is known. */
  cooldownSec: Partial<Record<AccountAgent, number>>
  limits: Record<string, AccountLimit>
  identity: Record<string, AccountIdentity>
  hidden?: { hookAdvice?: boolean; authEnvAdvice?: boolean; limitBanner?: boolean }
}

/** 5 hours, as accounts.sh's LIMIT_COOLDOWN. */
export const DEFAULT_COOLDOWN_SEC = 18000

export const ACCOUNTS_IPC = {
  list: 'accounts:list',
  add: 'accounts:add',
  update: 'accounts:update',
  move: 'accounts:move',
  remove: 'accounts:remove',
  setConnect: 'accounts:set-connect',
  stripCopied: 'accounts:strip-copied',
  setPreferred: 'accounts:set-preferred',
  setChooser: 'accounts:set-chooser',
  hideAdvice: 'accounts:hide-advice',
  importPreview: 'accounts:import-preview',
  import: 'accounts:import',
  check: 'accounts:check',
  pickFolder: 'accounts:pick-folder',
  /** A usage limit an account hit, as the chooser read it. */
  noteLimit: 'accounts:note-limit',
  /** "Mark available": forget an account's recorded limit. */
  clearLimit: 'accounts:clear-limit',
  /** "Re-copy from main profile": fresh stripped copies over the profile's own. */
  recopy: 'accounts:recopy',
  /** The account a launch goes on: the one asked for, else the agent's preferred one. */
  launchAccount: 'accounts:launch-account',
  /** The line a launch types: the agent's command on its account (§6.2). */
  launchLine: 'accounts:launch-line',
  /** main → renderer: the account Termpolis now knows a terminal runs on, or that it was changed
   *  by hand (TerminalAccountEvent). */
  terminalAccount: 'accounts:terminal-account',
  /** Move a terminal's running agent to another account, in place (SwitchRequest → SwitchOutcome). */
  switchAccount: 'accounts:switch',
  /** main → renderer: the step a switch is at (SwitchProgress). */
  switchProgress: 'accounts:switch-progress',
  /** One step of agy's guided switch (AgyStepRequest → AgyStepOutcome). */
  agySwitch: 'accounts:agy-switch',
  /** The model picker's half of a terminal's relaunch lock (ModelHoldRequest → ModelHold, or null
   *  while anything holds the terminal). */
  modelHold: 'accounts:model-hold',
  /** Lets the model picker's hold go ({ terminalId, key }). */
  modelRelease: 'accounts:model-release',
  /** The usage-limit chooser's look at a terminal whose screen changed ({ terminalId } → LimitLook). */
  limitLook: 'accounts:limit-look',
  /** Starts a hidden sign-in session: the CLI's own login in main's own PTY (SignInStartRequest →
   *  { sessionId }). */
  signInStart: 'accounts:sign-in-start',
  /** The user's input to it: a pick, a code, Open again, cancel (SignInInput). */
  signInInput: 'accounts:sign-in-input',
  /** main → renderer: a sign-in session's state (SignInState). */
  signInState: 'accounts:sign-in-state',
} as const

// ── What the renderer is shown ────────────────────────────────────────────────────────

export interface AccountRowView {
  id: string
  agent: AccountAgent
  label: string
  email?: string
  /** The launch string, or null for the default profile (and every agy account). */
  profile: string | null
  /** The folder the profile lives in, for display: the default one when `profile` is null. */
  folder: string | null
  isDefault: boolean
  autoOffer: boolean
  order: number
  color?: string
  connect: boolean
  origin: AgentAccount['origin']
  importedAs?: string
  folderExists: boolean
  /** Subfolders that are links into the default profile (made by Termpolis or found there). */
  shares: string[]
  /** "Last signed in as": the email the profile's own config names. Claude Code only; null when
   *  it names none or can't be read. */
  lastEmail: string | null
  /** The last "signed in now" check, if any. */
  identity?: AccountIdentity
  /** An unexpired usage limit Termpolis recorded. */
  limit?: AccountLimit
  /** When the ~/.claude StopFailure hook last marked this imported account limited (epoch ms),
   *  while still inside the cooldown and accounts.sh lists every registered profile. */
  limitedOutside?: number
  /** Termpolis's own entries in this profile. null for agy and for a missing folder. */
  connection: { server: boolean; hook: boolean; allow: boolean } | null
  /** Its settings.json skips Claude Code's bypass-permissions warning, so a swarm worker can take
   *  this account over. Claude Code only. */
  bypassReady: boolean
  /** Termpolis terminals Termpolis knows are running on this account. */
  terminals: number
  /** It started from a copy of the main profile's settings, which changed since: offer a re-copy. */
  recopyAvailable: boolean
}

export interface AccountsAdvice {
  /** Claude profiles whose settings.json runs a StopFailure hook: the first hook's command. */
  stopFailureHooks: Array<{ label: string; command: string }>
  /** Names (never values) of settings that outrank a profile's own sign-in. */
  authOverrides: string[]
}

export interface AccountsView {
  accounts: AccountRowView[]
  preferred: Partial<Record<AccountAgent, string>>
  chooser: boolean
  hidden: NonNullable<AccountsFile['hidden']>
  /** Agent Integration's consent: per-account Connect needs it. */
  integrationConnected: boolean
  /** ~/.claude/accounts.sh exists, so Import is offered. */
  importAvailable: boolean
  /** What differs between accounts.sh and the registry, one sentence each. */
  drift: string[]
  advice: AccountsAdvice
  home: string
  /** The account each profile agent's terminals run on when Termpolis types no account line for
   *  them, by Termpolis's own environment: a swarm's conductor and its workers. */
  envAccount?: Partial<Record<ProfileAgent, string>>
  /** Set when the registry file exists but can't be read: nothing is written until it can. */
  error?: string
}

export interface AddAccountRequest {
  agent: AccountAgent
  label: string
  email?: string
  /** 'new': create ~/.claude-<slug> (or ~/.codex-<slug>). 'existing': the folder the user picked
   *  with accounts:pick-folder (main remembers it; the renderer never passes a path). Ignored
   *  for agy. */
  folder?: 'new' | 'existing'
  /** Subfolders to share by a link (a new folder only). */
  share?: string[]
  /** Start from a stripped copy of the default profile's settings (a new folder only). */
  copy?: boolean
  connect?: boolean
  autoOffer?: boolean
  /** The colour the Add wizard picked: #rrggbb, or none. */
  color?: string
}

export interface AddAccountResult {
  account: AccountRowView
  /** Settings left out of the copy, by name. */
  leftOut: string[]
  copied: string[]
  /** What connecting wrote. */
  changes: AccountChange[]
  /** The lines that make ~/.claude/accounts.sh know the new account, when that file exists. */
  accountsShLines?: string[]
  /** What else happened: a subfolder left unshared, the main profile listed too. */
  notes?: string[]
}

export interface ImportPreviewRow {
  key: string
  label: string
  email?: string
  profile: string | null
  autoOffer: boolean
  order: number
  /** Already registered (same folder): imported rows are skipped. */
  registered: boolean
  folderExists: boolean
  shares: string[]
}

export interface ImportPreview {
  rows: ImportPreviewRow[]
  /** Lines that were refused, and why. */
  refused: string[]
  cooldownSec?: number
}

export type SignInMethod = 'claudeai' | 'console' | 'sso' | 'browser' | 'device'

/** What accounts:pick-folder answers: the folder the user picked in main's own dialog, for
 *  display only (main remembers the real path), and what Add would make of it. */
export interface PickFolderResult {
  /** Tildified; null when the dialog was cancelled. */
  folder: string | null
  /** Why that folder can't be a profile. */
  error?: string
  /** It is the agent's default profile folder. */
  isDefault?: boolean
  /** Subfolders that are already links into the default profile. */
  shares?: string[]
  exists?: boolean
}

/** What can be changed on an account in place. */
export interface AccountPatch {
  label?: string
  /** '' clears it. */
  email?: string
  autoOffer?: boolean
  /** null clears it. */
  color?: string | null
}

/** A write into an agent's config, as agent integration reports it. */
export interface AccountChange {
  agent: string
  file: string
  action: string
  what: string
  error?: string
}

export interface AccountChangesResult {
  changes: AccountChange[]
  account?: AccountRowView
}

export interface RecopyView {
  copied: string[]
  /** Settings left out of the copy, by name. */
  leftOut: string[]
  /** What connecting the profile again wrote. */
  changes: AccountChange[]
  account?: AccountRowView
}

export interface ImportResult {
  added: number
  changes: AccountChange[]
  view: AccountsView
}

/** A usage limit as the chooser read it from the CLI's own words. */
export interface NoteLimitRequest {
  text: string
  resetsAt?: number | null
  scope?: AccountLimit['scope']
  window?: AccountLimit['window']
  email?: string
}

/** What a launch asks main for: the line to type for `command` in that terminal's shell. */
export interface LaunchLineRequest {
  terminalId: string
  agent: AccountAgent
  shellType: string
  /** The agent's command as Termpolis would type it bare: `claude --model opus`, `agy`. */
  command: string
  /** The account to launch on; none, or one no longer registered: the agent's preferred one. */
  accountId?: string | null
}

export interface LaunchLineResult {
  /** What to type, without its Enter. */
  line: string
  /** The account the line launches on; null for an agent with no accounts. */
  accountId: string | null
  /** The line names the account (the agent has more than one, or this one isn't its default). */
  explicit: boolean
  /** Claude Code: the session the line starts (--session-id) or resumes, so a switch resumes it
   *  by its exact id (R8). */
  sessionId?: string
}

/** main → renderer: a terminal's account, as main now knows it. */
export interface TerminalAccountEvent {
  terminalId: string
  /** null: the agent's default profile. */
  accountId: string | null
  /** A line typed by hand set or unset the profile variable (or ran switch-now): Termpolis no
   *  longer knows the account, and the chip shows "?". */
  byHand: boolean
  /** A swarm worker's agent, as run_command started it: a worker has no launch line of its own. */
  agent?: AccountAgent
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────

/** The address an account should sign in with, when it is plainly one. */
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

export function isPlainEmail(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && PLAIN_EMAIL.test(s)
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export function hasControlChars(s: string): boolean {
  return CONTROL.test(s)
}

/** A label: 1 to 40 characters, no control characters, trimmed. */
export function cleanLabel(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim()
  return t && t.length <= 40 && !hasControlChars(t) ? t : null
}

/** The folder-name part a label gives a new profile: `[a-z0-9-]{1,32}`, or null. */
export function slugOf(label: string): string | null {
  const slug = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
    .replace(/-+$/, '')
  return slug || null
}

export type ShellFamily = 'posix' | 'powershell' | 'cmd'

/** The family of a Termpolis shell type, or null for one Termpolis can't type an account line into. */
export function familyOf(shellType: string): ShellFamily | null {
  switch (shellType) {
    case 'bash':
    case 'zsh':
    case 'gitbash':
      return 'posix'
    case 'powershell':
      return 'powershell'
    case 'cmd':
      return 'cmd'
    default:
      return null
  }
}

export interface AccountEnv {
  set: Record<string, string>
  unset: string[]
}

/** The variable assignments that put a terminal on `account`: the default profile UNSETS the
 *  variable (an empty CLAUDE_CONFIG_DIR would make Claude Code's config home relative to the
 *  folder it starts in), any other sets it to the launch string. agy has no variable. */
export function accountEnv(account: Pick<AgentAccount, 'agent' | 'profile'> | null, agent: AccountAgent, extraUnset: readonly string[] = []): AccountEnv {
  const env: AccountEnv = { set: {}, unset: [] }
  if (isProfileAgent(agent)) {
    const name = PROFILE_VARIABLE[agent]
    if (account && account.profile) env.set[name] = account.profile
    else env.unset.push(name)
  }
  for (const v of extraUnset) if (!env.unset.includes(v) && !(v in env.set)) env.unset.push(v)
  return env
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * One line that sets the account and runs `command` in the shell's own syntax, built so that a
 * line of one family typed into a shell of another runs nothing (verified for all nine pairs in
 * Git Bash, PowerShell 5.1 and cmd): a wrong shell type, or a shell nested in another, fails
 * closed instead of starting the agent on the old account.
 *
 *   posix       export CLAUDE_CONFIG_DIR='<p>' && <command>      (PS 5.1: `&&` is a parse error)
 *   powershell  & { $env:CLAUDE_CONFIG_DIR = '<p>'; <command> }  (bash: a leading `&` is an error)
 *   cmd         set "CLAUDE_CONFIG_DIR=<p>" && call <command>    (bash: `call` isn't a command)
 *
 * Each assignment lasts for the shell's life, so an agent started there later stays on the
 * account. Refused, with nothing to type: a control character anywhere, and for cmd a `"` in a
 * value or a `%` or `!` anywhere (cmd expands them).
 */
export function accountLine(family: ShellFamily, env: AccountEnv, command: string): { line: string } | { refused: string } {
  const values = Object.values(env.set)
  const names = [...Object.keys(env.set), ...env.unset]
  if (!command.trim()) return { refused: 'there is no command to run' }
  if (names.some((n) => !VARIABLE_NAME.test(n))) return { refused: 'a variable name is not a plain name' }
  if ([command, ...values].some(hasControlChars)) return { refused: 'the line would hold a control character' }
  if (family === 'posix') {
    const parts = Object.entries(env.set).map(([k, v]) => `export ${k}=${shQuote(v)}`)
    if (env.unset.length) parts.push(`unset ${env.unset.join(' ')}`)
    return { line: [...parts, command].join(' && ') }
  }
  if (family === 'powershell') {
    const parts = Object.entries(env.set).map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
    for (const k of env.unset) parts.push(`Remove-Item Env:${k} -ErrorAction SilentlyContinue`)
    return { line: `& { ${[...parts, command].join('; ')} }` }
  }
  if (values.some((v) => v.includes('"'))) return { refused: 'cmd can\'t take a folder whose name holds a double quote' }
  if ([command, ...values].some((s) => /[%!]/.test(s))) return { refused: 'cmd would expand a % or ! in the line' }
  const parts = [
    ...Object.entries(env.set).map(([k, v]) => `set "${k}=${v}"`),
    ...env.unset.map((k) => `set "${k}="`),
  ]
  return { line: [...parts, `call ${command}`].join(' && ') }
}

/** The CLI's own sign-in, as the hidden sign-in session runs it: arguments, never a shell line, so
 *  nothing in them is read by a shell. The method is the agent's: claude.ai (the default), the
 *  Anthropic Console or SSO for Claude Code; the browser (the default) or a device code for Codex.
 *  The email goes on only when it is plainly an address. Never `claude setup-token` or `codex login
 *  --with-api-key`, which would put a long-lived credential in Termpolis's hands. */
export function signInArgs(agent: ProfileAgent, method?: SignInMethod, email?: string): string[] {
  if (agent === 'codex') return method === 'device' ? ['login', '--device-auth'] : ['login']
  const flag = method === 'console' ? '--console' : method === 'sso' ? '--sso' : '--claudeai'
  return isPlainEmail(email) ? ['auth', 'login', flag, '--email', email] : ['auth', 'login', flag]
}

/** `p` with the home folder written as `~`, for display. */
export function tildifyPath(p: string, home: string): string {
  if (!home || !p) return p
  const sep = home.includes('\\') ? '\\' : '/'
  const h = home.replace(/[\\/]+$/, '')
  const fold = (s: string): string => (sep === '\\' ? s.toLowerCase() : s)
  if (fold(p) === fold(h)) return '~'
  return fold(p).startsWith(fold(h + sep)) ? `~${sep}${p.slice(h.length + 1)}` : p
}
