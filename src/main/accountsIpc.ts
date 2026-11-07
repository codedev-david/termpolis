// Settings ▸ Accounts, main side: the IPC the Accounts tab and its sign-in terminal call, plus the
// few lookups index.ts needs to launch, trust and route on an account. Every file goes through
// agentAccounts.ts and accountFs.ts, so nothing here can open a sign-in; the renderer never passes
// a path (a folder is picked with main's own dialog and remembered here), and what it is shown of
// a profile is the view below: labels, emails, folders and states, never a config file.
//
// Logs hold account labels, never emails.
import { randomUUID } from 'crypto'
import { join } from 'path'
import { MODEL_HELD, changesAccountByHand, completesSwitchAccount, isSessionId } from '../shared/accountSwitch'
import type { AgyStepOutcome, AgyStepRequest, ModelHold, SwitchOutcome, SwitchRequest } from '../shared/accountSwitch'
import { AGY_ENV_AUTH, runAgyStep } from './agySwitch'
import { endSignIns, endSignInsOf, signInInput, startSignInSession } from './signInSession'
import type { SessionDeps } from './signInSession'
import { killProcessTree } from './processTree'
import type { SignInInput, SignInState } from '../shared/signInScreens'
import { carryTranscript, findTranscript } from './accountCarry'
import { holdForModel, holdsModelKey, look, releaseModelHold, runAccountSwitch } from './accountSwitch'
import type { Look, SwitchIO } from './accountSwitch'
import { agentGone, agentOfLaunch, lookForLimit, noteEnteredLine } from './limitLook'
import { setExtraTranscriptRoots } from './conversationIngest'
import type { ConversationSource } from './conversationIngest'
import type { LiveStart } from './limitLook'
import type { LimitLook } from '../shared/accountLimits'
import {
  ACCOUNTS_IPC, ACCOUNT_AGENTS, ACCOUNT_AGENT_LABEL, PROFILE_AGENTS, PROFILE_VARIABLE, SHAREABLE_FOLDERS, accountEnv, accountLine,
  cleanLabel, familyOf, isPlainEmail, isProfileAgent, signInArgs, slugOf, tildifyPath,
} from '../shared/agentAccounts'
import type {
  AccountAgent, AccountIdentity, AccountRowView, AccountsAdvice, AccountsView, AddAccountResult, AgentAccount,
  ImportPreview, LaunchLineResult, ProfileAgent, RecopyView, SignInMethod,
} from '../shared/agentAccounts'
import type { AgentIntegrationChange } from '../shared/agentIntegration'
import { accountFs } from './accountFs'
import type { AccountFs } from './accountFs'
import { claudeSignedInNow, codexSignedInNow, findOnPath, resolveCli, shimInvocation } from './accountIdentity'
import type { CheckDeps, IdentityCheck } from './accountIdentity'
import { copySources, createProfile, recopyProfile } from './accountProfiles'
import {
  AccountsRefusal, accountProfileTargets, accountsShDrift, accountsShLines, activeLimit, checkProfileFolder,
  claudeJsonOf, cleanLimit, comparisonKey, cooldownFor, defaultProfileDir, discoverShares, findAccount, isAccountConnected,
  lastSignedInAs, limitedMarker, liveProfileDir, liveProfileDirAsync, loadAccounts, loadAccountsAsync, newAccountId, previewAccountsSh, profileDirOf,
  readAccountsSh, updateAccounts,
} from './agentAccounts'
import type { AccountsDoc, ProfileTarget } from './agentAccounts'
import type { AgentIntegrationPaths, AgentIntegrationRuntime } from './agentIntegrationManager'
import {
  connectAccountProfile, disconnectAccountProfile, profileConnection, stripCopiedEntries,
} from './agentIntegrationManager'
import { err, ok } from './ipcResult'
import { userRoutingVar } from './headroomProxy/proxySupervisor'
import { getExtendedPath } from './agentPaths'

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
  /** Where the terminal's output ends now (its buffer's next offset): where an agent a line
   *  started begins. */
  outputEnd?: (terminalId: string) => number
  /** The terminals' buffers and PTYs, for a switch (accountSwitch.ts); none, no switch. */
  switchIO?: Omit<SwitchIO, 'progress'>
  /** For tests: the status commands. */
  signedInNow?: (agent: ProfileAgent, profile: string | null, deps: CheckDeps) => Promise<IdentityCheck>
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  /** Opens a provider's sign-in page in the user's browser (shell.openExternal): the sign-in
   *  sheet's Open again, on the user's click only. */
  openExternal?: (url: string) => void
  /** For tests: the sign-in session's PTY (node-pty's spawn), and the CLI it runs. */
  signInSpawn?: SessionDeps['spawn']
  signInCli?: (agent: AccountAgent, args: string[], env: Record<string, string>) => SignInCli
  /** For tests: the sign-in session's clock and its sleep. */
  sleep?: (ms: number) => Promise<void>
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
  // A restart line printed before this is of an agent Termpolis has since put on an account itself: not held against it.
  try { wiring.io?.restarted?.(terminalId) } catch { /* nothing to forget */ }
}

/** Marks the terminal's account as unknown to Termpolis, which keeps what it last knew for the chip to say: something moved it that
 *  no line Termpolis typed shows (§6.1). The renderer is told. */
function markByHand(terminalId: string): void {
  byHand.add(terminalId)
  wiring.send?.(ACCOUNTS_IPC.terminalAccount, { terminalId, accountId: terminalAccounts.get(terminalId) ?? null, byHand: true })
}

/** David's own wrapper printed that it starts Claude Code again here on another profile (SW3-3): a /switch-account that Claude's own
 *  completion or history made, which the keys main saw do not spell out. The terminal is then of an account Termpolis does not know. */
function noteRestarted(terminalId: string): void {
  let restarted = false
  try { restarted = wiring.io?.restarted?.(terminalId) === true } catch { /* no sign read */ }
  if (restarted && !byHand.has(terminalId)) markByHand(terminalId)
}

export function forgetTerminalAccount(terminalId: string): void {
  terminalAccounts.delete(terminalId)
  sessionIds.delete(terminalId)
  ownLines.delete(terminalId)
  typedLines.delete(terminalId)
  editedLines.delete(terminalId)
  byHand.delete(terminalId)
  unsettled.delete(terminalId)
  agentStarts.delete(terminalId)
  screenReleased.delete(terminalId)
  workers.delete(terminalId)
  shellAccounts.delete(terminalId)
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
const ownLines = new Map<string, Array<{ line: string; until: number; agent: AccountAgent }>>()

/** Remembers a line main built for a terminal, for OWN_LINE_MS: once typed, it is Termpolis's own,
 *  and starts `agent` (a launch's line can name it otherwise: a test shim, a wrapper). */
function noteOwnLine(terminalId: string, line: string, now: number, agent: AccountAgent): void {
  ownLines.set(terminalId, [...(ownLines.get(terminalId) ?? []).filter((l) => l.until > now), { line, until: now + OWN_LINE_MS, agent }])
}
/** What was typed into each terminal since its last Enter, gathered from keystrokes. */
const typedLines = new Map<string, string>()
/** Terminals whose account a line typed by hand changed: Termpolis no longer knows it. */
const byHand = new Set<string>()
/** Terminals a switch put on an account but whose agent did not come up on it (nothing showed, a
 *  question to answer, a sign-in screen): they run on the target by Termpolis's record, and the same
 *  switch asked again is the user's retry, not a switch to where it already is. */
const unsettled = new Set<string>()

/** Where each terminal's agent was started in its output, and the line that started it: what the
 *  switch reads its exit and its relaunch from (accountSwitch.ts), as submit does run_command's,
 *  and the usage-limit chooser the agent's lifecycle (limitLook.ts). */
export type AgentStart = LiveStart
const agentStarts = new Map<string, AgentStart>()

export function terminalAgentStart(terminalId: string): AgentStart | undefined {
  return agentStarts.get(terminalId)
}

/** A start as main records it: the agent its line names, and when, with nothing seen of it yet. */
function startRecord(start: AgentStart, now: number): AgentStart {
  const agent = start.agent ?? agentOfLaunch(start.commands[0] ?? '')
  return { at: start.at, commands: start.commands, ...(agent ? { agent } : {}), time: start.time ?? now }
}

/** Records the agent started in a terminal, and has main keep that terminal's screen from now on: a replay
 *  of the 32 KB window it retains loses the input box of an agent that has worked a while (F-R2-2). A
 *  terminal that cannot keep one still has its start recorded, and its window is replayed. */
function setStart(terminalId: string, start: AgentStart): void {
  agentStarts.set(terminalId, start)
  screenReleased.delete(terminalId)
  try { wiring.io?.watch?.(terminalId) } catch { /* replayed from the window then */ }
}

/** Terminals whose kept screen was let go because their agent was seen gone: until the next recorded start, which keeps one again. */
const screenReleased = new Set<string>()

/** Lets go of the terminal's kept screen once its agent is seen gone, once: nothing reads it then, and drawing every chunk the terminal prints
 *  on it, its whole life, is the main thread's time (SAFETY-R3-8). The reads replay the window meanwhile, as they did before F-R2-2. */
function releaseScreen(terminalId: string): void {
  if (screenReleased.has(terminalId) || agentStarts.get(terminalId)?.ended !== true) return
  screenReleased.add(terminalId)
  try { wiring.io?.unwatch?.(terminalId) } catch { /* it is let go at the next start's watch, or lives on at its small cost */ }
}

export function noteAgentStart(terminalId: string, start: AgentStart, now: number = Date.now()): void {
  setStart(terminalId, startRecord(start, now))
}

/** A line typed by hand changed the terminal's account (it set or unset a profile variable). */
export function isAccountChangedByHand(terminalId: string): boolean {
  return byHand.has(terminalId)
}

/** What index.ts's terminal:write and the switch reach main's other parts through, once
 *  registerAccountsIpc has run. */
const wiring: {
  send?: (channel: string, payload: unknown) => void
  outputEnd?: (terminalId: string) => number
  io?: Omit<SwitchIO, 'progress'>
  paths?: () => Pick<AgentIntegrationPaths, 'userData' | 'home'>
  env?: Readonly<Record<string, string | undefined>>
  fsx?: AccountFs
} = {}

/** An account's colour, as the registry keeps it. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

// ── Learning from every account (§10) ──────────────────────────────────────────────────

/** Where each registered profile keeps its conversations, for learning and Past AI Sessions:
 *  Claude Code's projects/, Codex's sessions/, in each account's own folder (the default profile's
 *  is the default folder already). A profile Termpolis may not touch (a test run's, outside its
 *  agent home) or whose folder is gone gives none. Read from the registry at each call. */
export function profileTranscriptRoots(source: ConversationSource): string[] {
  if (source === 'gemini' || !wiring.paths) return []
  const { home, userData } = wiring.paths()
  const loaded = loadAccounts(userData, wiring.fsx)
  if (!loaded.ok) return []
  const roots: string[] = []
  for (const a of loaded.doc.file.accounts) {
    if (a.agent !== source || a.profile === null) continue
    const dir = liveProfileDir(a, home, wiring.fsx)
    if (dir) roots.push(join(dir, source === 'claude' ? 'projects' : 'sessions'))
  }
  return roots
}

/** profileTranscriptRoots for the ingest pass and the Past AI Sessions list, which run on a timer:
 *  the same answer, read without a synchronous file call (1.54.5's main-thread rule). A test that
 *  wires its own filesystem gets the synchronous answer from it. */
export async function profileTranscriptRootsAsync(source: ConversationSource): Promise<string[]> {
  if (source === 'gemini' || !wiring.paths) return []
  if (wiring.fsx && wiring.fsx !== accountFs) return profileTranscriptRoots(source)
  const { home, userData } = wiring.paths()
  const loaded = await loadAccountsAsync(userData)
  if (!loaded.ok) return []
  const roots: string[] = []
  for (const a of loaded.doc.file.accounts) {
    if (a.agent !== source || a.profile === null) continue
    const dir = await liveProfileDirAsync(a, home)
    if (dir) roots.push(join(dir, source === 'claude' ? 'projects' : 'sessions'))
  }
  return roots
}

// ── The usage-limit chooser's marker (§8.6, R6) ────────────────────────────────────────

/** In a terminal's env: Termpolis watches this terminal for usage limits for its whole life, so a
 *  StopFailure hook (David's ~/.claude/hooks/auth-failover.sh) stands down there instead of opening
 *  a second window on another account. */
export const LIMIT_CHOOSER_VAR = 'TERMPOLIS_LIMIT_CHOOSER'

/**
 * A new terminal's extra env with the marker's part (R6): `TERMPOLIS_LIMIT_CHOOSER=1` only on a
 * terminal Termpolis creates to launch an agent, and watches (`watch`: that agent, or true for one
 * not known yet, a swarm worker's), once that agent (any agent, when not known) has two accounts
 * or more; a promise kept for the terminal's whole life, whatever the chooser setting says later
 * (switched off, its limits get the banner). Any other terminal never carries it: one Termpolis
 * inherited is cleared, since there a Claude Code typed by hand isn't watched and the hook must
 * act. `extra` comes back unchanged when there is nothing to add.
 */
export function withLimitChooser(extra: Record<string, string> | undefined, watch: unknown): Record<string, string> | undefined {
  const agent = ACCOUNT_AGENTS.find((a) => a === watch)
  let marked = false
  if ((agent || watch === true) && wiring.paths) {
    const loaded = loadAccounts(wiring.paths().userData, wiring.fsx)
    const count = (a: AccountAgent): number => (loaded.ok ? loaded.doc.file.accounts.filter((x) => x.agent === a).length : 0)
    marked = (agent ? [agent] : ACCOUNT_AGENTS).some((a) => count(a) >= 2)
  }
  if (marked) return { ...(extra ?? {}), [LIMIT_CHOOSER_VAR]: '1' }
  return (wiring.env ?? process.env)[LIMIT_CHOOSER_VAR] !== undefined ? { ...(extra ?? {}), [LIMIT_CHOOSER_VAR]: '' } : extra
}

// ── Swarm workers (§9) ─────────────────────────────────────────────────────────────────

/** The terminals the swarm's conductor created (not a phone's): its workers. A worker's agent is
 *  started with run_command, which types no account line; a restart of it on another account holds
 *  its terminal as a worker's (R7), and types the worker's own flags again. */
const workers = new Set<string>()

/** The account a line Termpolis typed into a worker (a restart's) put its shell on, per agent: the
 *  variable stays set in that shell, so a later start of that agent there runs on it. */
const shellAccounts = new Map<string, Partial<Record<ProfileAgent, string>>>()

export function noteSwarmWorker(terminalId: string): void {
  workers.add(terminalId)
}

/**
 * The account a terminal opened without an account line runs `agent` on: the one Termpolis's own
 * environment names with the profile variable (CLAUDE_CONFIG_DIR, CODEX_HOME), else, with it
 * unset, the agent's default profile; null when no registered account is that profile, or the
 * value is empty (no profile: Claude Code's config home would be the folder it starts in, R24). A
 * shell's rc file can set the variable too, which Termpolis can't see.
 */
export function envAccountOf(doc: AccountsDoc, agent: ProfileAgent, env: Readonly<Record<string, string | undefined>>, fsx: AccountFs = accountFs): AgentAccount | null {
  const own = doc.file.accounts.filter((a) => a.agent === agent)
  const named = env[PROFILE_VARIABLE[agent]]
  if (named === undefined) return own.find((a) => a.profile === null) ?? null
  if (!named.trim()) return null
  const key = comparisonKey(named, fsx)
  return own.find((a) => a.profile !== null && comparisonKey(a.profile, fsx) === key) ?? null
}

/**
 * A command run_command typed into a swarm worker, as main typed it (index.ts runCommand, which
 * sanitizes it): an agent's start, recorded as a launch line of Termpolis's own is, for its exit
 * and its restart's flags; and the worker's account, the one Termpolis's environment gives it
 * (envAccountOf). A line that sets the profile variable itself leaves the account unknown (by
 * hand). The renderer is told the worker's agent and account: a worker has no launch line, and
 * no agentCommand. Any other terminal's command is not a worker's, and is left alone. Never throws.
 */
export function noteWorkerCommand(terminalId: string, command: string, now: number = Date.now()): void {
  if (!workers.has(terminalId)) return
  try {
    const typed = command.trim()
    const agent = ACCOUNT_AGENTS.find((a) => a === typed.split(/\s+/)[0])
    // A profile variable set by a line stays set in that shell: the account is unknown from then on.
    if (changesAccountByHand(typed) && !byHand.has(terminalId)) {
      byHand.add(terminalId)
      terminalAccounts.delete(terminalId)
      wiring.send?.(ACCOUNTS_IPC.terminalAccount, { terminalId, accountId: null, byHand: true })
    }
    if (!agent) {
      agentStarts.delete(terminalId)
      return
    }
    setStart(terminalId, startRecord({ at: wiring.outputEnd?.(terminalId) ?? 0, commands: [typed], agent }, now))
    // A new run of the agent: the conversation an earlier run of it named is not this one's (SAFETY-R3-1).
    if (agent === 'claude') noteTerminalSession(terminalId, claudeSessionOf(typed).id)
    const handSet = byHand.has(terminalId)
    let accountId: string | null = null
    if (!handSet && isProfileAgent(agent)) {
      // The account a restart's line put this shell on, for this agent: the variable stays set there.
      accountId = shellAccounts.get(terminalId)?.[agent] ?? null
      if (accountId === null && wiring.paths) {
        const loaded = loadAccounts(wiring.paths().userData, wiring.fsx)
        // The env is wired with the paths, at registration.
        if (loaded.ok) accountId = envAccountOf(loaded.doc, agent, wiring.env!, wiring.fsx)?.id ?? null
      }
    }
    if (accountId) terminalAccounts.set(terminalId, accountId)
    else terminalAccounts.delete(terminalId)
    wiring.send?.(ACCOUNTS_IPC.terminalAccount, { terminalId, accountId, byHand: handSet, agent })
  } catch { /* the worker runs as before; a restart then finds no record */ }
}

/** The account Termpolis's environment gives each profile agent's terminals with no account line
 *  (envAccountOf): a swarm's conductor and workers run there. */
export function envAccounts(doc: AccountsDoc, env: Readonly<Record<string, string | undefined>>, fsx: AccountFs = accountFs): Partial<Record<ProfileAgent, string>> {
  const out: Partial<Record<ProfileAgent, string>> = {}
  for (const agent of PROFILE_AGENTS) {
    const a = envAccountOf(doc, agent, env, fsx)
    if (a) out[agent] = a.id
  }
  return out
}

/**
 * The account kept from the automatic offers (work) whose own login is in `a`'s profile, though `a` is a different account: the login
 * in a profile decides which account it is, as accounts.sh's account_for_email decides it, and David's logins move between his folders
 * (SWARM-R3-1; the renderer's unofferedLoginOwner reads the same from the view). Undefined for none: no login read, no account that
 * expects it, or only `a`'s own.
 */
export function unofferedLoginIn(doc: AccountsDoc, a: AgentAccount, home: string, fsx: AccountFs): AgentAccount | undefined {
  if (!isProfileAgent(a.agent)) return undefined
  const login = lastSignedInAs(a, home, doc, fsx)
  if (!login) return undefined
  return doc.file.accounts.find((x) => x.agent === a.agent && x.id !== a.id && !x.autoOffer && !!x.email && x.email.toLowerCase() === login.toLowerCase())
}

/** The longest typed line kept: a pasted file is no account line. */
const TYPED_LINE_MAX = 4096
/** One escape sequence at the head of a write, whole: an X10 mouse report (three bytes follow its CSI M), any other CSI, an OSC
 *  reply (`ESC ] 11 ; ...`) or a DCS, SOS, PM or APC string with its terminator, an SS3 key, or Alt+key. A lone Alt+] or Alt+P is
 *  a key, so a string is taken only where it is a reply (an OSC with its number, the others with their ST). */
const ESCAPE_SEQUENCE = /^\x1b(?:\[M[\s\S]{3}|\[[0-?]*[ -/]*[@-~]|\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*\x1b\\|O.|.)?/
/** What xterm.js and the terminal behind it send through the same write as keystrokes, and no key is: focus in and out, mouse
 *  reports, the cursor position, device attributes, status and mode replies, the answers to colour queries, and the bracketed
 *  paste's end marker. ConPTY turns the focus reports on and asks for the cursor in every Windows session, so one is sent at the
 *  start and with every change of focus. None touches a shell's line (MODELS-R3-1). */
const TERMINAL_REPLY = /^\x1b(?:\[(?:M[\s\S]{3}|[IO]|20[01]~|[<=>?][0-9;:]*[ -/]*[@-~]|[0-9;:]*[ -/]*[Rcnty])|[\]PX^_][\s\S]+)$/
/** Keys that move in a line or delete from it without changing an empty one: the cursor keys, Home, End, Insert and Delete. */
const MOVES_NOTHING = /^\x1b(?:\[(?:\d+(?:;\d+)*)?[CDHF]|\[[123478](?:;\d+)?~|O[CDHF])$/

/** A line typed by hand, for the agent's lifecycle (limitLook.ts): an agent started at the shell, or
 *  a prompt entered in the agent's box. A look that fails changes nothing, and never stops the
 *  line's other checks. */
function noteLife(terminalId: string, typed: string, now: number, lookNow: () => Look, edited = false): void {
  const io = wiring.io
  const end = wiring.outputEnd?.(terminalId)
  if (!io || end === undefined) return
  try {
    const started = noteEnteredLine(io, terminalId, agentStarts.get(terminalId), typed, end, now, lookNow, edited)
    if (!started) releaseScreen(terminalId)
    if (started) {
      setStart(terminalId, started)
      // The conversation of the line just typed is the terminal's now, and the one an earlier launch named is not: a switch before
      // this session has a turn (no exit hint) must not resume the old one (SAFETY-R3-1). A line the shell edited names none.
      if (started.agent === 'claude') noteTerminalSession(terminalId, started.unsure ? null : claudeSessionOf(typed).id)
    } else if (edited) noteUnseenLaunch(terminalId, end, now, lookNow)
  } catch { /* the next look reads it */ }
}

/**
 * The shell ran a line the keys do not say (a history recall, a completion, a cursor move): while an earlier start is on record and its
 * agent is gone, the line may have started the agent again, with other flags and another conversation (`cla`, Tab; `cd repo && cla`,
 * Tab: no word of the keys names it), and any edited line is read so. The cost of the doubt is a bare relaunch that says so. The record becomes one of an agent started
 * with unknown options (a bare relaunch that says so), and the session the earlier launch named is not this one (SAFETY-R3-1,
 * MODELS-R3-3). An agent still running took the line into its box: nothing changes. With no earlier start there is no agent to
 * name, and the line is left alone.
 */
function noteUnseenLaunch(terminalId: string, end: number, now: number, lookNow: () => Look): void {
  const io = wiring.io
  const prev = agentStarts.get(terminalId)
  if (!io || !prev?.agent) return
  if (!agentGone(io, terminalId, prev, now, lookNow())) return
  prev.ended = true
  setStart(terminalId, { at: end, commands: [prev.agent], agent: prev.agent, time: now, unsure: true })
  if (prev.agent === 'claude') noteTerminalSession(terminalId, null)
}

/** A whole line was typed into a terminal: Termpolis's own (one main built), or one that changes
 *  the account by hand, which marks the terminal so (§6.1) and tells the renderer. */
function noteLine(terminalId: string, line: string, now: number, lookNow: () => Look, held = false, edited = false): 'own' | 'by-hand' | null {
  const typed = line.trim()
  if (!typed) {
    // An Enter after a recall or a completion with nothing typed over it: the shell ran a line the keys do not say.
    const end = wiring.outputEnd?.(terminalId)
    if (edited && end !== undefined) {
      try { noteUnseenLaunch(terminalId, end, now, lookNow) } catch { /* the next look reads it */ }
    }
    return null
  }
  const mine = (ownLines.get(terminalId) ?? []).filter((l) => l.until > now)
  // Typed under the model picker's hold: the agent's start again, as the picker's relaunch chose it
  // once the agent had exited (so main could not be told beforehand). Never a line that sets or
  // unsets the account, which stays a change by hand whoever types it.
  const launched = held && !changesAccountByHand(typed) ? agentOfLaunch(typed) : null
  if (launched) {
    mine.push({ line: typed, until: now + OWN_LINE_MS, agent: launched })
    // The conversation it resumes is the terminal's session now; a new or an unnamed one has no id Termpolis knows.
    if (launched === 'claude') noteTerminalSession(terminalId, claudeSessionOf(typed).id)
  }
  const at = mine.findIndex((l) => l.line === typed)
  if (at >= 0) {
    const [own] = mine.splice(at, 1)
    ownLines.set(terminalId, mine)
    const end = wiring.outputEnd?.(terminalId)
    if (end !== undefined) setStart(terminalId, startRecord({ at: end, commands: [typed], agent: own.agent }, now))
    return 'own'
  }
  noteLife(terminalId, typed, now, lookNow, edited)
  // A slash command the CLI's own completion cut short may be what ran: `/sw`, Tab (or Down and Enter) is /switch-account (SW3-3).
  if (!changesAccountByHand(typed) && !(edited && completesSwitchAccount(typed))) return null
  markByHand(terminalId)
  return 'by-hand'
}

/**
 * Every write to a terminal from the renderer (terminal:write), as typed: keystrokes are gathered
 * into the line they make until its Enter, with Backspace, Ctrl+U and Ctrl+C taken into account
 * and escape sequences (arrow keys) left out, and a write that holds whole lines (a paste,
 * Termpolis's own launch) is read line by line. Returns what the last whole line was.
 */
export function noteTypedInput(terminalId: string, typed: string, now: number = Date.now(), key?: string): 'own' | 'by-hand' | null {
  let result: 'own' | 'by-hand' | null = null
  const lookNow = oneLook(terminalId)
  // `key`: the one the write carried, which opens the model picker's hold only while that is live.
  const held = holdsModelKey(terminalId, key, now)
  gatherLines(terminalId, typed, (line, edited) => { result = noteLine(terminalId, line, now, lookNow, held, edited) })
  return result
}

/** One look for all the lines of a write, taken when a line first needs it: the screen can't change
 *  while it runs. */
function oneLook(terminalId: string): () => Look {
  let seen: Look | null = null
  return () => (seen ??= look(wiring.io as Omit<SwitchIO, 'progress'>, terminalId))
}

/** Keys a shell edits a line with beyond what the gatherer follows (readline's and PSReadLine's). A line made with one of them,
 *  or with an escape sequence that is a key (the arrow keys recall and move, Home, End and Delete edit), is not the text the keys
 *  typed say (MODELS-R2-4). Backspace, Ctrl+U and Ctrl+C are followed, so they are not among them. These fill a line, whatever
 *  it holds: Ctrl+R searches the history, Ctrl+P and Ctrl+N recall from it, Ctrl+Y yanks what was killed, Ctrl+O runs the line and
 *  brings the next one. */
const FILLING_KEYS = '\x12\x10\x0e\x19\x0f'
/** And these change only a line that holds text: Tab completes (in cmd also an empty one, which no launch word follows), and
 *  Ctrl+A/E/B/F/K/W/T/D move, kill, transpose or delete, which an empty line has nothing for. Ctrl+D with nothing typed is
 *  the end of input: how an agent is left, never an edit (SW3-6). */
const LINE_KEYS = '\t\x01\x05\x02\x06\x0b\x17\x14\x04'
/** The lines whose pending text has been edited so far (by terminal), carried across the writes that make one line. */
const editedLines = new Set<string>()

/** Keystrokes gathered into the line they make until its Enter, with Backspace, Ctrl+U and Ctrl+C
 *  taken into account and escape sequences left out; `onLine` gets each whole line, and whether the shell's own editing
 *  (EDITING_KEYS, an arrow key) took part in making it. */
function gatherLines(terminalId: string, typed: string, onLine: (line: string, edited: boolean) => void): void {
  let line = typedLines.get(terminalId) ?? ''
  let edited = editedLines.has(terminalId)
  for (let i = 0; i < typed.length; i++) {
    const c = typed[i]
    if (c === '\x1b' && typed.startsWith('\x1b[200~', i)) {
      // A bracketed paste: its line breaks are text in the box (a shell takes them as `;`), not Enters;
      // the user's own Enter sends it. An end marker that never came ends it with what was written.
      const end = typed.indexOf('\x1b[201~', i + 6)
      const body = typed.slice(i + 6, end < 0 ? typed.length : end)
      // An empty line (a trailing newline, as copied from a README) adds no ';': "claude;" is no launch.
      line = (line + body.split(/\r\n|\r|\n/).filter(Boolean).join('; ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).slice(0, TYPED_LINE_MAX)
      i = end < 0 ? typed.length : end + 5
    } else if (c === '\x1b' && (typed[i + 1] === '\r' || typed[i + 1] === '\n')) {
      // Esc then Enter (Shift+Enter in an agent's box, TerminalPane): a new line in the box, not a submit.
      line += ' '
      i++
    } else if (c === '\r' || c === '\n') {
      onLine(line, edited)
      line = ''
      edited = false
    } else if (c === '\x7f' || c === '\b') line = line.slice(0, -1)
    else if (c === '\x15' || c === '\x03') {
      line = ''
      edited = false
    } else if (c === '\x1b') {
      const seq = (ESCAPE_SEQUENCE.exec(typed.slice(i)) as RegExpExecArray)[0]
      i += seq.length - 1
      // What the terminal sends of itself is no key, and a key that cannot change an empty line changes none.
      if (!TERMINAL_REPLY.test(seq) && (line !== '' || !MOVES_NOTHING.test(seq))) edited = true
    } else if (FILLING_KEYS.includes(c) || (LINE_KEYS.includes(c) && line !== '')) edited = true
    else if (c >= ' ' && line.length < TYPED_LINE_MAX) line += c
  }
  if (line || edited) typedLines.set(terminalId, line)
  else typedLines.delete(terminalId)
  if (edited) editedLines.add(terminalId)
  else editedLines.delete(terminalId)
}

/**
 * What an MCP client (the conductor) writes into a swarm worker (index.ts): a prompt entered in the
 * worker's box is the worker's turn (R4), which a restarted worker's carried stop asks about.
 * Nothing else is read from it: a task can name a profile variable without changing an account.
 * Any other terminal's MCP writes are left alone.
 */
export function noteWorkerInput(terminalId: string, typed: string, now: number = Date.now()): void {
  if (!workers.has(terminalId)) return
  const lookNow = oneLook(terminalId)
  gatherLines(terminalId, typed, (line) => {
    if (line.trim()) noteLife(terminalId, line.trim(), now, lookNow)
  })
}

/**
 * Whether the terminal's agent was relaunched by Termpolis and has taken no turn since: the limit its
 * screen shows is the one the conversation stopped at before, drawn again by the resumed session above
 * its empty box (R4, real Claude Code does), and no stop of the new run. A prompt entered in its box ends
 * it (noteWorkerInput for a worker the conductor writes to), and a limit shown after that blocks again.
 */
export function workerStopCarried(terminalId: string): boolean {
  const start = agentStarts.get(terminalId)
  return start !== undefined && start.relaunched === true && start.turned !== true
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

/** The lines one write makes, for the tests of how keystrokes are gathered. */
export const _gatherLinesForTest = gatherLines

export function _resetTerminalAccountsForTest(): void {
  terminalAccounts.clear()
  sessionIds.clear()
  ownLines.clear()
  typedLines.clear()
  editedLines.clear()
  byHand.clear()
  unsettled.clear()
  agentStarts.clear()
  screenReleased.clear()
  workers.clear()
  shellAccounts.clear()
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
  // A registry that cannot be read (invalid JSON, written by another version, empty) cannot say the id is no account: it is not
  // connected, as isTerminalAccountConnected reads it, rather than the default profile, which a write meant for another account
  // would then land in (SAFETY-R3-3). An id a readable registry does not hold is still no account (D13).
  if (!loaded.ok) return { connected: false }
  const account = findAccount(loaded.doc, accountId)
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
  const loaded = loadAccounts(paths.userData)
  // A user who added no account sees no change (D13): the by-hand rule is for a registry with accounts.
  const registered = loaded.ok && loaded.doc.file.accounts.length > 0
  // An account changed by hand is one Termpolis doesn't know: it answers nothing there.
  if (registered && typeof terminalId === 'string' && byHand.has(terminalId)) return false
  const id = typeof terminalId === 'string' ? terminalAccountId(terminalId) : undefined
  // A terminal still on an account the user then removed (R9): the profile is one Termpolis let go of,
  // and an answer written there would never be taken back by Disconnect.
  if (typeof id === 'string' && !(loaded.ok && findAccount(loaded.doc, id))) return false
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
    envAccount: envAccounts(doc, ctx.env, ctx.fsx),
  }
}

// ── The hidden sign-in session (the in-app account UI, §3) ─────────────────────────────

/** The CLI a sign-in session runs: its resolved path and its arguments, or why it can't. */
export type SignInCli = { file: string; args: string[] | string } | { error: string }

/** Termpolis's own variables, and every profile variable: none of them reach a sign-in's CLI but the
 *  account's own, set again below. */
const SIGN_IN_DROP = /^(?:TERMPOLIS_.*|ELECTRON_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME)$/i

/** The env a sign-in's CLI starts with: the one Termpolis's terminals get (its proxy and browser
 *  settings among it), less Termpolis's own variables and every profile variable, plus the
 *  account's: deleted for the default profile, never set empty (R24). A test run's scratch home
 *  stands in for the real one, so a CLI a test starts never reaches the developer's sign-ins. */
export function signInEnv(agent: AccountAgent, profile: string | null, base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && !SIGN_IN_DROP.test(k)) env[k] = v
  const testHome = base.TERMPOLIS_TEST_AGENT_HOME?.trim()
  if (testHome) {
    env.HOME = testHome
    env.USERPROFILE = testHome
  }
  env.TERM = 'xterm-256color'
  if (isProfileAgent(agent) && profile) env[PROFILE_VARIABLE[agent]] = profile
  return env
}

/** The CLI for a sign-in, as the status checks find it (R20): by its resolved path, an npm shim on
 *  Windows through `cmd.exe /d /s /c` with plain arguments only (an email the shim's line can't take
 *  is left off: it only fills in the page). agy by its path. */
export function signInCli(agent: AccountAgent, args: string[], env: Record<string, string>, platform: NodeJS.Platform = process.platform): SignInCli {
  const missing = { error: `${ACCOUNT_AGENT_LABEL[agent]} isn't installed where Termpolis can find it (not on PATH)` }
  if (!isProfileAgent(agent)) {
    const file = findOnPath('agy', env, platform)
    return file ? { file, args } : missing
  }
  const cli = resolveCli(agent, { env, platform })
  if (!cli) return missing
  // A shim is Windows's only (resolveCli).
  if (cli.kind === 'exe') return { file: cli.file, args }
  const at = args.indexOf('--email')
  const plain = at < 0 ? args : args.slice(0, at)
  const inv = shimInvocation(cli.file, args, env) ?? shimInvocation(cli.file, plain, env)
  return inv ? { file: inv.file, args: inv.args.join(' ') } : { error: 'the CLI is installed in a folder Termpolis can\'t run it from safely' }
}

/** For quit: every sign-in session ends, with its process tree. */
export function endAccountSignIns(): void {
  endSignIns()
}

// ── Registration ───────────────────────────────────────────────────────────────────────

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
  // The CLIs are looked for, and started, on the PATH a terminal would give them: a GUI launch (a macOS
  // Finder or Dock launch, Linux under nvm, volta or ~/.local/bin) hands Electron's main a minimal one
  // (agentPaths.ts), where Check and Sign in would find no claude, codex or agy at all. An environment a
  // test injects is used as it is.
  const cliEnv = (): Readonly<Record<string, string | undefined>> => (deps.env ? env : { ...env, PATH: getExtendedPath() })
  const signedInNow = deps.signedInNow ?? ((agent, profile, d) => (agent === 'claude' ? claudeSignedInNow(profile, d) : codexSignedInNow(profile, d)))
  const startTimer = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const stopTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  /** The folder the user picked last, per agent, waiting for Add. */
  const picked = new Map<AccountAgent, string>()
  wiring.send = deps.send
  wiring.outputEnd = deps.outputEnd
  wiring.io = deps.switchIO
  wiring.paths = deps.paths
  wiring.env = env
  wiring.fsx = fsx
  // Learning and Past AI Sessions read every registered profile's conversations from now on.
  setExtraTranscriptRoots(profileTranscriptRoots, profileTranscriptRootsAsync)

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
    const color = typeof input.color === 'string' && HEX_COLOR.test(input.color) ? input.color : undefined
    const p = deps.paths()
    if (!isProfileAgent(agent)) {
      const { value } = update((doc) => {
        uniqueLabel(doc, agent, label)
        const account: AgentAccount = {
          id: newAccountId(), agent, label, profile: null, autoOffer, order: nextOrder(doc, agent), connect: false,
          origin: 'label', links: [], ...(email ? { email } : {}), ...(color ? { color } : {}),
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
        ...(color ? { color } : {}), ...(copied.length ? { copiedAt: now() } : {}),
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
        if (typeof input.color === 'string' && HEX_COLOR.test(input.color)) a.color = input.color
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
  const checkNow = async (a: AgentAccount, fresh = false): Promise<{ identity: AccountIdentity; doc: AccountsDoc }> => {
    if (!isProfileAgent(a.agent)) throw new Error('Termpolis can\'t ask the Antigravity CLI who is signed in: it shows the email on its own screen')
    if (!liveProfileDir(a, deps.paths().home, fsx)) throw new Error(`${a.label}'s profile folder doesn't exist`)
    // Right after a sign-in its tokens are seconds old: no check can need to refresh them then.
    if (!fresh && CHECK_SKIPS_LIVE_PROFILES && terminalsOnAccount(a.id) > 0) {
      throw new Error(`A Termpolis terminal is running on ${a.label}, so Termpolis doesn't ask ${ACCOUNT_AGENT_LABEL[a.agent]} now: a check could refresh the sign-in that terminal uses. Close it, or read "last signed in as".`)
    }
    const r = await signedInNow(a.agent, a.profile, { cwd: deps.checkCwd(), env: cliEnv() })
    if ('error' in r) throw new Error(r.error)
    const identity: AccountIdentity = r.identity
    return { identity, doc: update((d) => { d.file.identity[a.id] = identity }).doc }
  }

  handle(ACCOUNTS_IPC.check, async (input) => {
    const a = accountOf(loadDoc(), input.id)
    return rowOf((await checkNow(a)).doc, a.id)
  })

  /** One Google sign-in for the computer user: every agy terminal Termpolis knows moves with it (and
   *  `also`), and new ones launch on it. */
  const moveAgy = (target: AgentAccount, also: string[]): void => {
    const doc = loadDoc()
    const agyIds = new Set(doc.file.accounts.filter((a) => a.agent === 'agy').map((a) => a.id))
    const moved = new Set(also)
    for (const [tid, aid] of terminalAccounts) if (aid !== null && agyIds.has(aid)) moved.add(tid)
    for (const tid of moved) {
      noteTerminalAccount(tid, target.id)
      deps.send(ACCOUNTS_IPC.terminalAccount, { terminalId: tid, accountId: target.id, byHand: false })
    }
    update((d) => { d.file.preferred.agy = target.id })
    console.log(`[accounts] agy moved to ${target.label}: ${moved.size} terminal${moved.size === 1 ? '' : 's'}`)
  }

  // The hidden sign-in session (§3): never a Termpolis terminal, so nothing else can see or type
  // into it. The renderer names the account and the method; main builds everything else.
  const sessionDeps: SessionDeps = {
    spawn: deps.signInSpawn ?? ((file, args, opts) => (require('node-pty') as { spawn: SessionDeps['spawn'] }).spawn(file, args, opts)),
    killTree: (pid) => { killProcessTree(pid) },
    send: (state: SignInState) => deps.send(ACCOUNTS_IPC.signInState, state),
    openExternal: (url) => deps.openExternal?.(url),
    now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    setInterval: startTimer,
    clearInterval: stopTimer,
  }
  /** The windows whose going away ends their sessions, each watched once. */
  const watchedOwners = new WeakSet<object>()
  ipc.handle(ACCOUNTS_IPC.signInStart, async (e, raw) => {
    try {
      const input = isRecord(raw) ? raw : {}
      const a = accountOf(loadDoc(), input.accountId)
      const mode = input.mode === 'agy-switch' ? 'agy-switch' : 'sign-in'
      if ((mode === 'agy-switch') !== (a.agent === 'agy')) throw new Error(a.agent === 'agy' ? 'the Antigravity CLI signs in through its switch' : `${a.label} isn't an Antigravity CLI account`)
      if (mode === 'agy-switch') {
        // agy signs in from the environment there: /logout signs nothing out (agy-signin.md).
        const byEnv = AGY_ENV_AUTH.find((name) => !!env[name])
        if (byEnv) throw new Error(`agy signs in with ${byEnv} from the environment here, so signing out changes nothing: change ${byEnv} instead`)
      } else if (!liveProfileDir(a, deps.paths().home, fsx)) {
        throw new Error(`${a.label}'s profile folder doesn't exist`)
      }
      const args = isProfileAgent(a.agent)
        ? signInArgs(a.agent, SIGN_IN_METHODS[a.agent].find((m) => m === input.method) ?? SIGN_IN_METHODS[a.agent][0], a.email)
        : []
      const childEnv = signInEnv(a.agent, a.profile, cliEnv())
      const cli = (deps.signInCli ?? signInCli)(a.agent, args, childEnv)
      if ('error' in cli) throw new Error(cli.error)
      const owner = (e as { sender?: { once?: (event: string, fn: () => void) => void } } | null)?.sender
      const started = startSignInSession({
        accountId: a.id, agent: a.agent, key: a.agent === 'agy' ? 'agy' : `${a.agent}:${a.profile ?? ''}`,
        file: cli.file, args: cli.args, env: childEnv, cwd: deps.checkCwd(), mode, label: a.label, owner,
        confirm: async () => {
          try {
            const { identity } = await checkNow(a, true)
            if (!identity.signedIn) return { signedOut: true }
            return { email: identity.email, ...(identity.plan ? { plan: identity.plan } : {}) }
          } catch (e3) {
            return { error: message(e3) }
          }
        },
        onAgySignedIn: () => moveAgy(a, []),
      }, sessionDeps)
      if (owner && typeof owner === 'object' && !watchedOwners.has(owner)) {
        watchedOwners.add(owner)
        owner.once?.('destroyed', () => endSignInsOf(owner))
      }
      console.log(`[accounts] sign-in for ${a.label} started (${mode})`)
      return ok(started)
    } catch (e2) {
      return err(message(e2))
    }
  })
  handle(ACCOUNTS_IPC.signInInput, async (input) => {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    return signInInput(sessionId, input as unknown as SignInInput)
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
    // bare command on the default profile, and no account recorded (D13). The line is still
    // Termpolis's own, so the agent it starts is watched for a usage limit (limitLook.ts).
    const loaded = loadAccounts(userData(), fsx)
    const accounts = loaded.ok ? sortedAccounts(loaded.doc).filter((a) => a.agent === agent) : []
    if (!loaded.ok || accounts.length === 0) {
      noteOwnLine(terminalId, command, now(), agent)
      return { line: command, accountId: null, explicit: false }
    }
    const account = launchAccountOf(loaded.doc, accounts, input.accountId)
    // Named on the line once the agent has more than one account: a CLAUDE_CONFIG_DIR a shell's rc
    // file exports can't then move the launch (§6.2). The default profile's line unsets it.
    const explicit = accounts.length > 1 || (isProfileAgent(agent) && account.profile !== null)
    let line = command
    let sessionId: string | undefined
    // agy has no variable to set, so its line stays the bare command in every shell: wrapped, as
    // PowerShell's `& { agy }`, it would hide the launch from the audit.
    if (explicit && isProfileAgent(agent)) {
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
    noteOwnLine(terminalId, line, now(), agent)
    return { line, accountId: account.id, explicit, ...(sessionId ? { sessionId } : {}) }
  })

  // The usage-limit chooser's look at a terminal whose screen changed (§8.1): judged here, next to
  // the buffer, with main's record of the agent started there and of the terminal's account.
  handle(ACCOUNTS_IPC.limitLook, (input): LimitLook => {
    const io = deps.switchIO
    if (!io) throw new Error('main has no terminals to look at')
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) throw new Error('which terminal?')
    noteRestarted(terminalId)
    const start = agentStarts.get(terminalId)
    const seen = lookForLimit(io, terminalId, start, now())
    releaseScreen(terminalId)
    const accountId = terminalAccounts.get(terminalId) ?? null
    // R15: an account recorded as out of usage BEFORE this agent started on it, whose agent now answers a
    // prompt (seen at work on a turn), is not out of usage: the record was wrong, or its reset came early.
    // Once per start. A limit recorded after the start (another terminal's) is none of this agent's to lift.
    if (start && accountId && !start.healed && seen.live && seen.turned && seen.status.status === 'working') {
      start.healed = true
      const benched = loadAccounts(userData(), fsx)
      const limit = benched.ok ? benched.doc.file.limits[accountId] : undefined
      if (limit && limit.seenAt < (start.time ?? 0)) update((d) => { delete d.file.limits[accountId] })
    }
    return { ...seen, accountId, byHand: byHand.has(terminalId) }
  })

  handle(ACCOUNTS_IPC.switchAccount, async (input): Promise<SwitchOutcome> => {
    const io = deps.switchIO
    if (!io) throw new Error('switching accounts isn\'t available')
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) throw new Error('which terminal?')
    const req: SwitchRequest = { terminalId, targetId: String(input.targetId ?? ''), shellType: String(input.shellType ?? '') }
    noteRestarted(terminalId)
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
    if (source && source.id === target.id && !isAccountChangedByHand(terminalId) && !unsettled.has(terminalId)) throw new Error(`this terminal already runs on ${target.label}`)
    // D14, R17: onto an account that isn't offered automatically (work), or carrying a conversation
    // off one, is the user's second confirmation. The UI asks it where it asks for the switch; a
    // request without it is refused here, so no path can skip the question. When Termpolis doesn't
    // know which account the terminal is on (the user changed it by hand, as the account scripts do,
    // or an agent started by hand has no record), the conversation may be on such an account too.
    // The login in a profile is the account, not the folder's row (accounts.sh's account_for_email; the logins move between the folders):
    // a profile that is signed in to the work login is the work account for this question, whatever its own flag says (SWARM-R3-1).
    const unoffered = !target.autoOffer ? target : source && !source.autoOffer ? source
      : unofferedLoginIn(doc, target, home, fsx) ?? (source ? unofferedLoginIn(doc, source, home, fsx) : undefined) ?? null
    if (unoffered && input.confirmedCarry !== true) throw new Error(`${unoffered.label} isn't offered automatically, so switching a conversation to or from it needs your confirmation`)
    const mayBeOn = !source || isAccountChangedByHand(terminalId) ? doc.file.accounts.find((a) => a.agent === target.agent && !a.autoOffer) : undefined
    if (mayBeOn && input.confirmedCarry !== true) throw new Error(`this conversation may be on ${mayBeOn.label}, which isn't offered automatically, so switching it needs your confirmation`)
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
      // A swarm worker's restart says so to the conductor, while it holds the worker (§9, R7).
      ...(workers.has(terminalId) ? { lockKind: 'worker' as const } : {}),
      // A profile that routes Anthropic traffic itself (a base URL, an outbound proxy or a cloud
      // provider in its settings) takes the compression proxy's variables out of the line: the terminal's
      // spawn env set them for the profile it started on (design 5.2). Only where the proxy was Termpolis's:
      // when its own environment routes (a company gateway) the terminal inherited that, and the proxy
      // stepped aside, so there is nothing of Termpolis's to take out and the user's route must stay.
      ...(agent === 'claude' && userRoutingVar(env, {}) === null && userRoutingVar(env, accountSettingsEnv(deps.paths(), target.id, fsx)) !== null
        ? { extraUnset: ['ANTHROPIC_BASE_URL', 'TERMPOLIS_HEADROOM_PROXY'] } : {}),
      newSessionId: () => randomUUID(),
      record: (r) => {
        noteTerminalAccount(terminalId, r.accountId)
        if (workers.has(terminalId)) shellAccounts.set(terminalId, { ...shellAccounts.get(terminalId), [agent]: r.accountId })
        // Termpolis relaunched the agent here: the conversation it resumed draws its old limit again (R4).
        const relaunched = startRecord(r.start, now())
        relaunched.relaunched = true
        setStart(terminalId, relaunched)
        if (agent === 'claude') noteTerminalSession(terminalId, r.sessionId)
        deps.send(ACCOUNTS_IPC.terminalAccount, { terminalId, accountId: r.accountId, byHand: false })
      },
    })
    // Where the terminal stands: on the target and settled when the agent came up there; on the target
    // by Termpolis's record but not settled when the line was typed and the agent did not (a retry is the
    // user's to ask); as it was when nothing was typed.
    if (outcome.kind === 'switched' || outcome.kind === 'fresh') unsettled.delete(terminalId)
    else if (terminalAccountId(terminalId) === target.id) unsettled.add(terminalId)
    // The relaunch landed on the target's sign-in screen: its stored sign-in no longer works, which
    // its status command can't tell (it reads that one exists). Its badge says so until a check.
    if (outcome.kind === 'sign-in') update((d) => { d.file.identity[target.id] = { email: null, signedIn: false, checkedAt: now(), source: 'sign-in-screen' } })
    // Labels only, never emails.
    console.log(`[accounts] switch of a ${ACCOUNT_AGENT_LABEL[agent]} terminal from ${source?.label ?? 'an account Termpolis didn\'t know'} to ${target.label}${req.reason ? ` (${req.reason})` : ''}: ${outcome.kind}`)
    return outcome
  })

  handle(ACCOUNTS_IPC.agySwitch, async (input): Promise<AgyStepOutcome> => {
    const io = deps.switchIO
    if (!io) throw new Error('switching accounts isn\'t available')
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) throw new Error('which terminal?')
    const step = (['exit', 'resume'] as const).find((s) => s === input.step)
    if (!step) throw new Error('unknown step')
    const target = accountOf(loadDoc(), input.targetId)
    if (target.agent !== 'agy') throw new Error(`${target.label} is not an Antigravity CLI account`)
    const req: AgyStepRequest = { terminalId, targetId: target.id, shellType: String(input.shellType ?? ''), step }
    if (isSessionId(input.conversationId)) req.conversationId = input.conversationId
    if (input.assumeExited === true) req.assumeExited = true
    const outcome = await runAgyStep(req, {
      io,
      ...(terminalAgentStart(terminalId) ? { start: terminalAgentStart(terminalId) } : {}),
      env,
      record: (r) => noteAgentStart(terminalId, r.start, now()),
    })
    // On the sign-in the hidden session moved every agy to: this terminal is on it too now.
    if (outcome.kind === 'resumed') {
      noteTerminalAccount(terminalId, target.id)
      deps.send(ACCOUNTS_IPC.terminalAccount, { terminalId, accountId: target.id, byHand: false })
    }
    return outcome
  })

  // The model picker's half of the relaunch lock (§7.5, R7): while it types, MCP clients and the
  // phone are refused and every write but the picker's own is dropped. What the picker types to
  // start the agent again counts as the agent's start (noteTypedInput, by the hold's key), so a later
  // switch relaunches the model it picked. The line isn't known yet: the exit names the conversation.
  handle(ACCOUNTS_IPC.modelHold, (input): ModelHold => {
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) throw new Error('which terminal?')
    const key = holdForModel(terminalId, now())
    if (!key) throw new Error(MODEL_HELD)
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

