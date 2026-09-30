// Agent integration: what Termpolis writes into Claude Code, Codex and Gemini CLI
// configs, and the consent that gates those writes. Main does the writes; the
// renderer shows them (onboarding, the one-time review for existing users, and
// Settings ▸ Agent integration). Pure — no fs, no `process` — so both sides import it.

export type AgentIntegrationConsent = 'granted' | 'declined' | null

export type AgentId = 'claude' | 'codex' | 'gemini'

/** One step of an apply or disconnect, as the UI lists it. */
export interface AgentIntegrationChange {
  agent: AgentId
  /** Absolute path of the file touched. The UI shortens the home prefix to `~`. */
  file: string
  action: 'add' | 'update' | 'remove' | 'unchanged' | 'skipped'
  /** One line, e.g. "MCP server `termpolis`" or "SessionStart memory hook". */
  what: string
  /** Why a step was skipped or failed. */
  error?: string
}

export interface AgentIntegrationAgentStatus {
  /** The agent's config folder exists, i.e. the CLI has been run on this machine. */
  installed: boolean
  configPath: string
  /** The Termpolis MCP server is currently registered in that config. */
  registered: boolean
}

export interface AgentIntegrationStatus {
  consent: AgentIntegrationConsent
  /** Configs written by a Termpolis version from before consent existed. Such a user
   *  gets the one-time review instead of the onboarding step. */
  legacyDetected: boolean
  /** Launch keeps agent configs connected: consent granted, or a legacy install that
   *  has not answered the review yet (so upgrading never silently breaks anyone). */
  connected: boolean
  /** Claude Code SessionStart hook that loads the memory primer. A sub-option of connect. */
  primerHook: boolean
  agents: Record<AgentId, AgentIntegrationAgentStatus>
  /** Termpolis tools Claude Code runs without asking. Everything else asks first. */
  autoAllowedTools: string[]
  /** Folders Termpolis marked trusted in Claude Code since this ledger began. */
  trustedFolders: string[]
  /** Codex's own config trusts the home folder — which Termpolis's old blind answer to
   *  Codex's trust prompt could have caused. The UI offers to remove it. */
  codexHomeTrusted: boolean
}

export interface AgentIntegrationSetRequest {
  connect: boolean
  primerHook?: boolean
}

export interface AgentIntegrationSetResult {
  status: AgentIntegrationStatus
  changes: AgentIntegrationChange[]
}

/** What `memory:prepare-codex-context` hands the Codex launcher. */
export interface CodexLaunchContext {
  /** Single-line, shell-safe text for `-c "developer_instructions='…'"`, or null to add nothing. */
  developerInstructions: string | null
  /** Why nothing is added: no consent, the user's config already sets developer_instructions,
   *  or Codex isn't connected (no config.toml, or no `[mcp_servers.termpolis]` in it). */
  skipped?: 'no-consent' | 'user-set' | 'disabled'
  /** Memory tools newly pre-approved in config.toml (never overwrites a value already there). */
  approvals: number
  /** A legacy Termpolis block was removed from `<cwd>/AGENTS.md`, or the whole file when that was all it held. */
  agentsMdCleaned?: 'block-removed' | 'file-deleted'
}

export const AGENT_INTEGRATION_IPC = {
  status: 'agents:integration-status',
  set: 'agents:integration-set',
  folderTrustAllowed: 'agents:folder-trust-allowed',
  removeCodexHomeTrust: 'agents:remove-codex-home-trust',
} as const

/**
 * Termpolis MCP tools Claude Code may run without asking: they only read, or write
 * Termpolis's own memory. The single source for the Claude allow list and the Codex
 * approvals — a new tool is not auto-approved until someone adds it here.
 */
export const MCP_TOOLS_AUTO_ALLOWED: readonly string[] = [
  'memory_primer', 'memory_search', 'memory_list', 'memory_related', 'memory_audit',
  'memory_graph', 'memory_selfcheck', 'memory_pool', 'memory_anticipate', 'memory_conflicts',
  'memory_write', 'memory_link', 'memory_feedback', 'memory_correct',
  'retrieve_full',
  'code_search', 'code_locate', 'code_explore', 'code_callers', 'code_callees', 'code_impact',
  'list_terminals', 'swarm_list_agents', 'swarm_list_tasks', 'swarm_read_messages',
  'test_coverage', 'get_git_status',
]

/** Tools that run commands, type into or read other terminals, list files, reach other
 *  MCP servers or change swarm state. Claude Code keeps asking for these. */
export const MCP_TOOLS_ASK: readonly string[] = [
  'run_command', 'run_and_wait', 'write_to_terminal', 'create_terminal', 'close_terminal',
  'read_output', 'get_file_tree', 'gateway_call', 'gateway_list_tools',
  'swarm_send_message', 'swarm_create_task', 'swarm_update_task',
]

/** The tools Termpolis pre-approves in Codex's config.toml: only the memory ones. */
export const CODEX_AUTO_APPROVED_TOOLS: readonly string[] = MCP_TOOLS_AUTO_ALLOWED.filter(t => t.startsWith('memory_'))

/**
 * What connecting writes, per agent. Onboarding, the one-time review and Settings list
 * exactly these lines, and main writes nothing beyond them — change both together.
 */
export const AGENT_INTEGRATION_WRITES: Readonly<Record<AgentId, readonly string[]>> = {
  claude: [
    'Adds the Termpolis MCP server (memory, code search, terminals) to your Claude Code user config (.claude.json)',
    `Lets ${MCP_TOOLS_AUTO_ALLOWED.length} read-only and memory tools run without asking (settings.json). Tools that run commands or type into terminals still ask`,
    'Marks folders you open agents in as trusted, so Claude Code skips its trust prompt. Never your home folder or a drive root',
  ],
  codex: [
    'Adds the Termpolis MCP server to config.toml',
    `Pre-approves the ${CODEX_AUTO_APPROVED_TOOLS.length} memory tools, unless you already chose a setting for them`,
    'Answers the folder-trust prompt for folders you open agents in. Never your home folder or a drive root',
  ],
  gemini: [
    'Adds the Termpolis MCP server to settings.json',
  ],
}

/** The optional Claude Code SessionStart hook, as the UI describes it. */
export const PRIMER_HOOK_DESCRIPTION =
  'Loads your project memory whenever a Claude Code session starts, including sessions started outside Termpolis (a SessionStart hook in settings.json)'

/** Longest Codex launch instruction Termpolis will type into a shell. */
export const CODEX_INSTRUCTION_MAX_CHARS = 1500

/**
 * True when text can ride inside `-c "developer_instructions='…'"` unchanged in bash,
 * PowerShell 5.1 and cmd, and as a TOML literal string: one line of letters, digits,
 * spaces and `. , : ; ( ) - _ /`. No quotes, `$`, backtick, `%`, `!`, `&`, `|`, `<`, `>` or `^`.
 */
export function isShellSafeInstruction(text: string): boolean {
  return text.length > 0 && text.length <= CODEX_INSTRUCTION_MAX_CHARS && /^[A-Za-z0-9 .,:;()_/-]+$/.test(text)
}

/**
 * A path as its root (`/`, `x:/`, or `//` for UNC) plus lower-cased names, with `.` and
 * `..` resolved. Null for a relative path: no agent writes one, and it could name any folder.
 * Case is folded everywhere, not only on Windows: macOS compares names case-insensitively
 * too, and for a check that refuses trust, matching too much is the safe mistake.
 */
function normalizeForTrust(p: string, home = ''): { root: string; names: string[] } | null {
  let s = (p ?? '').trim()
  if (/^~(?=[\\/]|$)/.test(s)) {
    if (!(home ?? '').trim()) return null
    s = home.trim() + s.slice(1)
  }
  // `\\?\C:\x` and `\\?\UNC\server\share` (Win32 verbatim paths, which Codex can write as
  // trust keys) name the same folders as `C:\x` and `\\server\share`.
  s = s.replace(/\\/g, '/').replace(/^\/\/[?.]\/UNC(?=\/|$)/i, '/').replace(/^\/\/[?.]\//, '')
  const drive = /^([a-z]):(?=\/|$)/i.exec(s)
  const root = drive ? drive[1].toLowerCase() + ':/' : s.startsWith('//') ? '//' : s.startsWith('/') ? '/' : null
  if (!root) return null
  const names: string[] = []
  for (let name of s.slice(drive ? 2 : root.length).split('/')) {
    // Windows drops trailing dots and spaces from a name, so `C:\Users\me.` is home.
    if (root !== '/' && name !== '..') name = name.replace(/[. ]+$/, '')
    if (name === '..') names.pop()
    else if (name && name !== '.') names.push(name.toLowerCase())
  }
  return { root, names }
}

/**
 * True for a folder whose trust would reach far beyond one project: the home folder,
 * any folder above it, a drive root, `/`, or a UNC share root. Claude Code checks trust
 * by walking up from the working folder, so trusting home trusts every project under it.
 * A path that can't be placed (empty, relative, `~` with no home) counts as unsafe.
 */
export function isUnsafeTrustRoot(p: string, home: string): boolean {
  const path = normalizeForTrust(p, home)
  if (!path) return true
  if (path.names.length <= (path.root === '//' ? 2 : 0)) return true
  const h = normalizeForTrust(home ?? '')
  if (!h || h.root !== path.root || path.names.length > h.names.length) return false
  return path.names.every((name, i) => name === h.names[i])
}
