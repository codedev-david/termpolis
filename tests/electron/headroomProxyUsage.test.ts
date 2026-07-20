import { describe, it, expect } from 'vitest'
import * as zlib from 'zlib'
const { parseUsageFromSse, decodeBody } = await import('../../src/main/headroomProxy/usageParse')

const sse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":78824,"cache_creation_input_tokens":673}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":198}}',
  '',
  'data: [DONE]',
].join('\n')

describe('usageParse', () => {
  it('extracts input/cache/output from a real-shaped SSE stream', () => {
    expect(parseUsageFromSse(sse)).toEqual({ input_tokens: 10, cache_read_input_tokens: 78824, cache_creation_input_tokens: 673, output_tokens: 198 })
  })

  it('returns zeros when no usage is present', () => {
    expect(parseUsageFromSse('event: ping\ndata: {"type":"ping"}\n')).toEqual({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 })
  })

  it('ignores malformed data lines without throwing', () => {
    expect(() => parseUsageFromSse('data: not-json\ndata: {broken\n')).not.toThrow()
  })

  it('decodeBody gunzips gzip, decodes brotli, and passes through plain', () => {
    expect(decodeBody(zlib.gzipSync(Buffer.from('hello')), 'gzip')).toBe('hello')
    expect(decodeBody(zlib.brotliCompressSync(Buffer.from('brot')), 'br')).toBe('brot')
    expect(decodeBody(Buffer.from('plain'), undefined)).toBe('plain')
  })

  it('decodeBody falls back to utf8 on a bad encoding claim', () => {
    expect(decodeBody(Buffer.from('x'), 'gzip')).toBe('x')
  })
})
