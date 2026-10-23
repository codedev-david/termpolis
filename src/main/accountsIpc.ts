// Settings ▸ Accounts, main side: the IPC the Accounts tab and its sign-in terminal call, plus the
// few lookups index.ts needs to launch, trust and route on an account. Every file goes through
// agentAccounts.ts and accountFs.ts, so nothing here can open a sign-in; the renderer never passes
// a path (a folder is picked with main's own dialog and remembered here), and what it is shown of
// a profile is the view below: labels, emails, folders and states, never a config file.
//
// Logs hold account labels, never emails.
import { randomUUID } from 'crypto'
import { join } from 'path'
import { MODEL_HELD, changesAccountByHand, isSessionId } from '../shared/accountSwitch'
import type { AgyStepOutcome, AgyStepRequest, ModelHold, SwitchOutcome, SwitchRequest } from '../shared/accountSwitch'
import { runAgyStep } from './agySwitch'
import { carryTranscript, findTranscript } from './accountCarry'
import { holdForModel, releaseModelHold, runAccountSwitch } from './accountSwitch'
import type { SwitchIO } from './accountSwitch'
import {
  ACCOUNTS_IPC, ACCOUNT_AGENTS, ACCOUNT_AGENT_LABEL, SHAREABLE_FOLDERS, accountEnv, accountLine, cleanLabel, familyOf,
  isPlainEmail, isProfileAgent, signInCommand, signInTerminalName, slugOf, tildifyPath,
} from '../shared/agentAccounts'
import type {
  AccountAgent, AccountIdentity, AccountRowView, AccountsAdvice, AccountsView, AddAccountResult, AgentAccount,
  ImportPreview, LaunchLineResult, ProfileAgent, RecopyView, SignInMethod, SignInProgress,
} from '../shared/agentAccounts'
import type { AgentIntegrationChange } from '../shared/agentIntegration'
import { accountFs, readClaudeJsonFields } from './accountFs'
import type { AccountFs } from './accountFs'
import { claudeSignedInNow, codexSignedInNow } from './accountIdentity'
import type { CheckDeps, IdentityCheck } from './accountIdentity'
import { copySources, createProfile, recopyProfile } from './accountProfiles'
import {
  AccountsRefusal, accountProfileTargets, accountsShDrift, accountsShLines, activeLimit, checkProfileFolder,
  claudeJsonOf, cleanLimit, cooldownFor, defaultProfileDir, discoverShares, findAccount, isAccountConnected, isReachable,
  lastSignedInAs, limitedMarker, liveProfileDir, loadAccounts, newAccountId, previewAccountsSh, profileDirOf,
  readAccountsSh, updateAccounts,
} from './agentAccounts'
import type { AccountsDoc, ProfileTarget } from './agentAccounts'
import type { AgentIntegrationPaths, AgentIntegrationRuntime } from './agentIntegrationManager'
import {
  connectAccountProfile, disconnectAccountProfile, profileConnection, stripCopiedEntries,
} from './agentIntegrationManager'
import { err, ok } from './ipcResult'

export interface AccountsIpcLike {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void
}

export interface AccountsIpcDeps {
  /** Where agent configs and Termpolis's settings live (resolveAgentIntegrationPaths). */
  paths: () => AgentIntegrationPaths
  /** What connecting writes with (agentIntegrationRuntime). */
  runtime: () => AgentIntegrationRuntime
  /** Agent Integration's consent: every per-account write rests on it. */
  integrationConnected: () => boolean
  /** Main's own folder dialog, opened on hidden folders: profile folders are dot-folders. */
  pickFolder: (title: string) => Promise<string | null>
  /** To the renderer: a sign-in's progress. */
  send: (channel: string, payload: unknown) => void
  /** A folder of Termpolis's own to run the agents' status commands in. */
  checkCwd: () => string
  env?: Readonly<Record<string, string | undefined>>
  now?: () => number
  fsx?: AccountFs
  /** Has the shell printed a prompt in this terminal's output since `offset` (its prompt report:
   *  OSC 9;9 from PowerShell and cmd, OSC 7 from bash)? Tells a sign-in's command finished. */
  promptSince?: (terminalId: string, offset: number) => boolean
  /** Where the terminal's output ends now (its buffer's next offset): where an agent a line
   *  started begins. */
  outputEnd?: (terminalId: string) => number
  /** The terminals' buffers and PTYs, for a switch (accountSwitch.ts); none, no switch. */
  switchIO?: Omit<SwitchIO, 'progress'>
  /** For tests: the status commands. */
  signedInNow?: (agent: ProfileAgent, profile: string | null, deps: CheckDeps) => Promise<IdentityCheck>
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── Which terminal runs on which account ───────────────────────────────────────────────

/** Main's own record of the account it put each terminal on (from the line it built for that
 *  terminal: launch, switch, restart). What a hook or the renderer says is never asked. */
const terminalAccounts = new Map<string, string | null>()

export function noteTerminalAccount(terminalId: string, accountId: string | null): void {
  terminalAccounts.set(terminalId, accountId)
  byHand.delete(terminalId)
}

export function forgetTerminalAccount(terminalId: string): void {
  terminalAccounts.delete(terminalId)
  sessionIds.delete(terminalId)
  ownLines.delete(terminalId)
  typedLines.delete(terminalId)
  byHand.delete(terminalId)
  agentStarts.delete(terminalId)
}

/** The Claude Code session Termpolis started each terminal's agent with (--session-id) or resumed
 *  in it: what a switch resumes when the agent printed no exit hint (R8). */
const sessionIds = new Map<string, string>()

export function terminalSessionId(terminalId: string): string | undefined {
  return sessionIds.get(terminalId)
}

export function noteTerminalSession(terminalId: string, sessionId: string | null): void {
  if (sessionId) sessionIds.set(terminalId, sessionId)
  else sessionIds.delete(terminalId)
}

/** How long a line main built stays Termpolis's own: the renderer types it within moments. */
export const OWN_LINE_MS = 10_000

/** The lines main built for each terminal (launch-line), each until it is typed or OWN_LINE_MS
 *  pass: typed through terminal:write, one of them is Termpolis's own line, not a change by hand
 *  (R1). */
const ownLines = new Map<string, Array<{ line: string; until: number }>>()
/** What was typed into each terminal since its last Enter, gathered from keystrokes. */
const typedLines = new Map<string, string>()
/** Terminals whose account a line typed by hand changed: Termpolis no longer knows it. */
const byHand = new Set<string>()

/** Where each terminal's agent was started in its output, and the line that started it: what the
 *  switch reads its exit and its relaunch from (accountSwitch.ts), as submit does run_command's. */
export interface AgentStart {
  at: number
  commands: string[]
}
const agentStarts = new Map<string, AgentStart>()

export function terminalAgentStart(terminalId: string): AgentStart | undefined {
  return agentStarts.get(terminalId)
}

export function noteAgentStart(terminalId: string, start: AgentStart): void {
  agentStarts.set(terminalId, start)
}

/** A line typed by hand changed the terminal's account (it set or unset a profile variable). */
export function isAccountChangedByHand(terminalId: string): boolean {
  return byHand.has(terminalId)
}

/** What index.ts's terminal:write and the switch reach main's other parts through, once
 *  registerAccountsIpc has run. */
const wiring: { send?: (channel: string, payload: unknown) => void; outputEnd?: (terminalId: string) => number } = {}

/** The longest typed line kept: a pasted file is no account line. */
const TYPED_LINE_MAX = 4096
const ESCAPE_SEQUENCE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/

/** A whole line was typed into a terminal: Termpolis's own (one main built), or one that changes
 *  the account by hand, which marks the terminal so (§6.1) and tells the renderer. */
function noteLine(terminalId: string, line: string, now: number): 'own' | 'by-hand' | null {
  const typed = line.trim()
  if (!typed) return null
  const mine = (ownLines.get(terminalId) ?? []).filter((l) => l.until > now)
  const at = mine.findIndex((l) => l.line === typed)
  if (at >= 0) {
    mine.splice(at, 1)
    ownLines.set(terminalId, mine)
    const end = wiring.outputEnd?.(terminalId)
    if (end !== undefined) agentStarts.set(terminalId, { at: end, commands: [typed] })
    return 'own'
  }
  if (!changesAccountByHand(typed)) return null
  byHand.add(terminalId)
  wiring.send?.(ACCOUNTS_IPC.terminalAccount, { terminalId, accountId: terminalAccounts.get(terminalId) ?? null, byHand: true })
  return 'by-hand'
}

/**
 * Every write to a terminal from the renderer (terminal:write), as typed: keystrokes are gathered
 * into the line they make until its Enter, with Backspace, Ctrl+U and Ctrl+C taken into account
 * and escape sequences (arrow keys) left out, and a write that holds whole lines (a paste,
 * Termpolis's own launch) is read line by line. Returns what the last whole line was.
 */
export function noteTypedInput(terminalId: string, typed: string, now: number = Date.now()): 'own' | 'by-hand' | null {
  let line = typedLines.get(terminalId) ?? ''
  let result: 'own' | 'by-hand' | null = null
  for (let i = 0; i < typed.length; i++) {
    const c = typed[i]
    if (c === '\r' || c === '\n') {
      result = noteLine(terminalId, line, now)
      line = ''
    } else if (c === '\x7f' || c === '\b') line = line.slice(0, -1)
    else if (c === '\x15' || c === '\x03') line = ''
    else if (c === '\x1b') i += (ESCAPE_SEQUENCE.exec(typed.slice(i)) as RegExpExecArray)[0].length - 1
    else if (c >= ' ' && line.length < TYPED_LINE_MAX) line += c
  }
  if (line) typedLines.set(terminalId, line)
  else typedLines.delete(terminalId)
  return result
}

/** The account Termpolis put this terminal on: undefined when it never did (a terminal from
 *  before accounts, or an agent started by hand), null for the default profile. */
export function terminalAccountId(terminalId: string): string | null | undefined {
  return terminalAccounts.get(terminalId)
}

/** Termpolis terminals Termpolis put on this account. */
export function terminalsOnAccount(accountId: string): number {
  let n = 0
  for (const id of terminalAccounts.values()) if (id === accountId) n++
  return n
}

export function _resetTerminalAccountsForTest(): void {
  terminalAccounts.clear()
  sessionIds.clear()
  ownLines.clear()
  typedLines.clear()
  byHand.clear()
  agentStarts.clear()
}

// ── Lookups index.ts uses ──────────────────────────────────────────────────────────────

export interface AccountTarget {
  account?: AgentAccount
  /** The account's profile, for a write: undefined for the default profile (the default files). */
  target?: ProfileTarget
  /** May Termpolis write into this account's profile or answer its prompts? False for an account
   *  the user didn't connect, and for one whose profile folder is gone: a write meant for it must
   *  never land in the default profile instead. */
  connected: boolean
}

/** Resolve an account id for a launch-time write (folder trust, the Codex prepare). An unknown or
 *  missing id is the default profile, today's behaviour (D13); a refusal is the caller's to make
 *  from `connected`. */
export function resolveAccountTarget(paths: Pick<AgentIntegrationPaths, 'home' | 'userData'>, accountId: unknown, fsx: AccountFs = accountFs): AccountTarget {
  if (typeof accountId !== 'string' || !accountId) return { connected: true }
  const loaded = loadAccounts(paths.userData, fsx)
  const account = loaded.ok ? findAccount(loaded.doc, accountId) : undefined
  if (!account) return { connected: true }
  if (!isProfileAgent(account.agent) || account.profile === null) return { account, connected: true }
  const dir = liveProfileDir(account, paths.home, fsx)
  if (!dir) return { account, connected: false }
  const claudeJson = claudeJsonOf(account, paths.home)
  return { account, target: { agent: account.agent, dir, ...(claudeJson ? { claudeJson } : {}), accountId: account.id }, connected: isAccountConnected(account) }
}

/** As resolveAccountTarget, for a launch of `agent`: another agent's account never resolves, so
 *  nothing meant for this launch is written into a profile of another agent's. */
export function resolveLaunchTarget(paths: Pick<AgentIntegrationPaths, 'home' | 'userData'>, accountId: unknown, agent: ProfileAgent, fsx: AccountFs = accountFs): AccountTarget {
  const r = resolveAccountTarget(paths, accountId, fsx)
  return r.account && r.account.agent !== agent ? { account: r.account, connected: false } : r
}

/** The CODEX_HOME to take home-folder trust out of for an account: none named for the default
 *  home (no account, or the default profile's), and an error, never the default home instead,
 *  for an account that isn't Codex's or whose folder is gone. Not gated on Connect: taking trust
 *  out is what the user asked for, on that account. */
export function codexHomeFor(paths: Pick<AgentIntegrationPaths, 'home' | 'userData'>, accountId: unknown, fsx: AccountFs = accountFs): { home?: string } | { error: string } {
  const { account, target } = resolveAccountTarget(paths, accountId, fsx)
  if (!account || (account.agent === 'codex' && account.profile === null)) return {}
  if (account.agent !== 'codex') return { error: `${account.label} is not a Codex account` }
  return target ? { home: target.dir } : { error: `${account.label}'s profile folder doesn't exist` }
}

/** Is the terminal on an account the user connected? A terminal Termpolis never put on an account
 *  runs on the default profile (D13). */
export function isTerminalAccountConnected(paths: Pick<AgentIntegrationPaths, 'home' | 'userData'>, terminalId: unknown): boolean {
  // An account changed by hand is one Termpolis doesn't know: it answers nothing there.
  if (typeof terminalId === 'string' && byHand.has(terminalId)) return false
  const id = typeof terminalId === 'string' ? terminalAccountId(terminalId) : undefined
  return resolveAccountTarget(paths, id ?? undefined).connected
}

/** The connected accounts' profiles, for agent integration's runtime. */
export function connectedProfileTargets(paths: Pick<AgentIntegrationPaths, 'home' | 'userData'>, fsx: AccountFs = accountFs): ProfileTarget[] {
  const loaded = loadAccounts(paths.userData, fsx)
  return loaded.ok ? accountProfileTargets(paths, loaded.doc, { connectedOnly: true }, fsx) : []
}

/** The `env` block of a Claude account's own settings.json, for the proxy's step-aside: undefined
 *  for no account or the default profile (the default reader decides), null when it has none. */
export function accountSettingsEnv(paths: Pick<AgentIntegrationPaths, 'home' | 'userData'>, accountId: unknown, fsx: AccountFs = accountFs): Record<string, unknown> | null | undefined {
  const { account, target } = resolveAccountTarget(paths, accountId, fsx)
  if (!account || account.agent !== 'claude' || account.profile === null) return undefined
  if (!target) return null
  const settings = readSettings(target.dir, fsx)
  const env = settings?.env
  return isRecord(env) ? env : null
}

// ── The view ───────────────────────────────────────────────────────────────────────────

/** A profile's settings.json, parsed; null when missing or unreadable. Not a credential. */
function readSettings(dir: string, fsx: AccountFs): Record<string, unknown> | null {
  try {
    const text = fsx.readText(join(dir, 'settings.json'))
    if (text === null) return null
    const v: unknown = JSON.parse(text.replace(/^\uFEFF/, '') || '{}')
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

/** Settings that outrank every profile's own sign-in: switching account changes nothing while one
 *  is set. Checked by name only; values are never stored, logged or shown. */
const AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']

function isOn(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const t = v.trim().toLowerCase()
  return t !== '' && t !== '0' && t !== 'false'
}

/** A StopFailure hook's command, shown only when it is plainly a script to run (a command line
 *  that could carry a token is not repeated on screen). */
function hookCommandShown(command: string): string {
  return /^[\w./~\\:-]+(\s+[\w./~\\:-]+){0,3}$/.test(command) && command.length <= 160 ? command : 'a StopFailure hook'
}

function firstStopFailureHook(settings: Record<string, unknown> | null): string | null {
  const hooks = settings?.hooks
  if (!isRecord(hooks) || !Array.isArray(hooks.StopFailure)) return null
  for (const group of hooks.StopFailure) {
    const items = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [group]
    for (const h of items) if (isRecord(h) && typeof h.command === 'string' && h.command.trim()) return h.command.trim()
  }
  return null
}

function adviceFor(doc: AccountsDoc, home: string, env: Readonly<Record<string, string | undefined>>, fsx: AccountFs): AccountsAdvice {
  const advice: AccountsAdvice = { stopFailureHooks: [], authOverrides: [] }
  for (const name of AUTH_ENV) if (env[name]?.trim()) advice.authOverrides.push(`${name} (Termpolis's environment)`)
  for (const name of PROVIDER_SWITCHES) if (isOn(env[name])) advice.authOverrides.push(`${name} (Termpolis's environment)`)
  for (const a of doc.file.accounts) {
    if (a.agent !== 'claude') continue
    const dir = liveProfileDir(a, home, fsx)
    const settings = dir ? readSettings(dir, fsx) : null
    if (!settings) continue
    const hook = firstStopFailureHook(settings)
    if (hook) advice.stopFailureHooks.push({ label: a.label, command: hookCommandShown(hook) })
    const block = isRecord(settings.env) ? settings.env : {}
    for (const name of AUTH_ENV) if (typeof block[name] === 'string' && block[name]) advice.authOverrides.push(`${name} (${a.label}'s settings.json)`)
    for (const name of PROVIDER_SWITCHES) if (isOn(block[name])) advice.authOverrides.push(`${name} (${a.label}'s settings.json)`)
    if (settings.apiKeyHelper !== undefined) advice.authOverrides.push(`apiKeyHelper (${a.label}'s settings.json)`)
  }
  return advice
}

/** A copied profile whose main profile's files changed since the copy. */
function recopyOffered(a: AgentAccount, live: string | null, home: string, fsx: AccountFs): boolean {
  if (!live || a.copiedAt === undefined || !isProfileAgent(a.agent)) return false
  const main = defaultProfileDir(a.agent, home)
  const copiedAt = a.copiedAt
  return copySources(a.agent).some((src) => (fsx.stat(join(main, src.name))?.mtimeMs ?? 0) > copiedAt)
}

function rowView(doc: AccountsDoc, a: AgentAccount, home: string, now: number, unlisted: number, fsx: AccountFs): AccountRowView {
  const folder = profileDirOf(a, home)
  const live = liveProfileDir(a, home, fsx)
  const row: AccountRowView = {
    id: a.id,
    agent: a.agent,
    label: a.label,
    profile: a.profile,
    folder,
    isDefault: isProfileAgent(a.agent) && a.profile === null,
    autoOffer: a.autoOffer,
    order: a.order,
    connect: a.connect,
    origin: a.origin,
    folderExists: !!live,
    shares: live && isProfileAgent(a.agent) && a.profile !== null ? discoverShares(a.agent, live, home, fsx) : [],
    lastEmail: lastSignedInAs(a, home, doc, fsx),
    connection: live && isProfileAgent(a.agent) ? profileConnection({ agent: a.agent, dir: live, claudeJson: claudeJsonOf(a, home) ?? undefined }) : null,
    bypassReady: a.agent === 'claude' && !!live && readSettings(live, fsx)?.skipDangerousModePermissionPrompt === true,
    terminals: terminalsOnAccount(a.id),
    recopyAvailable: recopyOffered(a, live, home, fsx),
  }
  if (a.email) row.email = a.email
  if (a.color) row.color = a.color
  if (a.importedAs) row.importedAs = a.importedAs
  const identity = doc.file.identity[a.id]
  if (identity) row.identity = identity
  const limit = activeLimit(doc, a, now)
  if (limit) row.limit = limit
  // The ~/.claude StopFailure hook's own record, as a floor. Ignored while accounts.sh lacks a
  // registered profile: the hook then names the wrong account.
  const marker = a.agent === 'claude' && unlisted === 0 ? limitedMarker(home, a.importedAs, fsx) : null
  if (marker !== null && now - marker * 1000 < cooldownFor(doc, 'claude') * 1000) row.limitedOutside = marker * 1000
  return row
}

export function sortedAccounts(doc: AccountsDoc): AgentAccount[] {
  return [...doc.file.accounts].sort((x, y) => ACCOUNT_AGENTS.indexOf(x.agent) - ACCOUNT_AGENTS.indexOf(y.agent) || x.order - y.order)
}

export function accountsView(
  doc: AccountsDoc,
  ctx: { home: string; integrationConnected: boolean; env: Readonly<Record<string, string | undefined>>; now: number; fsx: AccountFs },
): AccountsView {
  const drift = accountsShDrift(ctx.home, doc, ctx.fsx)
  return {
    accounts: sortedAccounts(doc).map((a) => rowView(doc, a, ctx.home, ctx.now, drift.unlisted, ctx.fsx)),
    preferred: { ...doc.file.preferred },
    chooser: doc.file.chooser,
    hidden: { ...(doc.file.hidden ?? {}) },
    integrationConnected: ctx.integrationConnected,
    importAvailable: readAccountsSh(ctx.home, ctx.fsx).kind !== 'missing',
    drift: drift.lines,
    advice: adviceFor(doc, ctx.home, ctx.env, ctx.fsx),
    home: ctx.home,
  }
}

// ── Registration ───────────────────────────────────────────────────────────────────────

/** A sign-in is watched for at most this long. */
export const SIGN_IN_WATCH_MS = 10 * 60 * 1000
/** How often the profile's .claude.json is stat'ed (never read) while a sign-in runs. */
export const SIGN_IN_POLL_MS = 3000

const SIGN_IN_METHODS: Readonly<Record<ProfileAgent, readonly SignInMethod[]>> = {
  claude: ['claudeai', 'console', 'sso'],
  codex: ['browser', 'device'],
}

/** A refreshing status check while a session holds the same sign-in can log that session out
 *  (refresh tokens rotate on use). Until a live test shows `claude auth status` and Codex's
 *  account/read never refresh (T2, T3), neither runs against a profile Termpolis has a terminal on. */
const CHECK_SKIPS_LIVE_PROFILES = true

/** The account a launch goes on, among the agent's (`accounts`, not empty): the one asked for
 *  while it is still registered; else the agent's preferred one; else its default profile; else
 *  its first. */
export function launchAccountOf(doc: AccountsDoc, accounts: readonly AgentAccount[], requested: unknown): AgentAccount {
  return accounts.find((a) => a.id === requested)
    ?? accounts.find((a) => a.id === doc.file.preferred[accounts[0].agent])
    ?? accounts.find((a) => a.profile === null)
    ?? accounts[0]
}

/** Which session a Claude Code command starts: the one it resumes (`--resume <id>`) or names
 *  (`--session-id <id>`); none it can tell (`--continue`, `--resume` with no id); or a new one,
 *  which a launch gives an id of its own so a switch can resume it. */
export function claudeSessionOf(command: string): { id: string | null; fresh: boolean } {
  const tokens = command.split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--resume' || t === '-r' || t === '--session-id') return { id: isSessionId(tokens[i + 1]) ? tokens[i + 1] : null, fresh: false }
    if (t === '--continue' || t === '-c' || t === '--fork-session') return { id: null, fresh: false }
  }
  return { id: null, fresh: true }
}

export function registerAccountsIpc(ipc: AccountsIpcLike, deps: AccountsIpcDeps): void {
  const fsx = deps.fsx ?? accountFs
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  const signedInNow = deps.signedInNow ?? ((agent, profile, d) => (agent === 'claude' ? claudeSignedInNow(profile, d) : codexSignedInNow(profile, d)))
  const startTimer = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const stopTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  /** The folder the user picked last, per agent, waiting for Add. */
  const picked = new Map<AccountAgent, string>()
  const watches = new Map<string, { timer: unknown; until: number; mtime: number | null; email: string | null }>()
  wiring.send = deps.send
  wiring.outputEnd = deps.outputEnd

  const view = (doc: AccountsDoc): AccountsView => {
    const p = deps.paths()
    return accountsView(doc, { home: p.home, integrationConnected: deps.integrationConnected(), env, now: now(), fsx })
  }
  const rowOf = (doc: AccountsDoc, id: string): AccountRowView | undefined => view(doc).accounts.find((r) => r.id === id)
  const userData = (): string => deps.paths().userData
  const handle = (channel: string, fn: (input: Record<string, unknown>) => unknown): void => {
    ipc.handle(channel, async (_e, input) => {
      try {
        return ok(await fn(isRecord(input) ? input : {}))
      } catch (e) {
        return err(message(e))
      }
    })
  }
  /** Load-change-save, or throw the refusal or the save error as the answer. */
  const update = <T>(mutate: (doc: AccountsDoc) => T): { value: T; doc: AccountsDoc } => {
    const r = updateAccounts(userData(), mutate, fsx)
    if (!r.ok) throw new Error(r.error)
    return r
  }
  const loadDoc = (): AccountsDoc => {
    const r = loadAccounts(userData(), fsx)
    if (!r.ok) throw new Error(r.error)
    return r.doc
  }
  const accountOf = (doc: AccountsDoc, id: unknown): AgentAccount => {
    const a = findAccount(doc, id)
    if (!a) throw new AccountsRefusal('that account isn\'t registered any more')
    return a
  }
  const targetOf = (a: AgentAccount): ProfileTarget | null => {
    if (!isProfileAgent(a.agent)) return null
    const dir = liveProfileDir(a, deps.paths().home, fsx)
    if (!dir) return null
    const claudeJson = claudeJsonOf(a, deps.paths().home)
    return { agent: a.agent, dir, ...(claudeJson ? { claudeJson } : {}), accountId: a.id }
  }
  const connectRows = (a: AgentAccount): AgentIntegrationChange[] => {
    const t = targetOf(a)
    if (!t || a.profile === null || !deps.integrationConnected()) return []
    return connectAccountProfile({ ...deps.runtime(), paths: deps.paths() }, t)
  }
  const uniqueLabel = (doc: AccountsDoc, agent: AccountAgent, label: string, selfId?: string): void => {
    if (doc.file.accounts.some((x) => x.agent === agent && x.id !== selfId && x.label.toLowerCase() === label.toLowerCase())) {
      throw new AccountsRefusal(`${ACCOUNT_AGENT_LABEL[agent]} already has an account named ${label}`)
    }
  }
  const nextOrder = (doc: AccountsDoc, agent: AccountAgent): number =>
    doc.file.accounts.filter((x) => x.agent === agent).reduce((m, x) => Math.max(m, x.order + 1), 0)

  /** The default profile, registered too the first time another one is added for its agent, so
   *  both show and either can be switched to. */
  const ensureDefault = (doc: AccountsDoc, agent: ProfileAgent): string | null => {
    if (doc.file.accounts.some((x) => x.agent === agent && x.profile === null)) return null
    const taken = (l: string): boolean => doc.file.accounts.some((x) => x.agent === agent && x.label.toLowerCase() === l)
    let label = 'main'
    for (let n = 2; taken(label); n++) label = `main ${n}`
    const account: AgentAccount = {
      id: newAccountId(), agent, label, profile: null, autoOffer: true, order: 0, connect: true, origin: 'adopted', links: [],
    }
    for (const x of doc.file.accounts) if (x.agent === agent) x.order += 1
    const email = lastSignedInAs(account, deps.paths().home, doc, fsx)
    if (email) account.email = email
    doc.file.accounts.push(account)
    return label
  }

  handle(ACCOUNTS_IPC.list, () => view(loadDoc()))

  handle(ACCOUNTS_IPC.pickFolder, async (input) => {
    const agent = input.agent === 'codex' ? 'codex' : 'claude'
    const folder = await deps.pickFolder(`Choose the ${ACCOUNT_AGENT_LABEL[agent]} profile folder`)
    if (!folder) {
      picked.delete(agent)
      return { folder: null }
    }
    const p = deps.paths()
    const checked = checkProfileFolder(agent, folder, { home: p.home, accounts: loadDoc().file.accounts }, fsx)
    if ('error' in checked) {
      picked.delete(agent)
      return { folder: tildifyPath(folder, p.home), error: checked.error }
    }
    picked.set(agent, folder)
    const dir = checked.profile ?? join(p.home, agent === 'claude' ? '.claude' : '.codex')
    return {
      folder: tildifyPath(dir, p.home),
      isDefault: checked.profile === null,
      shares: checked.profile ? discoverShares(agent, dir, p.home, fsx) : [],
      exists: fsx.exists(dir),
    }
  })

  handle(ACCOUNTS_IPC.add, (input): AddAccountResult => {
    const agent = ACCOUNT_AGENTS.find((a) => a === input.agent)
    const label = cleanLabel(input.label)
    if (!agent) throw new Error('unknown agent')
    if (!label) throw new Error('give the account a name: 1 to 40 characters')
    const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim() : undefined
    if (email !== undefined && !isPlainEmail(email)) throw new Error('that email address isn\'t a plain address')
    const autoOffer = input.autoOffer !== false
    const wantsConnect = input.connect === true
    const p = deps.paths()
    if (!isProfileAgent(agent)) {
      const { value } = update((doc) => {
        uniqueLabel(doc, agent, label)
        const account: AgentAccount = {
          id: newAccountId(), agent, label, profile: null, autoOffer, order: nextOrder(doc, agent), connect: false,
          origin: 'label', links: [], ...(email ? { email } : {}),
        }
        doc.file.accounts.push(account)
        return account.id
      })
      return { account: rowOf(loadDoc(), value) as AccountRowView, leftOut: [], copied: [], changes: [] }
    }
    const make = (folder: string, origin: AgentAccount['origin'], links: AgentAccount['links'], copied: readonly string[] = []) => (doc: AccountsDoc): { id: string; listed: string | null } => {
      uniqueLabel(doc, agent, label)
      const checked = checkProfileFolder(agent, folder, { home: p.home, accounts: doc.file.accounts }, fsx)
      if ('error' in checked) throw new AccountsRefusal(checked.error)
      const listed = checked.profile === null ? null : ensureDefault(doc, agent)
      const account: AgentAccount = {
        id: newAccountId(), agent, label, profile: checked.profile, autoOffer, order: nextOrder(doc, agent),
        connect: checked.profile === null ? true : wantsConnect, origin, links, ...(email ? { email } : {}),
        ...(copied.length ? { copiedAt: now() } : {}),
      }
      doc.file.accounts.push(account)
      return { id: account.id, listed }
    }
    // The name is checked before any folder is made for it.
    uniqueLabel(loadDoc(), agent, label)
    let id: string
    let listed: string | null = null
    let copied: string[] = []
    let leftOut: string[] = []
    let notes: string[] = []
    if (input.folder === 'existing') {
      const folder = picked.get(agent)
      if (!folder) throw new Error('choose the folder first')
      const r = update(make(folder, 'adopted', []))
      picked.delete(agent)
      id = r.value.id
      listed = r.value.listed
    } else {
      const slug = slugOf(label)
      if (!slug) throw new Error('the name gives no folder name: use letters or digits')
      const allowed = SHAREABLE_FOLDERS[agent].map((f) => f.name)
      const share = Array.isArray(input.share)
        ? input.share.filter((s): s is string => typeof s === 'string' && allowed.includes(s))
        : SHAREABLE_FOLDERS[agent].filter((f) => f.on).map((f) => f.name)
      const made: { id: string; listed: string | null } = { id: '', listed: null }
      const created = createProfile({
        agent, home: p.home, slug, share, copy: input.copy !== false,
        commit: (dir, links, copiedFiles) => {
          const r = updateAccounts(userData(), make(dir, 'created', links, copiedFiles), fsx)
          if (!r.ok) return r.error
          Object.assign(made, r.value)
          return null
        },
      }, fsx)
      if (!created.ok) throw new Error(created.leftAt ? `${created.error}. Some of it is still in ${tildifyPath(created.leftAt, p.home)}` : created.error)
      id = made.id
      listed = made.listed
      copied = created.copied
      leftOut = created.leftOut
      notes = created.notes
    }
    const doc = loadDoc()
    const account = findAccount(doc, id) as AgentAccount
    const changes = account.connect ? connectRows(account) : []
    const result: AddAccountResult = { account: rowOf(loadDoc(), id) as AccountRowView, leftOut, copied, changes }
    if (listed) notes = [`Your main ${ACCOUNT_AGENT_LABEL[agent]} profile is listed too, as ${listed}.`, ...notes]
    if (notes.length) result.notes = notes
    if (agent === 'claude' && account.profile) {
      const lines = accountsShLines(p.home, label, email, account.profile, fsx)
      if (lines) result.accountsShLines = lines
    }
    return result
  })

  handle(ACCOUNTS_IPC.update, (input) => {
    const { doc } = update((d) => {
      const a = accountOf(d, input.id)
      if (input.label !== undefined) {
        const label = cleanLabel(input.label)
        if (!label) throw new AccountsRefusal('give the account a name: 1 to 40 characters')
        uniqueLabel(d, a.agent, label, a.id)
        a.label = label
      }
      if (input.email !== undefined) {
        const email = typeof input.email === 'string' ? input.email.trim() : ''
        if (email && !isPlainEmail(email)) throw new AccountsRefusal('that email address isn\'t a plain address')
        if (email) a.email = email
        else delete a.email
      }
      if (typeof input.autoOffer === 'boolean') a.autoOffer = input.autoOffer
      if (input.color !== undefined) {
        if (typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)) a.color = input.color
        else delete a.color
      }
    })
    return rowOf(doc, String(input.id))
  })

  handle(ACCOUNTS_IPC.move, (input) => {
    const { doc } = update((d) => {
      const a = accountOf(d, input.id)
      const step = input.by === -1 ? -1 : 1
      const list = sortedAccounts(d).filter((x) => x.agent === a.agent)
      list.forEach((x, i) => { x.order = i })
      const i = list.indexOf(a)
      const j = i + step
      if (j < 0 || j >= list.length) return
      list[i].order = j
      list[j].order = i
    })
    return view(doc)
  })

  handle(ACCOUNTS_IPC.remove, (input) => {
    const a = accountOf(loadDoc(), input.id)
    const t = targetOf(a)
    // Termpolis's own entries come out of the profile; the folder, its sign-in and its links stay.
    const changes = t && a.profile !== null ? disconnectAccountProfile(deps.paths(), t) : []
    update((d) => {
      d.file.accounts = d.file.accounts.filter((x) => x.id !== a.id)
      for (const ag of ACCOUNT_AGENTS) if (d.file.preferred[ag] === a.id) delete d.file.preferred[ag]
      delete d.file.limits[a.id]
      delete d.file.identity[a.id]
    })
    return { changes }
  })

  handle(ACCOUNTS_IPC.setConnect, (input) => {
    const connect = input.connect === true
    const doc = loadDoc()
    const a = accountOf(doc, input.id)
    if (!isProfileAgent(a.agent)) throw new Error('the Antigravity CLI has no profile to connect')
    if (a.profile === null) throw new Error('the main profile is connected through Agent Integration')
    if (connect && !deps.integrationConnected()) throw new Error('Turn on Agent Integration first')
    update((d) => { accountOf(d, a.id).connect = connect })
    const t = targetOf(a)
    const changes = !t ? [] : connect ? connectRows({ ...a, connect }) : disconnectAccountProfile(deps.paths(), t)
    return { changes, account: rowOf(loadDoc(), a.id) }
  })

  handle(ACCOUNTS_IPC.recopy, (input): RecopyView => {
    const a = accountOf(loadDoc(), input.id)
    if (!isProfileAgent(a.agent) || a.copiedAt === undefined) throw new Error(`${a.label} was never started from a copy of your main profile`)
    const home = deps.paths().home
    const dir = liveProfileDir(a, home, fsx)
    if (!dir) throw new Error(`${a.label}'s profile folder doesn't exist`)
    const r = recopyProfile(a.agent, home, dir, fsx)
    if (!r.ok) throw new Error(r.error)
    const { doc } = update((d) => { accountOf(d, a.id).copiedAt = now() })
    // The fresh copy has Termpolis's entries taken out: a connected profile gets them back.
    const changes = a.connect ? connectRows(a) : []
    return { copied: r.copied, leftOut: r.leftOut, changes, account: rowOf(doc, a.id) }
  })

  handle(ACCOUNTS_IPC.stripCopied, (input) => {
    const a = accountOf(loadDoc(), input.id)
    const t = targetOf(a)
    if (!t || a.agent !== 'claude') throw new Error('only a Claude Code profile has a settings.json to clean')
    return { changes: stripCopiedEntries(t), account: rowOf(loadDoc(), a.id) }
  })

  handle(ACCOUNTS_IPC.setPreferred, (input) => {
    const agent = ACCOUNT_AGENTS.find((x) => x === input.agent)
    if (!agent) throw new Error('unknown agent')
    const { doc } = update((d) => {
      if (input.id === null || input.id === undefined || input.id === '') {
        delete d.file.preferred[agent]
        return
      }
      const a = accountOf(d, input.id)
      if (a.agent !== agent) throw new AccountsRefusal('that account belongs to another agent')
      d.file.preferred[agent] = a.id
    })
    return view(doc)
  })

  handle(ACCOUNTS_IPC.setChooser, (input) => view(update((d) => { d.file.chooser = input.on !== false }).doc))

  handle(ACCOUNTS_IPC.hideAdvice, (input) => {
    const which = (['hookAdvice', 'authEnvAdvice', 'limitBanner'] as const).find((w) => w === input.which)
    if (!which) throw new Error('unknown notice')
    return view(update((d) => { d.file.hidden = { ...(d.file.hidden ?? {}), [which]: true } }).doc)
  })

  handle(ACCOUNTS_IPC.importPreview, (): ImportPreview => {
    const r = previewAccountsSh(deps.paths().home, loadDoc(), fsx)
    if ('error' in r) throw new Error(r.error)
    return r
  })

  handle(ACCOUNTS_IPC.import, (input) => {
    const p = deps.paths()
    const wanted = isRecord(input.connect) ? input.connect : {}
    const added: string[] = []
    const { doc } = update((d) => {
      const preview = previewAccountsSh(p.home, d, fsx)
      if ('error' in preview) throw new AccountsRefusal(preview.error)
      const keys = Array.isArray(input.keys) ? input.keys.filter((k): k is string => typeof k === 'string') : null
      for (const row of preview.rows) {
        if (row.registered || (keys && !keys.includes(row.key))) continue
        if (d.file.accounts.some((x) => x.agent === 'claude' && x.label.toLowerCase() === row.label.toLowerCase())) continue
        const account: AgentAccount = {
          id: newAccountId(), agent: 'claude', label: row.label, profile: row.profile, autoOffer: row.autoOffer,
          order: nextOrder(d, 'claude'), connect: row.profile === null ? true : wanted[row.key] === true,
          origin: 'accounts-sh', importedAs: row.key, links: [], ...(row.email ? { email: row.email } : {}),
        }
        d.file.accounts.push(account)
        added.push(account.id)
      }
      if (preview.cooldownSec && d.file.cooldownSec.claude === undefined) d.file.cooldownSec.claude = preview.cooldownSec
    })
    const changes: AgentIntegrationChange[] = []
    for (const id of added) {
      const a = findAccount(doc, id) as AgentAccount
      if (a.connect) changes.push(...connectRows(a))
    }
    return { added: added.length, changes, view: view(loadDoc()) }
  })

  /** "Signed in now" for an account, from its agent's own status command, kept in the registry.
   *  Throws why it couldn't ask. */
  const checkNow = async (a: AgentAccount): Promise<{ identity: AccountIdentity; doc: AccountsDoc }> => {
    if (!isProfileAgent(a.agent)) throw new Error('Termpolis can\'t ask the Antigravity CLI who is signed in: it shows the email on its own screen')
    if (!liveProfileDir(a, deps.paths().home, fsx)) throw new Error(`${a.label}'s profile folder doesn't exist`)
    if (CHECK_SKIPS_LIVE_PROFILES && terminalsOnAccount(a.id) > 0) {
      throw new Error(`A Termpolis terminal is running on ${a.label}, so Termpolis doesn't ask ${ACCOUNT_AGENT_LABEL[a.agent]} now: a check could refresh the sign-in that terminal uses. Close it, or read "last signed in as".`)
    }
    const r = await signedInNow(a.agent, a.profile, { cwd: deps.checkCwd(), env })
    if ('error' in r) throw new Error(r.error)
    const identity: AccountIdentity = r.identity
    return { identity, doc: update((d) => { d.file.identity[a.id] = identity }).doc }
  }

  handle(ACCOUNTS_IPC.check, async (input) => {
    const a = accountOf(loadDoc(), input.id)
    return rowOf((await checkNow(a)).doc, a.id)
  })

  handle(ACCOUNTS_IPC.signInLine, (input) => {
    const a = accountOf(loadDoc(), input.accountId)
    if (!isProfileAgent(a.agent)) throw new Error('the Antigravity CLI signs in on its own screen')
    const family = familyOf(String(input.shellType ?? ''))
    if (!family) throw new Error('Termpolis can\'t type a sign-in line into that shell')
    const methods = SIGN_IN_METHODS[a.agent]
    const method = methods.find((m) => m === input.method) ?? methods[0]
    const line = accountLine(family, accountEnv(a, a.agent), signInCommand(a.agent, family, method, a.email))
    if ('refused' in line) throw new Error(`Termpolis won't type that line: ${line.refused}`)
    // Termpolis knows only its own terminals (it never lists processes), so the warning always
    // names the sessions it can't see.
    const n = terminalsOnAccount(a.id)
    const outside = `any ${ACCOUNT_AGENT_LABEL[a.agent]} window outside Termpolis that uses this profile, including scheduled jobs`
    const why = 'a session still running there can overwrite a new sign-in when it refreshes.'
    const warning = n > 0
      ? `Close the ${n} Termpolis terminal${n === 1 ? '' : 's'} running on ${a.label} first, and ${outside}: ${why}`
      : `Close ${outside} first: ${why}`
    return { line: line.line, warning, name: signInTerminalName(a.agent, a.label) }
  })

  handle(ACCOUNTS_IPC.watchSignIn, (input) => {
    const a = accountOf(loadDoc(), input.accountId)
    if (!isProfileAgent(a.agent)) return { watching: false }
    const home = deps.paths().home
    const claudeJson = claudeJsonOf(a, home)
    const file = claudeJson && isReachable(claudeJson) ? claudeJson : null
    // The sign-in terminal and its output's end before the line was typed: the shell's next
    // prompt after it means the CLI's own sign-in command has finished, signed in or not.
    const terminalId = typeof input.terminalId === 'string' && input.terminalId ? input.terminalId : null
    const mark = typeof input.mark === 'number' && Number.isFinite(input.mark) && input.mark > 0 ? input.mark : 0
    const prompted = terminalId && deps.promptSince ? (): boolean => (deps.promptSince as NonNullable<AccountsIpcDeps['promptSince']>)(terminalId, mark) : null
    // Codex keeps nothing Termpolis may read until its sign-in is done: only its shell's prompt
    // says when that is.
    if (!file && !prompted) return { watching: false }
    const existing = watches.get(a.id)
    if (existing) stopTimer(existing.timer)
    const mtimeOf = (): number | null => (file ? fsx.stat(file)?.mtimeMs ?? null : null)
    const readEmail = (): string | null => {
      if (!file) return null
      const r = readClaudeJsonFields(file, ['oauthAccount.emailAddress'])
      const e = r.kind === 'ok' ? r.values['oauthAccount.emailAddress'] : undefined
      return isPlainEmail(e) ? e : null
    }
    const w = { timer: null as unknown, until: now() + SIGN_IN_WATCH_MS, mtime: mtimeOf(), email: readEmail() }
    const end = (): void => {
      stopTimer(w.timer)
      watches.delete(a.id)
    }
    /** Once the command finished: "signed in now", asked once, and the watch's last word. */
    const finish = async (): Promise<void> => {
      const done: SignInProgress = { accountId: a.id, done: true, email: readEmail() }
      try {
        const { identity } = await checkNow(a)
        done.identity = identity
        if (identity.email) done.email = identity.email
      } catch (e) {
        done.checkError = message(e)
      }
      deps.send(ACCOUNTS_IPC.signInProgress, done)
    }
    w.timer = startTimer(() => {
      if (now() > w.until) {
        end()
        deps.send(ACCOUNTS_IPC.signInProgress, { accountId: a.id, done: true, email: w.email })
        return
      }
      if (prompted && prompted()) {
        end()
        void finish()
        return
      }
      // A stat is not a read: the file is read, for its named field only, when it changed.
      const m = mtimeOf()
      if (m === w.mtime) return
      w.mtime = m
      const email = readEmail()
      if (email === w.email) return
      w.email = email
      deps.send(ACCOUNTS_IPC.signInProgress, { accountId: a.id, done: false, email })
    }, SIGN_IN_POLL_MS)
    watches.set(a.id, w)
    return { watching: true }
  })

  handle(ACCOUNTS_IPC.stopSignIn, (input) => {
    const id = typeof input.accountId === 'string' ? input.accountId : ''
    const w = watches.get(id)
    if (w) {
      stopTimer(w.timer)
      watches.delete(id)
    }
    return { stopped: !!w }
  })

  // The account a launch of `agent` goes on, before its line is built: its folder trust and its
  // Codex prepare are written into that account's profile.
  handle(ACCOUNTS_IPC.launchAccount, (input): { accountId: string | null } => {
    const agent = ACCOUNT_AGENTS.find((a) => a === input.agent)
    if (!agent) throw new Error('unknown agent')
    const loaded = loadAccounts(userData(), fsx)
    const accounts = loaded.ok ? sortedAccounts(loaded.doc).filter((a) => a.agent === agent) : []
    return { accountId: loaded.ok && accounts.length > 0 ? launchAccountOf(loaded.doc, accounts, input.accountId).id : null }
  })

  handle(ACCOUNTS_IPC.launchLine, (input): LaunchLineResult => {
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    const agent = ACCOUNT_AGENTS.find((a) => a === input.agent)
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!terminalId) throw new Error('which terminal?')
    if (!agent) throw new Error('unknown agent')
    if (!command) throw new Error('there is no command to run')
    // With no account for the agent, or a registry that can't be read, the launch is today's: the
    // bare command on the default profile, and nothing recorded (D13).
    const loaded = loadAccounts(userData(), fsx)
    const accounts = loaded.ok ? sortedAccounts(loaded.doc).filter((a) => a.agent === agent) : []
    if (!loaded.ok || accounts.length === 0) return { line: command, accountId: null, explicit: false }
    const account = launchAccountOf(loaded.doc, accounts, input.accountId)
    // Named on the line once the agent has more than one account: a CLAUDE_CONFIG_DIR a shell's rc
    // file exports can't then move the launch (§6.2). The default profile's line unsets it.
    const explicit = accounts.length > 1 || (isProfileAgent(agent) && account.profile !== null)
    let line = command
    let sessionId: string | undefined
    if (explicit) {
      let typed = command
      if (agent === 'claude') {
        const session = claudeSessionOf(command)
        sessionId = session.id ?? undefined
        if (session.fresh) {
          sessionId = randomUUID()
          typed = `${command} --session-id ${sessionId}`
        }
      }
      const family = familyOf(String(input.shellType ?? ''))
      if (!family) throw new Error('Termpolis can\'t type an account line into that shell')
      const built = accountLine(family, accountEnv(account, agent), typed)
      if ('refused' in built) throw new Error(`Termpolis won't type that line: ${built.refused}`)
      line = built.line
    }
    noteTerminalAccount(terminalId, account.id)
    if (agent === 'claude') noteTerminalSession(terminalId, sessionId ?? null)
    const t = now()
    ownLines.set(terminalId, [...(ownLines.get(terminalId) ?? []).filter((l) => l.until > t), { line, until: t + OWN_LINE_MS }])
    return { line, accountId: account.id, explicit, ...(sessionId ? { sessionId } : {}) }
  })

  handle(ACCOUNTS_IPC.switchAccount, async (input): Promise<SwitchOutcome> => {
    const io = deps.switchIO
    if (!io) throw new Error('switching accounts isn\'t available')
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) throw new Error('which terminal?')
    const req: SwitchRequest = { terminalId, targetId: String(input.targetId ?? ''), shellType: String(input.shellType ?? '') }
    if (typeof input.instructions === 'string') req.instructions = input.instructions
    for (const flag of ['assumeExited', 'stopBusy', 'fresh'] as const) if (input[flag] === true) req[flag] = true
    if (typeof input.reason === 'string') req.reason = input.reason.slice(0, 80)
    const doc = loadDoc()
    const target = accountOf(doc, req.targetId)
    if (!isProfileAgent(target.agent)) throw new Error('the Antigravity CLI switches through its own sign-in')
    const home = deps.paths().home
    const currentId = terminalAccountId(terminalId)
    const source = currentId ? findAccount(doc, currentId) : undefined
    if (source && source.agent !== target.agent) throw new Error(`this terminal runs ${ACCOUNT_AGENT_LABEL[source.agent]}, not ${ACCOUNT_AGENT_LABEL[target.agent]}`)
    if (source && source.id === target.id && !isAccountChangedByHand(terminalId)) throw new Error(`this terminal already runs on ${target.label}`)
    if (target.profile !== null && !liveProfileDir(target, home, fsx)) throw new Error(`${target.label}'s profile folder doesn't exist`)
    const agent = target.agent
    // Claude Code: where this conversation's transcript can be, and where the target looks for it.
    const projectsOf = (a: AgentAccount): string => join(profileDirOf(a, home) as string, 'projects')
    const targetProjects = projectsOf(target)
    const sourceProjects = source && !isAccountChangedByHand(terminalId)
      ? [projectsOf(source)]
      : [...new Set([join(defaultProfileDir('claude', home), 'projects'), ...doc.file.accounts.filter((a) => a.agent === 'claude').map(projectsOf)])]
    const outcome = await runAccountSwitch(req, {
      io: { ...io, progress: (p) => deps.send(ACCOUNTS_IPC.switchProgress, p) },
      target,
      agent,
      ...(source ? { source } : {}),
      ...(terminalAgentStart(terminalId) ? { start: terminalAgentStart(terminalId) } : {}),
      ...(terminalSessionId(terminalId) ? { sessionId: terminalSessionId(terminalId) } : {}),
      hasTranscript: (id) => findTranscript([...sourceProjects, targetProjects], id, fsx) !== null,
      carry: (id) => {
        const r = carryTranscript(sourceProjects, targetProjects, id, now(), fsx)
        return r.kind === 'carried' ? { carried: true, ...(r.kept ? { kept: r.kept } : {}) } : { carried: false }
      },
      newSessionId: () => randomUUID(),
      record: (r) => {
        noteTerminalAccount(terminalId, r.accountId)
        noteAgentStart(terminalId, r.start)
        if (agent === 'claude') noteTerminalSession(terminalId, r.sessionId)
        deps.send(ACCOUNTS_IPC.terminalAccount, { terminalId, accountId: r.accountId, byHand: false })
      },
    })
    // Labels only, never emails.
    console.log(`[accounts] switch of a ${ACCOUNT_AGENT_LABEL[agent]} terminal from ${source?.label ?? 'an account Termpolis didn\'t know'} to ${target.label}${req.reason ? ` (${req.reason})` : ''}: ${outcome.kind}`)
    return outcome
  })

  handle(ACCOUNTS_IPC.agySwitch, async (input): Promise<AgyStepOutcome> => {
    const io = deps.switchIO
    if (!io) throw new Error('switching accounts isn\'t available')
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) throw new Error('which terminal?')
    const step = (['sign-out', 'login', 'check', 'resume'] as const).find((s) => s === input.step)
    if (!step) throw new Error('unknown step')
    const target = accountOf(loadDoc(), input.targetId)
    if (target.agent !== 'agy') throw new Error(`${target.label} is not an Antigravity CLI account`)
    const req: AgyStepRequest = { terminalId, targetId: target.id, shellType: String(input.shellType ?? ''), step }
    if (isSessionId(input.conversationId)) req.conversationId = input.conversationId
    if (typeof input.mark === 'number' && Number.isFinite(input.mark) && input.mark >= 0) req.mark = input.mark
    if (input.assumeExited === true) req.assumeExited = true
    const outcome = await runAgyStep(req, {
      io,
      ...(terminalAgentStart(terminalId) ? { start: terminalAgentStart(terminalId) } : {}),
      env,
      record: (r) => noteAgentStart(terminalId, r.start),
    })
    if (outcome.kind === 'switched') {
      // One Google sign-in for the computer user: every agy terminal Termpolis knows moved with it,
      // and new ones launch on it.
      const doc = loadDoc()
      const agyIds = new Set(doc.file.accounts.filter((a) => a.agent === 'agy').map((a) => a.id))
      const moved = new Set([terminalId])
      for (const [tid, aid] of terminalAccounts) if (aid !== null && agyIds.has(aid)) moved.add(tid)
      for (const tid of moved) {
        noteTerminalAccount(tid, target.id)
        deps.send(ACCOUNTS_IPC.terminalAccount, { terminalId: tid, accountId: target.id, byHand: false })
      }
      update((d) => { d.file.preferred.agy = target.id })
      console.log(`[accounts] agy moved to ${target.label}: ${moved.size} terminal${moved.size === 1 ? '' : 's'}`)
    }
    return outcome
  })

  // The model picker's half of the relaunch lock (§7.5, R7): while it types, MCP clients and the
  // phone are refused and every write but the picker's own is dropped. Its line counts as the
  // agent's start once typed, so a later switch relaunches the model it picked.
  handle(ACCOUNTS_IPC.modelHold, (input): ModelHold => {
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) throw new Error('which terminal?')
    const line = typeof input.line === 'string' ? input.line.trim() : ''
    if (!line) throw new Error('there is no command to run')
    // A model change keeps the account: its line is never one that changes it.
    if (changesAccountByHand(line)) throw new Error('a model change doesn\'t change the account')
    const t = now()
    const key = holdForModel(terminalId, t)
    if (!key) throw new Error(MODEL_HELD)
    ownLines.set(terminalId, [...(ownLines.get(terminalId) ?? []).filter((l) => l.until > t), { line, until: t + OWN_LINE_MS }])
    return { key }
  })

  handle(ACCOUNTS_IPC.modelRelease, (input) => {
    if (typeof input.terminalId === 'string' && typeof input.key === 'string') releaseModelHold(input.terminalId, input.key)
    return true
  })

  handle(ACCOUNTS_IPC.noteLimit, (input) => {
    const limit = cleanLimit(input, now())
    if (!limit) throw new Error('that is not a usage limit')
    const { doc } = update((d) => { d.file.limits[accountOf(d, input.id).id] = limit })
    return rowOf(doc, String(input.id))
  })

  handle(ACCOUNTS_IPC.clearLimit, (input) => {
    const { doc } = update((d) => { delete d.file.limits[accountOf(d, input.id).id] })
    return rowOf(doc, String(input.id))
  })
}

