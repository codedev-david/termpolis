/**
 * stdio-adapter.cjs Contract Test
 * --------------------------------
 * The adapter is spawned as a subprocess by Claude Code. It reads:
 *   - `mcp-token` and `mcp-port` from the user's app-data dir
 *   - JSON-RPC messages from stdin
 * ...and proxies each request to Termpolis's HTTP MCP server at 127.0.0.1.
 *
 * If any of these contracts drift — e.g., the app starts writing to a
 * different directory, or the adapter stops sending the Authorization
 * header — the swarm conductor silently fails. There is NO runtime
 * error message visible to users.
 *
 * These are cheap regex-based invariants that guard against that drift.
 * They are intentionally loose (no mocked stdin/http test) — the goal
 * is "catch someone deleting half the adapter by accident", not
 * end-to-end verification. End-to-end is covered by the full-pipeline
 * swarm E2E and mcp-registration.spec.ts.
 *
 * The one exception is the nested-delegation block at the bottom, which
 * drives the real adapter against a stand-in app: what it guards is a
 * request that must never leave the adapter, and only traffic shows that.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { spawn } from 'child_process'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import type { AddressInfo } from 'net'

const REPO_ROOT = resolve(__dirname, '..', '..')
const ADAPTER = resolve(REPO_ROOT, 'src/mcp-adapter/stdio-adapter.cjs')

describe('stdio-adapter.cjs — runtime contract', () => {
  const src = existsSync(ADAPTER) ? readFileSync(ADAPTER, 'utf-8') : ''

  it('file exists (the whole thing is moot otherwise)', () => {
    expect(existsSync(ADAPTER)).toBe(true)
    expect(src.length).toBeGreaterThan(0)
  })

  it('has a node shebang so it can be spawned directly by Claude Code', () => {
    // Not strictly required (since we launch via `node <file>` in MCP config)
    // but the shebang future-proofs direct-execution setups.
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('reads the mcp-token file (auth)', () => {
    expect(src).toContain("'mcp-token'")
  })

  it('reads the mcp-port file (dynamic port)', () => {
    expect(src).toContain("'mcp-port'")
  })

  it('resolves the app-data dir through the shared dataDir.cjs (not a private copy)', () => {
    // The per-platform logic used to be inlined here and in three other adapters, and they drifted
    // (capital-T on Linux, missing XDG). It lives in ONE place now; the adapter must require it.
    expect(src).toMatch(/require\(['"]\.\/dataDir\.cjs['"]\)/)
    expect(src).toContain('termpolisDataDir')
  })

  it('the shared dataDir.cjs matches main/index.ts writers on every platform', () => {
    const shared = readFileSync(resolve(REPO_ROOT, 'src/mcp-adapter/dataDir.cjs'), 'utf-8')
    expect(shared).toMatch(/APPDATA/)                 // Windows
    expect(shared).toMatch(/['"]termpolis['"]/)       // lowercase name (app.setName('termpolis'))
    expect(shared).not.toMatch(/['"]Termpolis['"]/)   // never the capital-T that broke Linux
    expect(shared).toMatch(/Application Support/)      // macOS
    expect(shared).toMatch(/XDG_CONFIG_HOME/)          // Linux honours XDG — the zero-tools bug
    expect(shared).toMatch(/\.config/)
  })

  it('POSTs to 127.0.0.1 on the /mcp endpoint', () => {
    // Regressions we want to catch: hard-coded "localhost" (fine) but
    // also hard-coded :9315 with no fallback read from the port file.
    expect(src).toMatch(/127\.0\.0\.1/)
    expect(src).toMatch(/['"]\/mcp['"]/)
  })

  it('sends Authorization: Bearer <token> — server rejects requests without it', () => {
    expect(src).toMatch(/Authorization[^\n]*Bearer/i)
  })

  it('writes JSON responses to stdout (newline-delimited JSON-RPC)', () => {
    // Must write to stdout; stderr would be ignored by Claude Code.
    expect(src).toMatch(/process\.stdout\.write/)
    // Must emit '\n' so Claude Code's line reader terminates each message.
    expect(src).toMatch(/\\n/)
  })

  it('silently consumes MCP notifications (no id) — forwarding them confuses the server', () => {
    // The adapter must NOT forward `notifications/*` or `initialized` to
    // the server; they are client→adapter fire-and-forget. Forwarding
    // them causes the server to reply, which then confuses Claude Code.
    expect(src).toMatch(/notifications\//)
    expect(src).toMatch(/initialized/)
  })

  it('returns a JSON-RPC error response on failure (so Claude Code sees an error, not a hang)', () => {
    expect(src).toMatch(/jsonrpc.*2\.0/)
    expect(src).toMatch(/-32603/) // JSON-RPC internal error code
  })

  it('performs a startup health check so humans can see "adapter connected" on stderr', () => {
    expect(src).toMatch(/\/health/)
  })
})

// -----------------------------------------------------------------------
// Degraded mode (issue #8 follow-up): when Termpolis isn't running, the
// adapter must stay alive and respond to MCP handshake messages so the
// host agent (Gemini CLI / Codex / etc.) doesn't surface a hard
// "MCP server crashed" error. Tool calls return a friendly JSON-RPC error
// directing the user to start Termpolis.
// -----------------------------------------------------------------------
describe('stdio-adapter.cjs — degraded-mode behavior', () => {
  const src = readFileSync(ADAPTER, 'utf-8')

  it('does NOT process.exit when the token file is missing (used to crash Gemini)', () => {
    // Regression guard: prior version called process.exit(1) inside the
    // catch block of findToken. That made `gemini` show a hard
    // MCP-server-failed error and blocked all CLI use when Termpolis
    // wasn't running.
    const findTokenSection = src.slice(src.indexOf('function findToken'), src.indexOf('const TOKEN'))
    expect(findTokenSection).not.toMatch(/process\.exit/)
  })

  it('returns a stub initialize result so the agent treats the server as healthy', () => {
    // Required so the host doesn't bail out on initialize when the
    // server is offline. Empty tools list is fine — the agent simply
    // sees no Termpolis tools.
    expect(src).toMatch(/initialize/)
    expect(src).toMatch(/protocolVersion/)
    expect(src).toMatch(/capabilities/)
    expect(src).toMatch(/serverInfo/)
  })

  it('returns empty tools/resources/prompts lists in degraded mode', () => {
    // tools/list must return { tools: [] } so the agent doesn't try to
    // invoke any Termpolis tools while the server is offline.
    expect(src).toMatch(/tools\/list/)
    expect(src).toMatch(/resources\/list/)
    expect(src).toMatch(/prompts\/list/)
  })

  it('returns a friendly error pointing at Termpolis on any other request', () => {
    // The error message has to mention Termpolis so the user knows
    // what to do — generic "internal error" leaves them stuck.
    expect(src).toMatch(/Termpolis is not running/i)
  })

  it('flips into degraded mode on ECONNREFUSED rather than letting every call hang', () => {
    // Once a real connection fails, subsequent requests should short-
    // circuit through handleLocally instead of paying the full network
    // timeout each time.
    expect(src).toMatch(/ECONNREFUSED/)
    expect(src).toMatch(/SERVER_ONLINE\s*=\s*false/)
  })
})

describe('stdio-adapter.cjs — packaging invariants', () => {
  it('is a .cjs file (CommonJS) — .mjs/.js would break under Electron asarUnpack', () => {
    expect(ADAPTER.endsWith('.cjs')).toBe(true)
  })

  it('does not import from node_modules — it must be self-contained in the installer', () => {
    const src = readFileSync(ADAPTER, 'utf-8')
    // Only core Node modules allowed. Anything else would not be shipped
    // by extraResources and would blow up at runtime.
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    const nonCore = requires.filter((r) => {
      // Relative paths are fine — they go through extraResources
      if (r.startsWith('.') || r.startsWith('/')) return false
      // Core modules have no slash and are known
      const core = new Set([
        'fs',
        'path',
        'os',
        'http',
        'https',
        'net',
        'readline',
        'stream',
        'events',
        'url',
        'util',
        'crypto',
        'child_process',
      ])
      return !core.has(r)
    })
    expect(nonCore, `adapter imports non-core modules: ${nonCore.join(', ')}`).toEqual([])
  })
})

// -----------------------------------------------------------------------
// Nested delegation (linked machines, spec §4.5 rule 2 and §8). An agent a
// linked machine started runs with TERMPOLIS_LINKED_JOB set, and must not
// hand the work on to yet another machine. The adapter answers that call
// itself, so the refusal holds even where the agent's Termpolis MCP could
// not be switched off for the run.
// -----------------------------------------------------------------------

const NESTED = 'Nested delegation is not allowed: this agent was itself started by a linked machine.'

interface Rpc {
  jsonrpc: string
  id: unknown
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean }
  error?: { message: string }
}

/** Where dataDir.cjs looks for mcp-token and mcp-port once HOME, APPDATA and XDG_CONFIG_HOME all
 *  point at `root`. */
function dataDirUnder(root: string): string {
  return process.platform === 'darwin'
    ? join(root, 'Library', 'Application Support', 'termpolis')
    : join(root, 'termpolis') // APPDATA on Windows, XDG_CONFIG_HOME elsewhere
}

/** A stand-in for the app: healthy, and it records the tool name of every call forwarded to it. */
async function standInApp(): Promise<{ port: number; forwarded: string[]; close: () => Promise<void> }> {
  const forwarded: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.method === 'GET') {
        res.end('{"status":"ok"}')
        return
      }
      const rpc = JSON.parse(body)
      forwarded.push(rpc.params?.name ?? rpc.method)
      if (rpc.method === 'tools/list') {
        const tools = ['memory_search', 'run_command', 'linked_machines', 'code_explore', 'memory_write'].map((name) => ({ name }))
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }))
        return
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'answered by the app' }] } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as AddressInfo).port,
    forwarded,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** Runs the real adapter, sends each request, and returns the replies once there is one for every
 *  id. With a `port` the adapter is connected to the app there; with null it finds no token and
 *  runs degraded, as it does when Termpolis is not running. It has exited by the time this returns. */
async function runAdapter(
  port: number | null,
  extraEnv: Record<string, string>,
  requests: Array<{ id: number; method: string; params?: object }>,
): Promise<Rpc[]> {
  const root = mkdtempSync(join(tmpdir(), 'termpolis-adapter-linked-'))
  if (port !== null) {
    const dir = dataDirUnder(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp-token'), 'stand-in-token')
    writeFileSync(join(dir, 'mcp-port'), String(port))
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, XDG_CONFIG_HOME: root }
  delete env.TERMPOLIS_LINKED_JOB // the shell running the tests must not decide the outcome
  delete env.TERMPOLIS_READ_ONLY_RUN
  const child = spawn(process.execPath, [ADAPTER], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<void>((r) => child.on('exit', () => r()))
  let stdout = ''
  let stderr = '' // read so the pipe never fills, and shown if the adapter goes quiet
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  // Complete lines only: the last segment is either empty or a reply still arriving.
  const replies = (): Rpc[] => stdout.split('\n').slice(0, -1).filter((l) => l.trim()).map((l) => JSON.parse(l) as Rpc)
  try {
    await new Promise<void>((answered, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the adapter did not answer every request. stdout: ${stdout} stderr: ${stderr}`)),
        10_000,
      )
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const ids = replies().map((r) => r.id)
        if (requests.every((q) => ids.includes(q.id))) {
          clearTimeout(timer)
          answered()
        }
      })
      for (const q of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...q }) + '\n')
    })
    return replies()
  } finally {
    child.stdin.end() // readline 'close' exits the adapter
    const killer = setTimeout(() => child.kill(), 5_000)
    await exited
    clearTimeout(killer)
    rmSync(root, { recursive: true, force: true })
  }
}

describe('stdio-adapter.cjs — nested delegation (linked machines)', () => {
  const linkedRun = { name: 'linked_machines', arguments: { action: 'run', machine: 'laptop', agent: 'codex', prompt: 'review it' } }

  it('answers linked_machines itself inside a linked job, forwards the read-only toolset and refuses the rest', async () => {
    const app = await standInApp()
    try {
      const replies = await runAdapter(app.port, { TERMPOLIS_LINKED_JOB: '0123456789ab' }, [
        { id: 7, method: 'tools/call', params: linkedRun },
        { id: 8, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } },
        { id: 12, method: 'tools/call', params: { name: 'list_terminals', arguments: {} } },
      ])
      // A tool result marked isError, not a JSON-RPC error: the agent reads the reason as the
      // answer to its call instead of treating the server as broken.
      expect(replies.find((r) => r.id === 7)).toEqual({
        jsonrpc: '2.0',
        id: 7,
        result: { content: [{ type: 'text', text: NESTED }], isError: true },
      })
      expect(replies.find((r) => r.id === 8)?.result?.content[0].text).toBe('answered by the app')
      // Terminals are out of a delegated job's reach: refused here, never forwarded.
      expect(replies.find((r) => r.id === 12)?.result).toEqual({
        content: [{ type: 'text', text: expect.stringMatching(/^list_terminals is not available to a job another linked machine started/) }],
        isError: true,
      })
      // The app saw only the allowed call, so the adapter was connected and nothing else left it.
      expect(app.forwarded).toEqual(['memory_search'])
    } finally {
      await app.close()
    }
  })

  it('forwards linked_machines to the app for an agent the user started', async () => {
    const app = await standInApp()
    try {
      const replies = await runAdapter(app.port, {}, [{ id: 9, method: 'tools/call', params: linkedRun }])
      expect(replies.find((r) => r.id === 9)?.result?.content[0].text).toBe('answered by the app')
      expect(app.forwarded).toEqual(['linked_machines'])
    } finally {
      await app.close()
    }
  })

  it('gives the same refusal inside a linked job when Termpolis is not running', async () => {
    // The refusal does not depend on the app, so it comes first: an agent should not be told to
    // start Termpolis for a call it would then refuse anyway.
    const replies = await runAdapter(null, { TERMPOLIS_LINKED_JOB: '0123456789ab' }, [
      { id: 10, method: 'tools/call', params: linkedRun },
      { id: 11, method: 'tools/call', params: { name: 'memory_search', arguments: {} } },
      { id: 13, method: 'tools/call', params: { name: 'run_command', arguments: {} } },
    ])
    expect(replies.find((r) => r.id === 10)?.result).toEqual({ content: [{ type: 'text', text: NESTED }], isError: true })
    expect(replies.find((r) => r.id === 11)?.error?.message).toMatch(/Termpolis is not running/)
    expect(replies.find((r) => r.id === 13)?.result?.isError).toBe(true)
  })

  it('refuses only a linked_machines call, only inside a linked job, and treats an empty marker as set', () => {
    const { nestedDelegationRefusal } = createRequire(import.meta.url)(ADAPTER) as {
      nestedDelegationRefusal: (request: unknown, env: Record<string, string | undefined>) => Rpc | null
    }
    const call = (name: string, id?: number): object =>
      ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method: 'tools/call', params: { name, arguments: {} } })
    const inJob = { TERMPOLIS_LINKED_JOB: '0123456789ab' }

    expect(nestedDelegationRefusal(call('linked_machines', 3), inJob)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: NESTED }], isError: true },
    })
    expect(nestedDelegationRefusal(call('linked_machines', 3), {})).toBeNull()
    // Present is enough: a security check that an empty value switches off fails open.
    expect(nestedDelegationRefusal(call('linked_machines', 3), { TERMPOLIS_LINKED_JOB: '' })?.result?.isError).toBe(true)
    expect(nestedDelegationRefusal(call('memory_search', 3), inJob)).toBeNull()
    expect(nestedDelegationRefusal({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, inJob)).toBeNull()
    expect(nestedDelegationRefusal({ jsonrpc: '2.0', id: 5, method: 'tools/call' }, inJob)).toBeNull()
    expect(nestedDelegationRefusal(null, inJob)).toBeNull()
    expect(nestedDelegationRefusal(call('linked_machines'), inJob)?.id).toBeNull()
  })
})

describe('stdio-adapter.cjs — the delegated-job toolset (linked machines)', () => {
  type Adapter = {
    delegatedJobRefusal: (request: unknown, env: Record<string, string | undefined>) => Rpc | null
    filterDelegatedToolList: (request: unknown, response: unknown, env: Record<string, string | undefined>) => any
    DELEGATED_JOB_TOOLS: readonly string[]
  }
  const load = (): Adapter => createRequire(import.meta.url)(ADAPTER) as Adapter
  const call = (name: unknown, id?: number): object =>
    ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method: 'tools/call', params: { name, arguments: {} } })
  const inJob = { TERMPOLIS_LINKED_JOB: '0123456789ab' }

  it('offers a delegated job only the read-only tools, and an agent the user started everything', async () => {
    const app = await standInApp()
    try {
      const [inside] = await runAdapter(app.port, inJob, [{ id: 20, method: 'tools/list' }])
      expect(inside.result?.tools.map((t: { name: string }) => t.name)).toEqual(['memory_search', 'code_explore'])
      const [outside] = await runAdapter(app.port, {}, [{ id: 21, method: 'tools/list' }])
      expect(outside.result?.tools).toHaveLength(5)
    } finally {
      await app.close()
    }
  })

  it('is read-only and closed: no writes, terminals, commands, swarm, gateway or other machines', () => {
    const { DELEGATED_JOB_TOOLS } = load()
    for (const t of ['memory_write', 'memory_correct', 'memory_link', 'memory_feedback', 'memory_pool', 'list_terminals',
      'read_output', 'write_to_terminal', 'run_command', 'run_and_wait', 'create_terminal', 'close_terminal',
      'get_file_tree', 'gateway_call', 'gateway_list_tools', 'swarm_create_task', 'swarm_send_message', 'linked_machines']) {
      expect(DELEGATED_JOB_TOOLS).not.toContain(t)
    }
    expect(Object.isFrozen(DELEGATED_JOB_TOOLS)).toBe(true)
  })

  it('refuses everything outside the toolset, only inside a linked job, as a tool result', () => {
    const { delegatedJobRefusal } = load()
    expect(delegatedJobRefusal(call('run_command', 1), inJob)).toEqual({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: expect.stringMatching(/^run_command is not available/) }], isError: true },
    })
    expect(delegatedJobRefusal(call('run_command', 1), {})).toBeNull()
    expect(delegatedJobRefusal(call('run_command', 1), { TERMPOLIS_LINKED_JOB: '' })?.result?.isError).toBe(true)
    expect(delegatedJobRefusal(call('memory_search', 1), inJob)).toBeNull()
    expect(delegatedJobRefusal(call('linked_machines', 2), inJob)?.result?.content[0].text).toBe(NESTED)
    expect(delegatedJobRefusal(call('run_command'), inJob)?.id).toBeNull()
    expect(delegatedJobRefusal({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, inJob)).toBeNull()
    expect(delegatedJobRefusal({ jsonrpc: '2.0', id: 4, method: 'tools/call' }, inJob)).toBeNull()
    expect(delegatedJobRefusal(call(7, 5), inJob)).toBeNull()
    expect(delegatedJobRefusal(null, inJob)).toBeNull()
    expect(delegatedJobRefusal(call('run_command', 6), undefined as unknown as Record<string, string>)).toBeNull()
  })

  it('filters a tools/list answer only inside a linked job, and leaves anything else alone', () => {
    const { filterDelegatedToolList } = load()
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const answer = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'memory_search' }, { name: 'run_command' }, null], nextCursor: 'c' } }
    expect(filterDelegatedToolList(list, answer, inJob)).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'memory_search' }], nextCursor: 'c' } })
    expect(filterDelegatedToolList(list, answer, {})).toBe(answer)
    expect(filterDelegatedToolList(call('x', 1), answer, inJob)).toBe(answer)
    expect(filterDelegatedToolList(null, answer, inJob)).toBe(answer)
    const error = { jsonrpc: '2.0', id: 1, error: { message: 'nope' } }
    expect(filterDelegatedToolList(list, error, inJob)).toBe(error)
    expect(filterDelegatedToolList(list, null, inJob)).toBeNull()
  })

  it('applies the same toolset to a read-only run, worded for one', () => {
    const { delegatedJobRefusal, filterDelegatedToolList } = load()
    const readOnly = { TERMPOLIS_READ_ONLY_RUN: '1' }
    expect(delegatedJobRefusal(call('memory_write', 8), readOnly)?.result?.content[0].text)
      .toMatch(/^memory_write is not available to a read-only run\. It can use this machine's memory and code index, read-only, and nothing else\.$/)
    expect(delegatedJobRefusal(call('memory_search', 8), readOnly)).toBeNull()
    // Delegation from a read-only run is just another tool it may not use.
    expect(delegatedJobRefusal(call('linked_machines', 9), readOnly)?.result?.content[0].text).toMatch(/^linked_machines is not available to a read-only run/)
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const answer = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'memory_write' }, { name: 'code_impact' }] } }
    expect(filterDelegatedToolList(list, answer, readOnly).result.tools).toEqual([{ name: 'code_impact' }])
  })

  it('words a linked job\'s refusal for a linked job even when the run is also marked read-only', () => {
    const { delegatedJobRefusal } = load()
    expect(delegatedJobRefusal(call('run_command', 1), { ...inJob, TERMPOLIS_READ_ONLY_RUN: '1' })?.result?.content[0].text)
      .toMatch(/^run_command is not available to a job another linked machine started/)
  })
})
