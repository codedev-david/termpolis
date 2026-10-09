#!/usr/bin/env node

// Termpolis MCP Stdio Adapter
//
// Agents (Claude Code, Gemini CLI, Codex) launch this as a
// subprocess and speak JSON-RPC over stdio. We proxy each request to
// Termpolis's HTTP server on localhost:9315.
//
// Degraded mode (issue #8 follow-up reported by chan-yuu):
//   When Termpolis isn't running, the token file may be absent and the
//   port is definitely unreachable. The adapter used to `process.exit(1)`
//   on missing token — Gemini CLI surfaced that as a hard "MCP server
//   crashed" error and the user couldn't use Gemini at all.
//
//   Now: missing token / unreachable server puts the adapter in
//   *degraded* mode. We still speak the MCP protocol but report zero
//   tools and return a friendly JSON-RPC error on any tool call. From
//   the agent's perspective, the Termpolis MCP server simply has nothing
//   to offer — and the rest of the CLI works normally.

const http = require('http')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

// Shared with the other adapters so the data-dir logic (lowercase name, XDG_CONFIG_HOME on Linux)
// cannot drift again — see dataDir.cjs.
const { termpolisDataDir } = require('./dataDir.cjs')

// Returns the auth token, or null if Termpolis hasn't written one yet.
function findToken() {
  const tokenPath = path.join(termpolisDataDir(), 'mcp-token')
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim()
  } catch {
    return null
  }
}

const TOKEN = findToken()

// Port file may not exist (first run) or Termpolis may not be running.
// Fall back to the default — the health check decides whether we're online.
function findPort() {
  const portPath = path.join(termpolisDataDir(), 'mcp-port')
  try {
    const port = parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10)
    if (port > 0 && port < 65536) return port
  } catch {}
  return 9315
}

const MCP_PORT = findPort()

// Online state — toggled by the startup health check and by request
// failures. Starts pessimistic so the very first request can't slip
// through before the health probe lands.
let SERVER_ONLINE = false
let HEALTH_CHECKED = false

// JSON-RPC error response factory — covers degraded-mode fallbacks plus
// any other situation where we want to return a clean error to the agent
// without crashing.
function rpcError(id, message, code = -32603) {
  return { jsonrpc: '2.0', error: { code, message }, id: id ?? null }
}

// Minimal local responses for handshake messages — required so the agent
// sees a usable MCP server even when Termpolis is offline. Without these,
// degraded mode would still surface a "server failed initialize" error.
function handleLocally(request) {
  const id = request.id
  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'termpolis', version: 'degraded' },
      },
    }
  }
  if (request.method === 'tools/list' || request.method === 'resources/list' || request.method === 'prompts/list') {
    // Empty list — the agent will simply have no Termpolis tools to call.
    return { jsonrpc: '2.0', id, result: { tools: [], resources: [], prompts: [] } }
  }
  return rpcError(
    id,
    'Termpolis is not running. Start Termpolis (https://termpolis.com) to enable its MCP tools. Other agent features should work normally.',
  )
}

function sendToServer(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1',
      port: MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN || ''}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error(`Invalid JSON response: ${body}`))
        }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// F31: default a curated write's project scope to THIS adapter's cwd (= the terminal's
// directory where the agent was launched) when the agent omits `project`, so high-value
// decisions/facts are recalled with current-directory priority by default. Pure + guarded —
// never blocks a call. Search/primer are intentionally NOT defaulted (that would narrow a
// global memory_search into the current project unexpectedly).
function applyDefaultProjectScope(request, cwd) {
  try {
    if (request && request.method === 'tools/call' && request.params && request.params.name === 'memory_write') {
      const a = request.params.arguments
      if (a && (a.project === undefined || a.project === null || a.project === '')) a.project = cwd
    }
  } catch { /* never block a tool call on scoping */ }
  return request
}

// Linked machines (spec §4.5 rule 2). A job that another linked machine started runs with
// TERMPOLIS_LINKED_JOB set, and this adapter inherits it from the agent. That agent may not hand
// the work on to yet another machine: a chain of machines delegating to each other is a loop
// nobody is watching. Answered here, before the app or the network sees it, so the refusal holds
// even for an agent whose Termpolis MCP could not be switched off for the run. Any value counts,
// even an empty one: a check that an empty marker switches off fails open.
const NESTED_DELEGATION_REFUSAL = 'Nested delegation is not allowed: this agent was itself started by a linked machine.'

// The reply to send instead of forwarding, or null to carry on. A tool result marked isError
// rather than a JSON-RPC error, so the agent reads the reason as its answer instead of
// concluding that the server is broken.
function nestedDelegationRefusal(request, env) {
  if (!env || env.TERMPOLIS_LINKED_JOB === undefined) return null
  if (!request || request.method !== 'tools/call' || !request.params || request.params.name !== 'linked_machines') return null
  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    result: { content: [{ type: 'text', text: NESTED_DELEGATION_REFUSAL }], isError: true },
  }
}

// What a restricted run may use on this machine: its memory and code index, read-only, plus git
// status, coverage and expanding a compressed result. A run is restricted when another linked
// machine started it (TERMPOLIS_LINKED_JOB) or when it reads input it must not act on, such as a
// Second Opinion review (TERMPOLIS_READ_ONLY_RUN). Nothing that writes memory, reads or types into
// a terminal, runs a command, touches the swarm, reaches another MCP server or starts an agent
// elsewhere. Deny by default: a tool the server gains later stays out until it is added here on
// purpose. The app's copy is RESTRICTED_RUN_TOOLS in src/shared/agentIntegration.ts.
const DELEGATED_JOB_TOOLS = Object.freeze([
  'memory_search', 'memory_list', 'memory_related', 'memory_graph', 'memory_anticipate',
  'memory_selfcheck', 'memory_conflicts',
  'code_search', 'code_locate', 'code_explore', 'code_callers', 'code_callees', 'code_impact',
  'get_git_status', 'test_coverage', 'retrieve_full',
])

function inLinkedJob(env) {
  return !!env && env.TERMPOLIS_LINKED_JOB !== undefined
}

// Present is enough, as for the linked-job marker.
function inRestrictedRun(env) {
  return inLinkedJob(env) || (!!env && env.TERMPOLIS_READ_ONLY_RUN !== undefined)
}

function restrictedToolRefusal(name, env) {
  const who = inLinkedJob(env) ? 'a job another linked machine started' : 'a read-only run'
  return `${name} is not available to ${who}. It can use this machine's memory and code index, read-only, and nothing else.`
}

// The reply that refuses a restricted run's call to anything outside DELEGATED_JOB_TOOLS, or null
// to carry on. linked_machines inside a linked job keeps its own wording.
function delegatedJobRefusal(request, env) {
  if (!inRestrictedRun(env)) return null
  const nested = nestedDelegationRefusal(request, env)
  if (nested) return nested
  if (!request || request.method !== 'tools/call' || !request.params || typeof request.params.name !== 'string') return null
  const name = request.params.name
  if (DELEGATED_JOB_TOOLS.includes(name)) return null
  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    result: { content: [{ type: 'text', text: restrictedToolRefusal(name, env) }], isError: true },
  }
}

// A restricted run is offered only the tools it may call: no schema it would be refused, and fewer
// input tokens on every turn.
function filterDelegatedToolList(request, response, env) {
  if (!inRestrictedRun(env) || !request || request.method !== 'tools/list') return response
  const tools = response && response.result && Array.isArray(response.result.tools) ? response.result.tools : null
  if (!tools) return response
  return { ...response, result: { ...response.result, tools: tools.filter((t) => t && DELEGATED_JOB_TOOLS.includes(t.name)) } }
}

// Read JSON-RPC messages from stdin (newline-delimited)
async function handleLine(line) {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return // malformed input — drop silently, nothing useful we can reply with
  }
  applyDefaultProjectScope(request, process.cwd())
  // MCP notifications are fire-and-forget — don't forward to server
  if (!request.id && (request.method?.startsWith('notifications/') || request.method === 'initialized')) {
    return
  }
  // Ahead of degraded mode: whether the app is up does not change this answer.
  const refusal = delegatedJobRefusal(request, process.env)
  if (refusal) {
    process.stdout.write(JSON.stringify(refusal) + '\n')
    return
  }
  // Degraded mode: no token, or health check confirmed server down.
  if (!TOKEN || (HEALTH_CHECKED && !SERVER_ONLINE)) {
    process.stdout.write(JSON.stringify(handleLocally(request)) + '\n')
    return
  }
  try {
    const response = filterDelegatedToolList(request, await sendToServer(request), process.env)
    process.stdout.write(JSON.stringify(response) + '\n')
  } catch (err) {
    // Connection refused etc. — flip into degraded mode so subsequent
    // requests don't all eat the same network timeout, and return a
    // friendly error for this one.
    if (err && /ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(err.code || err.message || '')) {
      SERVER_ONLINE = false
      HEALTH_CHECKED = true
      process.stdout.write(JSON.stringify(handleLocally(request)) + '\n')
      return
    }
    process.stdout.write(JSON.stringify(rpcError(request.id, err.message)) + '\n')
  }
}

// Health check on start — outcome decides whether we proxy or degrade.
function probeHealth() {
  if (!TOKEN) {
    HEALTH_CHECKED = true
    SERVER_ONLINE = false
    process.stderr.write('Termpolis MCP adapter: token file missing — degraded mode (Termpolis not running).\n')
    return
  }
  http.get(`http://127.0.0.1:${MCP_PORT}/health`, (res) => {
    let body = ''
    res.on('data', chunk => body += chunk)
    res.on('end', () => {
      SERVER_ONLINE = res.statusCode === 200
      HEALTH_CHECKED = true
      if (SERVER_ONLINE) {
        process.stderr.write(`Termpolis MCP adapter connected: ${body}\n`)
      } else {
        process.stderr.write(`Termpolis MCP adapter: health endpoint returned ${res.statusCode} — degraded mode.\n`)
      }
    })
  }).on('error', () => {
    SERVER_ONLINE = false
    HEALTH_CHECKED = true
    process.stderr.write(`Termpolis MCP adapter: cannot reach localhost:${MCP_PORT} — degraded mode (Termpolis not running).\n`)
  })
}

// Runtime startup — guarded so `require()` in tests can exercise the pure helpers without
// attaching a stdin reader or firing the health probe.
function startAdapter() {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', handleLine)
  rl.on('close', () => process.exit(0))
  probeHealth()
}

if (require.main === module) startAdapter()

module.exports = {
  applyDefaultProjectScope, nestedDelegationRefusal, delegatedJobRefusal, filterDelegatedToolList, DELEGATED_JOB_TOOLS,
}
