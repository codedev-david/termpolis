import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'

/**
 * Every failure forwards the original bytes untouched: one proxy child serves every Claude session of an
 * app run, and a request it cannot handle must reach the API exactly as the client wrote it. Two lines of
 * defence hold this. The rewriter fails open on its own (returns the body it was given), and the server
 * fails open around the rewriter in case something outside the rewriter's own guard throws. The first was
 * tested; the second, the one that decides whether a thrown error becomes a 502 for the user, was not.
 * Faults are injected through the modules the rewriter and the server call.
 */

const fault = vi.hoisted(() => ({ rewrite: false, classify: false, stamp: false, turn: false }))
// What the server did, in order, when it read an answer: the end of the client's response and the three steps of
// reading the stream. Only the order test below looks at it.
const order = vi.hoisted(() => ({ trace: [] as string[], proxyPort: -1 }))

vi.mock('../../src/main/headroomProxy/wireCompress', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroomProxy/wireCompress')>('../../src/main/headroomProxy/wireCompress')
  return {
    ...real,
    rewriteMessagesBody: (...a: Parameters<typeof real.rewriteMessagesBody>): ReturnType<typeof real.rewriteMessagesBody> => {
      if (fault.rewrite) throw new Error('the rewriter blew up')
      return real.rewriteMessagesBody(...a)
    },
  }
})
vi.mock('../../src/main/headroomProxy/forwardedKinds', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroomProxy/forwardedKinds')>('../../src/main/headroomProxy/forwardedKinds')
  return {
    ...real,
    classifyMessages: (...a: Parameters<typeof real.classifyMessages>): ReturnType<typeof real.classifyMessages> => {
      if (fault.classify) throw new Error('the tally blew up')
      return real.classifyMessages(...a)
    },
  }
})
vi.mock('../../src/main/headroom/elisionMeta', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroom/elisionMeta')>('../../src/main/headroom/elisionMeta')
  return {
    ...real,
    stampModel: (...a: Parameters<typeof real.stampModel>): void => {
      if (fault.stamp) throw new Error('naming the model blew up')
      real.stampModel(...a)
    },
    stampPolicy: (...a: Parameters<typeof real.stampPolicy>): void => {
      if (fault.stamp) throw new Error('naming the policy blew up')
      real.stampPolicy(...a)
    },
  }
})

vi.mock('../../src/main/headroomProxy/usageParse', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroomProxy/usageParse')>('../../src/main/headroomProxy/usageParse')
  return {
    ...real,
    decodeBody: (...a: Parameters<typeof real.decodeBody>): ReturnType<typeof real.decodeBody> => {
      order.trace.push('decodeBody')
      return real.decodeBody(...a)
    },
    parseUsageFromSse: (...a: Parameters<typeof real.parseUsageFromSse>): ReturnType<typeof real.parseUsageFromSse> => {
      order.trace.push('parseUsage')
      return real.parseUsageFromSse(...a)
    },
    parseTurnShapeFromSse: (...a: Parameters<typeof real.parseTurnShapeFromSse>): ReturnType<typeof real.parseTurnShapeFromSse> => {
      order.trace.push('parseTurn')
      if (fault.turn) throw new Error('reading the turn blew up')
      return real.parseTurnShapeFromSse(...a)
    },
  }
})

const { createProxyServer } = await import('../../src/main/headroomProxy/proxyMain')
const { rewriteMessagesBody } = await import('../../src/main/headroomProxy/wireCompress')

const BIG = Array.from({ length: 90 }, (_, i) => `build step ${i}: compiled module ${i * 7} in ${i * 13} ms with 0 errors`).join('\n')
const body = JSON.stringify({
  model: 'claude-opus-5-5',
  messages: [
    { role: 'user', content: 'Please look into the failing build and tell me what you find in the log.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'Bash', input: { command: 'cat build.log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: BIG }] },
  ],
})

beforeEach(() => { fault.rewrite = false; fault.classify = false; fault.stamp = false; fault.turn = false })

describe('the server fails open around the rewriter', () => {
  let stub: http.Server, proxy: http.Server, port: number
  let upstreamBody = ''
  let results = 0
  const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":9,"cache_creation_input_tokens":0}}}\n\n'

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { upstreamBody = Buffer.concat(chunks).toString('utf8'); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE) })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false, onResult: () => { results++ } })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    port = (proxy.address() as { port: number }).port
  })
  afterAll(() => { stub.close(); proxy.close() })
  beforeEach(() => { upstreamBody = ''; results = 0 })

  const send = (b: string): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject); req.write(b); req.end()
  })

  it('when the rewriter throws, the API receives the exact bytes the client sent and the client gets its answer', async () => {
    fault.rewrite = true
    const r = await send(body)
    expect(r.status).toBe(200)
    expect(r.text).toBe(SSE)
    expect(upstreamBody).toBe(body)
    // Nothing was rewritten, so there is nothing to count: the request is not in any ledger.
    expect(results).toBe(0)
  })

  it('and with nothing wrong the same request is shortened, so the test above is about the throw and not about the body', async () => {
    const r = await send(body)
    expect(r.status).toBe(200)
    expect(upstreamBody).not.toBe(body)
    expect(upstreamBody.length).toBeLessThan(body.length)
    expect(results).toBe(1)
  })

  it('a body that is not JSON at all is forwarded as it came', async () => {
    const junk = '{"messages": [not json'
    const r = await send(junk)
    expect(r.status).toBe(200)
    expect(upstreamBody).toBe(junk)
  })
})

describe('the rewriter keeps its compression when only the bookkeeping fails', () => {
  it('a fault in the stub tally leaves the shortened body, and an empty tally', () => {
    const clean = rewriteMessagesBody(body)
    expect(clean.changed).toBe(true)
    expect(clean.stats.kinds.compact).toBe(1)
    fault.classify = true
    const r = rewriteMessagesBody(body)
    expect(r.changed).toBe(true)
    expect(r.body).toBe(clean.body)
    expect(r.stashes).toEqual(clean.stashes)
    expect(r.stats.kinds).toEqual({ plain: 0, compact: 0, dedup: 0, diff: 0, aged: 0, agedEarly: 0 })
  })

  it('a fault in naming the model or the policy leaves the shortened body, and the stash it must be able to redeem', () => {
    const clean = rewriteMessagesBody(body)
    fault.stamp = true
    const r = rewriteMessagesBody(body)
    expect(r.changed).toBe(true)
    expect(r.body).toBe(clean.body)
    expect(r.stashes).toHaveLength(1)
    expect(r.stashes[0].token).toBe(clean.stashes[0].token)
    expect(r.stashes[0].original).toBe(BIG)
    // The footer of the shortened result names a token the stash can answer for.
    expect(r.body).toContain(r.stashes[0].token)
  })

  it('an unchanged body stays unchanged when the tally throws: the original bytes, not a re-serialisation', () => {
    const small = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello there' }] })
    fault.classify = true
    const r = rewriteMessagesBody(small)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(small)
  })
})

// The usage of an answer and the shape of its turn are read in two passes over the same stream. The
// shape is bookkeeping for the retrieval charge: if reading it ever failed, the usage (the cost the whole
// ledger rests on) has to arrive all the same, as it did before the shape was read at all.
describe('the server keeps the usage of an answer whose turn it cannot read', () => {
  let stub: http.Server, proxy: http.Server, port: number
  const results: Array<{ usage: unknown; turn: unknown; changed: boolean; status: number }> = []
  const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const SSE =
    ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 3, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 10, output_tokens: 1 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'mcp__termpolis__retrieve_full', input: {} } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"token":"hr_0123456789abcdef"}' } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 90 } })

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE) })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false, onResult: (r) => { results.push(r) } })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    port = (proxy.address() as { port: number }).port
  })
  afterAll(() => { stub.close(); proxy.close() })
  beforeEach(() => { results.length = 0 })

  const send = (b: string): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject); req.write(b); req.end()
  })

  it('reads the turn of an answer when nothing is wrong, so the test below is about the throw', async () => {
    const r = await send(body)
    expect(r.text).toBe(SSE)
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].turn).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
    expect(results[0].usage).toEqual({ input_tokens: 3, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 10, output_tokens: 90 })
  })

  it('when reading the turn throws, the result still arrives with the usage and a turn that charges nothing', async () => {
    fault.turn = true
    const r = await send(body)
    expect(r.status).toBe(200)
    expect(r.text).toBe(SSE) // the client gets the whole answer
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].usage).toEqual({ input_tokens: 3, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 10, output_tokens: 90 })
    expect(results[0].turn).toEqual({ toolCalls: 0, retrieveCalls: 0, pure: false })
    expect(results[0]).toMatchObject({ changed: true, status: 200 })
  })
})

// Speed (D11). Reading an answer (unzipping it, then two passes over it for its usage and the shape of its turn) takes a
// few milliseconds on a short one and tens on a long one, and the person reading it must not wait for that: the
// client's response is ended FIRST and the bookkeeping runs after, as it did in v1.54.4 for the usage. A parse moved
// above res.end() would delay the end of every streamed answer by the parse time and nothing else would notice.
describe('the server ends the client\'s answer before it reads it', () => {
  let stub: http.Server, proxy: http.Server, port: number
  let realEnd: typeof http.ServerResponse.prototype.end
  const done: unknown[] = []
  const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const SSE =
    ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 3, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 10, output_tokens: 1 } } }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } })

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE) })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false, onResult: (r) => { done.push(r) } })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    port = (proxy.address() as { port: number }).port
    order.proxyPort = port
    // The stub in this file is a server too, so only a response written on the proxy's own port is the one that matters.
    realEnd = http.ServerResponse.prototype.end
    http.ServerResponse.prototype.end = function (this: http.ServerResponse, ...a: unknown[]): http.ServerResponse {
      if (this.socket?.localPort === order.proxyPort) order.trace.push('end')
      return (realEnd as (...b: unknown[]) => http.ServerResponse).apply(this, a)
    } as typeof realEnd
  })
  afterAll(() => { http.ServerResponse.prototype.end = realEnd; order.proxyPort = -1; stub.close(); proxy.close() })
  beforeEach(() => { done.length = 0; order.trace.length = 0 })

  const send = (b: string): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) } }, (res) => {
      res.on('data', () => {})
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject); req.write(b); req.end()
  })

  it('ends the response first, then decodes the stream, then reads the usage, then the turn', async () => {
    expect(await send(body)).toBe(200)
    await vi.waitFor(() => { expect(done).toHaveLength(1) })
    expect(order.trace).toEqual(['end', 'decodeBody', 'parseUsage', 'parseTurn'])
  })

  it('does the same for a request the rewriter left unchanged: it is counted, so its answer is read, still after the end', async () => {
    const small = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello there' }] })
    expect(await send(small)).toBe(200)
    await vi.waitFor(() => { expect(done).toHaveLength(1) })
    expect(done[0]).toMatchObject({ changed: false })
    expect(order.trace).toEqual(['end', 'decodeBody', 'parseUsage', 'parseTurn'])
  })

  it('and reads nothing of the answer to a request the rewriter threw on, which is forwarded untouched and counted nowhere', async () => {
    fault.rewrite = true
    expect(await send(body)).toBe(200)
    await vi.waitFor(() => { expect(order.trace).toContain('end') })
    expect(order.trace).toEqual(['end'])
    expect(done).toHaveLength(0)
  })

  it('observes only the proxy\'s own responses, so the test above is about the server and not about the stub', async () => {
    await send(body)
    await vi.waitFor(() => { expect(done).toHaveLength(1) })
    // The stub also ends a response (with the stream) before the proxy reads it; it is not in the trace.
    expect(order.trace.filter((t) => t === 'end')).toHaveLength(1)
  })
})
