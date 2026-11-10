// v1.58.0 Codex effort per message: the proxy server's Codex path, against a local stub upstream.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import * as zlib from 'zlib'
import { createProxyServer } from '../../src/main/headroomProxy/proxyMain'
import { setCodexAsker, setCodexRoute, _resetCodexRouteForTests, type CodexAsk } from '../../src/main/headroomProxy/codexRoute'

const z = zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer; zstdDecompressSync: (b: Buffer) => Buffer }

interface Seen { method: string; url: string; host: string; body: Buffer; encoding: string }
let seen: Seen[] = []
/** Status the stub answers with, per request in order (200 once the list runs out). */
let statuses: number[] = []
let stub: http.Server, proxy: http.Server, proxyPort: number, stubPort: number
let upstreamPort = 0

const body = (text: string, effort = 'medium'): string =>
  `{"model":"gpt-5.5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":${JSON.stringify(text)}}]}],"tools":[],"parallel_tool_calls":false,"reasoning":{"effort":"${effort}","summary":"auto"},"stream":true}`
const PATH = (t: string, rest = '/responses'): string => `/termpolis-codex/${t}/backend-api/codex${rest}`

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    const cs: Buffer[] = []
    req.on('data', (c) => cs.push(c))
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', host: String(req.headers.host), body: Buffer.concat(cs), encoding: String(req.headers['content-encoding'] || '') })
      const status = statuses.shift() ?? 200
      res.writeHead(status, { 'content-type': 'text/event-stream', 'x-stub': 'yes' })
      res.end(status === 200 ? 'data: {"type":"response.completed"}\n\n' : '{"error":"bad effort"}')
    })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
  stubPort = (stub.address() as { port: number }).port
  upstreamPort = stubPort
  proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort: stubPort, useHttps: false, codexUpstream: () => ({ hostname: '127.0.0.1', port: upstreamPort, https: false }) })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as { port: number }).port
})
afterAll(() => { stub.close(); proxy.close() })

let asks: CodexAsk[] = []
let answer: string | null = null
beforeEach(() => {
  seen = []; statuses = []; asks = []; answer = null; upstreamPort = stubPort
  _resetCodexRouteForTests()
  // Main answers at once, as the real one does over the frame.
  setCodexAsker((q) => { asks.push(q); queueMicrotask(() => setCodexRoute(q.terminal, q.key, answer)) })
})

function send(method: string, path: string, payload: Buffer | null, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string | number> = { ...headers }
    if (payload) h['content-length'] = payload.length
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path, method, headers: h }, (res) => {
      const cs: Buffer[] = []
      res.on('data', (c) => cs.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(cs).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}

describe('proxy Codex path', () => {
  it('sends a new typed turn at the effort main picked, to the real path, with the host rewritten', async () => {
    answer = 'low'
    const text = body('rename foo to bar')
    const r = await send('POST', PATH('t1'), Buffer.from(text), { 'content-type': 'application/json', authorization: 'Bearer eyJ' })
    expect(r.status).toBe(200)
    expect(r.headers['x-stub']).toBe('yes')
    expect(r.body).toContain('response.completed')
    expect(asks).toEqual([{ terminal: 't1', key: 1, task: 'rename foo to bar', asked: 'medium' }])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/backend-api/codex/responses', host: 'chatgpt.com' })
    expect(seen[0].body.toString('utf8')).toBe(text.replace('"effort":"medium"', '"effort":"low"'))
  })

  it('an API key goes to the /v1 path on api.openai.com', async () => {
    await send('POST', PATH('t2'), Buffer.from(body('hi')), { authorization: 'Bearer sk-test' })
    expect(seen[0]).toMatchObject({ url: '/v1/responses', host: 'api.openai.com' })
    expect(seen[0].body.toString('utf8')).toBe(body('hi')) // main answered null: as asked
  })

  it('re-compresses a zstd body after the edit', async () => {
    answer = 'high'
    const text = body('design the sync protocol')
    await send('POST', PATH('t3'), z.zstdCompressSync(Buffer.from(text)), { 'content-encoding': 'zstd' })
    expect(seen[0].encoding).toBe('zstd')
    expect(z.zstdDecompressSync(seen[0].body).toString('utf8')).toBe(text.replace('"effort":"medium"', '"effort":"high"'))
  })

  it('a refused effort is sent again exactly as Codex sent it', async () => {
    answer = 'xhigh'
    statuses = [400]
    const text = body('think very hard about this')
    const r = await send('POST', PATH('t4'), Buffer.from(text))
    expect(r.status).toBe(200)
    expect(seen.map((s) => s.body.toString('utf8'))).toEqual([text.replace('"effort":"medium"', '"effort":"xhigh"'), text])
  })

  it('blames the effort only when the original then goes through', async () => {
    // Refused both ways (a long context, say): the error is Codex's, and the effort stays usable.
    answer = 'low'
    statuses = [400, 400]
    const r = await send('POST', PATH('t12'), Buffer.from(body('one')))
    expect(r.status).toBe(400)
    expect(seen).toHaveLength(2)
    seen = []
    await send('POST', PATH('t12'), Buffer.from(body('one').replace('"input":[', '"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"two"}]},')))
    expect(seen[0].body.toString('utf8')).toContain('"effort":"low"')
    // Refused routed, taken as asked: xhigh is not sent again, high is the next best.
    answer = 'xhigh'
    statuses = [400]
    seen = []
    await send('POST', PATH('t13'), Buffer.from(body('a')))
    expect(seen.map((s) => /"effort":"(\w+)"/.exec(s.body.toString('utf8'))?.[1])).toEqual(['xhigh', 'medium'])
    seen = []
    await send('POST', PATH('t13'), Buffer.from(body('a').replace('"input":[', '"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"b"}]},')))
    expect(seen[0].body.toString('utf8')).toContain('"effort":"high"')
  })

  it('sends nothing upstream when Codex hangs up while main is still deciding', async () => {
    setCodexAsker((q) => { asks.push(q) }) // main never answers in time
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path: PATH('t14'), method: 'POST' })
      req.on('error', () => resolve())
      req.end(body('slow one'))
      setTimeout(() => { req.destroy(); resolve() }, 100)
    })
    await new Promise((r) => setTimeout(r, 650))
    expect(asks).toHaveLength(1)
    expect(seen).toHaveLength(0)
  })

  it('a refusal of an unrouted request is passed back as it came', async () => {
    statuses = [404]
    const r = await send('POST', PATH('t5'), Buffer.from(body('hello')))
    expect(r.status).toBe(404)
    expect(seen).toHaveLength(1)
  })

  it('forwards anything that is not a model turn untouched, query and all', async () => {
    const r = await send('GET', PATH('t6', '/models?client_version=0.9'), null)
    expect(r.status).toBe(200)
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/backend-api/codex/models?client_version=0.9' })
    expect(asks).toHaveLength(0)
    // A body in an encoding it cannot read goes as it came.
    const gz = zlib.gzipSync(Buffer.from(body('x')))
    await send('POST', PATH('t6'), gz, { 'content-encoding': 'gzip' })
    expect(seen[1].body.equals(gz)).toBe(true)
    expect(asks).toHaveLength(0)
  })

  it('answers 502 when the upstream cannot be reached', async () => {
    const closed = net.createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (closed.address() as { port: number }).port
    await new Promise<void>((r) => closed.close(() => r()))
    const r = await send('POST', PATH('t7'), Buffer.from(body('hi')))
    expect(r.status).toBe(502)
    expect(r.body).toContain('headroom proxy upstream error')
  })

  it('answers 502 when the request cannot even be built', async () => {
    upstreamPort = 70000 // out of range: http.request throws at once
    const r = await send('POST', PATH('t9'), Buffer.from(body('hi')))
    expect(r.status).toBe(502)
    expect(r.body).toContain('headroom proxy request error')
  })

  it('closes the upstream request when Codex hangs up mid-stream, and the reply when the upstream dies', async () => {
    let upstreamClosed!: () => void
    const closed = new Promise<void>((r) => { upstreamClosed = r })
    const held = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"type":"response.created"}\n\n')
        if (req.url?.includes('die')) setTimeout(() => res.socket?.destroy(), 20)
      })
      res.on('close', () => upstreamClosed())
    })
    await new Promise<void>((r) => held.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (held.address() as { port: number }).port
    try {
      // Codex hangs up after the first event: the upstream request goes too.
      await new Promise<void>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: proxyPort, path: PATH('t10'), method: 'POST' }, (res) => {
          res.once('data', () => { req.destroy(); resolve() })
        })
        req.on('error', () => resolve())
        req.end(body('stream'))
      })
      await closed
      // The upstream dies mid-reply: Codex's side is closed rather than left hanging.
      const ended = await new Promise<string>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: proxyPort, path: PATH('t11', '/die'), method: 'POST' }, (res) => {
          res.on('data', () => {})
          res.on('error', () => resolve('error'))
          res.on('close', () => resolve('close'))
        })
        req.on('error', () => resolve('error'))
        req.end('x')
      })
      expect(['error', 'close']).toContain(ended)
    } finally { held.closeAllConnections(); held.close() }
  })

  it('answers a Codex WebSocket upgrade 426, and drops any other upgrade', async () => {
    const upgrade = (path: string): Promise<string> => new Promise((resolve) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
      })
      let got = ''
      sock.on('data', (d) => { got += d.toString() })
      sock.on('close', () => resolve(got))
      sock.on('error', () => resolve(got))
    })
    expect(await upgrade(PATH('t8'))).toMatch(/^HTTP\/1\.1 426 /)
    expect(await upgrade('/v1/messages')).toBe('')
  })
})
