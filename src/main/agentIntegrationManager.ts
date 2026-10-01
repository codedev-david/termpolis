// Agent integration, main side: the ledger of what the user agreed to and what Termpolis
// wrote, the one-time migrations off the pre-consent behaviour, and apply / disconnect for
// Claude Code, Codex and Gemini CLI configs. Plain fs + paths, no electron import, so tests
// drive it with temp dirs. index.ts owns the IPC handlers and passes the runtime in.
//
// Ledger: `<userData>/agent-integration.json`
//   { version: 1, consent: 'granted' | 'declined' | null, primerHook: boolean, legacy: boolean,
//     migrations: string[], trustedByTermpolis: string[] }
//
// Versions from before consent existed wrote at fixed paths under the home folder, whatever
// CLAUDE_CONFIG_DIR or CODEX_HOME said, so detection and every cleanup look in both places.
// Nothing here throws: a config it cannot read or safely edit becomes a 'skipped' row. So does
// every agent config when there is no full home folder to find them in: a relative path would
// land in whatever folder Termpolis was started from.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'fs'
import { dirname, isAbsolute, join, resolve, sep, win32 } from 'path'
import { CODEX_AUTO_APPROVED_TOOLS, MCP_TOOLS_AUTO_ALLOWED, isUnsafeTrustRoot } from '../shared/agentIntegration'
import type {
  AgentId, AgentIntegrationAgentStatus, AgentIntegrationChange, AgentIntegrationConsent,
  AgentIntegrationSetRequest, AgentIntegrationSetResult, AgentIntegrationStatus, CodexLaunchContext,
} from '../shared/agentIntegration'
import { atomicWriteText, editJsonObject, errorText, readJsonObject, readTextFile } from './agentConfigIO'
import {
  FOREIGN_SERVER, applyAllowRules, applyPrimerHook, hasPluginEnablement, hasPrimerHook,
  hasServerEntry, hasTermpolisAllowRule, isAdapterPath, isPrimerHookCommand, isTermpolisPluginManifest,
  isTermpolisServerEntry, localMarketplaceNames, primerHookCommand, removeAllowRules,
  removeInstalledPlugin, removeLegacyAllowRules, removeMarketplaceEntry, removePluginEnablement,
  removePrimerHooks, removeRootServerEntry, removeServerEntry, termpolisServerEntry, toRunner,
  upsertClaudeUserServer, upsertServerEntry,
} from './agentMcpRegistry'
import type { EntryEdit, NodeSpec, ServerEntry } from './agentMcpRegistry'
import {
  addCodexToolApprovals, codexConfigSets, codexServerState, codexTrustedProjects,
  stripCodexProjectTrust, stripCodexServer, upsertCodexServer,
} from './codexConfigEdit'
import { claudeProjectKey, revertClaudeTrust, trustClaudeWorkspace, untrustUnsafeClaudeRoots } from './claudeTrust'
import { buildCodexInstruction, cleanAgentsMd } from './codexParity'

export interface AgentIntegrationPaths {
  /** The user's home folder as a full path, or '' when none is known. With '' no agent config
   *  is read or written: see agentPaths(). */
  home: string
  /** Termpolis's own userData folder; the ledger lives here. */
  userData: string
  /** `CLAUDE_CONFIG_DIR`, else `<home>/.claude`. Claude Code's settings.json lives here. */
  claudeDir: string
  /** `<CLAUDE_CONFIG_DIR>/.claude.json` when that is set, else `<home>/.claude.json`: Claude
   *  Code's user-scope MCP servers and its folder trust. */
  claudeJson: string
  /** `CODEX_HOME`, else `<home>/.codex`. config.toml lives here. */
  codexHome: string
  /** `<home>/.gemini`. settings.json lives here. */
  geminiDir: string
}

export interface AgentIntegrationRuntime {
  paths: AgentIntegrationPaths
  /** The stdio MCP adapter script that agent configs spawn. */
  adapterPath: string
  /** SessionStart memory-primer hook script (forward slashes), or null when the build lacks it. */
  hookScriptPath: string | null
  /** How agent configs spawn node: resolveNodeRunner(). */
  node: NodeSpec
  /** The shell to write the SessionStart hook for. Left out, claudeHookShell() works it out
   *  the way Claude Code does. */
  hookShell?: HookShell
}

/** The shell Claude Code runs a hook's command in: 'sh', its default (`/bin/sh`, or Git Bash on
 *  Windows), or 'powershell', which it uses instead on Windows when it finds no Git Bash. */
export type HookShell = 'sh' | 'powershell'

/** Result of `claude:trust-workspace`, unchanged in shape for the renderer. */
export interface TrustFolderResult {
  changed: boolean
  keys: string[]
  skipped?: 'no-consent' | 'no-home' | 'unsafe-root' | string
}

/** `p` when it is a full path, else ''. */
function fullPath(p: string | undefined): string {
  return typeof p === 'string' && isAbsolute(p) ? p : ''
}

/** Where each agent keeps its config. A home folder or override that is blank or relative
 *  (HOME='' makes os.homedir() return '' on macOS and Linux) counts as unknown: joined as it
 *  is, `.claude` would be a folder under the working directory. */
export function resolveAgentIntegrationPaths(
  osHome: string,
  userData: string,
  env: Readonly<Record<string, string | undefined>>,
): AgentIntegrationPaths {
  // Test runs (vitest setup, e2e launch) point every agent config at a scratch home, so a
  // spec that boots the app can never rewrite the developer's real ~/.claude* / ~/.codex.
  // One that is set but unusable gives no home at all, never the real one.
  const testHome = env.TERMPOLIS_TEST_AGENT_HOME?.trim()
  const home = fullPath(testHome || osHome)
  const claudeConfigDir = testHome ? '' : fullPath(env.CLAUDE_CONFIG_DIR?.trim())
  const codexHome = testHome ? '' : fullPath(env.CODEX_HOME?.trim())
  const inHome = (name: string): string => (home ? join(home, name) : '')
  return {
    home,
    userData,
    claudeDir: claudeConfigDir || inHome('.claude'),
    claudeJson: claudeConfigDir ? join(claudeConfigDir, '.claude.json') : inHome('.claude.json'),
    codexHome: codexHome || inHome('.codex'),
    geminiDir: inHome('.gemini'),
  }
}

type AgentPathSet = Omit<AgentIntegrationPaths, 'userData'>

/** The agent paths, when every one is a full path; null when the home folder is unknown (or a
 *  caller's paths cannot even be read). Callers then leave agent configs alone. */
function agentPaths(paths: AgentIntegrationPaths): AgentPathSet | null {
  try {
    const { home, claudeDir, claudeJson, codexHome, geminiDir } = paths
    const set = { home, claudeDir, claudeJson, codexHome, geminiDir }
    return Object.values(set).every((p) => fullPath(p) !== '') ? set : null
  } catch {
    return null
  }
}

const NO_HOME = 'Your home folder is unknown or not a full path (check HOME, or USERPROFILE on Windows), so no agent config was read or changed'

function noHomeRow(): AgentIntegrationChange {
  return change('claude', '~', 'skipped', 'Agent configs', NO_HOME)
}

/** errorText for any thrown value. One with no usable message or string form (a null-prototype
 *  object, say) still gives a line, so an error path cannot throw in turn. */
function errorTextSafe(e: unknown): string {
  try {
    return String(errorText(e))
  } catch {
    return 'unknown error'
  }
}

// ── Ledger ──────────────────────────────────────────────────────────────────────────────

const LEDGER_FILE = 'agent-integration.json'

interface Ledger {
  version: 1
  consent: AgentIntegrationConsent
  primerHook: boolean
  /** An older Termpolis had connected the agents before this ledger existed. */
  legacy: boolean
  /** One-time migrations that have completed. */
  migrations: string[]
  /** Claude Code folder-trust keys Termpolis switched on, so a disconnect can switch them off. */
  trustedByTermpolis: string[]
}

/** The ledger's full path, or null when userData is not a full path (the ledger would land in
 *  the working directory). Throws when userData is not a string; ledgerFileFor never does. */
function ledgerPath(paths: AgentIntegrationPaths): string | null {
  return isAbsolute(paths.userData) ? join(paths.userData, LEDGER_FILE) : null
}

/** The ledger's path for a row that reports on it, from any `paths` at all. */
function ledgerFileFor(paths: AgentIntegrationPaths | undefined): string {
  try {
    return (paths && ledgerPath(paths)) || LEDGER_FILE
  } catch {
    return LEDGER_FILE
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

/** The saved ledger, or null when there is none this version can read. */
function readLedger(paths: AgentIntegrationPaths): Ledger | null {
  const file = ledgerPath(paths)
  if (file === null) return null
  const r = readJsonObject(file)
  if (r.kind !== 'ok' || r.value.version !== 1) return null
  const v = r.value
  return {
    version: 1,
    consent: v.consent === 'granted' || v.consent === 'declined' ? v.consent : null,
    primerHook: v.primerHook !== false,
    legacy: v.legacy === true,
    migrations: stringList(v.migrations),
    trustedByTermpolis: stringList(v.trustedByTermpolis),
  }
}

/** Save the ledger. Returns why it could not be saved, or null. Never throws: a caller whose
 *  save carries the user's answer reports the failure, and the others just go on. */
function writeLedger(paths: AgentIntegrationPaths, ledger: Ledger): string | null {
  try {
    const file = ledgerPath(paths)
    if (file === null) throw new Error('the folder Termpolis keeps its settings in is not a full path')
    mkdirSync(paths.userData, { recursive: true })
    atomicWriteText(file, JSON.stringify(ledger, null, 2) + '\n')
    return null
  } catch (e) {
    const error = errorTextSafe(e)
    console.warn(`[agent-integration] could not save ${LEDGER_FILE}: ${error}`)
    return error
  }
}

/** The ledger, created on first use with a note of whether an older Termpolis had already
 *  connected the agents (detected before any migration touches those configs). With no home
 *  folder nothing can be detected, so that first ledger waits, unsaved, for a start that has one. */
function loadLedger(paths: AgentIntegrationPaths): Ledger {
  const saved = readLedger(paths)
  if (saved) return saved
  const known = agentPaths(paths) !== null
  const legacy = known ? detectLegacy(paths) : { found: false, primerHook: false }
  const ledger: Ledger = {
    version: 1,
    consent: null,
    primerHook: legacy.found ? legacy.primerHook : true,
    legacy: legacy.found,
    migrations: [],
    trustedByTermpolis: [],
  }
  if (known) writeLedger(paths, ledger)
  return ledger
}

/** Granted, or an existing install whose owner hasn't been asked yet: that keeps working,
 *  in its new narrower form, until they answer the one-time review. */
function isConnected(ledger: Ledger): boolean {
  return ledger.consent === 'granted' || (ledger.consent === null && ledger.legacy)
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────

type Json = Record<string, any>

function unique(list: string[]): string[] {
  const seen = new Set<string>()
  return list.filter((p) => {
    const key = process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const claudeDirs = (paths: AgentIntegrationPaths): string[] => unique([paths.claudeDir, join(paths.home, '.claude')])
const claudeJsonFiles = (paths: AgentIntegrationPaths): string[] => unique([paths.claudeJson, join(paths.home, '.claude.json')])
const codexHomes = (paths: AgentIntegrationPaths): string[] => unique([paths.codexHome, join(paths.home, '.codex')])

function change(
  agent: AgentId, file: string, action: AgentIntegrationChange['action'], what: string, error?: string,
): AgentIntegrationChange {
  return error === undefined ? { agent, file, action, what } : { agent, file, action, what, error }
}

const isChange = (c: AgentIntegrationChange): boolean => c.action !== 'unchanged'

function readJson(file: string): Json | null {
  const r = readJsonObject(file)
  return r.kind === 'ok' ? r.value : null
}

function readText(file: string): { text: string | null } | { error: string } {
  try {
    return { text: readTextFile(file) }
  } catch (e) {
    return { error: errorText(e) }
  }
}

interface Step {
  what: string
  run: (root: Json) => EntryEdit
}

/** Run `steps` over one JSON config in a single read-modify-write, one row per step. */
function editConfig(agent: AgentId, file: string, steps: Step[], create: boolean): AgentIntegrationChange[] {
  const outcomes: EntryEdit[] = []
  const r = editJsonObject(file, (root) => { for (const s of steps) outcomes.push(s.run(root)) }, { create })
  return steps.map((s, i) => {
    const o = outcomes[i]
    if (typeof o === 'object') return change(agent, file, 'skipped', s.what, o.skipped)
    if (r.status === 'error') {
      return o === 'unchanged' ? change(agent, file, 'unchanged', s.what) : change(agent, file, 'skipped', s.what, r.error)
    }
    return change(agent, file, o ?? 'unchanged', s.what)
  })
}

// ── Codex ───────────────────────────────────────────────────────────────────────────────

type CodexOwner = 'ours' | 'foreign' | 'empty' | 'absent' | { error: string }

/** Whose `[mcp_servers.termpolis]` this config.toml holds. 'empty': a table naming no command. */
function codexOwner(text: string): CodexOwner {
  const s = codexServerState(text)
  if (s.state === 'error') return { error: s.error }
  if (s.state === 'absent') return 'absent'
  if (s.command === undefined && s.args === undefined) return 'empty'
  return isAdapterPath(s.args?.[0]) ? 'ours' : 'foreign'
}

function applyCodex(entry: ServerEntry, file: string): AgentIntegrationChange[] {
  const server = 'MCP server'
  const approvals = 'Pre-approval for the memory tools'
  const read = readText(file)
  if ('error' in read) return [change('codex', file, 'skipped', server, read.error)]
  const original = read.text ?? ''
  const owner = codexOwner(original)
  if (typeof owner === 'object') return [change('codex', file, 'skipped', server, owner.error)]
  if (owner === 'foreign') return [change('codex', file, 'skipped', server, FOREIGN_SERVER)]
  const up = upsertCodexServer(original, entry)
  if ('error' in up) return [change('codex', file, 'skipped', server, up.error)]
  const rows = [change('codex', file, owner === 'absent' ? 'add' : up.changed ? 'update' : 'unchanged', server)]
  let next = up.text
  const ap = addCodexToolApprovals(next, CODEX_AUTO_APPROVED_TOOLS)
  if ('error' in ap) {
    rows.push(change('codex', file, 'skipped', approvals, ap.error))
  } else {
    next = ap.text
    rows.push(change('codex', file, ap.added.length ? 'add' : 'unchanged', approvals))
  }
  if (next === original) return rows
  try {
    atomicWriteText(file, next)
    return rows
  } catch (e) {
    const error = errorText(e)
    return rows.map((r) => (r.action === 'unchanged' || r.action === 'skipped' ? r : { ...r, action: 'skipped', error }))
  }
}

function stripCodex(file: string): AgentIntegrationChange[] {
  const what = 'MCP server'
  const read = readText(file)
  if ('error' in read) return [change('codex', file, 'skipped', what, read.error)]
  if (read.text === null) return []
  const owner = codexOwner(read.text)
  if (typeof owner === 'object') return [change('codex', file, 'skipped', what, owner.error)]
  if (owner === 'foreign') return [change('codex', file, 'unchanged', what)]
  // Also clears `[mcp_servers.termpolis.*]` tables left without their server, which Codex
  // refuses to load.
  const r = stripCodexServer(read.text)
  if ('error' in r) return [change('codex', file, 'skipped', what, r.error)]
  if (!r.changed) return [change('codex', file, 'unchanged', what)]
  try {
    atomicWriteText(file, r.text)
  } catch (e) {
    return [change('codex', file, 'skipped', what, errorText(e))]
  }
  return [change('codex', file, 'remove', what)]
}

// ── The local plugin earlier versions installed ─────────────────────────────────────────

function realDir(p: string): boolean {
  try {
    const s = lstatSync(p)
    return s.isDirectory() && !s.isSymbolicLink()
  } catch {
    return false
  }
}

/** Is `child`, links resolved, inside `parent`? Keeps removal away from a plugin folder that
 *  is really a link to somewhere else, such as a checkout of the plugin's source. */
function isInside(child: string, parent: string): boolean {
  try {
    const fold = (p: string): string => {
      const real = realpathSync.native(p)
      return process.platform === 'win32' ? real.toLowerCase() : real
    }
    const c = fold(child)
    const p = fold(parent)
    return c.startsWith(p.endsWith(sep) ? p : p + sep)
  } catch {
    return false
  }
}

interface PluginFolder {
  folder: string
  /** The highest folder removal may not touch. */
  keep: string
  /** The installer's files in `folder` that carry Termpolis's signature. */
  files: string[]
}

function pluginFolder(folder: string, keep: string): PluginFolder | null {
  if (!realDir(folder) || !isInside(folder, keep)) return null
  const files: string[] = []
  const manifest = join(folder, '.claude-plugin', 'plugin.json')
  if (realDir(join(folder, '.claude-plugin')) && isTermpolisPluginManifest(readJson(manifest), null)) files.push(manifest)
  const servers = join(folder, '.mcp.json')
  const mcp = readJson(servers)
  if (mcp && hasServerEntry(mcp)) files.push(servers)
  return files.length ? { folder, keep, files } : null
}

/** The plugin's folders under one Claude config dir: the marketplace source, and every
 *  version Claude Code copied into its plugin cache. */
function pluginFolders(dir: string, marketplaces: readonly string[]): PluginFolder[] {
  const found: Array<PluginFolder | null> = [
    pluginFolder(join(dir, 'local-marketplace', 'plugins', 'termpolis'), dir),
    pluginFolder(join(dir, 'local-marketplace', 'termpolis'), dir),
  ]
  const cache = join(dir, 'plugins', 'cache')
  for (const m of marketplaces) {
    const base = join(cache, m, 'termpolis')
    if (!realDir(base)) continue
    let versions: string[] = []
    try {
      versions = readdirSync(base)
    } catch {
      continue
    }
    for (const v of versions) found.push(pluginFolder(join(base, v), cache))
  }
  return found.filter((f): f is PluginFolder => f !== null)
}

/** Remove `from` and each folder above it while it is an empty real folder, stopping below `keep`. */
function pruneEmpty(from: string, keep: string): void {
  const stop = resolve(keep)
  for (let d = resolve(from); d.length > stop.length && d.startsWith(stop); d = dirname(d)) {
    if (!existsSync(d)) continue
    if (!realDir(d) || readdirSync(d).length) return
    rmdirSync(d)
  }
}

function claudeMarketplaces(dir: string): string[] {
  return localMarketplaceNames(readJson(join(dir, 'settings.json')), readJson(join(dir, 'plugins', 'known_marketplaces.json')))
}

/**
 * Take the plugin out of one Claude config dir: its enablement, Claude Code's install record,
 * the marketplace entry, and the two files the installer wrote in each copy of the folder.
 * Other files in those folders stay, and so does every marketplace registration: the user
 * may keep plugins of their own in the same marketplace.
 */
function removeLocalPlugin(dir: string): AgentIntegrationChange[] {
  const markets = claudeMarketplaces(dir)
  const rows = [
    ...editConfig('claude', join(dir, 'settings.json'), [
      { what: 'Local Termpolis plugin, enabled', run: (root) => removePluginEnablement(root, markets) },
    ], false),
    ...editConfig('claude', join(dir, 'plugins', 'installed_plugins.json'), [
      { what: 'Local Termpolis plugin, install record', run: (root) => removeInstalledPlugin(root, markets) },
    ], false),
    ...editConfig('claude', join(dir, 'local-marketplace', '.claude-plugin', 'marketplace.json'), [
      { what: 'Local Termpolis plugin, marketplace entry', run: removeMarketplaceEntry },
    ], false),
  ]
  for (const p of pluginFolders(dir, markets)) {
    try {
      for (const f of p.files) unlinkSync(f)
      pruneEmpty(join(p.folder, '.claude-plugin'), p.keep)
      rows.push(change('claude', p.folder, 'remove', 'Local Termpolis plugin, files'))
    } catch (e) {
      rows.push(change('claude', p.folder, 'skipped', 'Local Termpolis plugin, files', errorText(e)))
    }
  }
  return rows
}

// ── Other legacy writes ─────────────────────────────────────────────────────────────────

/** ~/.mcp.json is a project file Claude Code reads only in the home folder, where it asks
 *  before using it. The file goes when Termpolis's server was all it held. */
function removeGlobalMcpJson(paths: AgentIntegrationPaths): AgentIntegrationChange[] {
  const file = join(paths.home, '.mcp.json')
  const state = { emptied: false }
  const rows = editConfig('claude', file, [{
    what: 'MCP server in ~/.mcp.json',
    run: (root) => {
      const nested = removeServerEntry(root)
      const top = removeRootServerEntry(root)
      if (nested === 'unchanged' && top === 'unchanged') return 'unchanged'
      state.emptied = Object.keys(root).length === 0
      return 'remove'
    },
  }], false)
  if (state.emptied && rows[0].action === 'remove') {
    try {
      unlinkSync(file)
    } catch {
      // An empty {} left behind is harmless.
    }
  }
  return rows
}

const UNSAFE_TRUST = 'Folder trust for your home folder or a drive root'

function untrustRoots(file: string, home: string): AgentIntegrationChange {
  const r = untrustUnsafeClaudeRoots({ configPath: file, home })
  if (r.error) return change('claude', file, 'skipped', UNSAFE_TRUST, r.error)
  return change('claude', file, r.changed ? 'remove' : 'unchanged', UNSAFE_TRUST)
}

function revertTrust(file: string, keys: readonly string[]): AgentIntegrationChange {
  const what = 'Folder trust Termpolis added'
  const r = revertClaudeTrust(keys, { configPath: file })
  if (r.error) return change('claude', file, 'skipped', what, r.error)
  return change('claude', file, r.changed ? 'remove' : 'unchanged', what)
}

function detectLegacy(paths: AgentIntegrationPaths): { found: boolean; primerHook: boolean } {
  let found = false
  let primerHook = false
  for (const dir of claudeDirs(paths)) {
    const markets = claudeMarketplaces(dir)
    const settings = readJson(join(dir, 'settings.json'))
    if (settings && (hasServerEntry(settings) || hasTermpolisAllowRule(settings) || hasPluginEnablement(settings, markets))) found = true
    if (settings && hasPrimerHook(settings)) {
      found = true
      primerHook = true
    }
    if (pluginFolders(dir, markets).length) found = true
  }
  for (const file of [...claudeJsonFiles(paths), join(paths.home, '.mcp.json')]) {
    const root = readJson(file)
    if (root && (hasServerEntry(root) || isTermpolisServerEntry(root.termpolis))) found = true
  }
  for (const home of codexHomes(paths)) {
    const read = readText(join(home, 'config.toml'))
    if ('text' in read && read.text !== null && codexOwner(read.text) === 'ours') found = true
  }
  const gemini = readJson(join(paths.geminiDir, 'settings.json'))
  if (gemini && hasServerEntry(gemini)) found = true
  return { found, primerHook }
}

interface Migration {
  id: string
  run: (paths: AgentIntegrationPaths) => AgentIntegrationChange[]
}

/** Run once each, whatever the consent: they take back what older versions wrote unasked. */
const MIGRATIONS: readonly Migration[] = [
  {
    id: 'claude-allow-safe-list-v1',
    run: (paths) => claudeDirs(paths).flatMap((dir) => editConfig('claude', join(dir, 'settings.json'), [
      { what: 'Permission for every Termpolis tool to run without asking', run: removeLegacyAllowRules },
    ], false)),
  },
  { id: 'drop-global-mcp-json-v1', run: removeGlobalMcpJson },
  { id: 'remove-local-plugin-v1', run: (paths) => claudeDirs(paths).flatMap(removeLocalPlugin) },
  { id: 'untrust-home-v1', run: (paths) => claudeJsonFiles(paths).map((file) => untrustRoots(file, paths.home)) },
]

// ── Apply ───────────────────────────────────────────────────────────────────────────────

/** Where Claude Code looks for Git Bash after CLAUDE_CODE_GIT_BASH_PATH, before PATH. */
const GIT_BASH_DEFAULTS = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']

/** The file names Claude Code takes CLAUDE_CODE_GIT_BASH_PATH to be a shell by. */
const GIT_BASH_NAMES = ['bash.exe', 'sh.exe', 'bash', 'sh']

/**
 * The shell Claude Code will run the SessionStart hook in, found the way Claude Code 2.1 finds
 * it: sh everywhere but Windows, and on Windows too when there is a Git Bash; PowerShell when
 * there is none. Its Git Bash is CLAUDE_CODE_GIT_BASH_PATH when that names a bash or sh that
 * exists, else either default Git folder's, else the bin\bash.exe two folders above the first
 * git on PATH. Claude Code sets the `env` of its settings.json over its own environment first,
 * which is how its docs say to point it at a Git Bash it cannot find, so `settingsEnv` wins too.
 */
export function claudeHookShell(
  platform: NodeJS.Platform,
  settingsEnv: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
): HookShell {
  if (platform !== 'win32') return 'sh'
  // Windows reads variable names in any case.
  const vars = new Map<string, string>()
  for (const source of [env, settingsEnv]) {
    if (!source || typeof source !== 'object') continue
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === 'string') vars.set(k.toUpperCase(), v)
    }
  }
  const pinned = vars.get('CLAUDE_CODE_GIT_BASH_PATH')
  if (pinned && GIT_BASH_NAMES.includes(win32.basename(pinned).toLowerCase()) && fileExists(pinned)) return 'sh'
  if (GIT_BASH_DEFAULTS.some((p) => fileExists(p))) return 'sh'
  const git = firstOnPath('git', vars, fileExists)
  return git && fileExists(win32.join(git, '..', '..', 'bin', 'bash.exe')) ? 'sh' : 'powershell'
}

/** The first `name` on PATH as `where.exe` finds it: each full folder in turn, and in each,
 *  each PATHEXT extension in turn. */
function firstOnPath(name: string, vars: Map<string, string>, fileExists: (p: string) => boolean): string | null {
  const extensions = (vars.get('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (vars.get('PATH') ?? '').replace(/"/g, '').split(';')) {
    if (!win32.isAbsolute(dir)) continue
    const found = extensions.map((ext) => win32.join(dir, name + ext)).find((p) => fileExists(p))
    if (found) return found
  }
  return null
}

/** `s` as a PowerShell string literal, which takes it as it is. Within single quotes a quote
 *  is doubled, and PowerShell counts the curly single quotes as quotes as well. */
function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
}

/**
 * The SessionStart hook command: primerHookCommand, run only while both its runner and its
 * script are still there, written for the shell Claude Code runs it in (claudeHookShell) at
 * the start of every session. Claude Code shows each non-zero exit as a hook error. Termpolis
 * removed some other way than its uninstaller leaves the hook behind; this way the hook then
 * does nothing, silently, where it would otherwise fail in every session. Entries in an older
 * form are rewritten on the next connected start by applyHook, and the removal matches every
 * form by the script's name.
 */
function guardedHookCommand(node: NodeSpec, script: string, shell: HookShell): string {
  const runner = toRunner(node)
  const bin = runner.command.replace(/\\/g, '/')
  const file = script.replace(/\\/g, '/')
  // A bare name is looked up on PATH, as the shell will when it runs it.
  const bare = !bin.includes('/')
  if (shell === 'powershell') {
    const hasRunner = bare
      ? `(Get-Command ${psQuote(bin)} -CommandType Application -ErrorAction SilentlyContinue)`
      : `(Test-Path -LiteralPath ${psQuote(bin)} -PathType Leaf)`
    const env = Object.entries(runner.env ?? {}).map(([k, v]) => `$env:${k} = ${psQuote(v)}; `).join('')
    // `&` does not wait for a Windows app, as Termpolis.exe and electron.exe are: the shell
    // would exit 0 at once, and the primer print after Claude Code stopped reading. Start-Process
    // waits for any runner, hands it the shell's own stdin and stdout, and passes on its exit
    // code, as sh does. It joins -ArgumentList as it is, so the script goes in double quotes,
    // which a Windows path never holds.
    return `if ((Test-Path -LiteralPath ${psQuote(file)} -PathType Leaf) -and ${hasRunner}) `
      + `{ ${env}$p = Start-Process -FilePath ${psQuote(bin)} -ArgumentList ${psQuote(`"${file}"`)} `
      + '-NoNewWindow -Wait -PassThru; exit $p.ExitCode }'
  }
  const hasRunner = bare ? `command -v "${bin}" >/dev/null 2>&1` : `[ -f "${bin}" ]`
  return `if [ -f "${file}" ] && ${hasRunner}; then ${primerHookCommand(node, script)}; fi`
}

/** The one Termpolis hook applyPrimerHook leaves: in a group's `hooks`, or a flat group. */
function keptPrimerHook(root: Json): Json | undefined {
  const groups: Json[] = root.hooks?.SessionStart ?? []
  const hooks = groups.flatMap((g) => [g, ...(Array.isArray(g?.hooks) ? g.hooks : [])])
  return hooks.find((h) => isPrimerHookCommand(h?.command))
}

/**
 * applyPrimerHook with the command for the shell Claude Code will run it in. The PowerShell
 * form says so in the hook's `shell`, so that it is never handed to Git Bash; the sh form has
 * none, so that Claude Code's default runs it, in every version, as it always has. The `shell`
 * is compared as the command is, so a hook in any older form is rewritten once.
 */
function applyHook(root: Json, rt: AgentIntegrationRuntime, script: string): EntryEdit {
  const shell = rt.hookShell ?? claudeHookShell(process.platform, root.env)
  const edit = applyPrimerHook(root, guardedHookCommand(rt.node, script, shell))
  // None is left when the hook kept was a flat group whose own `hooks` held only copies of it:
  // dropping the copies drops the group. The next start adds it back.
  const hook = typeof edit === 'string' ? keptPrimerHook(root) : undefined
  if (!hook) return edit
  const was = hook.shell
  if (shell === 'powershell') hook.shell = 'powershell'
  else delete hook.shell
  return edit === 'unchanged' && hook.shell !== was ? 'update' : edit
}

/** Connect every agent that is installed (its config folder exists). Idempotent: a second
 *  run writes nothing. With no home folder, touches nothing and says so. */
function applyAll(rt: AgentIntegrationRuntime, primerHook: boolean): AgentIntegrationChange[] {
  const { paths } = rt
  if (!agentPaths(paths)) return [noHomeRow()]
  const entry = termpolisServerEntry(rt.node, rt.adapterPath)
  const rows: AgentIntegrationChange[] = []
  if (existsSync(paths.claudeDir)) {
    rows.push(...editConfig('claude', paths.claudeJson, [
      { what: 'MCP server', run: (root) => upsertClaudeUserServer(root, entry) },
    ], true))
    const hookScript = rt.hookScriptPath
    rows.push(...editConfig('claude', join(paths.claudeDir, 'settings.json'), [
      { what: 'Tool permissions', run: applyAllowRules },
      {
        what: 'SessionStart memory hook',
        run: (root) => {
          if (!primerHook) return removePrimerHooks(root)
          return hookScript ? applyHook(root, rt, hookScript) : 'unchanged'
        },
      },
      // Older versions put the server here, where Claude Code never looks for one.
      { what: 'Unused MCP server entry', run: removeServerEntry },
    ], true))
  }
  if (existsSync(paths.codexHome)) rows.push(...applyCodex(entry, join(paths.codexHome, 'config.toml')))
  if (existsSync(paths.geminiDir)) {
    rows.push(...editConfig('gemini', join(paths.geminiDir, 'settings.json'), [
      { what: 'MCP server', run: (root) => upsertServerEntry(root, entry) },
    ], true))
  }
  return rows
}

const noAgent = (): AgentIntegrationAgentStatus => ({ installed: false, configPath: '', registered: false })

function statusOf(paths: AgentIntegrationPaths, ledger: Ledger): AgentIntegrationStatus {
  const status = (agents: AgentIntegrationStatus['agents'], codexHomeTrusted: boolean): AgentIntegrationStatus => ({
    consent: ledger.consent,
    legacyDetected: ledger.legacy,
    connected: isConnected(ledger),
    primerHook: ledger.primerHook,
    agents,
    autoAllowedTools: [...MCP_TOOLS_AUTO_ALLOWED],
    trustedFolders: [...ledger.trustedByTermpolis],
    codexHomeTrusted,
  })
  // With no home folder no config is read, so no agent shows as installed.
  if (!agentPaths(paths)) return status({ claude: noAgent(), codex: noAgent(), gemini: noAgent() }, false)
  const claudeJson = readJson(paths.claudeJson)
  const codexFile = join(paths.codexHome, 'config.toml')
  const read = readText(codexFile)
  const codex = 'text' in read ? read.text : null
  const geminiFile = join(paths.geminiDir, 'settings.json')
  const gemini = readJson(geminiFile)
  const codexTrusted = codex === null ? [] : codexTrustedProjects(codex)
  return status({
    claude: { installed: existsSync(paths.claudeDir), configPath: paths.claudeJson, registered: !!claudeJson && hasServerEntry(claudeJson) },
    codex: { installed: existsSync(paths.codexHome), configPath: codexFile, registered: codex !== null && codexOwner(codex) === 'ours' },
    gemini: { installed: existsSync(paths.geminiDir), configPath: geminiFile, registered: !!gemini && hasServerEntry(gemini) },
  }, Array.isArray(codexTrusted) && codexTrusted.some((f) => isUnsafeTrustRoot(f, paths.home)))
}

/** App start: run each one-time migration not yet in the ledger, then re-apply the
 *  integration when connected (granted, or legacy with no answer yet). Never throws. */
export function bootAgentIntegration(rt: AgentIntegrationRuntime): AgentIntegrationSetResult {
  const changes: AgentIntegrationChange[] = []
  try {
    const ledger = loadLedger(rt.paths)
    // No migration can find the configs without a home folder, so none runs or counts as done:
    // the next start that has one runs them.
    const at = agentPaths(rt.paths)
    if (!at) return { status: statusOf(rt.paths, ledger), changes: [noHomeRow()] }
    const before = JSON.stringify(ledger)
    for (const m of MIGRATIONS) {
      if (ledger.migrations.includes(m.id)) continue
      let rows: AgentIntegrationChange[]
      try {
        rows = m.run(rt.paths)
      } catch (e) {
        rows = [change('claude', at.home, 'skipped', m.id, errorTextSafe(e))]
      }
      changes.push(...rows)
      // A migration that could not finish runs again next start.
      if (!rows.some((r) => r.action === 'skipped')) ledger.migrations.push(m.id)
    }
    if (isConnected(ledger)) changes.push(...applyAll(rt, ledger.primerHook))
    if (JSON.stringify(ledger) !== before) writeLedger(rt.paths, ledger)
    return { status: statusOf(rt.paths, ledger), changes: changes.filter(isChange) }
  } catch (e) {
    return failed(rt, e, changes)
  }
}

/** A call that failed part-way: the rows it had, one more saying why it stopped, and the status
 *  as saved. Built from nothing that can throw in turn, even when `rt` or its paths are unusable. */
function failed(rt: AgentIntegrationRuntime, e: unknown, changes: AgentIntegrationChange[]): AgentIntegrationSetResult {
  let paths: AgentIntegrationPaths | undefined
  try {
    paths = rt.paths
  } catch {
    // Left undefined: the row names the ledger file alone, and the status falls back to disconnected.
  }
  const row = change('claude', ledgerFileFor(paths), 'skipped', 'Agent integration', errorTextSafe(e))
  return { status: getAgentIntegrationStatus(paths as AgentIntegrationPaths), changes: [...changes.filter(isChange), row] }
}

/** Read-only snapshot for the renderer. Creates the ledger on first call (detecting legacy). */
export function getAgentIntegrationStatus(paths: AgentIntegrationPaths): AgentIntegrationStatus {
  try {
    return statusOf(paths, loadLedger(paths))
  } catch {
    const none = { installed: false, configPath: '', registered: false }
    return {
      consent: null, legacyDetected: false, connected: false, primerHook: true,
      agents: { claude: none, codex: none, gemini: none },
      autoAllowedTools: [...MCP_TOOLS_AUTO_ALLOWED], trustedFolders: [], codexHomeTrusted: false,
    }
  }
}

/** Onboarding, the review and Settings: record the answer, then apply or disconnect. Never throws.
 *  `saveError` says the answer could not be saved, so the next start would not know it. A connect
 *  then writes nothing into agent configs; a disconnect still takes everything out. */
export function setAgentIntegration(
  rt: AgentIntegrationRuntime,
  req: AgentIntegrationSetRequest,
): AgentIntegrationSetResult {
  try {
    if (!req.connect) {
      const { rows, saveError } = disconnect(rt.paths, true)
      return { status: getAgentIntegrationStatus(rt.paths), changes: rows, ...(saveError === null ? {} : { saveError }) }
    }
    const ledger = loadLedger(rt.paths)
    ledger.consent = 'granted'
    if (typeof req.primerHook === 'boolean') ledger.primerHook = req.primerHook
    // Connected without the answer on record, the agents would stay connected at the next start
    // with no consent saved for it. Nothing is written until the answer can be kept.
    const saveError = writeLedger(rt.paths, ledger)
    if (saveError !== null) return { status: getAgentIntegrationStatus(rt.paths), changes: [], saveError }
    const changes = applyAll(rt, ledger.primerHook).filter(isChange)
    return { status: statusOf(rt.paths, ledger), changes }
  } catch (e) {
    return failed(rt, e, [])
  }
}

/** Remove everything Termpolis wrote into agent configs, by signature. Settings uses it via
 *  setAgentIntegration; `--disconnect-agents` (uninstall) calls it directly. Never throws: a step
 *  that fails is a 'skipped' row and every other step still runs, so one agent's broken config
 *  cannot leave the others connected. */
export function disconnectAgentIntegration(
  paths: AgentIntegrationPaths,
  opts: { recordDecline?: boolean } = {},
): AgentIntegrationChange[] {
  const { rows, saveError } = disconnect(paths, !!opts?.recordDecline)
  if (saveError === null) return rows
  return [...rows, change('claude', ledgerFileFor(paths), 'skipped', 'Record of the disconnect', saveError)]
}

function disconnect(paths: AgentIntegrationPaths, recordDecline: boolean): { rows: AgentIntegrationChange[]; saveError: string | null } {
  const rows: AgentIntegrationChange[] = []
  const attempt = <T>(agent: AgentId, file: string, fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch (e) {
      rows.push(change(agent, file, 'skipped', 'Disconnect', errorTextSafe(e)))
      return fallback
    }
  }
  const run = (agent: AgentId, file: string, fn: () => AgentIntegrationChange[]): void => {
    rows.push(...attempt(agent, file, fn, []))
  }
  const saved = attempt('claude', ledgerFileFor(paths), () => readLedger(paths), null)
  const trusted = saved?.trustedByTermpolis ?? []
  // Keep the keys when a revert failed, so the next disconnect can try again.
  let trustKept = true
  const at = agentPaths(paths)
  if (!at) {
    rows.push(noHomeRow())
  } else {
    for (const dir of attempt('claude', at.claudeDir, () => claudeDirs(paths), [])) {
      const settings = join(dir, 'settings.json')
      run('claude', settings, () => editConfig('claude', settings, [
        { what: 'Tool permissions', run: removeAllowRules },
        { what: 'SessionStart memory hook', run: removePrimerHooks },
        { what: 'Unused MCP server entry', run: removeServerEntry },
      ], false))
      run('claude', dir, () => removeLocalPlugin(dir))
    }
    const claudeJsons = attempt('claude', at.claudeJson, () => claudeJsonFiles(paths), [])
    for (const file of claudeJsons) {
      run('claude', file, () => editConfig('claude', file, [{ what: 'MCP server', run: removeServerEntry }], false))
    }
    run('claude', join(at.home, '.mcp.json'), () => removeGlobalMcpJson(paths))
    for (const home of attempt('codex', at.codexHome, () => codexHomes(paths), [])) {
      const file = join(home, 'config.toml')
      run('codex', file, () => stripCodex(file))
    }
    const gemini = join(at.geminiDir, 'settings.json')
    run('gemini', gemini, () => editConfig('gemini', gemini, [{ what: 'MCP server', run: removeServerEntry }], false))

    const trustFrom = rows.length
    for (const file of claudeJsons) {
      run('claude', file, () => [revertTrust(file, trusted)])
      run('claude', file, () => [untrustRoots(file, at.home)])
    }
    trustKept = claudeJsons.length === 0 || rows.slice(trustFrom).some((r) => r.action === 'skipped')
  }

  const saveError = writeLedger(paths, {
    version: 1,
    consent: recordDecline ? 'declined' : null,
    primerHook: saved?.primerHook ?? true,
    legacy: false,
    migrations: saved?.migrations ?? [],
    trustedByTermpolis: trustKept ? trusted : [],
  })
  return { rows: rows.filter(isChange), saveError }
}

// ── Folder trust and the Codex launch ───────────────────────────────────────────────────

function isUnsafeFolder(folder: string, home: string): boolean {
  if (isUnsafeTrustRoot(folder, home)) return true
  const key = claudeProjectKey(folder)
  return isUnsafeTrustRoot(key, home) || (!!home.trim() && isUnsafeTrustRoot(key, claudeProjectKey(home)))
}

/** May Termpolis pre-accept or answer an agent's folder-trust prompt for this folder? Pass the
 *  folder's git root when known: Codex applies trust to the repository root, so a folder inside
 *  a repo rooted at the home folder (a dotfiles repo) must be refused too. */
export function isFolderTrustAllowed(paths: AgentIntegrationPaths, cwd: string, gitRoot?: string | null): boolean {
  try {
    if (!cwd || !cwd.trim() || !isConnected(loadLedger(paths))) return false
    // With no home folder known, the home folder could not be told from any other.
    if (!agentPaths(paths)) return false
    if (gitRoot && gitRoot.trim() && isUnsafeFolder(gitRoot, paths.home)) return false
    return !isUnsafeFolder(cwd, paths.home)
  } catch {
    return false
  }
}

/** Pre-accept Claude Code's folder-trust prompt for `cwd` (and its git root), when connected.
 *  Never the home folder or a filesystem root. Records what it set in the ledger. */
export function trustFolderForAgents(paths: AgentIntegrationPaths, cwd: string, gitRoot?: string | null): TrustFolderResult {
  try {
    const ledger = loadLedger(paths)
    if (!isConnected(ledger)) return { changed: false, keys: [], skipped: 'no-consent' }
    // With no home folder to find .claude.json in, or to refuse trust for, change nothing.
    if (!agentPaths(paths)) return { changed: false, keys: [], skipped: 'no-home' }
    const r = trustClaudeWorkspace(cwd, { configPath: paths.claudeJson, home: paths.home, alsoTrust: gitRoot ? [gitRoot] : [] })
    if (r.newlySet.length) {
      ledger.trustedByTermpolis = Array.from(new Set([...ledger.trustedByTermpolis, ...r.newlySet]))
      writeLedger(paths, ledger)
    }
    return r.skipped ? { changed: r.changed, keys: r.keys, skipped: r.skipped } : { changed: r.changed, keys: r.keys }
  } catch (e) {
    return { changed: false, keys: [], skipped: errorTextSafe(e) }
  }
}

/**
 * `memory:prepare-codex-context`: take a legacy Termpolis block out of `<cwd>/AGENTS.md`
 * (always), then, when connected, add memory-tool approvals that are missing and return the
 * `developer_instructions` override for the launch command. Never throws.
 */
export function prepareCodexLaunch(
  paths: AgentIntegrationPaths,
  cwd: string,
  opts: { steering?: string | null } = {},
): CodexLaunchContext {
  let cleaned: CodexLaunchContext['agentsMdCleaned']
  try {
    cleaned = cwd ? cleanAgentsMd(cwd).cleaned : undefined
  } catch {
    // cleanAgentsMd reports its own I/O errors, but a cwd it cannot even join (IPC hands in
    // whatever the renderer sent) throws. Launch without the cleanup rather than fail.
  }
  const base = cleaned ? { agentsMdCleaned: cleaned } : {}
  try {
    if (!isConnected(loadLedger(paths))) return { developerInstructions: null, skipped: 'no-consent', approvals: 0, ...base }
    // No home folder: Codex's config.toml can't be found, so Codex counts as not connected.
    if (!agentPaths(paths)) return { developerInstructions: null, skipped: 'disabled', approvals: 0, ...base }
    const file = join(paths.codexHome, 'config.toml')
    const text = readTextFile(file)
    if (text === null || codexOwner(text) !== 'ours') return { developerInstructions: null, skipped: 'disabled', approvals: 0, ...base }
    let approvals = 0
    const ap = addCodexToolApprovals(text, CODEX_AUTO_APPROVED_TOOLS)
    if (!('error' in ap) && ap.added.length) {
      try {
        atomicWriteText(file, ap.text)
        approvals = ap.added.length
      } catch {
        // Launch without them: Codex asks, as it would have anyway.
      }
    }
    const userSet = codexConfigSets(text, 'developer_instructions')
    if (typeof userSet === 'object') return { developerInstructions: null, skipped: 'disabled', approvals, ...base }
    if (userSet) return { developerInstructions: null, skipped: 'user-set', approvals, ...base }
    return { developerInstructions: buildCodexInstruction(opts.steering), approvals, ...base }
  } catch {
    return { developerInstructions: null, skipped: 'disabled', approvals: 0, ...base }
  }
}

/** Remove Codex's trust entry for the home folder (and any folder above it or a drive root). */
export function removeCodexHomeTrust(paths: AgentIntegrationPaths): { changed: boolean; error?: string } {
  try {
    if (!agentPaths(paths)) return { changed: false, error: NO_HOME }
    const file = join(paths.codexHome, 'config.toml')
    const text = readTextFile(file)
    if (text === null) return { changed: false }
    const r = stripCodexProjectTrust(text, (folder) => isUnsafeTrustRoot(folder, paths.home))
    if ('error' in r) return { changed: false, error: r.error }
    if (!r.removed.length) return { changed: false }
    atomicWriteText(file, r.text)
    return { changed: true }
  } catch (e) {
    return { changed: false, error: errorTextSafe(e) }
  }
}

/** The MCP config the swarm conductor is launched with (`--mcp-config`), consent or not:
 *  it is Termpolis's own agent, started by Termpolis. */
export function conductorMcpConfig(rt: AgentIntegrationRuntime): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { termpolis: { type: 'stdio', ...termpolisServerEntry(rt.node, rt.adapterPath) } } }
}
