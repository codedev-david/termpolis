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

/**
 * Read which tools an Anthropic Messages SSE stream (already decoded) called. Total by design: a
 * body it cannot read counts as no call, so a damaged or foreign one is never taken for a
 * retrieval turn and can never be charged as one. Never throws.
 */
export function parseTurnShapeFromSse(sse: string): TurnShape {
  let toolCalls = 0
  let retrieveCalls = 0
  try {
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data:')) continue
      const j = line.slice(5).trim()
      // A tool call announces itself on one event type only. Skipping the many delta lines before
      // the parse keeps this cheap on a long answer, which parseUsageFromSse already walks once.
      if (!j.includes('content_block_start')) continue
      let o: { type?: unknown; content_block?: { type?: unknown; name?: unknown } | null }
      try { o = JSON.parse(j) } catch { continue }
      if (!o || typeof o !== 'object' || o.type !== 'content_block_start') continue
      const b = o.content_block
      if (!b || typeof b !== 'object' || typeof b.type !== 'string' || !TOOL_CALL_BLOCKS.has(b.type)) continue
      toolCalls++
      if (b.type === 'tool_use' && typeof b.name === 'string' && bareToolName(b.name) === 'retrieve_full') retrieveCalls++
    }
  } catch {
    return { toolCalls: 0, retrieveCalls: 0, pure: false }
  }
  return { toolCalls, retrieveCalls, pure: toolCalls > 0 && retrieveCalls === toolCalls }
}
