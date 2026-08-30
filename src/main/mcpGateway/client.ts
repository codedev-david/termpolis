// mcpGateway/client.ts
//
// A minimal MCP client: enough JSON-RPC to enumerate an upstream server's tools and
// call one. Deliberately not a dependency — the MCP SDK would pull a transport stack
// into the main process for two request shapes this app already knows how to frame,
// and the app's own MCP *server* is hand-rolled for the same reason.
//
// Everything I/O-bound lives here so `index.ts` stays pure and exhaustively testable.
// The framing helpers are exported separately from the process/socket plumbing for
// exactly that reason: the parts that can be tested without a child process are.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { Transport, UpstreamTool } from './index'

export interface ServerSpec {
  id: string
  /** stdio: command + args. http: url. Exactly one shape is used. */
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

/** How long any single upstream request may take. An MCP server that hangs would
 *  otherwise hang the agent that called it, with no way for the user to tell which
 *  of the two is stuck. */
export const UPSTREAM_TIMEOUT_MS = 30_000

let nextId = 1
export function nextRequestId(): number {
  return nextId++
}

/** Reset the id counter. Tests only — ids are otherwise process-lifetime. */
export function resetRequestIds(): void {
  nextId = 1
}

export function frameRequest(method: string, params: unknown, id: number): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

/** Pull complete newline-delimited JSON objects out of a stdio buffer, returning the
 *  parsed messages and whatever partial tail is left. Line-delimited rather than
 *  Content-Length framed: every MCP stdio server in the wild emits NDJSON, and a
 *  partial read must never be parsed as a truncated object. */
export function drainMessages(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = []
  let rest = buffer
  for (;;) {
    const at = rest.indexOf('\n')
    if (at < 0) break
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (!line) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      /* a non-JSON line is a server logging to stdout; skip it rather than fail the
         whole drain, which would strand every later response in the same chunk */
    }
  }
  return { messages, rest }
}

/** Normalise an MCP `tools/list` result. Servers vary in whether they wrap the array. */
export function parseToolList(result: unknown): UpstreamTool[] {
  const tools = (result as { tools?: unknown })?.tools
  if (!Array.isArray(tools)) return []
  const out: UpstreamTool[] = []
  for (const entry of tools as Record<string, unknown>[]) {
    if (typeof entry?.name !== 'string') continue
    out.push({
      name: entry.name,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      inputSchema: entry.inputSchema,
    })
  }
  return out
}

/** Flatten an MCP `tools/call` result to text. The content array is the standard
 *  shape; anything else is stringified rather than dropped, because an unrecognised
 *  result the model cannot see is indistinguishable from a silent failure. */
export function parseToolResult(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : JSON.stringify(part)))
      .join('\n')
  }
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

/** An HTTP transport. Streamable-HTTP MCP servers accept a POSTed JSON-RPC body and
 *  answer with one JSON object, which is all the gateway needs. */
export function httpTransport(spec: ServerSpec, fetchImpl: typeof fetch = fetch): Transport {
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const res = await fetchImpl(spec.url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: frameRequest(method, params, nextRequestId()),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`)
      const body = await res.json() as { result?: unknown; error?: { message?: string } }
      if (body.error) throw new Error(body.error.message ?? 'upstream error')
      return body.result
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    id: spec.id,
    listTools: async () => parseToolList(await call('tools/list', {})),
    callTool: async (tool, args) => parseToolResult(await call('tools/call', { name: tool, arguments: args })),
  }
}

/** A stdio transport over a long-lived child process.
 *
 *  The child is spawned lazily on first use and reused: MCP servers are stateful
 *  (they expect `initialize` once), so a per-call process would both be slow and
 *  wrong. A dead child is dropped so the next call respawns rather than writing into
 *  a closed pipe. */
export function stdioTransport(
  spec: ServerSpec,
  spawnImpl: typeof spawn = spawn,
): Transport & { dispose: () => void } {
  let child: ChildProcessWithoutNullStreams | null = null
  let buffer = ''
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const settleAll = (err: Error): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  const ensure = (): ChildProcessWithoutNullStreams => {
    if (child && !child.killed && child.exitCode === null) return child
    buffer = ''
    const proc = spawnImpl(spec.command as string, spec.args ?? [], {
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const { messages, rest } = drainMessages(buffer)
      buffer = rest
      for (const msg of messages) {
        const { id, result, error } = msg as { id?: number; result?: unknown; error?: { message?: string } }
        if (typeof id !== 'number') continue
        const waiter = pending.get(id)
        if (!waiter) continue
        pending.delete(id)
        clearTimeout(waiter.timer)
        if (error) waiter.reject(new Error(error.message ?? 'upstream error'))
        else waiter.resolve(result)
      }
    })
    // stderr is drained but not surfaced: MCP servers log freely there, and letting
    // the pipe fill would deadlock the child.
    proc.stderr.resume()
    proc.on('exit', () => settleAll(new Error(`MCP server "${spec.id}" exited`)))
    proc.on('error', err => settleAll(err instanceof Error ? err : new Error(String(err))))
    child = proc
    return proc
  }

  const call = (method: string, params: unknown): Promise<unknown> => {
    const proc = ensure()
    const id = nextRequestId()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP server "${spec.id}" timed out after ${UPSTREAM_TIMEOUT_MS}ms`))
      }, UPSTREAM_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      try {
        proc.stdin.write(frameRequest(method, params, id))
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  return {
    id: spec.id,
    listTools: async () => parseToolList(await call('tools/list', {})),
    callTool: async (tool, args) => parseToolResult(await call('tools/call', { name: tool, arguments: args })),
    dispose: () => {
      settleAll(new Error('disposed'))
      try {
        child?.kill()
      } catch {
        /* best effort */
      }
      child = null
    },
  }
}

export function transportFor(spec: ServerSpec): Transport {
  return spec.url ? httpTransport(spec) : stdioTransport(spec)
}
