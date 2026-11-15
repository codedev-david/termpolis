#!/usr/bin/env node
'use strict'
// Memory A/B benchmark: a stand-in for src/mcp-adapter/memory-primer-hook.cjs.
//
// The real hook is hardwired to the app's port (9315) and reads the app's bearer from the user's
// Termpolis data folder, so it can't point at the benchmark's private server. This file mirrors
// what it sends for the two events that carry memory into a session:
//   SessionStart (source startup/resume/compact/clear) -> memory_primer {cwd, limit:12, source:'session-start'}
//   UserPromptSubmit (typed prompt)                    -> memory_primer {cwd, query (first 400 chars),
//                                                         limit:6, source:'prompt', sessionId, prime:false if < 12 words}
// and prints the same hookSpecificOutput JSON. Not mirrored: the PreToolUse code_outline hint and
// the PreCompact/PostCompact paths (the benchmark offers no code tools, and -p runs don't compact).
//
// One deliberate difference: the app keeps the first-prompt primer from 10% of sessions (a holdout,
// FNV-1a of the session id). Every ON run here is meant to get it, so a holdout id is salted until
// it lands in the focused arm. The salted id is used for both the gate and the server call.
//
// Usage (from a --settings hook command): node primer-hook.cjs <port> <bearerFile> <logFile>

const http = require('http')
const fs = require('fs')

const [, , PORT, BEARER_FILE, LOG_FILE] = process.argv
const LIMIT = 12
const PROMPT_LIMIT = 6
const PROMPT_QUERY_CHARS = 400
const MIN_PROMPT_WORDS = 12
const HOLDOUT_PERCENT = 10
const PRIME_SOURCES = new Set(['startup', 'resume', 'compact', 'clear'])

function log(entry) {
  if (!LOG_FILE) return
  try { fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n') } catch { /* best effort */ }
}

function armOf(sessionId) {
  let h = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 100 < HOLDOUT_PERCENT ? 'holdout' : 'focused'
}

function focusedId(sessionId) {
  let id = sessionId
  for (let i = 1; armOf(id) === 'holdout'; i++) id = `${sessionId}~${i}`
  return id
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    const to = setTimeout(() => resolve(data), 1500)
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => { clearTimeout(to); resolve(data) })
    process.stdin.on('error', () => { clearTimeout(to); resolve(data) })
  })
}

function call(bearer, args, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'memory_primer', arguments: args } })
    const req = http.request({
      hostname: '127.0.0.1', port: Number(PORT), path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve(d))
    })
    req.setTimeout(timeoutMs, () => { try { req.destroy() } catch { /* ignore */ } resolve('') })
    req.on('error', () => resolve(''))
    req.write(body)
    req.end()
  })
}

function extractPrimer(resp) {
  try {
    const inner = JSON.parse(JSON.parse(resp).result.content[0].text)
    return inner && typeof inner.primer === 'string' ? inner.primer : ''
  } catch {
    return ''
  }
}

async function main() {
  let hook = {}
  try { hook = JSON.parse((await readStdin()) || '{}') || {} } catch { hook = {} }
  const event = hook.hook_event_name
  const cwd = hook.cwd || process.cwd()
  let args
  if (event === 'SessionStart') {
    if (!PRIME_SOURCES.has(hook.source || 'startup')) return log({ event, skipped: 'source ' + hook.source })
    args = { cwd, limit: LIMIT, source: 'session-start' }
  } else if (event === 'UserPromptSubmit') {
    const prompt = typeof hook.prompt === 'string' ? hook.prompt.trim() : ''
    if (!prompt || prompt.startsWith('/') || typeof hook.session_id !== 'string') return log({ event, skipped: 'not a typed prompt' })
    const sessionId = focusedId(hook.session_id)
    args = { cwd, query: prompt.slice(0, PROMPT_QUERY_CHARS), limit: PROMPT_LIMIT, source: 'prompt', sessionId }
    if (prompt.split(/\s+/).length < MIN_PROMPT_WORDS) args.prime = false
  } else {
    return log({ event, skipped: 'event' })
  }
  let bearer = ''
  try { bearer = fs.readFileSync(BEARER_FILE, 'utf8').trim() } catch { /* no server */ }
  if (!bearer) return log({ event, skipped: 'no bearer' })
  const primer = extractPrimer(await call(bearer, args, event === 'SessionStart' ? 5000 : 3000))
  log({ event, sessionId: args.sessionId, salted: !!args.sessionId && args.sessionId !== hook.session_id, chars: primer.length, primer })
  if (primer) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: primer } }))
}

main().catch(() => { /* never block the session */ })
