// v1.58.0 Codex effort per message, the proxy's half. Runs in the proxy child.
//
// A Codex terminal launched by Termpolis gets `-c openai_base_url=http://127.0.0.1:PORT/termpolis-codex/<terminal>/backend-api/codex`
// (main/codexLaunch.ts). Codex cannot add a header to its built-in provider, so the terminal rides in the
// path, which ends in /backend-api/codex so Codex keeps treating the endpoint as its own backend. Here:
//
//  - the path is turned back into the real endpoint: chatgpt.com/backend-api/codex for a ChatGPT sign-in,
//    api.openai.com/v1 for an API key (a Bearer `sk-…`), the two endpoints Codex itself would have used;
//  - a WebSocket upgrade is answered 426, which makes Codex fall back to HTTP for the session (its own
//    fallback path), so each request's body can be read;
//  - when the user types a new message, main is asked (codex-turn) what effort it needs, and every request
//    of that turn is sent at that effort: `"reasoning":{"effort":"…"}` is edited in place, never by
//    re-serializing the body. The model is never changed (encrypted reasoning does not carry across models).
//
// Nothing else is touched: the model catalog, compaction, and requests Codex tags as its own internal work
// (`x-openai-subagent`) pass through as sent. A refused effort is sent again as Codex asked it.

import * as zlib from 'zlib'

/** zstd is in Node 22.15+ (Electron 43's Node has it); the installed @types/node predates it. */
const zstd = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer; zstdDecompressSync?: (b: Buffer) => Buffer }

export const CODEX_PREFIX = '/termpolis-codex/'
const PATH_RE = /^\/termpolis-codex\/([\w-]{1,128})\/backend-api\/codex(\/[^?#]*)?(\?[^#]*)?$/
/** serde writes the request's fields in a fixed order, compact: `reasoning` follows `parallel_tool_calls`. */
const EFFORT_RE = /"parallel_tool_calls":(?:true|false),"reasoning":\{"effort":"([a-z]+)"/g
const USER_ROLE = '"role":"user"'
/** How long a request of a new turn waits for main's answer before it goes as Codex asked it: main's
 *  classifier budget (350 ms) plus the hop there and back. */
export const CODEX_WAIT_MS = 500
/** Bodies past this are not parsed for the typed message (the turn keeps its effort). */
export const MAX_PARSE_CHARS = 16_000_000
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const TERMINAL_RE = /^[\w-]{1,128}$/

export interface CodexTarget {
  terminal: string
  host: string
  path: string
  /** POST …/responses: a model turn whose effort may be routed. */
  responses: boolean
}

type Headers = Record<string, string | string[] | undefined>

function header(headers: Headers, name: string): string {
  const v = headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s.trim() : ''
}

/** The real endpoint for a request to the Codex prefix; null for any other path. */
export function codexTarget(url: string, method: string | undefined, headers: Headers): CodexTarget | null {
  const m = PATH_RE.exec(url)
  if (!m) return null
  const rest = m[2] ?? ''
  const apiKey = /^bearer\s+sk-/i.test(header(headers, 'authorization'))
  return {
    terminal: m[1],
    host: apiKey ? 'api.openai.com' : 'chatgpt.com',
    path: (apiKey ? '/v1' : '/backend-api/codex') + rest + (m[3] ?? ''),
    responses: method === 'POST' && rest === '/responses',
  }
}

/** The raw reply to a WebSocket upgrade on the Codex prefix: Codex then uses HTTP for the session. */
export const UPGRADE_REFUSAL = 'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'

/** zstd is the only encoding Codex compresses request bodies with; null = leave the body alone. */
export function decodeRequest(buf: Buffer, encoding: string): string | null {
  const e = encoding.toLowerCase()
  try {
    if (e === '' || e === 'identity') return buf.toString('utf8')
    if (e === 'zstd' && zstd.zstdDecompressSync && zstd.zstdCompressSync) return zstd.zstdDecompressSync(buf).toString('utf8')
  } catch { /* not what it said it was: send it as it came */ }
  return null
}

export function encodeRequest(text: string, encoding: string): Buffer {
  const raw = Buffer.from(text, 'utf8')
  // Only reached for a body decodeRequest read, so zstd is there when it says zstd.
  return encoding.toLowerCase() === 'zstd' && zstd.zstdCompressSync ? zstd.zstdCompressSync(raw) : raw
}

/** The request's effort and where it sits, when the body holds exactly one. */
export function bodyEffort(text: string): { effort: string; start: number; end: number } | null {
  let found: { effort: string; start: number; end: number } | null = null
  for (const m of text.matchAll(EFFORT_RE)) {
    if (found) return null
    const end = m.index + m[0].length - 1
    found = { effort: m[1], start: end - m[1].length, end }
  }
  return found
}

export function withEffort(text: string, effort: string): string | null {
  const at = bodyEffort(text)
  if (!at || !/^[a-z]+$/.test(effort)) return null
  return text.slice(0, at.start) + effort + text.slice(at.end)
}

/** How many user messages the body holds (structural ones only: a quote inside a string is escaped). */
export function countUserItems(text: string): number {
  let n = 0
  for (let i = text.indexOf(USER_ROLE); i !== -1; i = text.indexOf(USER_ROLE, i + USER_ROLE.length)) n++
  return n
}

/** Text Codex adds as a user message itself: its environment, the AGENTS.md instructions, an aborted turn. */
function isInjected(t: string): boolean {
  const s = t.trim()
  return /^<([a-z_]+)>[\s\S]*<\/\1>$/.test(s) || s.startsWith('# AGENTS.md instructions')
}

/** The last message the user typed, from a Responses request body. */
export function lastTypedMessage(text: string): string | null {
  if (text.length > MAX_PARSE_CHARS) return null
  let input: unknown
  try { input = (JSON.parse(text) as { input?: unknown }).input } catch { return null }
  if (!Array.isArray(input)) return null
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as { type?: unknown; role?: unknown; content?: unknown }
    if (!item || item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content)) continue
    const typed = (item.content as Array<{ type?: unknown; text?: unknown }>)
      .filter((c) => c && c.type === 'input_text' && typeof c.text === 'string' && !isInjected(c.text as string))
      .map((c) => c.text as string)
      .join('\n')
      .trim()
    if (typed) return typed
  }
  return null
}

export interface CodexAsk { terminal: string; key: number; task: string; asked: string }

interface TurnState {
  users: number
  text: string | null
  key: number
  /** Main's answer for the turn; undefined while asking (or never answered), null = leave it. */
  effort: string | null | undefined
  refused: Set<string>
  off: boolean
}

const turns = new Map<string, TurnState>()
const waiters = new Map<string, Array<() => void>>()
let asker: ((q: CodexAsk) => void) | null = null
const MAX_TERMINALS = 256

export function setCodexAsker(fn: ((q: CodexAsk) => void) | null): void { asker = fn }

export function _resetCodexRouteForTests(): void { turns.clear(); waiters.clear(); asker = null }

function stateOf(terminal: string): TurnState {
  let s = turns.get(terminal)
  if (!s) {
    if (turns.size >= MAX_TERMINALS) { const first = turns.keys().next().value; if (first !== undefined) turns.delete(first) }
    s = { users: -1, text: null, key: 0, effort: undefined, refused: new Set(), off: false }
    turns.set(terminal, s)
  }
  return s
}

/** Main's answer for one turn (null = run it as Codex asked). A stale turn's answer is dropped. */
export function setCodexRoute(terminal: unknown, key: unknown, effort: unknown): void {
  if (typeof terminal !== 'string' || !TERMINAL_RE.test(terminal) || typeof key !== 'number') return
  const s = turns.get(terminal)
  if (!s || s.key !== key) return
  s.effort = typeof effort === 'string' && (CODEX_EFFORTS as readonly string[]).includes(effort) ? effort : null
  const id = `${terminal}:${key}`
  const w = waiters.get(id)
  waiters.delete(id)
  if (w) for (const done of w) done()
}

function waitFor(terminal: string, key: number, ms: number): Promise<void> {
  const id = `${terminal}:${key}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(id); resolve() }, ms)
    const list = waiters.get(id) ?? []
    list.push(() => { clearTimeout(timer); resolve() })
    waiters.set(id, list)
  })
}

export interface CodexPlan {
  body: string
  asked: string
  effort: string
}

/** The effort to send, given main's pick and what the API has refused in this terminal. */
function usable(want: string | null | undefined, s: TurnState): string | null {
  if (!want) return null
  if (!s.refused.has(want)) return want
  // A model without xhigh refuses it: high is the next best, unless that was refused too.
  return want === 'xhigh' && !s.refused.has('high') ? 'high' : null
}

/**
 * The body a Responses request goes out with, or null to send it as it came. A request of a new typed
 * turn first asks main and waits up to `waitMs` for the answer; the rest of the turn reuses it.
 */
export async function planCodexRequest(terminal: string, text: string, headers: Headers, waitMs = CODEX_WAIT_MS): Promise<CodexPlan | null> {
  if (!TERMINAL_RE.test(terminal) || header(headers, 'x-openai-subagent')) return null
  const at = bodyEffort(text)
  if (!at) return null
  const s = stateOf(terminal)
  if (s.off) return null
  const users = countUserItems(text)
  if (users !== s.users) {
    s.users = users
    const typed = lastTypedMessage(text)
    if (typed && typed !== s.text) {
      s.text = typed
      s.key++
      s.effort = undefined
      if (asker) {
        const key = s.key
        try { asker({ terminal, key, task: typed.slice(0, 4000), asked: at.effort }) } catch { /* runs as asked */ }
        await waitFor(terminal, key, waitMs)
      }
    }
  }
  const effort = usable(s.effort, s)
  if (!effort || effort === at.effort) return null
  const body = withEffort(text, effort)
  return body === null ? null : { body, asked: at.effort, effort }
}

/** The API refused the routed effort: it is not sent in this terminal again (and xhigh falls to high). */
export function noteCodexRefused(terminal: string, effort: string): void {
  const s = turns.get(terminal)
  if (!s) return
  s.refused.add(effort)
  if (s.refused.size >= 3) s.off = true
}

export function forgetCodexTerminal(terminal: unknown): void {
  if (typeof terminal === 'string') turns.delete(terminal)
}
