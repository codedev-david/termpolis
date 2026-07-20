import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import * as zlib from 'zlib'
const { createProxyServer } = await import('../../src/main/headroomProxy/proxyMain')

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":50000,"cache_creation_input_tokens":400}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":42}}',
  '',
].join('\n')

let received: Array<{ body: string; url: string }> = []
let results: Array<Record<string, unknown>> = []
let stub: http.Server, proxy: http.Server, stubPort: number, proxyPort: number

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    const cs: Buffer[] = []
    req.on('data', (c) => cs.push(c))
    req.on('end', () => {
      received.push({ body: Buffer.concat(cs).toString('utf8'), url: req.url || '' })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
      res.end(zlib.gzipSync(Buffer.from(SSE)))
    })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
  stubPort = (stub.address() as { port: number }).port
  proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort: stubPort, useHttps: false, onResult: (r) => results.push(r as unknown as Record<string, unknown>) })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as { port: number }).port
})
afterAll(() => { stub.close(); proxy.close() })

function post(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'accept-encoding': 'gzip' } }, (res) => {
      const cs: Buffer[] = []
      res.on('data', (c) => cs.push(c))
      res.on('end', () => { const raw = Buffer.concat(cs); const txt = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString() : raw.toString(); resolve({ status: res.statusCode || 0, body: txt }) })
    })
    req.on('error', reject); req.write(body); req.end()
  })
}

const BIG = Array.from({ length: 120 }, (_, i) => `log line ${i} with content`).join('\n')
const messagesBody = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: BIG }] }] })

describe('headroom proxy server (mock upstream)', () => {
  it('compresses the /v1/messages body, streams the response back, parses real usage', async () => {
    received = []; results = []
    const res = await post('/v1/messages?beta=true', messagesBody)
    expect(res.status).toBe(200)
    expect(res.body).toContain('message_start') // SSE streamed back and gunzipped fine
    expect(received).toHaveLength(1)
    expect(received[0].body.length).toBeLessThan(messagesBody.length) // upstream got a SMALLER body
    expect(received[0].body).toContain('retrieve_full')
    expect(results).toHaveLength(1)
    expect((results[0].stats as { trBlocks: number }).trBlocks).toBe(1)
    expect(results[0].usage).toEqual({ input_tokens: 12, cache_read_input_tokens: 50000, cache_creation_input_tokens: 400, output_tokens: 42 })
    expect((results[0].stashes as unknown[]).length).toBe(1)
  })

  it('passes through non-/v1/messages traffic unchanged and records nothing', async () => {
    received = []; results = []
    await post('/v1/other', messagesBody)
    expect(received[0].body).toBe(messagesBody)
    expect(results).toHaveLength(0)
  })

  it('is fail-open: a malformed body is forwarded unchanged (never corrupted)', async () => {
    received = []; results = []
    await post('/v1/messages', 'not json{')
    expect(received[0].body).toBe('not json{')
  })

  it('does NOT rewrite /v1/messages/count_tokens (Claude sizes its own context there)', async () => {
    received = []; results = []
    await post('/v1/messages/count_tokens', messagesBody)
    expect(received[0].body).toBe(messagesBody) // untouched — no compression, no double-count
    expect(results).toHaveLength(0)
  })
})
