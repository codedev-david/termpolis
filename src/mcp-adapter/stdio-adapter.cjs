#!/usr/bin/env node

// Termpolis MCP Stdio Adapter
//
// Agents (Claude Code, Gemini CLI, Codex, Qwen Code) launch this as a
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
const os = require('os')
const readline = require('readline')

function termpolisDataDir() {
  const platform = process.platform
  if (platform === 'win32') return path.join(process.env.APPDATA || '', 'termpolis')
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis')
  return path.join(os.homedir(), '.config', 'termpolis')
}

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

// Read JSON-RPC messages from stdin (newline-delimited)
const rl = readline.createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return // malformed input — drop silently, nothing useful we can reply with
  }
  // MCP notifications are fire-and-forget — don't forward to server
  if (!request.id && (request.method?.startsWith('notifications/') || request.method === 'initialized')) {
    return
  }
  // Degraded mode: no token, or health check confirmed server down.
  if (!TOKEN || (HEALTH_CHECKED && !SERVER_ONLINE)) {
    process.stdout.write(JSON.stringify(handleLocally(request)) + '\n')
    return
  }
  try {
    const response = await sendToServer(request)
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
})

rl.on('close', () => process.exit(0))

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

probeHealth()
