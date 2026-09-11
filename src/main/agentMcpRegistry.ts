// Helpers for auto-registering the Termpolis MCP server into the
// config files of Claude Code, Codex, and Gemini CLI.
//
// Extracted from index.ts so we can unit-test the "file is corrupt / empty
// / missing / truncated" paths in isolation. Each function is defensive:
// a broken config file should log-and-skip, never crash the main process.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { getAgentExtraPaths } from './agentPaths'

export interface RegistryResult {
  changed: boolean
  skipped?: 'missing' | 'corrupt' | 'already-registered' | 'write-failed'
  error?: string
}

function safeReadJson(path: string): { ok: true; value: any } | { ok: false; reason: 'missing' | 'corrupt'; error?: string } {
  if (!existsSync(path)) return { ok: false, reason: 'missing' }
  try {
    const raw = readFileSync(path, 'utf-8')
    // Empty / whitespace-only file → treat as corrupt (not a valid JSON doc).
    if (!raw.trim()) return { ok: false, reason: 'corrupt', error: 'empty file' }
    return { ok: true, value: JSON.parse(raw) }
  } catch (e: any) {
    return { ok: false, reason: 'corrupt', error: e?.message || String(e) }
  }
}

function atomicWriteJson(path: string, value: any): void {
  atomicWriteText(path, JSON.stringify(value, null, 2))
}

/** tmp+rename, so a crash mid-write leaves the original config intact rather than a
 *  truncated one. Claude and Gemini already got this through atomicWriteJson; Codex is
 *  TOML and so wrote straight to the live file until it was routed through here. */
function atomicWriteText(path: string, content: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, path)
}

// Scan a Claude `hooks.SessionStart` array (an array of hook groups, each with
// a nested `hooks: [{ type, command }]`) and collect every command string we
// can find. Used to detect an existing memory-primer registration without
// assuming any particular shape — tolerates malformed groups/entries.
function collectSessionStartCommands(sessionStart: unknown[]): string[] {
  const cmds: string[] = []
  const cmdOf = (x: unknown): string | undefined => {
    if (x && typeof x === 'object') {
      const c = (x as { command?: unknown }).command
      if (typeof c === 'string') return c
    }
    return undefined
  }
  for (const group of sessionStart) {
    if (!group || typeof group !== 'object') continue
    const top = cmdOf(group)
    if (top) cmds.push(top)
    const hooks = (group as { hooks?: unknown }).hooks
    if (Array.isArray(hooks)) {
      for (const h of hooks) {
        const c = cmdOf(h)
        if (c) cmds.push(c)
      }
    }
  }
  return cmds
}

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

function toRunner(spec: NodeSpec): NodeRunner {
  return typeof spec === 'string' ? { command: spec } : spec
}

/**
 * The runner rendered as a shell command prefix for a Claude Code hook.
 *
 * Hooks are `command` strings run through a shell — POSIX sh everywhere,
 * including Windows, where Claude Code shells out to Git Bash — so `K=V cmd`
 * is the portable way to hand the process an environment variable. That matters
 * for the Electron fallback: without ELECTRON_RUN_AS_NODE the same binary opens
 * a second Termpolis window instead of running the hook script.
 *
 * A bare `node` stays bare (unquoted) so the shell resolves it on PATH; an
 * absolute path is quoted, with backslashes normalized, because Windows paths
 * contain spaces (`C:/Program Files/...`).
 */
function hookCommand(runner: NodeRunner): string {
  const bin = runner.command === 'node' ? 'node' : `"${runner.command.replace(/\\/g, '/')}"`
  if (!runner.env) return bin
  const prefix = Object.entries(runner.env).map(([k, v]) => `${k}=${v}`).join(' ')
  return `${prefix} ${bin}`
}

/** Same runner, compared the way a config file stores it. */
function runnerMatches(existing: any, runner: NodeRunner): boolean {
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

// Register MCP server in Claude Code's global settings.json + auto-trust
// the termpolis tool wildcard. When hookScriptPath is provided, ALSO register
// the portable SessionStart memory-primer hook (deterministic memory recall).
// Returns changed=true if anything was written.
export function registerInClaudeSettings(settingsPath: string, adapterPath: string, hookScriptPath?: string, node: NodeSpec = 'node'): RegistryResult {
  const runner = toRunner(node)
  const read = safeReadJson(settingsPath)
  if (!read.ok) {
    if (read.reason === 'missing') return { changed: false, skipped: 'missing' }
    return { changed: false, skipped: 'corrupt', error: read.error }
  }
  // If the root parsed to a primitive / array / null, replace with {} —
  // setting properties on a non-object throws in strict mode.
  const settings: any = (read.value && typeof read.value === 'object' && !Array.isArray(read.value))
    ? read.value
    : {}
  let changed = false

  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
    settings.mcpServers = {}
    changed = true
  }
  const existing = settings.mcpServers.termpolis
  if (!existing || existing.args?.[0] !== adapterPath || !runnerMatches(existing, runner)) {
    settings.mcpServers.termpolis = { ...runner, args: [adapterPath] }
    changed = true
  }

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {}
    changed = true
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = []
    changed = true
  }

  // Purge legacy (*) entries — no longer a valid Claude Code matcher
  const legacy = settings.permissions.allow.filter(
    (p: unknown) => typeof p === 'string' && p.startsWith('mcp__termpolis__') && p.endsWith('(*)'),
  )
  if (legacy.length > 0) {
    settings.permissions.allow = settings.permissions.allow.filter((p: unknown) => !legacy.includes(p))
    changed = true
  }
  if (!settings.permissions.allow.includes('mcp__termpolis__*')) {
    settings.permissions.allow.push('mcp__termpolis__*')
    changed = true
  }

  // Optionally register the portable SessionStart memory-primer hook so EVERY
  // install gets deterministic memory recall — the digest is injected into
  // session context at startup instead of relying on the agent to call a tool.
  // Additive & idempotent: we never remove or reorder the user's own
  // SessionStart hooks or other hook events, and we never add the hook twice.
  if (hookScriptPath) {
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      settings.hooks = {}
      changed = true
    }
    if (!Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = []
      changed = true
    }
    const alreadyHooked = collectSessionStartCommands(settings.hooks.SessionStart)
      .some((c) => c.includes('memory-primer-hook'))
    if (!alreadyHooked) {
      // Path normalized to forward slashes — node accepts them on Windows and
      // they avoid backslash-escaping ambiguity in the JSON command string.
      // The runner is an absolute node path when resolvable (so the hook runs even
      // when the hook shell's PATH lacks node — nvm/fnm installs), else Termpolis's
      // own Electron in node mode, else the bare `node`. See hookCommand.
      const portableHookPath = hookScriptPath.replace(/\\/g, '/')
      const nodeForHook = hookCommand(runner)
      settings.hooks.SessionStart.push({
        hooks: [{ type: 'command', command: `${nodeForHook} "${portableHookPath}"` }],
      })
      changed = true
    }
  }

  if (!changed) return { changed: false, skipped: 'already-registered' }

  try {
    atomicWriteJson(settingsPath, settings)
    return { changed: true }
  } catch (e: any) {
    return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
  }
}

// Write the global Claude MCP manifest at ~/.mcp.json. Unlike the
// settings.json path this one is created if absent — Claude Code
// honors it even when the user has no settings file.
export function registerInGlobalMcp(mcpJsonPath: string, adapterPath: string, node: NodeSpec = 'node'): RegistryResult {
  const runner = toRunner(node)
  let globalMcp: any = {}
  if (existsSync(mcpJsonPath)) {
    const read = safeReadJson(mcpJsonPath)
    if (read.ok) globalMcp = read.value ?? {}
    // Corrupt file: we still overwrite with a clean manifest — better than
    // leaving a broken config that prevents Claude from ever registering.
  }
  if (!globalMcp || typeof globalMcp !== 'object') globalMcp = {}
  if (!globalMcp.mcpServers || typeof globalMcp.mcpServers !== 'object') globalMcp.mcpServers = {}

  const existing = globalMcp.mcpServers.termpolis
  if (existing && existing.args?.[0] === adapterPath && runnerMatches(existing, runner)) {
    // Clean up older root-level entry once, but don't rewrite disk if nothing else changed.
    if (!('termpolis' in globalMcp)) return { changed: false, skipped: 'already-registered' }
  }

  // The runner, not a bare `node`. Hardcoding it was the same ENOENT bug the comment
  // blocks at :64-80 and :166-176 describe fixing for the other three agents: a machine
  // with no `node` on PATH gets the Electron binary in ELECTRON_RUN_AS_NODE mode instead.
  // `runnerMatches` above is load-bearing for the fix — without it an install whose file
  // still says `command: "node"` would short-circuit as already-registered and stay broken.
  globalMcp.mcpServers.termpolis = { ...runner, args: [adapterPath] }
  delete globalMcp.termpolis

  try {
    atomicWriteJson(mcpJsonPath, globalMcp)
    return { changed: true }
  } catch (e: any) {
    return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
  }
}

// Codex config is TOML — we append a section if it's not already present.
// Treating the file as a text blob is deliberate: a proper TOML parser would
// choke on any user-made syntax error and block registration.
export function registerInCodex(codexTomlPath: string, adapterPath: string, node: NodeSpec = 'node'): RegistryResult {
  if (!existsSync(codexTomlPath)) return { changed: false, skipped: 'missing' }
  let content: string
  try {
    content = readFileSync(codexTomlPath, 'utf-8')
  } catch (e: any) {
    return { changed: false, skipped: 'corrupt', error: e?.message || String(e) }
  }
  const entry = codexEntry(adapterPath, toRunner(node))
  const existing = extractCodexSection(content)
  if (existing !== null) {
    // An entry we already wrote, still naming the same interpreter and adapter:
    // leave the file alone. Anything else is STALE and must be REPLACED, not
    // skipped — the ENOENT this fixes comes from configs an older build wrote
    // with `command = "node"` hardcoded, and those files already contain the
    // section, so a plain already-registered short-circuit would leave every
    // upgraded install broken forever.
    if (existing.trim() === entry.trim()) return { changed: false, skipped: 'already-registered' }
    try {
      // split/join, not String.replace: a `$&` or `$'` inside the generated entry is a
      // substitution pattern to `replace`, and a Windows adapter path can contain one.
      atomicWriteText(codexTomlPath, content.split(existing).join(entry))
      return { changed: true }
    } catch (e: any) {
      return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
    }
  }
  try {
    atomicWriteText(codexTomlPath, content + '\n' + entry)
    return { changed: true }
  } catch (e: any) {
    return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
  }
}

/** The `[mcp_servers.termpolis]` block as TOML. Backslashes are escaped because a
 *  Windows adapter path lands inside a basic (quoted) TOML string. */
function codexEntry(adapterPath: string, runner: NodeRunner): string {
  const q = (v: string): string => `"${v.replace(/\\/g, '\\\\')}"`
  let out = `[mcp_servers.termpolis]\ncommand = ${q(runner.command)}\nargs = [${q(adapterPath)}]\n`
  if (runner.env) {
    const pairs = Object.entries(runner.env).map(([k, v]) => `${k} = ${q(v)}`).join(', ')
    out += `env = { ${pairs} }\n`
  }
  return out
}

/** The existing termpolis section verbatim, or null when there is none. Text-blob
 *  editing, matching this file's reasoning about TOML: a real parser would refuse
 *  the whole config over an unrelated syntax error elsewhere in it. The section
 *  runs to the next table header or to end of file. */
function extractCodexSection(content: string): string | null {
  const start = content.indexOf('[mcp_servers.termpolis]')
  if (start === -1) return null
  const rest = content.slice(start + 1)
  const nextHeader = rest.search(/^[ \t]*\[/m)
  return nextHeader === -1 ? content.slice(start) : content.slice(start, start + 1 + nextHeader)
}

export function registerInGemini(settingsPath: string, adapterPath: string, node: NodeSpec = 'node'): RegistryResult {
  const runner = toRunner(node)
  const read = safeReadJson(settingsPath)
  if (!read.ok) {
    if (read.reason === 'missing') return { changed: false, skipped: 'missing' }
    return { changed: false, skipped: 'corrupt', error: read.error }
  }
  const settings: any = (read.value && typeof read.value === 'object' && !Array.isArray(read.value))
    ? read.value
    : {}
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') settings.mcpServers = {}

  const existing = settings.mcpServers.termpolis
  if (existing && existing.args?.[0] === adapterPath && runnerMatches(existing, runner)) {
    return { changed: false, skipped: 'already-registered' }
  }

  settings.mcpServers.termpolis = { ...runner, args: [adapterPath] }
  try {
    atomicWriteJson(settingsPath, settings)
    return { changed: true }
  } catch (e: any) {
    return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
  }
}
