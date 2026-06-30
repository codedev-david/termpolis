// Helpers for auto-registering the Termpolis MCP server into the
// config files of Claude Code, Codex, and Gemini CLI.
//
// Extracted from index.ts so we can unit-test the "file is corrupt / empty
// / missing / truncated" paths in isolation. Each function is defensive:
// a broken config file should log-and-skip, never crash the main process.

import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'fs'
import { join } from 'path'

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
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
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
 * Resolve an absolute `node` executable so the SessionStart memory hook and the
 * MCP adapter still run when the shell Claude Code uses to launch them has a PATH
 * without node — the GUI-launch-vs-login-shell discrepancy, and version managers
 * (nvm / fnm / volta) whose node isn't on the non-interactive PATH. Scans this
 * process's PATH plus a few well-known install dirs and returns the first node
 * that ACTUALLY EXISTS on disk; falls back to the bare `node` command (the prior
 * behavior — no regression) when none resolves, so a non-existent path is never
 * baked into the user's config. Pure: env + a file-existence probe are injectable.
 */
export function resolveNodeCommand(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
): string {
  const win = process.platform === 'win32'
  const exe = win ? 'node.exe' : 'node'
  const dirs = (env.PATH || env.Path || '').split(win ? ';' : ':').map((d) => d.trim()).filter(Boolean)
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

// Register MCP server in Claude Code's global settings.json + auto-trust
// the termpolis tool wildcard. When hookScriptPath is provided, ALSO register
// the portable SessionStart memory-primer hook (deterministic memory recall).
// Returns changed=true if anything was written.
export function registerInClaudeSettings(settingsPath: string, adapterPath: string, hookScriptPath?: string, nodeCommand: string = 'node'): RegistryResult {
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
  if (!existing || existing.args?.[0] !== adapterPath || (existing.command && existing.command !== nodeCommand)) {
    settings.mcpServers.termpolis = { command: nodeCommand, args: [adapterPath] }
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
      // nodeCommand is an absolute node path when resolvable (so the hook runs
      // even when the hook shell's PATH lacks node — nvm/fnm installs), else the
      // bare `node`. An absolute path is quoted (it may contain spaces).
      const portableHookPath = hookScriptPath.replace(/\\/g, '/')
      const nodeForHook = nodeCommand === 'node' ? 'node' : `"${nodeCommand.replace(/\\/g, '/')}"`
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
export function registerInGlobalMcp(mcpJsonPath: string, adapterPath: string): RegistryResult {
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
  if (existing && existing.args?.[0] === adapterPath) {
    // Clean up older root-level entry once, but don't rewrite disk if nothing else changed.
    if (!('termpolis' in globalMcp)) return { changed: false, skipped: 'already-registered' }
  }

  globalMcp.mcpServers.termpolis = { command: 'node', args: [adapterPath] }
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
export function registerInCodex(codexTomlPath: string, adapterPath: string): RegistryResult {
  if (!existsSync(codexTomlPath)) return { changed: false, skipped: 'missing' }
  let content: string
  try {
    content = readFileSync(codexTomlPath, 'utf-8')
  } catch (e: any) {
    return { changed: false, skipped: 'corrupt', error: e?.message || String(e) }
  }
  if (content.includes('[mcp_servers.termpolis]')) {
    return { changed: false, skipped: 'already-registered' }
  }
  const escaped = adapterPath.replace(/\\/g, '\\\\')
  const entry = `\n[mcp_servers.termpolis]\ncommand = "node"\nargs = ["${escaped}"]\n`
  try {
    appendFileSync(codexTomlPath, entry, 'utf-8')
    return { changed: true }
  } catch (e: any) {
    return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
  }
}

export function registerInGemini(settingsPath: string, adapterPath: string): RegistryResult {
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
  if (existing && existing.args?.[0] === adapterPath) {
    return { changed: false, skipped: 'already-registered' }
  }

  settings.mcpServers.termpolis = { command: 'node', args: [adapterPath] }
  try {
    atomicWriteJson(settingsPath, settings)
    return { changed: true }
  } catch (e: any) {
    return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
  }
}

// Qwen-Code (Alibaba's Gemini CLI fork) uses ~/.qwen/settings.json with the
// same mcpServers schema as Gemini. Mirror registerInGemini.
export function registerInQwen(settingsPath: string, adapterPath: string): RegistryResult {
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
  if (existing && existing.args?.[0] === adapterPath) {
    return { changed: false, skipped: 'already-registered' }
  }

  settings.mcpServers.termpolis = { command: 'node', args: [adapterPath] }
  try {
    atomicWriteJson(settingsPath, settings)
    return { changed: true }
  } catch (e: any) {
    return { changed: false, skipped: 'write-failed', error: e?.message || String(e) }
  }
}
