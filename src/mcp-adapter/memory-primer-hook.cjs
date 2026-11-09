#!/usr/bin/env node

// Termpolis memory hook (SessionStart, and from v1.55.0 UserPromptSubmit, PreCompact and PostCompact) — ships with the app, registered into every
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
// The Read hook runs before every whole-file Read, so it gives up fast (v1.55.0 outline hint).
const OUTLINE_TIMEOUT_MS = 1200
const PROMPT_LIMIT = 6
const PROMPT_QUERY_CHARS = 400
const MIN_PROMPT_WORDS = 12
// v1.55.0 relay. PreCompact: Claude Code uses the hook's plain stdout as instructions for the summary
// (under 10,000 characters; this stays under 1,500). PostCompact: the last prompt goes to the app,
// which may offer the pane a better-fitting model while the cache is cold anyway.
const COMPACT_INSTRUCTIONS = 'Keep decisions made and why, file paths touched, the open next step, and failing test names. ' +
  'Drop tool output bodies. Durable facts live in Termpolis memory (memory_search), so they need not be repeated here.'
const TRANSCRIPT_TAIL_BYTES = 512 * 1024

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

// Any typed prompt that is not a slash command. A short one gets no primer, but the app still sees
// it as the session's first prompt (the early re-route offer).
function isTypedPrompt(prompt) {
  if (typeof prompt !== 'string') return false
  const t = prompt.trim()
  return !!t && !t.startsWith('/')
}

// The text of a transcript user entry the person typed: not a tool result, the compaction summary,
// a meta line, or a slash command's record (those start with '<').
function typedText(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || !entry.message) return ''
  const c = entry.message.content
  let text = ''
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    if (c.some((p) => p && p.type === 'tool_result')) return ''
    text = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ')
  }
  text = text.trim()
  return text.startsWith('<') ? '' : text
}

// The last prompt the person typed, read from the transcript's last TRANSCRIPT_TAIL_BYTES only. '' when
// there is none or the file cannot be read.
async function lastUserPrompt(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return ''
  let fh
  try {
    fh = await fs.promises.open(transcriptPath, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const lines = buf.toString('utf-8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry
      try { entry = JSON.parse(lines[i]) } catch { continue }
      const text = typedText(entry)
      if (text) return text
    }
    return ''
  } catch {
    return ''
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
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

function memoryPrimer(token, args, timeoutMs, tool) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call', id: 1,
      params: { name: tool || 'memory_primer', arguments: args },
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

// A Read with no offset or limit reads the whole file: worth an outline hint when the file is large.
function isWholeRead(hook) {
  if (!hook || hook.tool_name !== 'Read') return false
  const input = hook.tool_input
  if (!input || typeof input !== 'object' || typeof input.file_path !== 'string' || !input.file_path) return false
  return input.offset === undefined && input.limit === undefined
}

// result.content[0].text is JSON whose .outline is the hint, or null.
function extractOutline(respString) {
  if (!respString) return ''
  try {
    const text = JSON.parse(respString).result.content[0].text
    const inner = JSON.parse(text)
    return inner && typeof inner.outline === 'string' ? inner.outline : ''
  } catch {
    return ''
  }
}

// The first-prompt call. TERMPOLIS_TERMINAL_ID, set in every Termpolis terminal, names the pane the
// session runs in, so the app can offer that pane a better-fitting model (v1.55.0 early re-route),
// a session started by hand included.
function promptArgs(cwd, query, sessionId, env) {
  const args = { cwd, query, limit: PROMPT_LIMIT, source: 'prompt', sessionId }
  const terminalId = env && env.TERMPOLIS_TERMINAL_ID
  if (typeof terminalId === 'string' && /^[\w-]{1,128}$/.test(terminalId)) args.terminalId = terminalId
  return args
}

async function main() {
  try {
    const hook = parseHookInput(await readStdin())
    const event = hook.hook_event_name
    if (event === 'PreToolUse') {
      // Context only: never a permission decision, so the read itself goes ahead unchanged.
      if (quietRun(process.env) || typeof hook.session_id !== 'string' || !isWholeRead(hook)) return
      let token
      try { token = fs.readFileSync(tokenPath(), 'utf-8').trim() } catch { return }
      if (!token) return
      const resp = await memoryPrimer(token, { path: hook.tool_input.file_path, sessionId: hook.session_id }, OUTLINE_TIMEOUT_MS, 'code_outline')
      const outline = extractOutline(resp)
      if (outline) process.stdout.write(buildOutput(outline, 'PreToolUse'))
      return
    }
    if (event === 'PreCompact') {
      if (!quietRun(process.env)) process.stdout.write(COMPACT_INSTRUCTIONS)
      return
    }
    const onPrompt = event === 'UserPromptSubmit'
    const afterCompact = event === 'PostCompact'
    if (onPrompt || afterCompact) {
      if (quietRun(process.env) || typeof hook.session_id !== 'string') return
      if (onPrompt && !isTypedPrompt(hook.prompt)) return
    } else if (!shouldPrime(hook.source)) return

    const cwd = hook.cwd || process.cwd()
    let args = { cwd, limit: LIMIT, source: 'session-start' }
    if (onPrompt || afterCompact) {
      const query = redactPrompt(afterCompact ? await lastUserPrompt(hook.transcript_path) : hook.prompt)
      if (!query.trim()) return
      args = promptArgs(cwd, query, hook.session_id, process.env)
      if (afterCompact) args.source = 'post-compact'
      else if (!isSubstantive(hook.prompt)) args.prime = false
    }

    let token
    try { token = fs.readFileSync(tokenPath(), 'utf-8').trim() } catch { return } // not installed/running
    if (!token) return

    const resp = await memoryPrimer(token, args, onPrompt || afterCompact ? PROMPT_TIMEOUT_MS : TIMEOUT_MS)
    const primer = extractPrimer(resp)
    if (!primer || afterCompact) return

    process.stdout.write(buildOutput(primer, onPrompt ? 'UserPromptSubmit' : 'SessionStart'))
  } catch {
    // Any unexpected failure: inject nothing, never block session start.
  }
}

if (require.main === module) main()

module.exports = { tokenPath, shouldPrime, parseHookInput, extractPrimer, buildOutput, isSubstantive, redactPrompt, quietRun, promptArgs, isTypedPrompt, typedText, lastUserPrompt, COMPACT_INSTRUCTIONS, isWholeRead, extractOutline }
