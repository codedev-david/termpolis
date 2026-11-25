// MODELHOME review M-10: proxyMain's branches the other proxy tests leave out. The result frame's
// subagent and struggling fields, a Codex upstream reached over TLS, and a Codex upstream that resets
// the connection after its answer has begun.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import { createProxyServer, resultFrame } from '../../src/main/headroomProxy/proxyMain'
import { setCodexAsker, setCodexRoute, _resetCodexRouteForTests } from '../../src/main/headroomProxy/codexRoute'

const body = `{"model":"gpt-5.5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"tools":[],"reasoning":{"effort":"medium"},"stream":true}`
const PATH = '/termpolis-codex/t1/backend-api/codex/responses'

let target = { hostname: '127.0.0.1', port: 0, https: false }
let plain: http.Server, resetter: net.Server, proxy: http.Server, proxyPort: number

beforeAll(async () => {
  plain = http.createServer((_req, res) => { res.writeHead(200); res.end('plain') })
  // Answers with a head and part of a body, then resets the connection.
  resetter = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n5\r\ndata:\r\n', () => {
        setTimeout(() => (sock as net.Socket & { resetAndDestroy: () => void }).resetAndDestroy(), 20)
      })
    })
  })
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()))
  await new Promise<void>((r) => resetter.listen(0, '127.0.0.1', () => r()))
  proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort: 1, useHttps: false, codexUpstream: () => target })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as { port: number }).port
})
afterAll(() => { plain.close(); resetter.close(); proxy.close() })

beforeEach(() => {
  _resetCodexRouteForTests()
  setCodexAsker((q) => { queueMicrotask(() => setCodexRoute(q.terminal, q.key, null)) })
})

function send(): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(body)
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: PATH, method: 'POST', headers: { 'content-length': payload.length, authorization: 'Bearer eyJ' } }, (res) => {
      const cs: Buffer[] = []
      res.on('data', (c) => cs.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(cs).toString('utf8') }))
      res.on('error', (e) => resolve({ error: e.message }))
      res.on('aborted', () => resolve({ error: 'aborted' }))
    })
    req.on('error', (e) => resolve({ error: e.message }))
    req.end(payload)
  })
}

describe('proxyMain branches', () => {
  it("the result frame carries a subagent's flag and the struggling level", () => {
    const f = resultFrame({ changed: false, stats: undefined as never, usage: undefined as never, turn: undefined as never, stashes: [], status: 200, agent: true, escalated: 2 } as Parameters<typeof resultFrame>[0])
    expect(f).toMatchObject({ kind: 'result', agent: true, escalated: 2 })
    const g = resultFrame({ changed: false, stats: undefined as never, usage: undefined as never, turn: undefined as never, stashes: [], status: 200 } as Parameters<typeof resultFrame>[0])
    expect(g).not.toHaveProperty('agent')
    expect(g).not.toHaveProperty('escalated')
  })

  it('a Codex upstream reached over TLS that does not speak it answers 502', async () => {
    target = { hostname: '127.0.0.1', port: (plain.address() as { port: number }).port, https: true }
    const r = await send()
    expect(r).toMatchObject({ status: 502 })
    expect((r as { body: string }).body).toContain('headroom proxy upstream error')
  })

  it('a Codex upstream that resets after its answer began cuts the client off, without a second head', async () => {
    target = { hostname: '127.0.0.1', port: (resetter.address() as { port: number }).port, https: false }
    const r = await send()
    // The head was already sent: the proxy can only drop the connection, so the answer is cut off
    // mid-body (an end() here would read as a whole, short answer).
    expect(r).toEqual({ error: 'aborted' })
  })
})
