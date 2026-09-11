# Cross-Agent MCP Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing-but-unreachable MCP gateway a Settings UI, and add a read-only inventory of MCP servers registered across Claude, Codex and Gemini.

**Architecture:** Two new pure main-process modules (`mcpToml.ts` text-scans Codex config; `mcpInventory.ts` merges all five sources into one view model with secrets masked), a new `mcp:` IPC namespace, and one new Settings tab. The gateway's missing `prompt` callback is wired to a native dialog so `defaultDecision: 'ask'` stops resolving to deny.

**Tech Stack:** TypeScript, Electron, React, Tailwind (bracketed hex palette), Vitest + @testing-library/react, Playwright + `_electron`.

**Spec:** `docs/superpowers/specs/2026-09-11-cross-agent-mcp-management-design.md`

## Global Constraints

- Coverage gate: **lines 97 / functions 96 / branches 95 / statements 96** (`vitest.config.ts:110-113`). Windows CI only. NEVER lower — backfill tests on the offending file.
- No new runtime dependency. Codex TOML is text-scanned, per `agentMcpRegistry.ts:313-315`.
- Foreign agent configs are **read-only** in this feature. No new write path to `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.mcp.json` beyond the two existing-bug fixes in Task 3.
- IPC envelope is the discriminated union `IpcResponse<T>` via `ok()` / `err()` from `src/main/ipcResult`. Single-object payloads only.
- Channel naming: `camelCaseNamespace:kebab-case-verb`.
- Renderer: named exports, Tailwind with bracketed VS Code hexes, `data-testid` on every interactive element, **non-optimistic writes**, **no polling timers**.
- Commit directly to `main`. No branches, no PRs.

---

### Task 1: Codex TOML server enumerator

**Files:**
- Create: `src/main/mcpToml.ts`
- Test: `tests/electron/mcpToml.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseCodexMcpServers(content: string): TomlMcpServer[]` and `interface TomlMcpServer { name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { parseCodexMcpServers } from '../../src/main/mcpToml'

describe('parseCodexMcpServers', () => {
  it('reads a plain stdio server', () => {
    const toml = [
      '[mcp_servers.termpolis]',
      'command = "node"',
      'args = ["C:\\\\Users\\\\d\\\\adapter.cjs"]',
      '',
    ].join('\n')
    expect(parseCodexMcpServers(toml)).toEqual([
      { name: 'termpolis', command: 'node', args: ['C:\\Users\\d\\adapter.cjs'] },
    ])
  })

  it('ignores sub-tables rather than inventing a server', () => {
    const toml = [
      '[mcp_servers.termpolis]',
      'command = "node"',
      '[mcp_servers.termpolis.tools.memory_search]',
      'approval_mode = "never"',
    ].join('\n')
    expect(parseCodexMcpServers(toml).map(s => s.name)).toEqual(['termpolis'])
  })

  it('does not mistake a bracket inside a value for a table header', () => {
    const toml = '[mcp_servers.a]\nargs = ["C:\\\\x[1].cjs"]\n'
    expect(parseCodexMcpServers(toml)).toEqual([{ name: 'a', args: ['C:\\x[1].cjs'] }])
  })

  it('handles CRLF, comments, quoted names and an unterminated final section', () => {
    const toml = '# top\r\n[mcp_servers."my-server"]\r\nurl = "https://x.test"\r\n[mcp_servers.tail]\r\ncommand = "x"'
    expect(parseCodexMcpServers(toml)).toEqual([
      { name: 'my-server', url: 'https://x.test' },
      { name: 'tail', command: 'x' },
    ])
  })

  it('reads an inline env table', () => {
    const toml = '[mcp_servers.a]\ncommand = "x"\nenv = { TOKEN = "abc", MODE = "dev" }\n'
    expect(parseCodexMcpServers(toml)[0].env).toEqual({ TOKEN: 'abc', MODE: 'dev' })
  })

  it('returns [] for garbage rather than throwing', () => {
    expect(parseCodexMcpServers('!!! not toml [[[')).toEqual([])
    expect(parseCodexMcpServers('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/mcpToml.test.ts`
Expected: FAIL — cannot resolve `../../src/main/mcpToml`.

- [ ] **Step 3: Write minimal implementation**

```ts
// mcpToml.ts
//
// Enumerates `[mcp_servers.NAME]` sections out of a Codex config.
//
// WHY A TEXT SCAN AND NOT A TOML PARSER: the same reason agentMcpRegistry.ts:313-315
// gives for writing one — a real parser refuses the whole file over an unrelated
// syntax error somewhere else in it, and this file is hand-edited. A listing that
// shows four of five servers beats a listing that shows none. Nothing here writes.

export interface TomlMcpServer {
  name: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

/** A TOML basic string, unescaped. Only the escapes a config path can contain. */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length < 2) return trimmed
  const q = trimmed[0]
  if ((q !== '"' && q !== "'") || trimmed[trimmed.length - 1] !== q) return trimmed
  const inner = trimmed.slice(1, -1)
  return q === "'" ? inner : inner.replace(/\\(["\\])/g, '$1')
}

/** Every quoted string in an inline array, in order. Tolerates trailing commas. */
function parseArray(raw: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2])
  }
  return out
}

function parseInlineTable(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) out[m[1]] = unquote(m[2])
  return out
}

/** The server name in `[mcp_servers.NAME]`, or null when the header is anything else
 *  — including a SUB-table such as `[mcp_servers.a.tools.b]`, which describes a server
 *  that its own header already introduced. */
function serverNameFromHeader(header: string): string | null {
  const prefix = 'mcp_servers.'
  if (!header.startsWith(prefix)) return null
  const rest = header.slice(prefix.length).trim()
  if (!rest) return null
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = rest[0]
    const end = rest.indexOf(q, 1)
    if (end === -1) return null
    // A quoted name followed by anything (`."tools"`) is a sub-table.
    return end === rest.length - 1 ? rest.slice(1, end) : null
  }
  return rest.includes('.') ? null : rest
}

export function parseCodexMcpServers(content: string): TomlMcpServer[] {
  if (typeof content !== 'string' || !content) return []
  const servers: TomlMcpServer[] = []
  let current: TomlMcpServer | null = null

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // A header only counts when `[` is the first non-space character on the line.
    // `args = ["C:\x[1].cjs"]` contains a bracket but is not a header.
    if (trimmed.startsWith('[')) {
      const end = trimmed.lastIndexOf(']')
      current = null
      if (end > 1) {
        const name = serverNameFromHeader(trimmed.slice(1, end).trim())
        if (name) {
          current = { name }
          servers.push(current)
        }
      }
      continue
    }

    if (!current) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()

    if (key === 'command') current.command = unquote(value)
    else if (key === 'url') current.url = unquote(value)
    else if (key === 'args') current.args = parseArray(value)
    else if (key === 'env') current.env = parseInlineTable(value)
  }

  return servers
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/mcpToml.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpToml.ts tests/electron/mcpToml.test.ts
git commit -m "feat(mcp): enumerate Codex [mcp_servers.*] sections without a TOML dep"
```

---

### Task 2: Cross-source inventory with secret masking

**Files:**
- Create: `src/main/mcpInventory.ts`
- Test: `tests/electron/mcpInventory.test.ts`

**Interfaces:**
- Consumes: `parseCodexMcpServers` (Task 1); `ServerSpec` from `./mcpGateway/client`; `redactArgs` from `./mcpGateway/guard`; `scanText` from `./aiSecurity`.
- Produces: `buildInventory(paths: InventoryPaths, gatewayServers: ServerSpec[]): McpInventory`, plus the exported types `InventorySourceId`, `InventorySource`, `InventoryServer`, `McpInventory`, `InventoryPaths`.

Note on reuse: `redactArgs(args, redact)` (`mcpGateway/guard.ts:92`) is a generic deep string-walk; the caller supplies the redactor. Pair it with `scanText(t).redacted` (`aiSecurity.ts:500`), which is the same pairing the gateway already uses. `env` values are masked unconditionally rather than scanned, because an MCP `env` entry is credential-by-convention and a bespoke token format may match no rule.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildInventory } from '../../src/main/mcpInventory'

let dir: string
const paths = () => ({
  claude: join(dir, 'settings.json'),
  globalMcp: join(dir, '.mcp.json'),
  codex: join(dir, 'config.toml'),
  gemini: join(dir, 'gemini.json'),
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-inv-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('buildInventory', () => {
  it('reports every source as missing when nothing exists', () => {
    const inv = buildInventory(paths(), [])
    expect(inv.servers).toEqual([])
    expect(inv.sources.filter(s => s.id !== 'gateway').every(s => s.status === 'missing')).toBe(true)
    expect(inv.sources.find(s => s.id === 'gateway')!.status).toBe('ok')
  })

  it('merges one server seen in two agents and flags drift', () => {
    writeFileSync(paths().claude, JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }))
    writeFileSync(paths().codex, '[mcp_servers.github]\ncommand = "gh-mcp"\n')
    const inv = buildInventory(paths(), [])
    const github = inv.servers.find(s => s.name === 'github')!
    expect(github.sources.claude).toBe(true)
    expect(github.sources.codex).toBe(true)
    expect(github.sources.gemini).toBe(false)
    expect(github.drift).toBe(true)
  })

  it('does not flag drift when all three agents agree', () => {
    const spec = JSON.stringify({ mcpServers: { a: { command: 'x' } } })
    writeFileSync(paths().claude, spec)
    writeFileSync(paths().gemini, spec)
    writeFileSync(paths().codex, '[mcp_servers.a]\ncommand = "x"\n')
    expect(buildInventory(paths(), []).servers.find(s => s.name === 'a')!.drift).toBe(false)
  })

  it('marks a corrupt source without losing the healthy ones', () => {
    writeFileSync(paths().claude, '{ not json')
    writeFileSync(paths().gemini, JSON.stringify({ mcpServers: { ok: { command: 'x' } } }))
    const inv = buildInventory(paths(), [])
    expect(inv.sources.find(s => s.id === 'claude')!.status).toBe('corrupt')
    expect(inv.sources.find(s => s.id === 'claude')!.error).toBeTruthy()
    expect(inv.servers.map(s => s.name)).toEqual(['ok'])
  })

  it('masks every env value and redacts credential-shaped args', () => {
    writeFileSync(paths().claude, JSON.stringify({
      mcpServers: { s: { command: 'x', args: ['--token', 'ghp_' + 'a'.repeat(36)], env: { TOKEN: 'plaintext' } } },
    }))
    const server = buildInventory(paths(), []).servers.find(s => s.name === 's')!
    expect(JSON.stringify(server)).not.toContain('plaintext')
    expect(JSON.stringify(server)).not.toContain('ghp_' + 'a'.repeat(36))
  })

  it('includes gateway servers as their own source', () => {
    const inv = buildInventory(paths(), [{ id: 'local', command: 'npx', args: ['srv'] }])
    const local = inv.servers.find(s => s.name === 'local')!
    expect(local.sources.gateway).toBe(true)
    expect(local.drift).toBe(false)
    expect(local.transport).toBe('stdio')
  })

  it('classifies a url-only entry as http', () => {
    writeFileSync(paths().gemini, JSON.stringify({ mcpServers: { remote: { url: 'https://x.test' } } }))
    expect(buildInventory(paths(), []).servers.find(s => s.name === 'remote')!.transport).toBe('http')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/mcpInventory.test.ts`
Expected: FAIL — cannot resolve `../../src/main/mcpInventory`.

- [ ] **Step 3: Write minimal implementation**

```ts
// mcpInventory.ts
//
// A read-only union of every MCP server the user has registered, across the four
// agent config files Termpolis already writes to plus Termpolis's own gateway.
//
// WHY THIS EXISTS: each agent CLI knows only its own config, so nobody can see the
// whole picture — a server that is registered in two of three agents, or one that
// stopped loading, is invisible until something breaks. Termpolis already touches all
// four files (index.ts:3680, 3689, 3786, 3794), so it is the one program positioned
// to show the union.
//
// NOTHING HERE WRITES. Registration stays in agentMcpRegistry.ts.
//
// SECRETS: these files routinely carry credentials inline. Everything returned has
// been through `mask()` below, so the renderer never receives a plaintext token.

import { existsSync, readFileSync } from 'fs'
import { parseCodexMcpServers } from './mcpToml'
import { redactArgs } from './mcpGateway/guard'
import { scanText } from './aiSecurity'
import type { ServerSpec } from './mcpGateway/client'

export type InventorySourceId = 'claude' | 'globalMcp' | 'codex' | 'gemini' | 'gateway'

export interface InventorySource {
  id: InventorySourceId
  label: string
  path: string
  status: 'ok' | 'missing' | 'corrupt'
  error?: string
}

export interface InventoryServer {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  sources: Record<InventorySourceId, boolean>
  /** Registered in at least one of the three agent CLIs but not all three. The
   *  gateway and ~/.mcp.json are shown but excluded: the gateway is Termpolis's own
   *  list, and ~/.mcp.json is a second Claude surface, so counting either would
   *  report drift on servers that are in fact consistent. */
  drift: boolean
}

export interface McpInventory {
  sources: InventorySource[]
  servers: InventoryServer[]
}

export interface InventoryPaths {
  claude: string
  globalMcp: string
  codex: string
  gemini: string
}

const MASK = '••••'
const DRIFT_SOURCES: InventorySourceId[] = ['claude', 'codex', 'gemini']

const LABELS: Record<InventorySourceId, string> = {
  claude: 'Claude Code',
  globalMcp: 'Claude (~/.mcp.json)',
  codex: 'Codex',
  gemini: 'Gemini',
  gateway: 'Termpolis gateway',
}

interface RawServer {
  name: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

type ReadOutcome =
  | { status: 'ok'; servers: RawServer[] }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string }

/** `mcpServers` out of a JSON agent config. Mirrors safeReadJson's contract in
 *  agentMcpRegistry.ts: a broken file is reported, never thrown and never repaired. */
function readJsonSource(path: string): ReadOutcome {
  if (!existsSync(path)) return { status: 'missing' }
  try {
    const raw = readFileSync(path, 'utf-8')
    if (!raw.trim()) return { status: 'corrupt', error: 'empty file' }
    const parsed = JSON.parse(raw)
    const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const table = root.mcpServers
    if (!table || typeof table !== 'object' || Array.isArray(table)) return { status: 'ok', servers: [] }
    const servers: RawServer[] = []
    for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
      const entry = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
      servers.push({
        name,
        command: typeof entry.command === 'string' ? entry.command : undefined,
        args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined,
        url: typeof entry.url === 'string' ? entry.url : undefined,
        env: entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
          ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined,
      })
    }
    return { status: 'ok', servers }
  } catch (e: any) {
    return { status: 'corrupt', error: e?.message || String(e) }
  }
}

function readCodexSource(path: string): ReadOutcome {
  if (!existsSync(path)) return { status: 'missing' }
  try {
    return { status: 'ok', servers: parseCodexMcpServers(readFileSync(path, 'utf-8')) }
  } catch (e: any) {
    return { status: 'corrupt', error: e?.message || String(e) }
  }
}

/** Args and url go through the shared redactor; every env VALUE is replaced outright.
 *  Keys survive so the panel can still show that a server wants `GITHUB_TOKEN`. */
function mask(server: RawServer): RawServer {
  const redact = (text: string): string => scanText(text).redacted
  return {
    name: server.name,
    command: server.command,
    args: server.args ? (redactArgs(server.args, redact) as string[]) : undefined,
    url: server.url ? redact(server.url) : undefined,
    env: server.env ? Object.fromEntries(Object.keys(server.env).map(k => [k, MASK])) : undefined,
  }
}

export function buildInventory(paths: InventoryPaths, gatewayServers: ServerSpec[]): McpInventory {
  const outcomes: Array<{ id: InventorySourceId; path: string; outcome: ReadOutcome }> = [
    { id: 'claude', path: paths.claude, outcome: readJsonSource(paths.claude) },
    { id: 'globalMcp', path: paths.globalMcp, outcome: readJsonSource(paths.globalMcp) },
    { id: 'codex', path: paths.codex, outcome: readCodexSource(paths.codex) },
    { id: 'gemini', path: paths.gemini, outcome: readJsonSource(paths.gemini) },
  ]

  const sources: InventorySource[] = outcomes.map(({ id, path, outcome }) => ({
    id,
    label: LABELS[id],
    path,
    status: outcome.status,
    ...(outcome.status === 'corrupt' ? { error: outcome.error } : {}),
  }))
  sources.push({ id: 'gateway', label: LABELS.gateway, path: 'gateway.json', status: 'ok' })

  const merged = new Map<string, InventoryServer>()
  const add = (raw: RawServer, source: InventorySourceId): void => {
    const safe = mask(raw)
    let entry = merged.get(safe.name)
    if (!entry) {
      entry = {
        name: safe.name,
        transport: safe.url && !safe.command ? 'http' : 'stdio',
        command: safe.command,
        args: safe.args,
        url: safe.url,
        sources: { claude: false, globalMcp: false, codex: false, gemini: false, gateway: false },
        drift: false,
      }
      merged.set(safe.name, entry)
    }
    entry.sources[source] = true
    entry.command ??= safe.command
    entry.args ??= safe.args
    entry.url ??= safe.url
  }

  for (const { id, outcome } of outcomes) {
    if (outcome.status === 'ok') for (const server of outcome.servers) add(server, id)
  }
  for (const spec of gatewayServers) {
    add({ name: spec.id, command: spec.command, args: spec.args, url: spec.url, env: spec.env }, 'gateway')
  }

  const servers = [...merged.values()]
  for (const server of servers) {
    const present = DRIFT_SOURCES.filter(id => server.sources[id]).length
    server.drift = present > 0 && present < DRIFT_SOURCES.length
  }
  servers.sort((a, b) => a.name.localeCompare(b.name))

  return { sources, servers }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/mcpInventory.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpInventory.ts tests/electron/mcpInventory.test.ts
git commit -m "feat(mcp): read-only cross-agent MCP inventory with secrets masked"
```

---

### Task 3: Fix two registration bugs found while surveying

**Files:**
- Modify: `src/main/agentMcpRegistry.ts:285-312` (`registerInGlobalMcp`), `:316-348` (`registerInCodex`)
- Modify: `src/main/index.ts:3691` (pass the runner)
- Test: `tests/electron/agentMcpRegistry.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `NodeSpec`, `toRunner` (already in the module).
- Produces: `registerInGlobalMcp(mcpJsonPath: string, adapterPath: string, node?: NodeSpec)` — a third optional parameter, so existing callers keep compiling.

- [ ] **Step 1: Write the failing tests**

```ts
it('registerInGlobalMcp writes the resolved runner, not a bare node', () => {
  const p = join(dir, '.mcp.json')
  registerInGlobalMcp(p, '/a/adapter.cjs', { command: '/usr/local/bin/node18' })
  expect(JSON.parse(readFileSync(p, 'utf-8')).mcpServers.termpolis.command).toBe('/usr/local/bin/node18')
})

it('registerInCodex writes atomically via a temp file', () => {
  const p = join(dir, 'config.toml')
  writeFileSync(p, '[other]\nx = 1\n')
  registerInCodex(p, '/a/adapter.cjs')
  const content = readFileSync(p, 'utf-8')
  expect(content).toContain('[other]')
  expect(content).toContain('[mcp_servers.termpolis]')
  expect(existsSync(p + '.tmp')).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/electron/agentMcpRegistry.test.ts`
Expected: FAIL — first asserts `'node'` received; second currently passes by luck but must be kept as a regression assertion once the write goes atomic.

- [ ] **Step 3: Implement**

In `registerInGlobalMcp`, take `node: NodeSpec = 'node'`, compute `const runner = toRunner(node)` and replace the hardcoded entry:

```ts
globalMcp.mcpServers.termpolis = { ...runner, args: [adapterPath] }
```

Add an atomic text writer beside `atomicWriteJson` and use it for both Codex write paths:

```ts
function atomicWriteText(path: string, content: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, path)
}
```

`registerInCodex` replaces `writeFileSync(codexTomlPath, content.replace(existing, entry), 'utf-8')` with `atomicWriteText(codexTomlPath, content.split(existing).join(entry))` — `split`/`join` also removes the latent `String.replace` special-pattern footgun where `$&` in `entry` would be substituted — and replaces the `appendFileSync` path with `atomicWriteText(codexTomlPath, content + '\n' + entry)`.

In `src/main/index.ts:3691`, pass the runner: `registerInGlobalMcp(globalMcpPath, adapterPath, nodeRunner)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/electron/agentMcpRegistry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentMcpRegistry.ts src/main/index.ts tests/electron/agentMcpRegistry.test.ts
git commit -m "fix(mcp): atomic Codex writes and honour the resolved node runner in ~/.mcp.json"
```

---

### Task 4: IPC, preload and types

**Files:**
- Modify: `src/main/index.ts` (handlers near the `tokenSavings:` block at `:3115`)
- Modify: `src/preload/index.ts` (inside `const api: TermpolisAPI`, which ends at `:259`)
- Modify: `src/renderer/src/types/index.ts` (DTOs above `TermpolisAPI` at `:276`; methods inside it)
- Test: `tests/electron/mcpInventoryIpc.test.ts`

**Interfaces:**
- Consumes: `buildInventory` (Task 2); `listGatewayServers`, `addGatewayServer`, `removeGatewayServer`, `getGatewayPolicy`, `setGatewayPolicy` from `./mcpGatewayRuntime`.
- Produces: `window.termpolis.mcpInventory()`, `.mcpGatewayServers()`, `.mcpGatewayAddServer(spec)`, `.mcpGatewayRemoveServer({ id })`, `.mcpGatewayPolicy()`, `.mcpGatewaySetPolicy(policy)` — each `Promise<IpcResponse<T>>`.

- [ ] **Step 1: Add the DTOs and interface methods**

In `src/renderer/src/types/index.ts`, above `TermpolisAPI`:

```ts
/** One MCP config file Termpolis can read. */
export interface McpSourceView {
  id: 'claude' | 'globalMcp' | 'codex' | 'gemini' | 'gateway'
  label: string
  path: string
  status: 'ok' | 'missing' | 'corrupt'
  error?: string
}

/** One MCP server, merged across sources. Secrets are already masked in main. */
export interface McpServerView {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  sources: Record<McpSourceView['id'], boolean>
  drift: boolean
}

export interface McpInventoryView {
  sources: McpSourceView[]
  servers: McpServerView[]
}

export interface McpGatewayServerView {
  id: string
  command?: string
  args?: string[]
  url?: string
}

export interface McpGatewayPolicyView {
  enabled: boolean
  defaultDecision: 'allow' | 'deny' | 'ask'
  strict: boolean
  rules: Array<{ server: string; tool: string; decision: 'allow' | 'deny' | 'ask' }>
}
```

Inside `TermpolisAPI`:

```ts
/** MCP: the cross-agent inventory (read-only) and the Termpolis gateway (editable). */
mcpInventory: () => Promise<IpcResponse<McpInventoryView>>
mcpGatewayServers: () => Promise<IpcResponse<McpGatewayServerView[]>>
mcpGatewayAddServer: (spec: McpGatewayServerView) => Promise<IpcResponse<McpGatewayServerView[]>>
mcpGatewayRemoveServer: (p: { id: string }) => Promise<IpcResponse<McpGatewayServerView[]>>
mcpGatewayPolicy: () => Promise<IpcResponse<McpGatewayPolicyView>>
mcpGatewaySetPolicy: (p: McpGatewayPolicyView) => Promise<IpcResponse<McpGatewayPolicyView>>
```

- [ ] **Step 2: Add the main handlers**

```ts
ipcMain.handle('mcp:inventory', () => {
  try {
    return ok(buildInventory({
      claude: join(homedir(), '.claude', 'settings.json'),
      globalMcp: join(homedir(), '.mcp.json'),
      codex: join(homedir(), '.codex', 'config.toml'),
      gemini: join(homedir(), '.gemini', 'settings.json'),
    }, listGatewayServers()))
  } catch (e: any) { return err(e.message) }
})
ipcMain.handle('mcp:gateway-servers', () => ok(listGatewayServers()))
ipcMain.handle('mcp:gateway-add-server', (_e, spec) => {
  if (!spec?.id) return err('A server id is required')
  addGatewayServer(spec)
  return ok(listGatewayServers())
})
ipcMain.handle('mcp:gateway-remove-server', (_e, p) => {
  removeGatewayServer(p?.id)
  return ok(listGatewayServers())
})
ipcMain.handle('mcp:gateway-policy', () => ok(getGatewayPolicy()))
ipcMain.handle('mcp:gateway-set-policy', (_e, p) => { setGatewayPolicy(p); return ok(getGatewayPolicy()) })
```

- [ ] **Step 3: Add the preload bridge**

```ts
mcpInventory: () => ipcRenderer.invoke('mcp:inventory'),
mcpGatewayServers: () => ipcRenderer.invoke('mcp:gateway-servers'),
mcpGatewayAddServer: (spec) => ipcRenderer.invoke('mcp:gateway-add-server', spec),
mcpGatewayRemoveServer: (p) => ipcRenderer.invoke('mcp:gateway-remove-server', p),
mcpGatewayPolicy: () => ipcRenderer.invoke('mcp:gateway-policy'),
mcpGatewaySetPolicy: (p) => ipcRenderer.invoke('mcp:gateway-set-policy', p),
```

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/main/index.ts src/preload/index.ts src/renderer/src/types/index.ts tests/electron/mcpInventoryIpc.test.ts
git commit -m "feat(mcp): mcp: IPC namespace for inventory and gateway management"
```

---

### Task 5: The Settings tab

**Files:**
- Create: `src/renderer/src/components/SettingsPane/McpServersSettings.tsx`
- Modify: `src/renderer/src/lib/settingsNav.ts:9` (add `'mcp'` to `SettingsTab`)
- Modify: `src/renderer/src/components/SettingsPane/SettingsPane.tsx` (import at `:6-13`; tab entry in the array at `:232-241`; render line near `:611`)
- Test: `tests/renderer/mcpServersSettings.test.tsx`

**Interfaces:**
- Consumes: the six `window.termpolis.mcp*` methods from Task 4.
- Produces: named export `McpServersSettings`.

Required `data-testid`s: `mcp-settings`, `mcp-refresh`, `mcp-gateway-empty`, `mcp-gateway-row-<id>`, `mcp-gateway-remove-<id>`, `mcp-add-id`, `mcp-add-command`, `mcp-add-submit`, `mcp-policy-enabled`, `mcp-policy-default`, `mcp-policy-strict`, `mcp-inventory-row-<name>`, `mcp-drift-<name>`, `mcp-source-<id>`, `mcp-error`.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { McpServersSettings } from '../../src/renderer/src/components/SettingsPane/McpServersSettings'

const ok = <T,>(data: T) => ({ success: true as const, data })
const fail = (error: string) => ({ success: false as const, error })

const inventory = {
  sources: [
    { id: 'claude', label: 'Claude Code', path: '/c', status: 'ok' },
    { id: 'gemini', label: 'Gemini', path: '/g', status: 'corrupt', error: 'bad json' },
  ],
  servers: [
    { name: 'github', transport: 'stdio', command: 'gh', sources: { claude: true, globalMcp: false, codex: false, gemini: false, gateway: false }, drift: true },
  ],
}

beforeEach(() => {
  ;(window as any).termpolis = {
    mcpInventory: vi.fn().mockResolvedValue(ok(inventory)),
    mcpGatewayServers: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }])),
    mcpGatewayAddServer: vi.fn().mockResolvedValue(ok([{ id: 'local', command: 'npx' }, { id: 'new', command: 'x' }])),
    mcpGatewayRemoveServer: vi.fn().mockResolvedValue(ok([])),
    mcpGatewayPolicy: vi.fn().mockResolvedValue(ok({ enabled: true, defaultDecision: 'ask', strict: false, rules: [] })),
    mcpGatewaySetPolicy: vi.fn().mockResolvedValue(ok({ enabled: false, defaultDecision: 'ask', strict: false, rules: [] })),
  }
})

describe('McpServersSettings', () => {
  it('renders the gateway list, the inventory and a corrupt source', async () => {
    render(<McpServersSettings />)
    await waitFor(() => expect(screen.getByTestId('mcp-gateway-row-local')).toBeInTheDocument())
    expect(screen.getByTestId('mcp-inventory-row-github')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-drift-github')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-source-gemini')).toHaveTextContent(/corrupt/i)
  })

  it('does not update the toggle when the policy write fails', async () => {
    ;(window as any).termpolis.mcpGatewaySetPolicy = vi.fn().mockResolvedValue(fail('nope'))
    render(<McpServersSettings />)
    await waitFor(() => expect(screen.getByTestId('mcp-policy-enabled')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('mcp-policy-enabled'))
    await waitFor(() => expect(screen.getByTestId('mcp-error')).toHaveTextContent('nope'))
    expect(screen.getByTestId('mcp-policy-enabled')).toHaveAttribute('aria-checked', 'true')
  })

  it('shows an error banner when every read fails', async () => {
    ;(window as any).termpolis.mcpInventory = vi.fn().mockResolvedValue(fail('no handler'))
    ;(window as any).termpolis.mcpGatewayServers = vi.fn().mockResolvedValue(fail('no handler'))
    ;(window as any).termpolis.mcpGatewayPolicy = vi.fn().mockResolvedValue(fail('no handler'))
    render(<McpServersSettings />)
    await waitFor(() => expect(screen.getByTestId('mcp-error')).toBeInTheDocument())
  })

  it('adds a gateway server and clears the form', async () => {
    render(<McpServersSettings />)
    await waitFor(() => expect(screen.getByTestId('mcp-add-id')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('mcp-add-id'), { target: { value: 'new' } })
    fireEvent.change(screen.getByTestId('mcp-add-command'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('mcp-add-submit'))
    await waitFor(() => expect(screen.getByTestId('mcp-gateway-row-new')).toBeInTheDocument())
    expect(screen.getByTestId('mcp-add-id')).toHaveValue('')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/renderer/mcpServersSettings.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Follow `RemoteSettings.tsx` shape: `useState(null)` per payload, one `refresh()` awaiting each call, `useEffect(() => { void refresh() }, [])`, an `apply()` helper funnelling envelopes into state or `setError`, no polling. Writes call IPC first and set state only from `res.data` (non-optimistic). Toggle markup copies the General-tab switch pattern with `role="switch"` and `aria-checked`. Palette: page `flex flex-col h-full p-6 gap-6 overflow-y-auto bg-[#1e1e1e]`, cards `p-3 border border-[#3c3c3c] rounded bg-[#252526]`, muted `text-[#9ca3af]`, error `text-[#f28b82]`, drift/warning `text-[#e5c07b]`, healthy dot `bg-[#7ee2a3]`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/renderer/mcpServersSettings.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the tab**

`settingsNav.ts:9` — add `| 'mcp'`. `SettingsPane.tsx` — `import { McpServersSettings } from './McpServersSettings'`, add `{ id: 'mcp', label: 'MCP Servers' }` after the `remote` entry, and `{activeTab === 'mcp' && <McpServersSettings />}` beside the other render lines.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/SettingsPane/McpServersSettings.tsx src/renderer/src/components/SettingsPane/SettingsPane.tsx src/renderer/src/lib/settingsNav.ts tests/renderer/mcpServersSettings.test.tsx
git commit -m "feat(mcp): MCP Servers settings tab"
```

---

### Task 6: Wire the gateway's approval prompt

**Files:**
- Modify: `src/main/mcpGatewayRuntime.ts:122-129`
- Test: `tests/electron/mcpGatewayRuntime.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `GatewayDeps['prompt']` — `(server: string, tool: string, findings: ArgFinding[]) => Promise<GateDecision>` (`mcpGateway/index.ts:44`).
- Produces: `setGatewayPrompt(fn: GatewayDeps['prompt'] | null): void`.

Why injected rather than importing `dialog` directly: `mcpGatewayRuntime` is unit-tested outside Electron, and `resolveAsk` fails closed when `prompt` throws — so an unconditional `import { dialog }` would turn every headless `ask` into a thrown import rather than a clean deny.

- [ ] **Step 1: Write the failing test**

```ts
it('denies an ask when no prompt is registered', async () => {
  setGatewayPrompt(null)
  setGatewayPolicy({ enabled: true, defaultDecision: 'ask', strict: false, rules: [] })
  const res: any = await gatewayCall({ tool: 'srv__thing' })
  expect(res.ok).toBe(false)
})

it('allows an ask when the registered prompt allows', async () => {
  const prompt = vi.fn().mockResolvedValue('allow')
  setGatewayPrompt(prompt)
  setGatewayPolicy({ enabled: true, defaultDecision: 'ask', strict: false, rules: [] })
  await gatewayCall({ tool: 'srv__thing' })
  expect(prompt).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/electron/mcpGatewayRuntime.test.ts`
Expected: FAIL — `setGatewayPrompt` is not exported.

- [ ] **Step 3: Implement**

```ts
let promptFn: GatewayDeps['prompt'] | null = null

/** Registered from index.ts once a window exists. Until then `ask` still denies,
 *  which is the documented fail-closed default for a headless run. */
export function setGatewayPrompt(fn: GatewayDeps['prompt'] | null): void {
  promptFn = fn
}
```

and in `createGateway({ ... })` replace the comment block with:

```ts
prompt: (server, tool, findings) =>
  promptFn ? promptFn(server, tool, findings) : Promise.resolve('deny' as const),
```

In `src/main/index.ts`, after the main window is created, register a `dialog.showMessageBox` implementation returning `'allow'` on button index 0 and `'deny'` otherwise, with the server, tool and any `findings` summarised in the message.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/electron/mcpGatewayRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpGatewayRuntime.ts src/main/index.ts tests/electron/mcpGatewayRuntime.test.ts
git commit -m "feat(mcp): wire the gateway approval prompt so 'ask' stops meaning deny"
```

---

### Task 7: e2e

**Files:**
- Create: `e2e/mcp-settings.spec.ts`

- [ ] **Step 1: Write the spec**

Copy `e2e/remote-settings.spec.ts` structure exactly: `test.describe.serial`, `execSync('npx electron-vite build')` in `beforeAll`, `electron.launch({ args: e2eLaunchArgs('mcp-settings'), env: { ...process.env, NODE_ENV: 'test' } })`, `await dismissOnboarding(page)`, `app.close()` in `afterAll`.

```ts
test('1. the MCP Servers tab opens and its inventory arrives', async () => {
  await page.locator('button[title="Settings"]').click()
  await expect(page.locator('[data-testid="settings-tabs"]')).toBeVisible()
  await page.locator('[data-testid="settings-tab-mcp"]').click()
  await expect(page.locator('[data-testid="mcp-settings"]')).toBeVisible()
  // Loading is a third render state with no Refresh button in it; waiting for the
  // button proves the inventory IPC round trip completed rather than hanging.
  await expect(page.locator('[data-testid="mcp-refresh"]')).toBeVisible({ timeout: 15000 })
})

test('2. a gateway server round-trips through main', async () => {
  await page.locator('[data-testid="mcp-add-id"]').fill('e2e-probe')
  await page.locator('[data-testid="mcp-add-command"]').fill('node')
  await page.locator('[data-testid="mcp-add-submit"]').click()
  await expect(page.locator('[data-testid="mcp-gateway-row-e2e-probe"]')).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="mcp-gateway-remove-e2e-probe"]').click()
  await expect(page.locator('[data-testid="mcp-gateway-row-e2e-probe"]')).toHaveCount(0)
})
```

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/mcp-settings.spec.ts`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add e2e/mcp-settings.spec.ts
git commit -m "test(mcp): e2e for the MCP Servers settings tab"
```

---

### Task 8: Gate and release

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run lint:strict && npm test`
Expected: all clean. Fix anything that is not.

- [ ] **Step 2: Coverage**

Run: `npm run test:coverage`
Expected: lines ≥ 97, functions ≥ 96, branches ≥ 95, statements ≥ 96. If a new file drags a number under, backfill tests on that file — never lower the gate.

- [ ] **Step 3: Bump**

```bash
npm version 1.41.0 --no-git-tag-version
```

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "v1.41.0: cross-agent MCP inventory and gateway management UI"
git push origin main
```

- [ ] **Step 5: Tag**

```bash
git tag v1.41.0
git push origin v1.41.0
```

The tag triggers `.github/workflows/release.yml`, draft-first since v1.39.0: `test → create-release → build → validate-draft → publish-release`. Nothing goes public until the draft validates.
