import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'
import * as zlib from 'zlib'
const { createProxyServer } = await import('../../src/main/headroomProxy/proxyMain')

/**
 * R1 criterion 1, the carrying half: the proxy reads each answer's shape off the stream it already
 * decodes for usage, and hands it to onResult beside the usage, so the ledger can charge a pure
 * retrieval turn. The stub upstream answers with a real-shaped stream chosen per test.
 */

const sse = (name: string | null): string => [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":50000,"cache_creation_input_tokens":400}}}',
  '',
  ...(name === null ? [] : [
    'event: content_block_start',
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"${name}","input":{}}}`,
    '',
  ]),
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":137}}',
  '',
].join('\n')

let answer = sse('mcp__termpolis__retrieve_full')
let gzip = false
let results: Array<Record<string, unknown>> = []
let stub: http.Server, proxy: http.Server, proxyPort: number

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (gzip) { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(Buffer.from(answer))) }
      else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(answer) }
    })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
  proxy = createProxyServer({
    upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false,
    onResult: (r) => results.push(r as unknown as Record<string, unknown>),
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as { port: number }).port
})
afterAll(() => { stub.close(); proxy.close() })
beforeEach(() => { results = []; gzip = false })

function post(path: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'accept-encoding': 'gzip' } }, (res) => {
      res.resume(); res.on('end', () => resolve())
    })
    req.on('error', reject); req.write(body); req.end()
  })
}
const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })

describe('proxy result carries the turn shape', () => {
  it('reports a pure retrieval turn beside the usage', async () => {
    answer = sse('mcp__termpolis__retrieve_full')
    await post('/v1/messages', body)
    expect(results).toHaveLength(1)
    expect(results[0].turn).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
    expect(results[0].usage).toEqual({ input_tokens: 12, cache_read_input_tokens: 50000, cache_creation_input_tokens: 400, output_tokens: 137 })
  })

  it('reports a mixed turn as not pure', async () => {
    answer = sse('Read')
    await post('/v1/messages', body)
    expect(results[0].turn).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false })
  })

  it('reports an answer with no tool call as not pure', async () => {
    answer = sse(null)
    await post('/v1/messages', body)
    expect(results[0].turn).toEqual({ toolCalls: 0, retrieveCalls: 0, pure: false })
  })

  it('reads the shape out of a gzip-encoded answer', async () => {
    answer = sse('retrieve_full'); gzip = true
    await post('/v1/messages', body)
    expect(results[0].turn).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
  })
})
