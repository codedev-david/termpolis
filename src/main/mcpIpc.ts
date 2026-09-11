/**
 * The `mcp:` IPC surface — the human-facing half of the MCP gateway.
 *
 * Kept out of `index.ts` for the reason `ipcResult.ts` exists: a module that
 * registers its own channels should be testable without importing the 3,700-line
 * main entry. Every handler here is exercised by `tests/electron/mcpIpc.test.ts`
 * against a fake `ipc`, with no Electron in the process.
 *
 * Two invariants this file is responsible for:
 *
 * 1. SECRETS NEVER CROSS THE BRIDGE. Foreign MCP configs routinely carry
 *    credentials inline (`args: ["--token", "ghp_..."]`, `env: { API_KEY: ... }`).
 *    Enumerating them means reading secrets, so masking happens HERE, at the IPC
 *    boundary, not in the component. `mcpInventory` already masks what it reads;
 *    the gateway's own server list is masked on the way out by `maskSpec`.
 * 2. HEALTH IS PROBE-ON-DEMAND. `liveTransports()` in mcpGatewayRuntime memoises
 *    stdio transports as live child processes, so anything that touches a
 *    transport spawns a real server. `mcp:gateway-test` therefore builds a
 *    THROWAWAY transport, uses it once, and disposes it — it never reaches into
 *    the runtime's memoised set, and nothing here probes on a timer.
 */

import { homedir } from 'os'
import { join } from 'path'
import { ok, err } from './ipcResult'
import { buildInventory, type InventoryPaths } from './mcpInventory'
import { transportFor, type ServerSpec } from './mcpGateway/client'
import type { Transport } from './mcpGateway'
import { defaultPolicy, type GatewayPolicy, type GateDecision, type ToolRule } from './mcpGateway/policy'
import {
  getGatewayPolicy,
  setGatewayPolicy,
  listGatewayServers,
  addGatewayServer,
  removeGatewayServer,
} from './mcpGatewayRuntime'

export interface McpIpcLike {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void
}

const MASK = '••••'

/** The four foreign configs Termpolis already writes to. Resolved at call time, not at
 *  import time, so a test can point HOME elsewhere and so a user who creates
 *  `~/.codex/config.toml` mid-session sees it on the next Refresh. */
export function defaultInventoryPaths(home: string = homedir()): InventoryPaths {
  return {
    claude: join(home, '.claude', 'settings.json'),
    globalMcp: join(home, '.mcp.json'),
    codex: join(home, '.codex', 'config.toml'),
    gemini: join(home, '.gemini', 'settings.json'),
  }
}

/** Env values are replaced wholesale rather than scanned: a gateway `env` entry exists to
 *  carry a credential, so "it did not match a known secret pattern" is not a reason to
 *  ship it to the renderer. Keys survive so the panel can say what a server expects. */
export function maskSpec(spec: ServerSpec): ServerSpec {
  const out: ServerSpec = { id: spec.id }
  if (spec.command !== undefined) out.command = spec.command
  if (spec.args !== undefined) out.args = [...spec.args]
  if (spec.url !== undefined) out.url = spec.url
  if (spec.env) {
    out.env = {}
    for (const key of Object.keys(spec.env)) out.env[key] = MASK
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const DECISIONS: GateDecision[] = ['allow', 'deny', 'ask']

function isDecision(v: unknown): v is GateDecision {
  return typeof v === 'string' && (DECISIONS as string[]).includes(v)
}

/**
 * Coerce a renderer-supplied policy into a valid one.
 *
 * The renderer is not a trust boundary the way a network peer is, but it is the one
 * input to this subsystem that a bug can corrupt silently and PERSIST — `setGatewayPolicy`
 * writes to disk, and a policy with a junk `defaultDecision` would be read back on every
 * boot. An unrecognised decision falls back to the closed default rather than being
 * stored, so a malformed write can never leave the gateway open.
 */
export function sanitizePolicy(input: unknown): GatewayPolicy {
  const base = defaultPolicy()
  if (!isRecord(input)) return base
  const rules: ToolRule[] = []
  if (Array.isArray(input.rules)) {
    for (const raw of input.rules) {
      if (!isRecord(raw)) continue
      const { server, tool, decision } = raw
      if (typeof server !== 'string' || typeof tool !== 'string' || !isDecision(decision)) continue
      rules.push({ server, tool, decision })
    }
  }
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    defaultDecision: isDecision(input.defaultDecision) ? input.defaultDecision : base.defaultDecision,
    strict: typeof input.strict === 'boolean' ? input.strict : base.strict,
    rules,
  }
}

/** A spec is only usable if it names exactly one transport. Rejecting here keeps an
 *  unreachable server out of the persisted list entirely, rather than letting it fail on
 *  every call forever with no indication of why. */
export function parseSpec(input: unknown): { spec: ServerSpec } | { error: string } {
  if (!isRecord(input)) return { error: 'A server definition is required' }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) return { error: 'Server id is required' }

  const command = typeof input.command === 'string' && input.command.trim() ? input.command.trim() : undefined
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined
  if (command && url) return { error: 'Give either a command or a URL, not both' }
  if (!command && !url) return { error: 'A command (stdio) or a URL (http) is required' }

  const spec: ServerSpec = { id }
  if (command) {
    spec.command = command
    if (Array.isArray(input.args)) spec.args = input.args.filter((a): a is string => typeof a === 'string')
  }
  if (url) spec.url = url
  if (isRecord(input.env)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.env)) if (typeof v === 'string') env[k] = v
    if (Object.keys(env).length > 0) spec.env = env
  }
  return { spec }
}

export interface GatewayTestResult {
  ok: boolean
  tools?: number
  error?: string
}

/**
 * Connect to one server, count its tools, disconnect.
 *
 * Uses the spec that is ALREADY PERSISTED, looked up by id, rather than a spec from the
 * renderer — the renderer's copy has its env masked, so testing that would probe a server
 * with `API_KEY=••••` and report a misleading auth failure.
 */
export async function testServer(
  id: string,
  servers: ServerSpec[] = listGatewayServers(),
  make: (spec: ServerSpec) => Transport = transportFor,
): Promise<GatewayTestResult> {
  const spec = servers.find(s => s.id === id)
  if (!spec) return { ok: false, error: `No such server: ${id}` }
  let transport: Transport | null = null
  try {
    transport = make(spec)
    const tools = await transport.listTools()
    return { ok: true, tools: tools.length }
  } catch (e: any) {
    return { ok: false, error: e?.message ? String(e.message) : String(e) }
  } finally {
    try {
      ;(transport as unknown as { dispose?: () => void } | null)?.dispose?.()
    } catch {
      /* the probe already has its answer; a failed teardown must not overwrite it */
    }
  }
}

/**
 * Register the `mcp:` channels.
 *
 * Reads are total: a broken config is a status on one row, never a rejected call, because
 * the panel that would explain the breakage is the same panel that fails to render.
 */
export function registerMcpIpc(ipc: McpIpcLike, paths: () => InventoryPaths = defaultInventoryPaths): void {
  ipc.handle('mcp:inventory', () => {
    try {
      return ok(buildInventory(paths(), listGatewayServers()))
    } catch (e: any) {
      return err(e?.message ? String(e.message) : String(e))
    }
  })

  ipc.handle('mcp:gateway-servers', () => ok(listGatewayServers().map(maskSpec)))

  ipc.handle('mcp:gateway-add-server', (_e, input) => {
    const parsed = parseSpec(isRecord(input) ? input.spec : undefined)
    if ('error' in parsed) return err(parsed.error)
    try {
      addGatewayServer(parsed.spec)
    } catch (e: any) {
      return err(e?.message ? String(e.message) : String(e))
    }
    // Answer with the list as it now stands, so the panel renders what was persisted
    // rather than what it hoped would be persisted.
    return ok(listGatewayServers().map(maskSpec))
  })

  ipc.handle('mcp:gateway-remove-server', (_e, input) => {
    const id = isRecord(input) && typeof input.id === 'string' ? input.id : ''
    if (!id) return err('Server id is required')
    try {
      removeGatewayServer(id)
    } catch (e: any) {
      return err(e?.message ? String(e.message) : String(e))
    }
    return ok(listGatewayServers().map(maskSpec))
  })

  ipc.handle('mcp:gateway-policy', () => ok(getGatewayPolicy()))

  ipc.handle('mcp:gateway-set-policy', (_e, input) => {
    const policy = sanitizePolicy(isRecord(input) ? input.policy : undefined)
    try {
      setGatewayPolicy(policy)
    } catch (e: any) {
      return err(e?.message ? String(e.message) : String(e))
    }
    return ok(getGatewayPolicy())
  })

  ipc.handle('mcp:gateway-test', async (_e, input) => {
    const id = isRecord(input) && typeof input.id === 'string' ? input.id : ''
    if (!id) return err('Server id is required')
    return ok(await testServer(id))
  })
}
