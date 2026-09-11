// mcpInventory.ts
//
// A read-only union of every MCP server the user has registered, across the four agent
// config files Termpolis already writes to plus Termpolis's own gateway.
//
// WHY THIS EXISTS: each agent CLI knows only its own config, so nobody can see the whole
// picture — a server registered in two of three agents, or one that silently stopped
// loading, is invisible until something breaks. Termpolis already touches all four files
// (index.ts:3680, 3689, 3786, 3794), so it is the one program positioned to show the union.
//
// NOTHING HERE WRITES. Registration stays in agentMcpRegistry.ts. This module only reads,
// which is what makes it safe to point at irreplaceable hand-edited files.
//
// SECRETS: these configs routinely carry credentials inline (`args: ["--token", "ghp_…"]`).
// Everything returned has been through `mask()`, so the renderer receives `••••` and never
// the plaintext — masking happens here, in main, not in the component.

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
  /** Keys as written; every value replaced with `MASK`. */
  env?: Record<string, string>
  /** Present-in map, keyed by source id. */
  sources: Record<InventorySourceId, boolean>
  /** In some agents but not all — see DRIFT_SOURCES. */
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

/** Drift is measured across the three AGENTS only. The gateway is Termpolis's own list
 *  and `~/.mcp.json` is a second Claude surface, so counting either would report drift on
 *  servers that are in fact consistent. */
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
      const env = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
        ? Object.fromEntries(
            Object.entries(entry.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined
      servers.push({
        name,
        command: typeof entry.command === 'string' ? entry.command : undefined,
        args: Array.isArray(entry.args)
          ? entry.args.filter((a): a is string => typeof a === 'string')
          : undefined,
        url: typeof entry.url === 'string' ? entry.url : undefined,
        env,
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

/** Args and url go through the gateway's own deep redactor; every env VALUE is replaced
 *  outright. Env is masked rather than scanned because an MCP `env` entry is
 *  credential-by-convention — a bespoke token format matches no scanner rule. */
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
        env: safe.env,
        sources: { claude: false, globalMcp: false, codex: false, gemini: false, gateway: false },
        drift: false,
      }
      merged.set(safe.name, entry)
    }
    entry.sources[source] = true
    // First source to describe a detail wins; later ones only fill gaps. A server the
    // user registered everywhere should read the same whichever config is listed first.
    entry.command ??= safe.command
    entry.args ??= safe.args
    entry.url ??= safe.url
    entry.env ??= safe.env
    if (entry.transport === 'stdio' && !entry.command && entry.url) entry.transport = 'http'
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
