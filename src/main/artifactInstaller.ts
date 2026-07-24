// Safe Import — the INSTALL stage. Once a third-party artifact (a skill, slash
// command, subagent, MCP server or plugin pulled off GitHub/a marketplace) has
// been SCANNED and APPROVED, this is what actually lands it in the user's agent
// configs so the agent can use it locally.
//
// WHY it is its own module, fully dependency-injected:
//   Installing means writing into the user's LIVE agent configs — ~/.claude,
//   ~/.codex, ~/.gemini. Those files are irreplaceable (hand-edited
//   settings, other people's MCP servers, existing skills). The two ways to get
//   this wrong are (a) clobbering something that was already there and (b)
//   letting a hostile archive path escape the install dir. Both are pure logic,
//   so both are provable — the fs is injected and every test runs in memory.
//   Nothing here imports electron, and node:fs is only reached lazily inside
//   defaultInstallerDeps().
//
// Mirrors agentMcpRegistry.ts for the config shapes (mcpServers in JSON for
// Claude/Gemini, an [mcp_servers.x] TOML block for Codex) — that module
// registers OUR server, this one registers THEIRS.

import { basename, dirname, extname, join } from 'path'

export type ArtifactKind = 'skill' | 'command' | 'subagent' | 'mcp' | 'plugin'
export type AgentTarget = 'claude' | 'codex' | 'gemini'

export interface ArtifactFile {
  /** Path RELATIVE to the archive root, as it came out of the zip/repo. */
  path: string
  content: string
}

export interface McpServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface Artifact {
  /** The approved name. Everything on disk is keyed off this, not off the archive. */
  name: string
  kind: ArtifactKind
  files: ArtifactFile[]
  /** Server definition for kind==='mcp'. Falls back to the one inside `files`. */
  mcp?: McpServerDef
}

export interface InstallerDeps {
  home: () => string
  readFile: (p: string) => string | null
  writeFile: (p: string, data: string) => void
  mkdirp: (p: string) => void
  exists: (p: string) => boolean
  /**
   * Optional delete. Uninstalling an MCP server is a read-modify-WRITE (we
   * rewrite the settings file without the entry), so it needs no delete — but
   * uninstalling a skill/command/subagent means removing real files. Blanking
   * them with writeFile would be worse than useless: a 0-byte SKILL.md still
   * loads. So when no `rm` is supplied we remove nothing and report nothing,
   * rather than lie about what we deleted.
   */
  rm?: (p: string) => void
}

export interface InstalledPath {
  target: AgentTarget
  path: string
}

// Config roots. Codex is the odd one out: TOML, and no commands dir (it has
// prompts instead), which is why it can only ever accept an MCP server.
const AGENT_DIR: Record<AgentTarget, string> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini',
}

const TARGETS_BY_KIND: Record<ArtifactKind, AgentTarget[]> = {
  mcp: ['claude', 'codex', 'gemini'],
  command: ['claude', 'gemini'],
  skill: ['claude'],
  subagent: ['claude'],
  plugin: ['claude'],
}

const SKILL_FILE = 'SKILL.md'
const PLUGIN_MANIFEST = 'plugin.json'
const PLUGIN_DIR = '.claude-plugin'

type Json = Record<string, unknown>

// ---------------------------------------------------------------------------
// path + parsing helpers (pure)
// ---------------------------------------------------------------------------

// Archive entries always use forward slashes; a local path may not. Split on
// both so the same artifact lands identically on Windows and posix.
function segments(p: string): string[] {
  return String(p || '').split(/[\\/]+/).filter((s) => s && s !== '.')
}

// A name reaching the fs comes from a THIRD PARTY. `../../.bashrc` as a name is
// a real attack, so strip it down to something that cannot traverse or hide.
function sanitizeName(raw: string): string {
  const n = String(raw || '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return n || 'artifact'
}

// Same idea for the relative paths inside a bundle (zip-slip): refuse the file
// outright rather than try to repair it — a skill that needs `..` is not a skill.
function safeSegments(p: string): string[] | null {
  const segs = segments(p)
  return segs.some((s) => s === '..') ? null : segs
}

function startsWith(segs: string[], prefix: string[]): boolean {
  return prefix.every((s, i) => segs[i] === s)
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined // parse failure — distinct from a literal `null`
  }
}

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(o)) {
    if (typeof val === 'string') out[k] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// Minimal YAML frontmatter reader — we only ever need the flat scalar keys
// (name/description/tools). A real YAML parser is a dependency (and an attack
// surface) we don't need to classify a file.
function parseFrontmatter(md: string): Record<string, string> | null {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md || '')
  if (!m) return null
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function stripFrontmatter(md: string): string {
  return (md || '').replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim()
}

function isMarkdown(p: string): boolean {
  return extname(p).toLowerCase() === '.md'
}

function isPluginManifest(p: string): boolean {
  const s = segments(p)
  return s.length >= 2 && s[s.length - 2] === PLUGIN_DIR && s[s.length - 1] === PLUGIN_MANIFEST
}

function isSkillFile(p: string): boolean {
  return segments(p).pop() === SKILL_FILE
}

function hasMcpServers(content: string): boolean {
  const o = asObject(safeJson(content))
  return !!o && 'mcpServers' in o
}

function serverMap(content: string): Json | null {
  return asObject(asObject(safeJson(content))?.mcpServers)
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

/**
 * Infer the artifact kind + name from its file list.
 *
 * Order is the whole design here — the checks are nested, not exclusive:
 *   plugin  first, because a plugin bundle legitimately CONTAINS skills,
 *           commands and a .mcp.json; the manifest is what says "this is one
 *           unit". Testing mcp first would misfile every plugin.
 *   skill   next: SKILL.md at any depth (github zips nest under <repo>-main/).
 *   mcp     a `.mcp.json`, or any json carrying an `mcpServers` key.
 *   subagent BEFORE command: a subagent's markdown also has a `description:`,
 *           so `tools:` is the only thing that tells them apart.
 * Anything else is junk → null, and Safe Import refuses to install it.
 */
export function classifyArtifact(files: ArtifactFile[]): { kind: ArtifactKind; name: string } | null {
  if (!Array.isArray(files) || files.length === 0) return null

  const plugin = files.find((f) => isPluginManifest(f.path))
  if (plugin) {
    const manifest = asObject(safeJson(plugin.content))
    const declared = typeof manifest?.name === 'string' ? manifest.name : ''
    // dir that CONTAINS .claude-plugin/ — that's the plugin root.
    const dir = segments(plugin.path).slice(0, -2).pop() || ''
    return { kind: 'plugin', name: sanitizeName(declared || dir || 'plugin') }
  }

  const skill = files.find((f) => isSkillFile(f.path))
  if (skill) {
    // The dir holding SKILL.md IS the skill (it's the unit we copy), so prefer
    // it; a bare SKILL.md with no parent falls back to the frontmatter name.
    const segs = segments(skill.path)
    const parent = segs.length >= 2 ? segs[segs.length - 2] : ''
    const fm = parseFrontmatter(skill.content)
    return { kind: 'skill', name: sanitizeName(parent || fm?.name || 'skill') }
  }

  const mcp = files.find((f) => segments(f.path).pop() === '.mcp.json' || hasMcpServers(f.content))
  if (mcp) {
    const first = Object.keys(serverMap(mcp.content) || {})[0] || ''
    const file = segments(mcp.path).pop() || ''
    return { kind: 'mcp', name: sanitizeName(first || basename(file, '.json') || 'mcp') }
  }

  // Command/subagent are single-file artifacts. More than one markdown with no
  // SKILL.md and no manifest is genuinely ambiguous — refuse rather than guess.
  const mds = files.filter((f) => isMarkdown(f.path))
  if (mds.length !== 1) return null
  const fm = parseFrontmatter(mds[0].content)
  if (!fm) return null
  // Claude keys a subagent off its frontmatter `name:` — so does the installer.
  if (fm.name && fm.tools) return { kind: 'subagent', name: sanitizeName(fm.name) }
  // ...but a slash command is named by its FILE (`deploy.md` → `/deploy`).
  if (fm.description) return { kind: 'command', name: sanitizeName(basename(mds[0].path, '.md')) }
  return null
}

/** Which agents can actually accept this kind of artifact. */
export function supportedTargets(kind: ArtifactKind): AgentTarget[] {
  return [...(TARGETS_BY_KIND[kind] || [])]
}

// ---------------------------------------------------------------------------
// TOML rendering (Codex config + Gemini commands)
// ---------------------------------------------------------------------------

function tomlString(s: string): string {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Multi-line basic string. A raw `"""` inside the body would TERMINATE the
// literal early and let the rest of the artifact's text inject TOML keys — this
// escape is the boundary between "imported prompt" and "imported config".
// (A lone trailing `"` is safe: we always emit a newline before the closer.)
function tomlMultiline(s: string): string {
  const body = String(s).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
  return `"""\n${body}\n"""`
}

function tomlKey(k: string): string {
  return k.replace(/[^A-Za-z0-9_-]/g, '_') // bare-key charset; keeps the table parseable
}

function codexBlock(name: string, s: McpServerDef): string {
  const lines = [`\n[mcp_servers.${name}]`, `command = ${tomlString(s.command)}`]
  if (s.args?.length) lines.push(`args = [${s.args.map(tomlString).join(', ')}]`)
  if (s.env && Object.keys(s.env).length > 0) {
    lines.push(`\n[mcp_servers.${name}.env]`)
    for (const [k, v] of Object.entries(s.env)) lines.push(`${tomlKey(k)} = ${tomlString(v)}`)
  }
  return `${lines.join('\n')}\n`
}

// Gemini CLI takes custom commands as TOML, not
// markdown — and its argument placeholder is {{args}}, not Claude's
// $ARGUMENTS. Translating is the difference between a command that works after
// import and one that silently passes the literal string "$ARGUMENTS".
function toCommandToml(md: string): string {
  const fm = parseFrontmatter(md)
  const prompt = stripFrontmatter(md).replace(/\$ARGUMENTS/g, '{{args}}')
  const lines = ['# Installed by Termpolis Safe Import']
  if (fm?.description) lines.push(`description = ${tomlString(fm.description)}`)
  lines.push(`prompt = ${tomlMultiline(prompt)}`)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// write planning (pure — install and uninstall MUST agree on the paths)
// ---------------------------------------------------------------------------

interface PlannedWrite {
  path: string
  content: string
}

// Dir that OWNS an anchor file: the one holding SKILL.md, or the one holding
// .claude-plugin/.
function anchorRoot(kind: ArtifactKind, path: string): string[] {
  const segs = segments(path)
  return kind === 'plugin' ? segs.slice(0, -2) : segs.slice(0, -1)
}

// The root of the artifact inside the archive. Everything is copied relative to
// it, so archive junk OUTSIDE it (README, LICENSE, CI config, a SIBLING skill)
// is dropped — scattering that into ~/.claude is how you get a mess nobody can
// clean up. One archive can hold several anchors (awesome-* repos ship a whole
// dir of skills), so we anchor on the one the user actually approved by name and
// only fall back to the first when nothing matches (i.e. it was renamed).
function artifactRoot(a: Artifact): string[] {
  const isAnchor = a.kind === 'plugin' ? isPluginManifest : isSkillFile
  const anchors = a.files.filter((f) => isAnchor(f.path))
  const name = sanitizeName(a.name)
  const anchor = anchors.find((f) => anchorRoot(a.kind, f.path).pop() === name) ?? anchors[0]
  if (!anchor) return [] // malformed bundle: treat the archive root as the root
  return anchorRoot(a.kind, anchor.path)
}

function treeWrites(a: Artifact, root: string): PlannedWrite[] {
  const prefix = artifactRoot(a)
  const out: PlannedWrite[] = []
  for (const f of a.files) {
    const segs = safeSegments(f.path)
    if (!segs) continue                    // zip-slip — refuse the file
    if (!startsWith(segs, prefix)) continue // outside the artifact root — junk
    const rel = segs.slice(prefix.length)
    if (rel.length === 0) continue          // bare directory entry
    out.push({ path: join(root, ...rel), content: f.content })
  }
  return out
}

function primaryMarkdown(a: Artifact): string | null {
  const md = a.files.find((f) => isMarkdown(f.path))
  return md ? md.content : null
}

// Every file this artifact puts on disk for one target. MCP servers are absent
// on purpose: they are MERGED into an existing config, never copied as a file.
function planWrites(a: Artifact, t: AgentTarget, home: string): PlannedWrite[] {
  const name = sanitizeName(a.name)
  if (a.kind === 'skill') return treeWrites(a, join(home, '.claude', 'skills', name))
  // Same local marketplace index.ts already registers the Termpolis plugin in —
  // it's the dir Claude Code discovers local plugins from.
  if (a.kind === 'plugin') return treeWrites(a, join(home, '.claude', 'local-marketplace', 'plugins', name))

  const md = primaryMarkdown(a)
  if (md === null) return [] // malformed: a command/subagent IS its markdown
  if (a.kind === 'subagent') return [{ path: join(home, '.claude', 'agents', `${name}.md`), content: md }]
  if (t === 'claude') return [{ path: join(home, '.claude', 'commands', `${name}.md`), content: md }]
  return [{ path: join(home, AGENT_DIR[t], 'commands', `${name}.toml`), content: toCommandToml(md) }]
}

function settingsPath(t: AgentTarget, home: string): string {
  return t === 'codex'
    ? join(home, '.codex', 'config.toml')
    : join(home, AGENT_DIR[t], 'settings.json')
}

// ---------------------------------------------------------------------------
// MCP merge / unmerge
// ---------------------------------------------------------------------------

// The approved server def. `a.mcp` wins; otherwise recover it from the bundled
// .mcp.json so a caller can hand us the raw scanned files without hoisting it.
function resolveServer(a: Artifact): McpServerDef | null {
  if (a.mcp?.command) return a.mcp
  for (const f of a.files) {
    const servers = serverMap(f.content)
    if (!servers) continue
    const entry = asObject(servers[a.name]) || asObject(Object.values(servers)[0])
    if (entry && typeof entry.command === 'string') {
      return { command: entry.command, args: asStringArray(entry.args), env: asStringMap(entry.env) }
    }
  }
  return null
}

function serverEntry(s: McpServerDef): Json {
  const e: Json = { command: s.command }
  if (s.args?.length) e.args = [...s.args]
  if (s.env && Object.keys(s.env).length > 0) e.env = { ...s.env }
  return e
}

// Read-modify-write the agent's JSON settings. We only ever touch OUR key —
// every other server, and every other top-level setting, is written back
// untouched. The write itself is atomic in the fs adapter (tmp + rename), which
// is why InstallerDeps needs no rename hook: durability is the adapter's job,
// merge correctness is ours.
function mergeJsonServer(t: AgentTarget, name: string, server: McpServerDef, deps: InstallerDeps): string | null {
  const p = settingsPath(t, deps.home())
  const raw = deps.readFile(p)
  let root: Json = {}
  if (raw !== null && raw.trim() !== '') {
    const parsed = safeJson(raw)
    // Corrupt config: bail out. Overwriting a file we cannot parse would destroy
    // settings the user hand-edited — failing the install is the lesser evil.
    if (parsed === undefined) return null
    root = asObject(parsed) ?? {} // array/primitive root is already broken — start clean
  }
  const servers = asObject(root.mcpServers) ?? {}
  servers[name] = serverEntry(server)
  root.mcpServers = servers
  deps.mkdirp(dirname(p))
  deps.writeFile(p, JSON.stringify(root, null, 2))
  return p
}

// Codex is TOML. We treat it as a text blob and APPEND, exactly like
// agentMcpRegistry.registerInCodex — a real TOML parser would choke on any
// syntax error the user already has and block the install. The header check is
// what makes a repeat install idempotent (no duplicate block).
function appendCodexServer(name: string, server: McpServerDef, deps: InstallerDeps): string {
  const p = settingsPath('codex', deps.home())
  const raw = deps.readFile(p) ?? ''
  if (raw.includes(`[mcp_servers.${name}]`)) return p // already ours
  deps.mkdirp(dirname(p))
  deps.writeFile(p, raw + codexBlock(name, server))
  return p
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Drop `[mcp_servers.<name>]` and any of its sub-tables, line by line. Line-wise
// (not regex-over-the-blob) because a value like `args = ["/a.cjs"]` contains a
// `[` — a naive "up to the next bracket" match would leave half the block behind.
function stripCodexServer(raw: string, name: string): string {
  const mine = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(name)}(\\.[^\\]]*)?\\]`)
  const out: string[] = []
  let skipping = false
  for (const line of raw.split('\n')) {
    if (/^\s*\[/.test(line)) skipping = mine.test(line) // a new section ends the previous one
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Install an approved artifact into each target agent's config.
 *
 * Targets the artifact's kind can't support are silently omitted (a skill has
 * nowhere to go in Codex), as is any target whose config we refuse to touch
 * (corrupt JSON) or whose server def we can't resolve.
 *
 * Idempotent in BOTH senses: running it twice leaves the same bytes on disk AND
 * returns the same paths — so the caller can re-run an install to repair one.
 */
export function installArtifact(a: Artifact, targets: AgentTarget[], deps: InstallerDeps): InstalledPath[] {
  const home = deps.home()
  const name = sanitizeName(a.name)
  const allowed = supportedTargets(a.kind)
  const out: InstalledPath[] = []

  for (const target of targets) {
    if (!allowed.includes(target)) continue

    if (a.kind === 'mcp') {
      const server = resolveServer(a)
      if (!server) continue
      const p = target === 'codex'
        ? appendCodexServer(name, server, deps)
        : mergeJsonServer(target, name, server, deps)
      if (p) out.push({ target, path: p })
      continue
    }

    for (const w of planWrites(a, target, home)) {
      deps.mkdirp(dirname(w.path))
      deps.writeFile(w.path, w.content)
      out.push({ target, path: w.path })
    }
  }
  return out
}

/**
 * Remove exactly what installArtifact wrote (derived from the same artifact, so
 * the two can never drift) and return the paths actually changed. Paths that
 * were already gone are not reported — the return value is what we DID, not what
 * we intended.
 */
export function uninstallArtifact(a: Artifact, targets: AgentTarget[], deps: InstallerDeps): string[] {
  const home = deps.home()
  const name = sanitizeName(a.name)
  const allowed = supportedTargets(a.kind)
  const removed: string[] = []

  for (const target of targets) {
    if (!allowed.includes(target)) continue

    if (a.kind === 'mcp') {
      const p = settingsPath(target, home)
      const raw = deps.readFile(p)
      if (raw === null) continue

      if (target === 'codex') {
        const next = stripCodexServer(raw, name)
        if (next === raw) continue // block was never there
        deps.writeFile(p, next)
        removed.push(p)
        continue
      }

      const root = asObject(safeJson(raw)) // corrupt / non-object → leave it alone
      const servers = root ? asObject(root.mcpServers) : null
      if (!servers || !(name in servers)) continue
      delete servers[name]
      deps.writeFile(p, JSON.stringify(root, null, 2))
      removed.push(p)
      continue
    }

    // File-backed artifacts need a real delete — see InstallerDeps.rm.
    if (!deps.rm) continue
    for (const w of planWrites(a, target, home)) {
      if (!deps.exists(w.path)) continue
      deps.rm(w.path)
      removed.push(w.path)
    }
  }
  return removed
}

/**
 * Real-filesystem adapter. node:fs is required LAZILY so importing this module
 * (in a unit test, or anywhere near the renderer) never drags fs in.
 * `home` is overridable so the adapter itself can be tested against a temp dir
 * instead of the developer's actual ~/.claude.
 */
export function defaultInstallerDeps(home?: string): InstallerDeps {
  const fs = require('fs')
  const root = home ?? require('os').homedir()
  return {
    home: () => root,
    readFile: (p: string) => {
      try {
        return fs.readFileSync(p, 'utf-8')
      } catch {
        return null // missing / unreadable — callers treat this as "not there yet"
      }
    },
    // Atomic: these are LIVE configs. A half-written settings.json is a broken
    // agent, so replace via tmp + rename (same trick as agentMcpRegistry).
    writeFile: (p: string, data: string) => {
      const tmp = `${p}.tmp`
      fs.writeFileSync(tmp, data, 'utf-8')
      fs.renameSync(tmp, p)
    },
    mkdirp: (p: string) => {
      fs.mkdirSync(p, { recursive: true })
    },
    exists: (p: string) => fs.existsSync(p),
    rm: (p: string) => {
      try {
        fs.rmSync(p, { force: true })
      } catch {
        // Already gone / locked — uninstall is best-effort, never fatal.
      }
    },
  }
}
