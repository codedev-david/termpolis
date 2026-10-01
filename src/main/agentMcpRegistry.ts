// What Termpolis's entries look like inside the agent CLIs' JSON configs, as pure transforms
// over the parsed object (agentIntegrationManager does the file IO and the consent), plus the
// node runner every one of those entries spawns the stdio adapter with.
//
// Everything that removes an entry finds it by signature, never by the current adapter path:
// a server whose first argument is Termpolis's stdio adapter, a hook whose command runs
// memory-primer-hook.cjs, allow rules only Termpolis ever wrote. A `termpolis` server the
// user configured themselves fails that check and is left alone.
//
// Claude Code reads MCP servers from `.claude.json` (user scope), never from settings.json.
// Earlier versions wrote one into settings.json, where it did nothing; it is removed here.
import { existsSync } from 'fs'
import { join } from 'path'
import { getAgentExtraPaths } from './agentPaths'
import { MCP_TOOLS_AUTO_ALLOWED } from '../shared/agentIntegration'

/**
 * How an agent's MCP config should spawn the stdio adapter.
 *
 * A bare `node` is not a safe thing to write into these files. The agent CLI
 * spawns this command DIRECTLY (no shell), so the OS resolves it against the
 * PATH the agent inherited — which is Termpolis's PATH, and Termpolis is
 * usually started from a desktop launcher rather than a login shell. On Linux
 * that PATH is typically just /usr/bin:/bin, so a Node installed by nvm/fnm/
 * volta is invisible and the spawn fails with ENOENT, surfacing inside the
 * agent as:
 *
 *   MCP client for `termpolis` failed to start: MCP startup failed:
 *   No such file or directory (os error 2)
 *
 * — reported on Linux against Codex, whose config had `command = "node"`
 * hardcoded (Claude's had been resolved since the same bug hit it there).
 */
export interface NodeRunner {
  command: string
  /** Extra environment the command needs; omitted when it needs none. */
  env?: Record<string, string>
}

/** Accept either shape at a call site, so a plain 'node' string still works. */
export type NodeSpec = string | NodeRunner

export function toRunner(spec: NodeSpec): NodeRunner {
  return typeof spec === 'string' ? { command: spec } : spec
}

/**
 * The runner rendered as a shell command prefix for a Claude Code hook.
 *
 * This is the POSIX sh form, which Claude Code runs everywhere it has a sh: on
 * Windows that is Git Bash. Without one it runs hooks in PowerShell, and the
 * manager writes a PowerShell form instead (guardedHookCommand, claudeHookShell
 * in agentIntegrationManager.ts). In sh, `K=V cmd` is the portable way to hand
 * the process an environment variable. That matters
 * for the Electron fallback: without ELECTRON_RUN_AS_NODE the same binary opens
 * a second Termpolis window instead of running the hook script.
 *
 * A bare `node` stays bare (unquoted) so the shell resolves it on PATH; an
 * absolute path is quoted, with backslashes normalized, because Windows paths
 * contain spaces (`C:/Program Files/...`).
 */
export function hookCommand(runner: NodeRunner): string {
  const bin = runner.command === 'node' ? 'node' : `"${runner.command.replace(/\\/g, '/')}"`
  if (!runner.env) return bin
  const prefix = Object.entries(runner.env).map(([k, v]) => `${k}=${v}`).join(' ')
  return `${prefix} ${bin}`
}

/** Same runner, compared the way a config file stores it. */
export function runnerMatches(existing: any, runner: NodeRunner): boolean {
  if (!existing || existing.command !== runner.command) return false
  const want = runner.env ?? null
  const have = existing.env && typeof existing.env === 'object' ? existing.env : null
  if (want === null) return have === null || Object.keys(have).length === 0
  if (have === null) return false
  return Object.entries(want).every(([k, v]) => have[k] === v)
}

/**
 * Resolve an absolute `node` executable so the SessionStart memory hook and the
 * MCP adapter still run when the shell Claude Code uses to launch them has a PATH
 * without node — the GUI-launch-vs-login-shell discrepancy, and version managers
 * (nvm / fnm / volta) whose node isn't on the non-interactive PATH. Scans this
 * process's PATH, the same version-manager directories agent CLIs are found in,
 * plus a few well-known install dirs, and returns the first node that ACTUALLY
 * EXISTS on disk; falls back to the bare `node` command (the prior behavior — no
 * regression) when none resolves, so a non-existent path is never baked into the
 * user's config. Pure: env + a file-existence probe are injectable.
 */
export function resolveNodeCommand(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
  extraDirs: () => string[] = getAgentExtraPaths,
): string {
  const win = process.platform === 'win32'
  const exe = win ? 'node.exe' : 'node'
  const dirs = (env.PATH || env.Path || '').split(win ? ';' : ':').map((d) => d.trim()).filter(Boolean)
  // The version-manager dirs agent CLIs are already hunted through. nvm installs
  // node and the globally-installed agent side by side, so if `codex` was found
  // under ~/.nvm/versions/node/<v>/bin, node is in that same directory.
  try {
    for (const d of extraDirs()) dirs.push(d)
  } catch {
    // Probing version managers touches the filesystem; a failure there must not
    // cost us the PATH candidates we already have.
  }
  // Well-known absolute install locations as a backstop for stripped PATHs.
  if (win) {
    if (env.ProgramFiles) dirs.push(join(env.ProgramFiles, 'nodejs'))
    dirs.push('C:\\Program Files\\nodejs')
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  }
  for (const dir of dirs) {
    const candidate = join(dir, exe)
    if (fileExists(candidate)) return candidate
  }
  return 'node'
}

/**
 * The runner to write into agent MCP configs: a real node when one can be found,
 * and otherwise Termpolis's own Electron binary in Node mode.
 *
 * The fallback matters because Node is not a dependency of the installed app —
 * the .deb and the Windows installer ship Electron and nothing else. On a machine
 * with no Node at all, `command = "node"` is not a best-effort guess, it is a
 * guaranteed ENOENT. `ELECTRON_RUN_AS_NODE=1` makes process.execPath behave as a
 * plain Node interpreter (Chromium never starts), and that binary is the one file
 * we can be certain exists, since it is the process writing the config.
 */
export function resolveNodeRunner(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
  electronPath: string = process.execPath,
): NodeRunner {
  const node = resolveNodeCommand(env, fileExists)
  if (node !== 'node') return { command: node }
  // Bare 'node' means nothing was found on disk. Prefer the binary we are.
  if (electronPath && fileExists(electronPath)) {
    return { command: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: 'node' }
}

// ── Entries, and how to recognise them ─────────────────────────────────────────────────

type Json = Record<string, any>

/** What a transform did to the object it was given. */
export type EditAction = 'add' | 'update' | 'remove' | 'unchanged'

/** A transform's outcome: an action, or why it refused to touch the file. */
export type EntryEdit = EditAction | { skipped: string }

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** How every Termpolis server entry ends: the adapter script, in both layouts it ships in. */
export const ADAPTER_SIGNATURE = 'mcp-adapter/stdio-adapter.cjs'

/** True for a path to Termpolis's stdio adapter, whichever install or checkout it is in. */
export function isAdapterPath(arg: unknown): boolean {
  return typeof arg === 'string' && arg.replace(/\\/g, '/').toLowerCase().endsWith(ADAPTER_SIGNATURE)
}

/** A server entry Termpolis wrote: its first argument is the stdio adapter. */
export function isTermpolisServerEntry(entry: unknown): boolean {
  return isObject(entry) && Array.isArray(entry.args) && isAdapterPath(entry.args[0])
}

/** A hook command Termpolis wrote: it runs the memory-primer hook script. */
export function isPrimerHookCommand(command: unknown): boolean {
  return typeof command === 'string' && /memory-primer-hook\.cjs/.test(command)
}

export interface ServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** The entry every agent config gets: the runner, with the adapter as its only argument. */
export function termpolisServerEntry(node: NodeSpec, adapterPath: string): ServerEntry {
  const runner = toRunner(node)
  return { command: runner.command, args: [adapterPath], ...(runner.env ? { env: { ...runner.env } } : {}) }
}

/** The SessionStart hook command for the memory primer. */
export function primerHookCommand(node: NodeSpec, hookScriptPath: string): string {
  return `${hookCommand(toRunner(node))} "${hookScriptPath.replace(/\\/g, '/')}"`
}

const ELECTRON_FALLBACK_ENV = 'ELECTRON_RUN_AS_NODE'

/** The env the Electron fallback wrote, which must go once a real node is found. */
function isFallbackEnv(env: unknown): boolean {
  return isObject(env) && Object.keys(env).length === 1 && env[ELECTRON_FALLBACK_ENV] === '1'
}

export const FOREIGN_SERVER = 'a `termpolis` MCP server that Termpolis did not add is already configured here, so it was left as it is'

/**
 * Put Termpolis's server in `root.mcpServers.termpolis`, or bring the one there up to date.
 * Keys Termpolis doesn't manage (a timeout, `disabled`, the user's own env vars) survive;
 * `fixed` sets keys an agent requires, such as Claude Code's `type`.
 */
export function upsertServerEntry(root: Json, entry: ServerEntry, fixed: Json = {}): EntryEdit {
  if (root.mcpServers !== undefined && !isObject(root.mcpServers)) return { skipped: '`mcpServers` is not an object' }
  const existing = root.mcpServers?.termpolis
  if (existing !== undefined && !isTermpolisServerEntry(existing)) return { skipped: FOREIGN_SERVER }
  const next: Json = { ...(existing ?? {}), ...fixed, command: entry.command, args: [...entry.args] }
  if (entry.env) next.env = { ...(isObject(next.env) ? next.env : {}), ...entry.env }
  else if (isFallbackEnv(next.env)) delete next.env
  if (existing !== undefined && JSON.stringify(next) === JSON.stringify(existing)) return 'unchanged'
  root.mcpServers = { ...(root.mcpServers ?? {}), termpolis: next }
  return existing === undefined ? 'add' : 'update'
}

/** Claude Code's user-scope server in `.claude.json`, as `claude mcp add -s user` writes it. */
export function upsertClaudeUserServer(root: Json, entry: ServerEntry): EntryEdit {
  return upsertServerEntry(root, entry, { type: 'stdio' })
}

/** Remove Termpolis's `mcpServers.termpolis`, and an `mcpServers` that leaves empty. */
export function removeServerEntry(root: Json): EditAction {
  const servers = root.mcpServers
  if (!isObject(servers) || !isTermpolisServerEntry(servers.termpolis)) return 'unchanged'
  delete servers.termpolis
  if (Object.keys(servers).length === 0) delete root.mcpServers
  return 'remove'
}

/** The first ~/.mcp.json writer put the server at the top level, with no `mcpServers` wrapper. */
export function removeRootServerEntry(root: Json): EditAction {
  if (!isTermpolisServerEntry(root.termpolis)) return 'unchanged'
  delete root.termpolis
  return 'remove'
}

export function hasServerEntry(root: Json): boolean {
  return isObject(root.mcpServers) && isTermpolisServerEntry(root.mcpServers.termpolis)
}

// ── Claude Code settings.json: tool permissions ────────────────────────────────────────

const CLAUDE_TOOL_PREFIX = 'mcp__termpolis__'

/** The blanket rule earlier versions wrote: every Termpolis tool, including run_command. */
const WILDCARD_RULE = `${CLAUDE_TOOL_PREFIX}*`

/** The explicit list the first version wrote. Its switch to the wildcard left these behind. */
const FIRST_VERSION_TOOLS: readonly string[] = [
  'list_terminals', 'create_terminal', 'run_command', 'read_output', 'close_terminal',
  'write_to_terminal', 'get_file_tree', 'get_git_status', 'swarm_send_message',
  'swarm_read_messages', 'swarm_create_task', 'swarm_list_tasks', 'swarm_update_task',
  'swarm_list_agents',
]

export const CLAUDE_ALLOW_RULES: readonly string[] = MCP_TOOLS_AUTO_ALLOWED.map((t) => CLAUDE_TOOL_PREFIX + t)

function allowArray(root: Json): string[] | null | { skipped: string } {
  if (root.permissions === undefined) return null
  if (!isObject(root.permissions)) return { skipped: '`permissions` is not an object' }
  if (root.permissions.allow === undefined) return null
  if (!Array.isArray(root.permissions.allow)) return { skipped: '`permissions.allow` is not an array' }
  return root.permissions.allow
}

/**
 * Rules only Termpolis wrote: the wildcard, the `(*)` forms an older Claude Code accepted, and
 * the first version's list when all of it is still there. That list mixed in tools that run
 * commands, and one or two such rules could be the user's own choice, but all 14 in a row are
 * Termpolis's. The safe list's own rules are left to the caller.
 */
function legacyRules(allow: readonly unknown[]): Set<string> {
  const out = new Set<string>()
  for (const r of allow) {
    if (typeof r !== 'string') continue
    if (r === WILDCARD_RULE || (r.startsWith(CLAUDE_TOOL_PREFIX) && r.endsWith('(*)'))) out.add(r)
  }
  const first = FIRST_VERSION_TOOLS.map((t) => CLAUDE_TOOL_PREFIX + t)
  if (first.every((r) => allow.includes(r))) {
    for (const r of first) if (!CLAUDE_ALLOW_RULES.includes(r)) out.add(r)
  }
  return out
}

function dropRules(root: Json, drop: Set<string>): EditAction {
  if (drop.size === 0) return 'unchanged'
  const allow: unknown[] = root.permissions.allow
  root.permissions.allow = allow.filter((r) => !(typeof r === 'string' && drop.has(r)))
  if (root.permissions.allow.length === 0) delete root.permissions.allow
  if (Object.keys(root.permissions).length === 0) delete root.permissions
  return 'remove'
}

/** One-time migration: take away the blanket and legacy rules. */
export function removeLegacyAllowRules(root: Json): EntryEdit {
  const allow = allowArray(root)
  if (!Array.isArray(allow)) return allow ?? 'unchanged'
  return dropRules(root, legacyRules(allow))
}

/** Allow the safe tools, appending only the rules that are missing. */
export function applyAllowRules(root: Json): EntryEdit {
  const allow = allowArray(root)
  if (allow !== null && !Array.isArray(allow)) return allow
  const have = allow ?? []
  const missing = CLAUDE_ALLOW_RULES.filter((r) => !have.includes(r))
  if (missing.length === 0) return 'unchanged'
  root.permissions = { ...(root.permissions ?? {}), allow: [...have, ...missing] }
  return missing.length === CLAUDE_ALLOW_RULES.length ? 'add' : 'update'
}

/** Disconnect: the safe list plus everything the migration removes. */
export function removeAllowRules(root: Json): EntryEdit {
  const allow = allowArray(root)
  if (!Array.isArray(allow)) return allow ?? 'unchanged'
  const drop = legacyRules(allow)
  for (const r of CLAUDE_ALLOW_RULES) if (allow.includes(r)) drop.add(r)
  return dropRules(root, drop)
}

export function hasTermpolisAllowRule(root: Json): boolean {
  const allow = allowArray(root)
  return Array.isArray(allow) && allow.some((r) => typeof r === 'string' && r.startsWith(CLAUDE_TOOL_PREFIX))
}

// ── Claude Code settings.json: the SessionStart memory hook ────────────────────────────

function sessionStart(root: Json): unknown[] | null | { skipped: string } {
  if (root.hooks === undefined) return null
  if (!isObject(root.hooks)) return { skipped: '`hooks` is not an object' }
  if (root.hooks.SessionStart === undefined) return null
  if (!Array.isArray(root.hooks.SessionStart)) return { skipped: '`hooks.SessionStart` is not an array' }
  return root.hooks.SessionStart
}

/** Where each Termpolis hook sits: a group's `hooks[i]`, or (item -1) a flat group that is one. */
function primerHookSites(groups: unknown[]): Array<{ group: number; item: number }> {
  const sites: Array<{ group: number; item: number }> = []
  groups.forEach((g, group) => {
    if (!isObject(g)) return
    if (isPrimerHookCommand(g.command)) sites.push({ group, item: -1 })
    if (Array.isArray(g.hooks)) {
      g.hooks.forEach((h: unknown, item: number) => {
        if (isObject(h) && isPrimerHookCommand(h.command)) sites.push({ group, item })
      })
    }
  })
  return sites
}

/** Remove these sites, then any group, SessionStart list or hooks object that leaves empty. */
function removeSites(root: Json, sites: Array<{ group: number; item: number }>): void {
  const groups: Json[] = root.hooks.SessionStart
  const dropGroup = new Set<number>()
  for (const s of [...sites].reverse()) {
    const g = groups[s.group]
    if (s.item === -1) dropGroup.add(s.group)
    else {
      g.hooks.splice(s.item, 1)
      if (g.hooks.length === 0) dropGroup.add(s.group)
    }
  }
  root.hooks.SessionStart = groups.filter((_, i) => !dropGroup.has(i))
  if (root.hooks.SessionStart.length === 0) delete root.hooks.SessionStart
  if (Object.keys(root.hooks).length === 0) delete root.hooks
}

/** Exactly one Termpolis SessionStart hook, running `command`. */
export function applyPrimerHook(root: Json, command: string): EntryEdit {
  const groups = sessionStart(root)
  if (groups !== null && !Array.isArray(groups)) return groups
  const sites = primerHookSites(groups ?? [])
  if (sites.length === 0) {
    const entry = { hooks: [{ type: 'command', command }] }
    root.hooks = { ...(root.hooks ?? {}), SessionStart: [...(groups ?? []), entry] }
    return 'add'
  }
  const [keep, ...extra] = sites
  const g = (groups as Json[])[keep.group]
  const hook = keep.item === -1 ? g : g.hooks[keep.item]
  let changed = false
  if (hook.command !== command) {
    hook.command = command
    changed = true
  }
  if (extra.length) {
    removeSites(root, extra)
    changed = true
  }
  return changed ? 'update' : 'unchanged'
}

export function removePrimerHooks(root: Json): EntryEdit {
  const groups = sessionStart(root)
  if (!Array.isArray(groups)) return groups ?? 'unchanged'
  const sites = primerHookSites(groups)
  if (sites.length === 0) return 'unchanged'
  removeSites(root, sites)
  return 'remove'
}

export function hasPrimerHook(root: Json): boolean {
  const groups = sessionStart(root)
  return Array.isArray(groups) && primerHookSites(groups).length > 0
}

// ── The local plugin earlier versions installed ────────────────────────────────────────

/** Marketplaces the local plugin was registered under: `local-plugins`, plus any whose
 *  source is the `local-marketplace` folder Termpolis created. */
export function localMarketplaceNames(settings: Json | null, knownMarketplaces: Json | null): string[] {
  const names = new Set(['local-plugins'])
  for (const table of [settings?.extraKnownMarketplaces, knownMarketplaces]) {
    if (!isObject(table)) continue
    for (const [name, value] of Object.entries(table)) {
      const path = isObject(value) && isObject(value.source) ? value.source.path : undefined
      if (typeof path === 'string' && path.replace(/\\/g, '/').includes('local-marketplace')) names.add(name)
    }
  }
  return [...names]
}

function dropPluginKeys(table: unknown, marketplaces: readonly string[]): boolean {
  if (!isObject(table)) return false
  let removed = false
  for (const m of marketplaces) {
    if (Object.prototype.hasOwnProperty.call(table, `termpolis@${m}`)) {
      delete table[`termpolis@${m}`]
      removed = true
    }
  }
  return removed
}

/** settings.json `enabledPlugins`. */
export function removePluginEnablement(root: Json, marketplaces: readonly string[]): EditAction {
  if (!dropPluginKeys(root.enabledPlugins, marketplaces)) return 'unchanged'
  if (Object.keys(root.enabledPlugins).length === 0) delete root.enabledPlugins
  return 'remove'
}

export function hasPluginEnablement(root: Json, marketplaces: readonly string[]): boolean {
  return isObject(root.enabledPlugins) && marketplaces.some((m) => `termpolis@${m}` in root.enabledPlugins)
}

/** plugins/installed_plugins.json, which Claude Code keeps. */
export function removeInstalledPlugin(root: Json, marketplaces: readonly string[]): EditAction {
  return dropPluginKeys(root.plugins, marketplaces) ? 'remove' : 'unchanged'
}

/** local-marketplace/.claude-plugin/marketplace.json: the entry pointing at the plugin folder. */
export function removeMarketplaceEntry(root: Json): EditAction {
  if (!Array.isArray(root.plugins)) return 'unchanged'
  const isOurs = (p: unknown): boolean =>
    isObject(p) && p.name === 'termpolis' && typeof p.source === 'string' &&
    p.source.replace(/\\/g, '/').replace(/\/+$/, '') === './plugins/termpolis'
  const keep = root.plugins.filter((p: unknown) => !isOurs(p))
  if (keep.length === root.plugins.length) return 'unchanged'
  root.plugins = keep
  return 'remove'
}

/** The plugin folder's own files: plugin.json names Termpolis as author, or .mcp.json runs the adapter. */
export function isTermpolisPluginManifest(pluginJson: Json | null, mcpJson: Json | null): boolean {
  const byManifest = !!pluginJson && pluginJson.name === 'termpolis' &&
    isObject(pluginJson.author) && pluginJson.author.name === 'Termpolis'
  return byManifest || (!!mcpJson && hasServerEntry(mcpJson))
}
