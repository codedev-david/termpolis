import * as zlib from 'zlib'
import { bareToolName } from '../headroom/router'

export interface Usage {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  output_tokens: number
}

/**
 * What one response asked the client to do, as far as the cost of eliding text is concerned.
 * `pure` is the one the ledger charges for: at least one tool call, and every one of them
 * retrieve_full. Such a turn exists only to fetch text the proxy took out, so the prefix it
 * re-reads and the output it writes are a cost of the elision rather than of the work.
 */
export interface TurnShape {
  /** Tool calls in the answer, of any kind the client or the server runs. */
  toolCalls: number
  /** How many of them were retrieve_full, under any MCP or plugin namespace. */
  retrieveCalls: number
  pure: boolean
  /**
   * Present, and true, only on a turn that did nothing but load retrieve_full. Claude Code runs with
   * ENABLE_TOOL_SEARCH, so retrieve_full is usually a deferred tool and a conversation's first ask
   * arrives as two turns: this one, a ToolSearch call whose query names the tool, and then the
   * `pure` one that calls it. The ledger charges the pair as one ask (proxyLedger.ts). A ToolSearch
   * turn that loads anything else, or does other work besides, is not a hop.
   */
  hop?: true
}

/** Decode an HTTP body buffer honoring content-encoding; falls back to utf8 on any error. */
export function decodeBody(buf: Buffer, enc?: string): string {
  const e = (enc || '').toLowerCase()
  try {
    if (e.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8')
    if (e.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8')
    if (e.includes('deflate')) return zlib.inflateSync(buf).toString('utf8')
  } catch {
    /* fall through to raw utf8 */
  }
  return buf.toString('utf8')
}

/**
 * Extract real token usage from an Anthropic Messages SSE stream (already decoded).
 * input/cache come from the message_start event's message.usage; output_tokens
 * from message_delta. Returns zeros when no usage is present. Never throws.
 */
export function parseUsageFromSse(sse: string): Usage {
  const u: Usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const j = line.slice(5).trim()
    if (!j || j === '[DONE]') continue
    let o: { message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown> }
    try { o = JSON.parse(j) } catch { continue }
    const us = (o.message && o.message.usage) || o.usage
    if (!us) continue
    if (us.input_tokens != null) u.input_tokens = Number(us.input_tokens)
    if (us.cache_read_input_tokens != null) u.cache_read_input_tokens = Number(us.cache_read_input_tokens)
    if (us.cache_creation_input_tokens != null) u.cache_creation_input_tokens = Number(us.cache_creation_input_tokens)
    if (us.output_tokens != null) u.output_tokens = Math.max(u.output_tokens, Number(us.output_tokens))
  }
  return u
}

/** Block types that put a tool call in an answer. The server-run kinds count as calls too: a turn
 *  that also searched the web is not a turn that only fetched. */
const TOOL_CALL_BLOCKS = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use'])

/** The client-side tool Claude Code loads a deferred tool through. A server-run search block with a
 *  similar name loads inside the one response and costs no turn, so only a `tool_use` counts. */
const TOOL_SEARCH = 'ToolSearch'
/** How much of one ToolSearch call's input is read. A query is a few dozen characters; the cap bounds
 *  what a damaged or hostile stream can make the parser hold. */
const SEARCH_INPUT_CAP = 2048
/** How many ToolSearch calls of one answer are followed. The rest still count as tool calls. */
const SEARCH_CALLS_MAX = 16
/** The API's own tool search, which runs inside the one answer (`tool_search_tool_regex`, `_bm25`).
 *  It only loads tools, so it is not counted as a call: an answer that loads retrieve_full this way
 *  and then calls it is a turn that only fetched. Matched on a server-run block only. */
const SERVER_TOOL_SEARCH = 'tool_search'
/** The tool's name as a word of its own, or as the last `__` segment of a namespaced one, which is how
 *  bareToolName reads a name in the tools list: `select:mcp__termpolis__retrieve_full`, a bare name or
 *  a keyword all match; a name that merely begins or ends with it (`retrieve_full_all`,
 *  `not_retrieve_full`) is another tool and does not. */
const NAMES_RETRIEVE_FULL = /(?:(?<![A-Za-z0-9_])|(?<=__))retrieve_full(?![A-Za-z0-9_])/

/** The two events that decide whether an answer finished, matched on the front of a data line without parsing it:
 *  the API writes the type first, `{"type":"message_stop"}` (the error event has spaces, `{"type": "error", ...}`).
 *  Anchored, so a delta line, which is nearly every line of a long answer, fails the match within a few characters;
 *  and a text that is merely the word error, or that quotes an event, is a string inside a line and never its start. */
const STREAM_END = /^\{\s*"type"\s*:\s*"(message_stop|error)"/

/**
 * Read which tools an Anthropic Messages SSE stream (already decoded) called. Total by design: a
 * body it cannot read counts as no call, so a damaged or foreign one is never taken for a
 * retrieval turn and can never be charged as one. An answer counts as a turn only if it finished:
 * the API ends one with message_stop, and an overloaded one is an HTTP 200 whose stream breaks off
 * with an `error` event, after which the client asks again, so charging the broken answer would
 * count one ask twice. Its tool calls are still reported (they were made); it is never `pure` and
 * never a `hop`. Never throws.
 */
export function parseTurnShapeFromSse(sse: string): TurnShape {
  let toolCalls = 0
  let retrieveCalls = 0
  let searchCalls = 0
  let completed = false
  let errored = false
  // What each ToolSearch call is being asked, by content-block index, assembled from its input
  // deltas. Created by the first ToolSearch call, so an answer without one never pays for it.
  let searchInput: Map<number, string> | null = null
  // The ToolSearch blocks that have started and not yet stopped.
  const open = new Set<number>()
  try {
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data:')) continue
      const j = line.slice(5).trim()
      const end = STREAM_END.exec(j)
      if (end !== null) { if (end[1] === 'message_stop') completed = true; else errored = true; continue }
      // A tool call announces itself on one event type only. Skipping the many delta lines before
      // the parse keeps this cheap on a long answer, which parseUsageFromSse already walks once. The
      // one exception is the input of a ToolSearch call, wanted from its start to its stop and no
      // longer: the input of any call after it, a Write or an Edit, can be far longer and is not read.
      if (!j.includes('content_block_start') && !(open.size > 0 && (j.includes('input_json_delta') || j.includes('content_block_stop')))) continue
      let o: { type?: unknown; index?: unknown; content_block?: { type?: unknown; name?: unknown } | null; delta?: { type?: unknown; partial_json?: unknown } | null }
      try { o = JSON.parse(j) } catch { continue }
      if (!o || typeof o !== 'object') continue
      if (o.type === 'content_block_start') {
        const b = o.content_block
        if (!b || typeof b !== 'object' || typeof b.type !== 'string' || !TOOL_CALL_BLOCKS.has(b.type)) continue
        if (b.type === 'server_tool_use' && typeof b.name === 'string' && b.name.startsWith(SERVER_TOOL_SEARCH)) continue
        toolCalls++
        if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
        const name = bareToolName(b.name)
        if (name === 'retrieve_full') retrieveCalls++
        else if (name === TOOL_SEARCH) {
          searchCalls++
          if (typeof o.index === 'number') {
            if (searchInput === null) searchInput = new Map()
            if (searchInput.size < SEARCH_CALLS_MAX) { searchInput.set(o.index, ''); open.add(o.index) }
          }
        }
      } else if (o.type === 'content_block_stop') {
        if (typeof o.index === 'number') open.delete(o.index)
      } else if (o.type === 'content_block_delta' && searchInput !== null) {
        const d = o.delta
        if (typeof o.index !== 'number' || !d || typeof d !== 'object' || d.type !== 'input_json_delta' || typeof d.partial_json !== 'string') continue
        const have = open.has(o.index) ? searchInput.get(o.index) : undefined
        if (have !== undefined && have.length < SEARCH_INPUT_CAP) searchInput.set(o.index, (have + d.partial_json).slice(0, SEARCH_INPUT_CAP))
      }
    }
  } catch {
    return { toolCalls: 0, retrieveCalls: 0, pure: false }
  }
  const finished = completed && !errored
  const shape: TurnShape = { toolCalls, retrieveCalls, pure: finished && toolCalls > 0 && retrieveCalls === toolCalls }
  // A hop is a turn made of ToolSearch calls and nothing else, one of which asks for retrieve_full.
  if (finished && searchCalls > 0 && searchCalls === toolCalls && searchInput !== null) {
    for (const q of searchInput.values()) if (NAMES_RETRIEVE_FULL.test(q)) { shape.hop = true; break }
  }
  return shape
}
