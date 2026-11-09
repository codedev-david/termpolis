#!/usr/bin/env node

// Termpolis memory hook (SessionStart, and from v1.55.0 UserPromptSubmit) — ships with the app, registered into every
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

const PORT = 9315
const TIMEOUT_MS = 5000
const LIMIT = 12
// v1.55.0 first-prompt primer: Claude Code waits for a UserPromptSubmit hook before it sends the
// prompt, so this one gets a shorter budget and fewer notes, matched to what the prompt asks.
const PROMPT_TIMEOUT_MS = 3000
const PROMPT_LIMIT = 6
const PROMPT_QUERY_CHARS = 400
const MIN_PROMPT_WORDS = 12

// Location of Termpolis's local-server bearer token. Shared with the CLI and the MCP adapter so the
// win32/darwin/linux logic (lowercase name, XDG_CONFIG_HOME on Linux) cannot drift — dataDir.cjs.
const { dataFile } = require('./dataDir.cjs')
function tokenPath() {
  return dataFile('mcp-token')
}

// Prime on a fresh start, /resume, and after a compaction or /clear (v1.55.0): each of these
// leaves the session without the digest. The call says source 'session-start', so the app starts
// the session's record of shown notes afresh, and a later memory_primer call in the same session
// gets only notes it has not seen. An unknown source is skipped; a missing one defaults to prime.
const PRIME_SOURCES = new Set(['startup', 'resume', 'compact', 'clear'])
function shouldPrime(source) {
  return PRIME_SOURCES.has(source || 'startup')
}

// A prompt worth a focused primer: at least MIN_PROMPT_WORDS words, and not a slash command.
function isSubstantive(prompt) {
  if (typeof prompt !== 'string') return false
  const t = prompt.trim()
  if (!t || t.startsWith('/')) return false
  return t.split(/\s+/).length >= MIN_PROMPT_WORDS
}

// The prompt as it goes to the app's memory search: secrets matched by the scanner's rules are
// replaced first, then it is cut to PROMPT_QUERY_CHARS. A rule table that will not load sends nothing.
function redactPrompt(prompt) {
  let rules
  try { rules = require('./secretRules.cjs') } catch { return '' }
  let text = String(prompt)
  for (const r of Array.isArray(rules) ? rules : []) {
    if (r && r.pattern instanceof RegExp) text = text.replace(r.pattern, '[redacted]')
  }
  return text.slice(0, PROMPT_QUERY_CHARS)
}

// A run Termpolis started for another machine or on input it must not act on: no memory goes in.
function quietRun(env) {
  return !!env && (env.TERMPOLIS_LINKED_JOB !== undefined || env.TERMPOLIS_READ_ONLY_RUN !== undefined)
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

// The hook stdout contract, for SessionStart and UserPromptSubmit alike: additionalContext is
// injected as context.
function buildOutput(primer, eventName) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName || 'SessionStart', additionalContext: primer },
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

function memoryPrimer(token, args, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call', id: 1,
      params: { name: 'memory_primer', arguments: args },
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
    req.setTimeout(timeoutMs || TIMEOUT_MS, () => { try { req.destroy() } catch { /* ignore */ } ; resolve('') })
    req.on('error', () => resolve('')) // server down / connection refused → no-op
    req.write(body)
    req.end()
  })
}

async function main() {
  try {
    const hook = parseHookInput(await readStdin())
    const onPrompt = hook.hook_event_name === 'UserPromptSubmit'
    if (onPrompt) {
      if (quietRun(process.env) || !isSubstantive(hook.prompt) || typeof hook.session_id !== 'string') return
    } else if (!shouldPrime(hook.source)) return

    const cwd = hook.cwd || process.cwd()
    let args = { cwd, limit: LIMIT, source: 'session-start' }
    if (onPrompt) {
      const query = redactPrompt(hook.prompt)
      if (!query.trim()) return
      args = { cwd, query, limit: PROMPT_LIMIT, source: 'prompt', sessionId: hook.session_id }
    }

    let token
    try { token = fs.readFileSync(tokenPath(), 'utf-8').trim() } catch { return } // not installed/running
    if (!token) return

    const resp = await memoryPrimer(token, args, onPrompt ? PROMPT_TIMEOUT_MS : TIMEOUT_MS)
    const primer = extractPrimer(resp)
    if (!primer) return

    process.stdout.write(buildOutput(primer, onPrompt ? 'UserPromptSubmit' : 'SessionStart'))
  } catch {
    // Any unexpected failure: inject nothing, never block session start.
  }
}

if (require.main === module) main()

module.exports = { tokenPath, shouldPrime, parseHookInput, extractPrimer, buildOutput, isSubstantive, redactPrompt, quietRun }
