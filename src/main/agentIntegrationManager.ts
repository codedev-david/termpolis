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
// Nothing here throws: a config it cannot read or safely edit becomes a 'skipped' row.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { CODEX_AUTO_APPROVED_TOOLS, MCP_TOOLS_AUTO_ALLOWED, isUnsafeTrustRoot } from '../shared/agentIntegration'
import type {
  AgentId, AgentIntegrationChange, AgentIntegrationConsent, AgentIntegrationSetRequest,
  AgentIntegrationSetResult, AgentIntegrationStatus, CodexLaunchContext,
} from '../shared/agentIntegration'
import { atomicWriteText, editJsonObject, errorText, readJsonObject, readTextFile } from './agentConfigIO'
import {
  FOREIGN_SERVER, applyAllowRules, applyPrimerHook, hasPluginEnablement, hasPrimerHook,
  hasServerEntry, hasTermpolisAllowRule, isAdapterPath, isTermpolisPluginManifest,
  isTermpolisServerEntry, localMarketplaceNames, primerHookCommand, removeAllowRules,
  removeInstalledPlugin, removeLegacyAllowRules, removeMarketplaceEntry, removePluginEnablement,
  removePrimerHooks, removeRootServerEntry, removeServerEntry, termpolisServerEntry,
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
}

/** Result of `claude:trust-workspace`, unchanged in shape for the renderer. */
export interface TrustFolderResult {
  changed: boolean
  keys: string[]
  skipped?: 'no-consent' | 'unsafe-root' | string
}

export function resolveAgentIntegrationPaths(
  osHome: string,
  userData: string,
  env: Readonly<Record<string, string | undefined>>,
): AgentIntegrationPaths {
  // Test runs (vitest setup, e2e launch) point every agent config at a scratch home, so a
  // spec that boots the app can never rewrite the developer's real ~/.claude* / ~/.codex.
  const testHome = env.TERMPOLIS_TEST_AGENT_HOME?.trim()
  const home = testHome || osHome
  const claudeConfigDir = testHome ? undefined : env.CLAUDE_CONFIG_DIR?.trim()
  const codexHome = testHome ? undefined : env.CODEX_HOME?.trim()
  return {
    home,
    userData,
    claudeDir: claudeConfigDir || join(home, '.claude'),
    claudeJson: claudeConfigDir ? join(claudeConfigDir, '.claude.json') : join(home, '.claude.json'),
    codexHome: codexHome || join(home, '.codex'),
    geminiDir: join(home, '.gemini'),
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

function ledgerPath(paths: AgentIntegrationPaths): string {
  return join(paths.userData, LEDGER_FILE)
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

/** The saved ledger, or null when there is none this version can read. */
function readLedger(paths: AgentIntegrationPaths): Ledger | null {
  const r = readJsonObject(ledgerPath(paths))
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

function writeLedger(paths: AgentIntegrationPaths, ledger: Ledger): void {
  try {
    mkdirSync(paths.userData, { recursive: true })
    atomicWriteText(ledgerPath(paths), JSON.stringify(ledger, null, 2) + '\n')
  } catch (e) {
    console.warn(`[agent-integration] could not save ${LEDGER_FILE}: ${errorText(e)}`)
  }
}

/** The ledger, created on first use with a note of whether an older Termpolis had already
 *  connected the agents (detected before any migration touches those configs). */
function loadLedger(paths: AgentIntegrationPaths): Ledger {
  const saved = readLedger(paths)
  if (saved) return saved
  const legacy = detectLegacy(paths)
  const ledger: Ledger = {
    version: 1,
    consent: null,
    primerHook: legacy.found ? legacy.primerHook : true,
    legacy: legacy.found,
    migrations: [],
    trustedByTermpolis: [],
  }
  writeLedger(paths, ledger)
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

/** Connect every agent that is installed (its config folder exists). Idempotent: a second
 *  run writes nothing. */
function applyAll(rt: AgentIntegrationRuntime, primerHook: boolean): AgentIntegrationChange[] {
  const { paths } = rt
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
          return hookScript ? applyPrimerHook(root, primerHookCommand(rt.node, hookScript)) : 'unchanged'
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

function statusOf(paths: AgentIntegrationPaths, ledger: Ledger): AgentIntegrationStatus {
  const claudeJson = readJson(paths.claudeJson)
  const codexFile = join(paths.codexHome, 'config.toml')
  const read = readText(codexFile)
  const codex = 'text' in read ? read.text : null
  const geminiFile = join(paths.geminiDir, 'settings.json')
  const gemini = readJson(geminiFile)
  const codexTrusted = codex === null ? [] : codexTrustedProjects(codex)
  return {
    consent: ledger.consent,
    legacyDetected: ledger.legacy,
    connected: isConnected(ledger),
    primerHook: ledger.primerHook,
    agents: {
      claude: { installed: existsSync(paths.claudeDir), configPath: paths.claudeJson, registered: !!claudeJson && hasServerEntry(claudeJson) },
      codex: { installed: existsSync(paths.codexHome), configPath: codexFile, registered: codex !== null && codexOwner(codex) === 'ours' },
      gemini: { installed: existsSync(paths.geminiDir), configPath: geminiFile, registered: !!gemini && hasServerEntry(gemini) },
    },
    autoAllowedTools: [...MCP_TOOLS_AUTO_ALLOWED],
    trustedFolders: [...ledger.trustedByTermpolis],
    codexHomeTrusted: Array.isArray(codexTrusted) && codexTrusted.some((f) => isUnsafeTrustRoot(f, paths.home)),
  }
}

/** App start: run each one-time migration not yet in the ledger, then re-apply the
 *  integration when connected (granted, or legacy with no answer yet). Never throws. */
export function bootAgentIntegration(rt: AgentIntegrationRuntime): AgentIntegrationSetResult {
  const changes: AgentIntegrationChange[] = []
  try {
    const ledger = loadLedger(rt.paths)
    const before = JSON.stringify(ledger)
    for (const m of MIGRATIONS) {
      if (ledger.migrations.includes(m.id)) continue
      let rows: AgentIntegrationChange[]
      try {
        rows = m.run(rt.paths)
      } catch (e) {
        rows = [change('claude', rt.paths.home, 'skipped', m.id, errorText(e))]
      }
      changes.push(...rows)
      // A migration that could not finish runs again next start.
      if (!rows.some((r) => r.action === 'skipped')) ledger.migrations.push(m.id)
    }
    if (isConnected(ledger)) changes.push(...applyAll(rt, ledger.primerHook))
    if (JSON.stringify(ledger) !== before) writeLedger(rt.paths, ledger)
    return { status: statusOf(rt.paths, ledger), changes: changes.filter(isChange) }
  } catch (e) {
    changes.push(change('claude', ledgerPath(rt.paths), 'skipped', 'Agent integration', errorText(e)))
    return { status: getAgentIntegrationStatus(rt.paths), changes: changes.filter(isChange) }
  }
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

/** Onboarding, the review and Settings: record the answer, then apply or disconnect. Never throws. */
export function setAgentIntegration(rt: AgentIntegrationRuntime, req: AgentIntegrationSetRequest): AgentIntegrationSetResult {
  try {
    if (!req.connect) {
      const changes = disconnectAgentIntegration(rt.paths, { recordDecline: true })
      return { status: getAgentIntegrationStatus(rt.paths), changes }
    }
    const ledger = loadLedger(rt.paths)
    ledger.consent = 'granted'
    if (typeof req.primerHook === 'boolean') ledger.primerHook = req.primerHook
    writeLedger(rt.paths, ledger)
    const changes = applyAll(rt, ledger.primerHook).filter(isChange)
    return { status: statusOf(rt.paths, ledger), changes }
  } catch (e) {
    return {
      status: getAgentIntegrationStatus(rt.paths),
      changes: [change('claude', ledgerPath(rt.paths), 'skipped', 'Agent integration', errorText(e))],
    }
  }
}

/** Remove everything Termpolis wrote into agent configs, by signature. Settings uses it via
 *  setAgentIntegration; `--disconnect-agents` (uninstall) calls it directly. Never throws. */
export function disconnectAgentIntegration(
  paths: AgentIntegrationPaths,
  opts: { recordDecline?: boolean } = {},
): AgentIntegrationChange[] {
  const rows: AgentIntegrationChange[] = []
  const run = (file: string, fn: () => AgentIntegrationChange[]): void => {
    try {
      rows.push(...fn())
    } catch (e) {
      rows.push(change('claude', file, 'skipped', 'Disconnect', errorText(e)))
    }
  }
  const saved = readLedger(paths)
  for (const dir of claudeDirs(paths)) {
    const settings = join(dir, 'settings.json')
    run(settings, () => editConfig('claude', settings, [
      { what: 'Tool permissions', run: removeAllowRules },
      { what: 'SessionStart memory hook', run: removePrimerHooks },
      { what: 'Unused MCP server entry', run: removeServerEntry },
    ], false))
    run(dir, () => removeLocalPlugin(dir))
  }
  for (const file of claudeJsonFiles(paths)) {
    run(file, () => editConfig('claude', file, [{ what: 'MCP server', run: removeServerEntry }], false))
  }
  run(join(paths.home, '.mcp.json'), () => removeGlobalMcpJson(paths))
  for (const home of codexHomes(paths)) {
    const file = join(home, 'config.toml')
    run(file, () => stripCodex(file))
  }
  const gemini = join(paths.geminiDir, 'settings.json')
  run(gemini, () => editConfig('gemini', gemini, [{ what: 'MCP server', run: removeServerEntry }], false))

  const trusted = saved?.trustedByTermpolis ?? []
  const trustRows: AgentIntegrationChange[] = []
  for (const file of claudeJsonFiles(paths)) {
    trustRows.push(revertTrust(file, trusted), untrustRoots(file, paths.home))
  }
  rows.push(...trustRows)

  writeLedger(paths, {
    version: 1,
    consent: opts.recordDecline ? 'declined' : null,
    primerHook: saved?.primerHook ?? true,
    legacy: false,
    migrations: saved?.migrations ?? [],
    // Keep the keys when a revert failed, so the next disconnect can try again.
    trustedByTermpolis: trustRows.some((r) => r.action === 'skipped') ? trusted : [],
  })
  return rows.filter(isChange)
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
    const r = trustClaudeWorkspace(cwd, { configPath: paths.claudeJson, home: paths.home, alsoTrust: gitRoot ? [gitRoot] : [] })
    if (r.newlySet.length) {
      ledger.trustedByTermpolis = Array.from(new Set([...ledger.trustedByTermpolis, ...r.newlySet]))
      writeLedger(paths, ledger)
    }
    return r.skipped ? { changed: r.changed, keys: r.keys, skipped: r.skipped } : { changed: r.changed, keys: r.keys }
  } catch (e) {
    return { changed: false, keys: [], skipped: errorText(e) }
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
  const file = join(paths.codexHome, 'config.toml')
  try {
    const text = readTextFile(file)
    if (text === null) return { changed: false }
    const r = stripCodexProjectTrust(text, (folder) => isUnsafeTrustRoot(folder, paths.home))
    if ('error' in r) return { changed: false, error: r.error }
    if (!r.removed.length) return { changed: false }
    atomicWriteText(file, r.text)
    return { changed: true }
  } catch (e) {
    return { changed: false, error: errorText(e) }
  }
}

/** The MCP config the swarm conductor is launched with (`--mcp-config`), consent or not:
 *  it is Termpolis's own agent, started by Termpolis. */
export function conductorMcpConfig(rt: AgentIntegrationRuntime): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { termpolis: { type: 'stdio', ...termpolisServerEntry(rt.node, rt.adapterPath) } } }
}
