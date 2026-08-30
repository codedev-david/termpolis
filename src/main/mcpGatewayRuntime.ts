// mcpGatewayRuntime.ts
//
// The stateful edge around the pure gateway: where the server list and the policy live
// on disk, and where the audit log is flushed.
//
// Kept apart from `mcpGateway/` deliberately. Everything in that directory is pure and
// exhaustively unit-tested; this file is the part that touches fs and process state and
// therefore the part that cannot be. Keeping the boundary sharp is what lets the
// interesting logic — decide/scan/redact/audit — be tested without a filesystem.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { createGateway, defaultPolicy, type GatewayPolicy, type Transport } from './mcpGateway'
import { transportFor, type ServerSpec } from './mcpGateway/client'
import { setGatewayAuditSink, type GatewayAuditEntry } from './mcpGateway/audit'
import { scanText } from './aiSecurity'

interface GatewayConfig {
  policy: GatewayPolicy
  servers: ServerSpec[]
}

let dir: string | null = null
let config: GatewayConfig = { policy: defaultPolicy(), servers: [] }
const transports = new Map<string, Transport>()

function configPath(): string {
  return join(dir as string, 'gateway.json')
}

export function initMcpGateway(userDataPath: string): void {
  if (!userDataPath || typeof userDataPath !== 'string') throw new Error('initMcpGateway: userDataPath required')
  dir = join(userDataPath, 'gateway')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* the gateway degrades to in-memory rather than failing app startup */
  }
  // Reset first. `init` means "this userData path is now the state", so pointing the
  // gateway at a path with no config must yield the closed default — not whatever
  // allow-list happened to be in memory from a previous path.
  config = { policy: defaultPolicy(), servers: [] }
  try {
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<GatewayConfig>
      config = {
        policy: { ...defaultPolicy(), ...(parsed.policy ?? {}) },
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      }
    }
  } catch {
    // A corrupt config must fail SAFE, not open: keep the default policy (ask) and no
    // servers, rather than inheriting a half-parsed allow-list.
    config = { policy: defaultPolicy(), servers: [] }
  }

  setGatewayAuditSink((entry: GatewayAuditEntry) => {
    try {
      appendFileSync(join(dir as string, 'gateway-audit.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* best effort — see recordGatewayCall */
    }
  })
}

function persist(): void {
  if (!dir) return
  try {
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
  } catch {
    /* best effort */
  }
}

export function getGatewayPolicy(): GatewayPolicy {
  return config.policy
}

export function setGatewayPolicy(policy: GatewayPolicy): void {
  config.policy = policy
  persist()
}

export function listGatewayServers(): ServerSpec[] {
  return [...config.servers]
}

export function addGatewayServer(spec: ServerSpec): void {
  config.servers = [...config.servers.filter(s => s.id !== spec.id), spec]
  transports.delete(spec.id)
  persist()
}

export function removeGatewayServer(id: string): void {
  config.servers = config.servers.filter(s => s.id !== id)
  const existing = transports.get(id) as (Transport & { dispose?: () => void }) | undefined
  try {
    existing?.dispose?.()
  } catch {
    /* best effort */
  }
  transports.delete(id)
  persist()
}

/** Transports are memoised: stdio servers hold a live child process that must be reused
 *  across calls (MCP servers expect `initialize` once), and re-spawning per call would
 *  be both slow and protocol-wrong. */
function liveTransports(): Transport[] {
  const out: Transport[] = []
  for (const spec of config.servers) {
    let transport = transports.get(spec.id)
    if (!transport) {
      transport = transportFor(spec)
      transports.set(spec.id, transport)
    }
    out.push(transport)
  }
  return out
}

const gateway = createGateway({
  getPolicy: () => config.policy,
  transports: liveTransports,
  scanSecrets: scanText,
  // No `prompt` wired yet: with none, `resolveAsk` denies. That is the correct default
  // for the first release — the gateway starts closed and the user opens it explicitly
  // through settings, rather than a dialog appearing the first time some agent probes
  // an upstream server.
})

export async function gatewayListTools(): Promise<unknown> {
  return await gateway.listTools()
}

export async function gatewayCall(opts: { tool: string; arguments?: unknown }): Promise<unknown> {
  const result = await gateway.callTool(opts.tool, opts.arguments ?? {})
  return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error }
}

export function disposeGateway(): void {
  for (const [, transport] of transports) {
    try {
      ;(transport as Transport & { dispose?: () => void }).dispose?.()
    } catch {
      /* best effort */
    }
  }
  transports.clear()
}
