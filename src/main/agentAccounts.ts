// The agent-account registry, main side: `<userData>/agent-accounts.json`, the rules for the
// profile folders it names, the read-only import of ~/.claude/accounts.sh, and what Termpolis
// can tell about an account without starting a process. Plain fs + paths, no electron import,
// so the uninstall-time disconnect (resources/disconnect-agents.cjs) can read it too.
//
// Every file goes through accountFs (the credential tripwire). A profile is stored as its LAUNCH
// STRING, exactly what goes into CLAUDE_CONFIG_DIR / CODEX_HOME: macOS names Claude Code's
// Keychain entry after a hash of that string as given, so it is never realpath'd. Comparisons
// (one account per folder, nothing inside another profile) use the realpath instead.
import { randomBytes } from 'crypto'
import { basename, isAbsolute, join, parse as parsePath, resolve, sep } from 'path'
import {
  ACCOUNT_AGENTS, DEFAULT_PROFILE_FOLDER, DEFAULT_COOLDOWN_SEC, cleanLabel, hasControlChars, isPlainEmail,
  isProfileAgent,
} from '../shared/agentAccounts'
import type {
  AccountAgent, AccountIdentity, AccountLimit, AccountLink, AccountsFile, AgentAccount, ImportPreview,
  ImportPreviewRow, ProfileAgent,
} from '../shared/agentAccounts'
import type { AgentIntegrationPaths } from './agentIntegrationManager'
import { accountFs, accountFsAsync, isSameOrInside, readClaudeJsonFields } from './accountFs'
import type { AccountFs, AccountFsAsync } from './accountFs'

export const ACCOUNTS_FILE = 'agent-accounts.json'

/** A registered account's profile, as agent integration writes into it: Claude Code's config dir
 *  and its `.claude.json`, or a CODEX_HOME. */
export interface ProfileTarget {
  agent: ProfileAgent
  dir: string
  /** Claude: `<dir>/.claude.json`, or `<home>/.claude.json` for the default profile. */
  claudeJson?: string
  accountId?: string
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_ACCOUNTS_SH_BYTES = 64 * 1024

type Json = Record<string, unknown>

function isRecord(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export interface AccountsDoc {
  file: AccountsFile
  /** Top-level fields this version doesn't know: written back as they were. */
  rest: Json
  /** Accounts this version can't read (another agent, a later version): written back as they were. */
  unknown: unknown[]
}

export function emptyAccountsFile(): AccountsFile {
  return { version: 1, accounts: [], preferred: {}, chooser: true, cooldownSec: {}, limits: {}, identity: {} }
}

const ORIGINS: ReadonlyArray<AgentAccount['origin']> = ['created', 'adopted', 'accounts-sh', 'label']
const ACCOUNT_ID = /^acc_[0-9a-f]{12}$/
const SH_KEY = /^[A-Za-z0-9_-]{1,32}$/

function parseLinks(v: unknown): AccountLink[] {
  if (!Array.isArray(v)) return []
  return v.filter((l): l is AccountLink => isRecord(l) && typeof l.name === 'string' && typeof l.target === 'string'
    && !!l.name && isAbsolute(l.target))
}

/** One saved account, or null when this version can't read it (it is then kept as it was). */
function parseAccount(v: unknown, index: number): AgentAccount | null {
  if (!isRecord(v)) return null
  const agent = ACCOUNT_AGENTS.find((a) => a === v.agent)
  const label = cleanLabel(v.label)
  if (typeof v.id !== 'string' || !ACCOUNT_ID.test(v.id) || !agent || !label) return null
  let profile: string | null = null
  if (v.profile !== null && v.profile !== undefined) {
    if (typeof v.profile !== 'string' || !isAbsolute(v.profile) || hasControlChars(v.profile) || !isProfileAgent(agent)) return null
    profile = v.profile
  }
  const origin = ORIGINS.find((o) => o === v.origin) ?? (agent === 'agy' ? 'label' : 'adopted')
  const account: AgentAccount = {
    ...v,
    id: v.id,
    agent,
    label,
    profile,
    autoOffer: v.autoOffer !== false,
    order: typeof v.order === 'number' && Number.isFinite(v.order) ? v.order : index,
    connect: v.connect === true,
    origin,
    links: parseLinks(v.links),
  }
  if (isPlainEmail(v.email)) account.email = v.email
  else delete account.email
  if (typeof v.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.color)) account.color = v.color
  else delete account.color
  if (typeof v.importedAs === 'string' && SH_KEY.test(v.importedAs)) account.importedAs = v.importedAs
  else delete account.importedAs
  if (typeof v.copiedAt === 'number' && Number.isFinite(v.copiedAt) && v.copiedAt > 0) account.copiedAt = v.copiedAt
  else delete account.copiedAt
  return account
}

function parseAgentMap<T>(v: unknown, ok: (x: unknown) => x is T): Partial<Record<AccountAgent, T>> {
  const out: Partial<Record<AccountAgent, T>> = {}
  if (!isRecord(v)) return out
  for (const a of ACCOUNT_AGENTS) if (ok(v[a])) out[a] = v[a] as T
  return out
}

const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0
const isCooldown = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= 90 * 86400

function parseRecords<T>(v: unknown, ok: (x: Json) => boolean): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isRecord(v)) return out
  for (const [k, x] of Object.entries(v)) if (ACCOUNT_ID.test(k) && isRecord(x) && ok(x)) out[k] = x as T
  return out
}

/** Parse a saved registry. Never throws: anything it can't read is kept aside, unchanged. */
export function parseAccountsDoc(raw: unknown): AccountsDoc {
  const file = emptyAccountsFile()
  const doc: AccountsDoc = { file, rest: {}, unknown: [] }
  if (!isRecord(raw)) return doc
  const { accounts, preferred, chooser, cooldownSec, limits, identity, hidden, ...rest } = raw
  delete rest.version
  doc.rest = rest
  const seen = new Set<string>()
  if (Array.isArray(accounts)) {
    accounts.forEach((a, i) => {
      const parsed = parseAccount(a, i)
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id)
        file.accounts.push(parsed)
      } else {
        doc.unknown.push(a)
      }
    })
  }
  file.preferred = parseAgentMap(preferred, isString)
  file.chooser = chooser !== false
  file.cooldownSec = parseAgentMap(cooldownSec, isCooldown)
  file.limits = parseRecords<AccountLimit>(limits, (x) => typeof x.seenAt === 'number' && typeof x.text === 'string')
  file.identity = parseRecords<AccountIdentity>(identity, (x) => typeof x.checkedAt === 'number')
  if (isRecord(hidden)) {
    file.hidden = {}
    for (const k of ['hookAdvice', 'authEnvAdvice', 'limitBanner'] as const) if (hidden[k] === true) file.hidden[k] = true
  }
  return doc
}

export function serializeAccountsDoc(doc: AccountsDoc): string {
  const { file } = doc
  const out: Json = {
    ...doc.rest,
    version: 1,
    accounts: [...file.accounts, ...doc.unknown],
    preferred: file.preferred,
    chooser: file.chooser,
    cooldownSec: file.cooldownSec,
    limits: file.limits,
    identity: file.identity,
  }
  if (file.hidden && Object.keys(file.hidden).length) out.hidden = file.hidden
  return JSON.stringify(out, null, 2) + '\n'
}

export type LoadResult = { ok: true; doc: AccountsDoc; exists: boolean } | { ok: false; error: string }

/** The registry's path, or null when userData is not a full path. */
export function accountsFilePath(userData: string): string | null {
  return typeof userData === 'string' && isAbsolute(userData) ? join(userData, ACCOUNTS_FILE) : null
}

/** The saved registry. A file that exists but can't be read is an error, never an empty
 *  registry: writing over it would lose the user's accounts. */
export function loadAccounts(userData: string, fsx: AccountFs = accountFs): LoadResult {
  const file = accountsFilePath(userData)
  if (!file) return { ok: false, error: 'the folder Termpolis keeps its settings in is not a full path' }
  let text: string | null
  try {
    text = fsx.readText(file, MAX_FILE_BYTES)
  } catch {
    return { ok: false, error: `${ACCOUNTS_FILE} can't be read` }
  }
  return parseLoadedAccounts(text)
}

/** loadAccounts without a synchronous file call, for a timer path (the ingest pass's transcript folders). */
export async function loadAccountsAsync(userData: string, fsx: AccountFsAsync = accountFsAsync): Promise<LoadResult> {
  const file = accountsFilePath(userData)
  if (!file) return { ok: false, error: 'the folder Termpolis keeps its settings in is not a full path' }
  let text: string | null
  try {
    text = await fsx.readText(file, MAX_FILE_BYTES)
  } catch {
    return { ok: false, error: `${ACCOUNTS_FILE} can't be read` }
  }
  return parseLoadedAccounts(text)
}

/** The registry from its file's text: null when there is no file. */
function parseLoadedAccounts(text: string | null): LoadResult {
  if (text === null) return { ok: true, doc: parseAccountsDoc({}), exists: false }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, error: `${ACCOUNTS_FILE} is not valid JSON, so Termpolis left it as it is` }
  }
  if (!isRecord(raw) || raw.version !== 1) return { ok: false, error: `${ACCOUNTS_FILE} was written by another version of Termpolis` }
  return { ok: true, doc: parseAccountsDoc(raw), exists: true }
}

export function saveAccounts(userData: string, doc: AccountsDoc, fsx: AccountFs = accountFs): string | null {
  const file = accountsFilePath(userData)
  if (!file) return 'the folder Termpolis keeps its settings in is not a full path'
  try {
    if (!fsx.exists(userData)) fsx.mkdir(userData, 0o700)
    fsx.writePrivate(file, serializeAccountsDoc(doc))
    return null
  } catch (e) {
    return `${ACCOUNTS_FILE} could not be saved (${(e as NodeJS.ErrnoException)?.code ?? 'error'})`
  }
}

export type UpdateResult<T> = { ok: true; value: T; doc: AccountsDoc } | { ok: false; error: string }

/** Thrown by an update's `mutate` to refuse the change: nothing is saved, and the message is the
 *  answer. */
export class AccountsRefusal extends Error {}

/** Load, change and save the registry. Nothing is saved when `mutate` throws an AccountsRefusal. */
export function updateAccounts<T>(
  userData: string,
  mutate: (doc: AccountsDoc) => T,
  fsx: AccountFs = accountFs,
): UpdateResult<T> {
  const loaded = loadAccounts(userData, fsx)
  if (!loaded.ok) return loaded
  let value: T
  try {
    value = mutate(loaded.doc)
  } catch (e) {
    if (e instanceof AccountsRefusal) return { ok: false, error: e.message }
    throw e
  }
  const error = saveAccounts(userData, loaded.doc, fsx)
  return error ? { ok: false, error } : { ok: true, value, doc: loaded.doc }
}

export function newAccountId(): string {
  return `acc_${randomBytes(6).toString('hex')}`
}

// ── Profile folders ────────────────────────────────────────────────────────────────────

/** The launch string for a folder: resolved and NFC-normalised, with any trailing separator
 *  dropped, and never realpath'd (see the header). */
export function launchString(p: string): string {
  const r = resolve(p).normalize('NFC')
  const root = parsePath(r).root
  return r.length > root.length ? r.replace(/[\\/]+$/, '') : r
}

function foldCase(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p
}

/** What two folders are compared by: their realpath where they exist, case-folded where the
 *  filesystem is. Never typed, never put in an env. */
export function comparisonKey(p: string, fsx: AccountFs = accountFs): string {
  const l = launchString(p)
  return foldCase(fsx.realpath(l) ?? l)
}

/** While a test run points every agent config at a scratch home, a profile outside it counts as
 *  missing: never read, never written (the rule resolveAgentIntegrationPaths follows). */
export function isReachable(p: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const testHome = env.TERMPOLIS_TEST_AGENT_HOME?.trim()
  return !testHome || isSameOrInside(resolve(p), resolve(testHome))
}

export function defaultProfileDir(agent: ProfileAgent, home: string): string {
  return join(home, DEFAULT_PROFILE_FOLDER[agent])
}

/** The folder an account's profile lives in; null for agy, or with no home folder known. */
export function profileDirOf(account: Pick<AgentAccount, 'agent' | 'profile'>, home: string): string | null {
  if (!isProfileAgent(account.agent)) return null
  if (account.profile) return account.profile
  return home && isAbsolute(home) ? defaultProfileDir(account.agent, home) : null
}

/** Claude Code's `.claude.json` for an account: `~/.claude.json` for the default profile. */
export function claudeJsonOf(account: Pick<AgentAccount, 'agent' | 'profile'>, home: string): string | null {
  if (account.agent !== 'claude') return null
  if (account.profile) return join(account.profile, '.claude.json')
  return home && isAbsolute(home) ? join(home, '.claude.json') : null
}

/** The profile's folder when it exists and may be touched. */
export function liveProfileDir(account: AgentAccount, home: string, fsx: AccountFs = accountFs): string | null {
  const dir = profileDirOf(account, home)
  return dir && isReachable(dir) && fsx.exists(dir) ? dir : null
}

/** liveProfileDir without a synchronous file call. */
export async function liveProfileDirAsync(account: AgentAccount, home: string, fsx: AccountFsAsync = accountFsAsync): Promise<string | null> {
  const dir = profileDirOf(account, home)
  return dir && isReachable(dir) && (await fsx.exists(dir)) ? dir : null
}

export interface FolderContext {
  home: string
  accounts: readonly AgentAccount[]
  /** The account being edited, when re-checking its own folder. */
  selfId?: string
}

/**
 * Whether `folder` can be `agent`'s profile, and as which launch string: null for the agent's
 * default profile. Refused: anything not a full path, control characters, the home folder, a
 * drive root, a folder outside the test home in a test run, a folder another account already
 * uses, and a folder inside another profile (or holding one).
 */
export function checkProfileFolder(agent: ProfileAgent, folder: unknown, ctx: FolderContext, fsx: AccountFs = accountFs): { profile: string | null } | { error: string } {
  if (typeof folder !== 'string' || !folder.trim()) return { error: 'no folder was chosen' }
  if (hasControlChars(folder)) return { error: 'the folder name holds a control character' }
  if (!isAbsolute(folder)) return { error: 'the folder is not a full path' }
  if (!ctx.home || !isAbsolute(ctx.home)) return { error: 'your home folder is unknown, so no profile can be checked' }
  const l = launchString(folder)
  if (!isReachable(l)) return { error: 'the folder is outside the test home' }
  if (parsePath(l).root === l) return { error: 'a drive or filesystem root can\'t be a profile' }
  const key = comparisonKey(l, fsx)
  if (key === comparisonKey(ctx.home, fsx)) return { error: 'your home folder itself can\'t be a profile' }
  const others = ctx.accounts.filter((a) => a.id !== ctx.selfId && isProfileAgent(a.agent))
  const isDefault = key === comparisonKey(defaultProfileDir(agent, ctx.home), fsx)
  for (const a of others) {
    const other = comparisonKey(a.profile ?? defaultProfileDir(a.agent as ProfileAgent, ctx.home), fsx)
    if (other === key) return { error: `${a.label} already uses that folder` }
    if (isSameOrInside(key, other) || isSameOrInside(other, key)) return { error: `that folder is inside ${a.label}'s profile, or holds it` }
  }
  if (!isDefault) {
    for (const a of ['claude', 'codex'] as const) {
      const main = comparisonKey(defaultProfileDir(a, ctx.home), fsx)
      if (isSameOrInside(key, main) || isSameOrInside(main, key)) return { error: 'that folder is inside an agent\'s main profile, or holds it' }
    }
  }
  return { profile: isDefault ? null : l }
}

/** Subfolders of `dir` that are links into the agent's default profile, by name. */
export function discoverShares(agent: ProfileAgent, dir: string, home: string, fsx: AccountFs = accountFs): string[] {
  if (!home || !isAbsolute(home)) return []
  const main = fsx.realpath(defaultProfileDir(agent, home))
  if (!main) return []
  const shares: string[] = []
  let entries
  try {
    entries = fsx.readDir(dir)
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue
    try {
      const real = fsx.realpath(join(dir, e.name))
      if (real && isSameOrInside(real, main)) shares.push(e.name)
    } catch {
      // A link named like a sign-in file: not one Termpolis looks into.
    }
  }
  return shares.sort()
}

// ── ~/.claude/accounts.sh (read-only) ──────────────────────────────────────────────────

export interface AccountsSh {
  accounts: string[]
  emails: Record<string, string>
  dirs: Record<string, string>
  defaultAccount?: string
  failover: string[]
  cooldown?: number
  refused: string[]
}

/** A value that must never come from a file bash sources: it would run or expand. */
const UNSAFE_VALUE = /[$`\\]/

function shWords(list: string, what: string, refused: string[]): string[] {
  const out: string[] = []
  for (const w of list.trim().split(/\s+/).filter(Boolean)) {
    if (SH_KEY.test(w)) out.push(w)
    else refused.push(`${what}: "${w.slice(0, 40)}" is not a plain name`)
  }
  return out
}

function shTable(text: string, name: string, refused: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const block = new RegExp(`^[ \\t]*declare[ \\t]+-A[ \\t]+${name}=\\(([^)]*)\\)`, 'm').exec(text)
  if (!block) return out
  for (const line of block[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const m = /^\s*\[([^\]]*)\]=(?:"([^"]*)"|'([^']*)'|([^\s"'#]*))\s*(?:#.*)?$/.exec(line)
    if (!m) {
      refused.push(`${name}: a line Termpolis can't read was skipped`)
      continue
    }
    const value = m[2] ?? m[3] ?? m[4]
    if (!SH_KEY.test(m[1])) refused.push(`${name}: "${m[1].slice(0, 40)}" is not a plain name`)
    else if (UNSAFE_VALUE.test(value)) refused.push(`${name}[${m[1]}] holds $, \` or \\, so it was skipped`)
    else out[m[1]] = value
  }
  return out
}

/** Parse accounts.sh's tables with anchored patterns. The file is never sourced or run. */
export function parseAccountsSh(text: string): AccountsSh {
  const refused: string[] = []
  const list = (name: string): string[] => {
    const m = new RegExp(`^[ \\t]*${name}=\\(([^)\\n]*)\\)`, 'm').exec(text)
    return m ? shWords(m[1], name, refused) : []
  }
  const sh: AccountsSh = {
    accounts: list('ACCOUNTS'),
    emails: shTable(text, 'ACCOUNT_EMAIL', refused),
    dirs: shTable(text, 'ACCOUNT_DIR', refused),
    failover: list('FAILOVER_ORDER'),
    refused,
  }
  const def = /^[ \t]*DEFAULT_ACCOUNT=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'#;]*))[ \t]*(?:#.*)?$/m.exec(text)
  const defName = def ? def[1] ?? def[2] ?? def[3] : undefined
  if (defName !== undefined) {
    if (SH_KEY.test(defName)) sh.defaultAccount = defName
    else refused.push('DEFAULT_ACCOUNT is not a plain name')
  }
  const cool = /^[ \t]*LIMIT_COOLDOWN=(\d{1,9})[ \t]*(?:#.*)?$/m.exec(text)
  if (cool) sh.cooldown = Number(cool[1])
  return sh
}

export function accountsShPath(home: string): string | null {
  return home && isAbsolute(home) ? join(defaultProfileDir('claude', home), 'accounts.sh') : null
}

export type AccountsShRead = { kind: 'missing' } | { kind: 'error'; error: string } | { kind: 'ok'; sh: AccountsSh }

export function readAccountsSh(home: string, fsx: AccountFs = accountFs): AccountsShRead {
  const file = accountsShPath(home)
  if (!file || !isReachable(file)) return { kind: 'missing' }
  try {
    const text = fsx.readText(file, MAX_ACCOUNTS_SH_BYTES)
    return text === null ? { kind: 'missing' } : { kind: 'ok', sh: parseAccountsSh(text) }
  } catch {
    return { kind: 'error', error: 'accounts.sh is larger than 64 KB or can\'t be read' }
  }
}

/** The launch string accounts.sh's scripts would put in CLAUDE_CONFIG_DIR for `key`, or null for
 *  the default profile; undefined when its folder isn't a plain folder name in the home folder. */
function shProfile(sh: AccountsSh, key: string, home: string): string | null | undefined {
  const dir = sh.dirs[key]
  if (key === sh.defaultAccount || dir === DEFAULT_PROFILE_FOLDER.claude) return null
  if (!dir || dir === '.' || dir === '..' || !/^[A-Za-z0-9._-]+$/.test(dir)) return undefined
  return launchString(home + sep + dir)
}

/** The same Claude profile folder, null being the default one. */
function sameFolder(a: string | null, b: string | null, home: string, fsx: AccountFs): boolean {
  const key = (p: string | null): string => comparisonKey(p ?? defaultProfileDir('claude', home), fsx)
  return key(a) === key(b)
}

/** What importing accounts.sh would add, row by row. */
export function previewAccountsSh(home: string, doc: AccountsDoc, fsx: AccountFs = accountFs): ImportPreview | { error: string } {
  const read = readAccountsSh(home, fsx)
  if (read.kind === 'missing') return { error: '~/.claude/accounts.sh doesn\'t exist' }
  if (read.kind === 'error') return { error: read.error }
  const { sh } = read
  const refused = [...sh.refused]
  const rows: ImportPreviewRow[] = []
  const claude = doc.file.accounts.filter((a) => a.agent === 'claude')
  const failoverRank = (k: string): number => {
    const i = sh.failover.indexOf(k)
    return i >= 0 ? i : sh.failover.length + sh.accounts.indexOf(k)
  }
  let defaultTaken = false
  for (const key of [...sh.accounts].sort((x, y) => failoverRank(x) - failoverRank(y))) {
    const profile = shProfile(sh, key, home)
    if (profile === undefined) {
      refused.push(`${key}: its folder isn't a plain folder name in your home folder`)
      continue
    }
    if (profile === null && defaultTaken) {
      refused.push(`${key}: only one account can be the default profile`)
      continue
    }
    if (profile === null) defaultTaken = true
    const dir = profile ?? defaultProfileDir('claude', home)
    const email = sh.emails[key]
    rows.push({
      key,
      label: key,
      ...(isPlainEmail(email) ? { email } : {}),
      profile,
      autoOffer: sh.failover.includes(key),
      order: rows.length,
      registered: claude.some((a) => a.importedAs === key || sameFolder(a.profile, profile, home, fsx)),
      folderExists: isReachable(dir) && fsx.exists(dir),
      shares: profile ? discoverShares('claude', profile, home, fsx) : [],
    })
  }
  return { rows, refused, ...(sh.cooldown ? { cooldownSec: sh.cooldown } : {}) }
}

/** The differences between accounts.sh and the registry, one sentence each. Empty when there is
 *  no accounts.sh. Re-read every time Settings ▸ Accounts opens; nothing is synced. */
export function accountsShDrift(home: string, doc: AccountsDoc, fsx: AccountFs = accountFs): { lines: string[]; unlisted: number } {
  const read = readAccountsSh(home, fsx)
  if (read.kind !== 'ok') return { lines: [], unlisted: 0 }
  const { sh } = read
  const lines: string[] = []
  const claude = doc.file.accounts.filter((a) => a.agent === 'claude')
  for (const a of claude) {
    if (a.importedAs) {
      if (!sh.accounts.includes(a.importedAs)) {
        lines.push(`${a.label} was imported as ${a.importedAs}, which accounts.sh no longer lists.`)
        continue
      }
      const shEmail = sh.emails[a.importedAs]
      if (isPlainEmail(shEmail) && a.email && shEmail.toLowerCase() !== a.email.toLowerCase()) {
        lines.push(`accounts.sh gives ${a.importedAs} another email than Termpolis has for ${a.label}.`)
      }
      const shDir = shProfile(sh, a.importedAs, home)
      // accounts.sh's folders are login slots (resolve_profiles): an account that followed its
      // login into another of them (reslotClaudeAccounts) is where accounts.sh would put it too.
      const inSlot = sh.accounts.some((k) => {
        const p = shProfile(sh, k, home)
        return p !== undefined && sameFolder(a.profile, p, home, fsx)
      })
      if (shDir !== undefined && !inSlot && !sameFolder(a.profile, shDir, home, fsx)) {
        lines.push(`accounts.sh puts ${a.importedAs} in another folder than Termpolis has for ${a.label}.`)
      }
    }
  }
  for (const key of sh.accounts) {
    const profile = shProfile(sh, key, home)
    if (!claude.some((a) => a.importedAs === key || (profile !== undefined && sameFolder(a.profile, profile, home, fsx)))) {
      lines.push(`accounts.sh lists ${key}, which Termpolis hasn't imported.`)
    }
  }
  let unlisted = 0
  for (const a of claude) {
    if (!a.profile) continue
    const listed = sh.accounts.some((k) => {
      const p = shProfile(sh, k, home)
      return p !== undefined && sameFolder(a.profile, p, home, fsx)
    })
    if (!listed) {
      unlisted++
      lines.push(`${a.label} isn't in accounts.sh, so your status line and failover hook count its sessions as ${sh.defaultAccount ?? 'the default account'}. Add it there to fix that.`)
    }
  }
  return { lines, unlisted }
}

/** The lines that make accounts.sh's scripts know a new Claude account. Termpolis never writes
 *  the file; the Add dialog shows these with a Copy button. */
export function accountsShLines(home: string, label: string, email: string | undefined, profile: string, fsx: AccountFs = accountFs): string[] | null {
  const read = readAccountsSh(home, fsx)
  if (read.kind !== 'ok') return null
  const key = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'account'
  const folder = basename(profile)
  // The scripts source this file: a name with a command substitution, a quote or a space would run or break there. Only
  // the names the import itself takes (shProfile) are offered; any other folder is left to the user to write by hand.
  if (!/^[A-Za-z0-9._-]+$/.test(folder) || folder === '.' || folder === '..') return null
  return [
    `ACCOUNTS=(${[...read.sh.accounts, key].join(' ')})   # add ${key}`,
    `  [${key}]="${email ?? ''}"   # in ACCOUNT_EMAIL`,
    `  [${key}]="${folder}"   # in ACCOUNT_DIR`,
  ]
}

/** When the ~/.claude StopFailure hook last marked an imported account limited (epoch seconds):
 *  `~/.claude/.limited-<key>`, which Termpolis only ever reads. */
export function limitedMarker(home: string, key: string | undefined, fsx: AccountFs = accountFs): number | null {
  if (!key || !SH_KEY.test(key) || !home || !isAbsolute(home)) return null
  const file = join(defaultProfileDir('claude', home), `.limited-${key}`)
  if (!isReachable(file)) return null
  try {
    const text = fsx.readText(file, 64)
    const n = text === null ? NaN : Number(text.trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// ── What Termpolis knows without starting a process ────────────────────────────────────

/** "Last signed in as": the email Claude Code keeps in the profile's `.claude.json`
 *  (`~/.claude.json` for the default profile), or the email Codex's own app server last
 *  reported. That a profile names an email does not mean it is still signed in. */
export function lastSignedInAs(account: AgentAccount, home: string, doc: AccountsDoc, fsx: AccountFs = accountFs): string | null {
  if (account.agent === 'codex') {
    const id = doc.file.identity[account.id]
    return id?.source === 'account-read' && isPlainEmail(id.email) ? id.email : null
  }
  const file = claudeJsonOf(account, home)
  if (!file || !isReachable(file) || !liveProfileDir(account, home, fsx)) return null
  const r = readClaudeJsonFields(file, ['oauthAccount.emailAddress'])
  const email = r.kind === 'ok' ? r.values['oauthAccount.emailAddress'] : undefined
  return isPlainEmail(email) ? email : null
}

/** What belongs to a profile folder rather than to the account that uses it. */
const FOLDER_FIELDS = ['profile', 'connect', 'origin', 'links', 'copiedAt'] as const
type FolderFields = Pick<AgentAccount, (typeof FOLDER_FIELDS)[number]>

/** Claude Code accounts follow their login between the profile folders they hold, as
 *  ~/.claude/accounts.sh's resolve_profiles does: the folders are login slots, not names. An
 *  account whose email is the login in one of the folders gets that folder (its own first); an
 *  account signed in nowhere keeps its own folder if that is free, else takes the first free one.
 *  So "personal" whose login sits in ~/.claude-work moves there, rather than showing ~/.claude's
 *  other login as "signed in to … instead!". Only Claude accounts with an email, two or more, each
 *  in its own folder. A moved account's checked identity is dropped (it described the old folder).
 *  Returns the labels of the accounts moved; [] leaves the registry as it was. */
export function reslotClaudeAccounts(doc: AccountsDoc, home: string, fsx: AccountFs = accountFs): string[] {
  const accts = doc.file.accounts.filter((a) => a.agent === 'claude' && isPlainEmail(a.email))
  if (accts.length < 2) return []
  const keys = accts.map((a) => {
    const dir = profileDirOf(a, home)
    return dir ? comparisonKey(dir, fsx) : null
  })
  if (keys.some((k) => !k) || new Set(keys).size !== keys.length) return []
  const owner = (email: string | null): number =>
    email ? accts.findIndex((a) => a.email!.toLowerCase() === email.toLowerCase()) : -1
  const login = accts.map((a) => owner(lastSignedInAs(a, home, doc, fsx)))
  // holder[slot] = the account that gets slot's folder; slot i is accts[i]'s folder now.
  const holder: number[] = accts.map(() => -1)
  accts.forEach((_, a) => {
    for (const s of [a, ...accts.keys()]) {
      if (login[s] === a && holder[s] < 0) {
        holder[s] = a
        return
      }
    }
  })
  accts.forEach((_, a) => {
    if (holder.includes(a)) return
    holder[holder[a] < 0 ? a : holder.indexOf(-1)] = a
  })
  if (holder.every((a, s) => a === s)) return []
  const folders: FolderFields[] = accts.map((a) => {
    const f = {} as Record<string, unknown>
    for (const k of FOLDER_FIELDS) f[k] = a[k]
    return f as unknown as FolderFields
  })
  // A usage limit was hit by the login in the folder, so it moves with the folder too.
  const limits = accts.map((a) => doc.file.limits[a.id])
  const moved: string[] = []
  holder.forEach((a, s) => {
    if (a === s) return
    const acct = accts[a]
    for (const k of FOLDER_FIELDS) delete (acct as unknown as Record<string, unknown>)[k]
    Object.assign(acct, folders[s])
    delete doc.file.identity[acct.id]
    if (limits[s]) doc.file.limits[acct.id] = limits[s]
    else delete doc.file.limits[acct.id]
    moved.push(acct.label)
  })
  return accts.filter((a) => moved.includes(a.label)).map((a) => a.label)
}

/** The account a usage limit or a check is recorded against, by id. */
export function findAccount(doc: AccountsDoc, id: unknown): AgentAccount | undefined {
  return typeof id === 'string' ? doc.file.accounts.find((a) => a.id === id) : undefined
}

/** Every Claude Code and Codex profile the registry names that exists and may be touched. With
 *  `connectedOnly`, only those the user connected (the default profile is connected through
 *  Agent Integration itself, so it always counts). */
export function accountProfileTargets(
  paths: Pick<AgentIntegrationPaths, 'home'>,
  doc: AccountsDoc,
  opts: { connectedOnly: boolean },
  fsx: AccountFs = accountFs,
): ProfileTarget[] {
  const targets: ProfileTarget[] = []
  for (const a of doc.file.accounts) {
    if (!isProfileAgent(a.agent)) continue
    if (opts.connectedOnly && a.profile !== null && !a.connect) continue
    const dir = liveProfileDir(a, paths.home, fsx)
    if (!dir) continue
    const claudeJson = claudeJsonOf(a, paths.home)
    targets.push({ agent: a.agent, dir, ...(claudeJson ? { claudeJson } : {}), accountId: a.id })
  }
  return targets
}

/** Is this account connected to Termpolis (given Agent Integration is)? */
export function isAccountConnected(account: AgentAccount | undefined): boolean {
  return !account || account.profile === null || account.connect
}

/** The cooldown for an agent: what the user (or accounts.sh) set, else 5 hours. */
export function cooldownFor(doc: AccountsDoc, agent: AccountAgent): number {
  return doc.file.cooldownSec[agent] ?? DEFAULT_COOLDOWN_SEC
}

// ── Usage limits ───────────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 86400 * 1000

/** When a recorded limit ends: its reset time; with none known, `seenAt` plus the cooldown. A
 *  weekly or monthly limit whose reset couldn't be read never falls back to the cooldown (in 5 h
 *  it would be offered again while out for days): it lasts until marked available, or 7 days. */
export function limitEndsAt(limit: AccountLimit, cooldownSec: number): number {
  if (limit.resetsAt !== null) return limit.resetsAt
  if (limit.window === 'weekly' || limit.window === 'monthly') return limit.seenAt + WEEK_MS
  return limit.seenAt + cooldownSec * 1000
}

/** The account's recorded usage limit, while it lasts. */
export function activeLimit(doc: AccountsDoc, account: AgentAccount, now: number): AccountLimit | undefined {
  const limit = doc.file.limits[account.id]
  return limit && limitEndsAt(limit, cooldownFor(doc, account.agent)) > now ? limit : undefined
}

const LIMIT_SCOPES: ReadonlyArray<AccountLimit['scope']> = ['account', 'model']
const LIMIT_WINDOWS: ReadonlyArray<NonNullable<AccountLimit['window']>> = ['session', 'weekly', 'monthly', 'other']

/** A limit as the chooser reports it, checked field by field; null when it isn't one. */
export function cleanLimit(v: unknown, now: number): AccountLimit | null {
  if (!isRecord(v) || typeof v.text !== 'string' || !v.text.trim()) return null
  const resetsAt = typeof v.resetsAt === 'number' && Number.isFinite(v.resetsAt) && v.resetsAt > 0 ? v.resetsAt : null
  const limit: AccountLimit = {
    seenAt: now,
    resetsAt,
    // The CLI's own words, one line, as the dialog shows them.
    text: v.text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 300),
    scope: LIMIT_SCOPES.find((s) => s === v.scope) ?? 'account',
  }
  const window = LIMIT_WINDOWS.find((w) => w === v.window)
  if (window) limit.window = window
  if (isPlainEmail(v.email)) limit.email = v.email
  return limit
}
