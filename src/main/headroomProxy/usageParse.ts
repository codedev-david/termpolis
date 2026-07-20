import * as zlib from 'zlib'

export interface Usage {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  output_tokens: number
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
