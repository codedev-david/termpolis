#!/usr/bin/env node

// Termpolis SessionStart memory hook — ships with the app, registered into every
// user's Claude Code settings.json by agentMcpRegistry (alongside the MCP server).
//
// WHY: Termpolis' whole point is that the AI remembers across sessions. Relying on
// the agent to *call* memory_primer is unreliable (it may not, or may reach for the
// wrong store). This hook instead PUTS the project memory digest directly into the
// session context at startup, current-repo-first, for EVERY Claude session — no
// reliance on the model, works for every install.
//
// It talks to the running Termpolis local control server (127.0.0.1:9315) with the
// same bearer token termpolis-cli uses, calls memory_primer with the session cwd,
// and prints the digest as SessionStart additionalContext. Fully best-effort: if
// Termpolis isn't running, the token is missing, or the call is slow/empty, it
// exits 0 and injects nothing — it must NEVER block or fail session start.
//
// The pure helpers are exported (see module.exports) so they can be unit-tested;
// main() only runs when the file is executed directly (the require.main guard).

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = 9315
const TIMEOUT_MS = 5000
const LIMIT = 12

// Cross-platform location Termpolis writes its local-server bearer token to — must
// match findToken() in termpolis-cli.cjs for win32 / darwin / linux.
function tokenPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'termpolis', 'mcp-token')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis', 'mcp-token')
  }
  return path.join(os.homedir(), '.config', 'termpolis', 'mcp-token')
}

// Prime on a fresh start or /resume; skip 'compact'/'clear' (the app re-primes after
// a compaction itself) so we never double-inject. A missing source defaults to prime.
function shouldPrime(source) {
  const s = source || 'startup'
  return s === 'startup' || s === 'resume'
}

// Parse the SessionStart hook JSON from stdin into an object; any non-object / bad
// JSON yields {} so callers can safely read .source/.cwd.
function parseHookInput(str) {
  try {
    const o = JSON.parse(str || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

// The MCP response's result.content[0].text is itself JSON; its .primer holds the
// digest. Returns '' for any missing/malformed layer (best-effort, never throws).
function extractPrimer(respString) {
  if (!respString) return ''
  try {
    const outer = JSON.parse(respString)
    const text = outer && outer.result && outer.result.content && outer.result.content[0] && outer.result.content[0].text
    if (!text) return ''
    const inner = JSON.parse(text)
    return inner && typeof inner.primer === 'string' ? inner.primer : ''
  } catch {
    return ''
  }
}

// The SessionStart hook stdout contract: additionalContext is injected as context.
function buildOutput(primer) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: primer },
  })
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    const to = setTimeout(() => resolve(data), 1500) // never hang on stdin
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => { clearTimeout(to); resolve(data) })
    process.stdin.on('error', () => { clearTimeout(to); resolve(data) })
  })
}

function memoryPrimer(token, cwd) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call', id: 1,
      params: { name: 'memory_primer', arguments: { cwd, limit: LIMIT } },
    })
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve(d))
    })
    req.setTimeout(TIMEOUT_MS, () => { try { req.destroy() } catch { /* ignore */ } ; resolve('') })
    req.on('error', () => resolve('')) // server down / connection refused → no-op
    req.write(body)
    req.end()
  })
}

async function main() {
  try {
    const hook = parseHookInput(await readStdin())
    if (!shouldPrime(hook.source)) return

    const cwd = hook.cwd || process.cwd()

    let token
    try { token = fs.readFileSync(tokenPath(), 'utf-8').trim() } catch { return } // not installed/running
    if (!token) return

    const resp = await memoryPrimer(token, cwd)
    const primer = extractPrimer(resp)
    if (!primer) return

    process.stdout.write(buildOutput(primer))
  } catch {
    // Any unexpected failure: inject nothing, never block session start.
  }
}

if (require.main === module) main()

module.exports = { tokenPath, shouldPrime, parseHookInput, extractPrimer, buildOutput }
