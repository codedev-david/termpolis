import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import {
  planRequest, setRoute, routeOf, terminalOf, isRouteFamily, noteRefused, isRefusal, asksHourCache,
  _resetModelRouteForTests, ROUTE_HEADER, DEFAULT_MODEL_IDS,
} from '../../src/main/headroomProxy/modelRoute'
const { createProxyServer, resultFrame, routeFields } = await import('../../src/main/headroomProxy/proxyMain')

const TOOLS = '"tools":[{"name":"Bash","input_schema":{}}]'
const body = (model: string, extra = TOOLS): string => `{"model":"${model}","max_tokens":10,${extra},"messages":[{"role":"user","content":"x \\"model\\":\\"y\\""}]}`
const H = (terminal?: string, session?: string): Record<string, string> => ({
  ...(terminal ? { [ROUTE_HEADER]: terminal } : {}),
  ...(session ? { 'x-claude-code-session-id': session } : {}),
})

beforeEach(() => _resetModelRouteForTests())

describe('modelRoute', () => {
  it('helpers', () => {
    expect(isRouteFamily('opus')).toBe(true)
    expect(isRouteFamily('fable')).toBe(false)
    expect(isRouteFamily(1)).toBe(false)
    expect(isRefusal(400)).toBe(true)
    expect(isRefusal(404)).toBe(true)
    expect(isRefusal(200)).toBe(false)
    expect(isRefusal(undefined)).toBe(false)
    expect(asksHourCache('{"cache_control":{"type":"ephemeral","ttl":"1h"}}')).toBe(true)
    expect(asksHourCache('{}')).toBe(false)
    expect(terminalOf({ [ROUTE_HEADER]: ' t-1 ' })).toBe('t-1')
    expect(terminalOf({ [ROUTE_HEADER]: ['t2', 't3'] })).toBe('t2')
    expect(terminalOf({ [ROUTE_HEADER]: 'bad id!' })).toBeNull()
    expect(terminalOf({})).toBeNull()
  })

  it('setRoute validates and clears', () => {
    setRoute('t', 'haiku')
    expect(routeOf('t')).toBe('haiku')
    setRoute('t', null)
    expect(routeOf('t')).toBeUndefined()
    setRoute('bad id!', 'haiku')
    setRoute(5, 'haiku')
    expect(routeOf('bad id!')).toBeUndefined()
  })

  it('rewrites only the top-level model of a routed main request', () => {
    setRoute('t', 'haiku')
    const b = body('claude-opus-5-5')
    const p = planRequest(b, H('t', 's1'))
    expect(p).toMatchObject({ terminal: 't', asked: 'opus', used: 'haiku', main: true, original: b })
    expect(p.body).toBe(body(DEFAULT_MODEL_IDS.haiku))
    expect(p.body).toContain('\\"model\\":\\"y\\"') // the one inside a message is untouched
  })

  it('uses the id the account has already sent for that family', () => {
    planRequest(body('claude-haiku-4-9-20990101', '"tools":[]'), H('other'))
    setRoute('t', 'haiku')
    expect(planRequest(body('claude-opus-5-5'), H('t')).body).toContain('"model":"claude-haiku-4-9-20990101"')
  })

  it('leaves alone: no header, no tools, no model, an unknown model, no route, the same family', () => {
    setRoute('t', 'haiku')
    const plain = (b: string, h: Record<string, string>) => {
      const p = planRequest(b, h)
      expect(p.body).toBe(b)
      expect(p.original).toBeUndefined()
      return p
    }
    plain(body('claude-opus-5-5'), H())
    expect(plain(body('claude-opus-5-5', '"tools":[]'), H('t')).main).toBe(false)
    expect(plain(body('claude-opus-5-5', '"system":"s"'), H('t')).main).toBe(false)
    plain('{"messages":[]}', H('t'))
    plain('not json', H('t'))
    expect(plain(body('claude-fable-5-1'), H('u')).asked).toBe('fable')
    plain(body('claude-opus-5-5'), H('noroute'))
    setRoute('h', 'haiku')
    expect(plain(body('claude-haiku-5-5'), H('h')).main).toBe(true)
  })

  it('a different family later in the session is a subagent and is not rewritten', () => {
    setRoute('t', 'opus')
    const first = planRequest(body('claude-sonnet-5-5'), H('t', 's1'))
    expect(first.used).toBe('opus')
    const sub = planRequest(body('claude-haiku-5-5'), H('t', 's1'))
    expect(sub.main).toBe(false)
    expect(sub.original).toBeUndefined()
    // a new session (/clear, a resume) sets the main family again
    expect(planRequest(body('claude-haiku-5-5'), H('t', 's2'))).toMatchObject({ main: true, used: 'opus' })
  })

  it('a refused model is not tried again for that terminal', () => {
    setRoute('t', 'haiku')
    noteRefused('t', 'haiku')
    expect(routeOf('t')).toBeUndefined()
    setRoute('t', 'haiku')
    expect(planRequest(body('claude-opus-5-5'), H('t')).original).toBeUndefined()
    noteRefused(null, 'haiku')
    noteRefused('t', 'other')
    setRoute('t', 'sonnet')
    noteRefused('t', 'opus') // a different family: the route stays
    expect(routeOf('t')).toBe('sonnet')
  })

  it('routeFields and resultFrame carry the routing facts', () => {
    expect(routeFields(null, Buffer.from(''))).toEqual({})
    const noTerm = planRequest(body('claude-opus-5-5'), H())
    expect(routeFields(noTerm, Buffer.from(''))).toEqual({})
    const p = planRequest(body('claude-opus-5-5'), H('t'))
    expect(routeFields(p, Buffer.from('"ttl":"1h"'), 'haiku')).toEqual({ terminal: 't', main: true, ttl1h: true, refused: 'haiku' })
    const sub = { ...p, main: false }
    expect(routeFields(sub, Buffer.from('{}'))).toEqual({ terminal: 't' })
    const f = resultFrame({ changed: false, stats: {} as never, usage: {} as never, turn: { toolCalls: 0, retrieveCalls: 0, pure: false }, stashes: [], status: 200, terminal: 't', main: true, ttl1h: true, refused: 'haiku' } as never)
    expect(f).toMatchObject({ terminal: 't', main: true, ttl1h: true, refused: 'haiku' })
    const g = resultFrame({ changed: false, stats: {} as never, usage: {} as never, turn: { toolCalls: 0, retrieveCalls: 0, pure: false }, stashes: [], status: 200 } as never)
    expect(g).not.toHaveProperty('terminal')
    expect(g).not.toHaveProperty('main')
  })
})

describe('the proxy routes a session', () => {
  const SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":5000,"cache_creation_input_tokens":40}}}',
    '', 'event: message_stop', 'data: {"type":"message_stop"}', '',
  ].join('\n')
  let stub: http.Server, proxy: http.Server, port: number
  let seen: Array<{ body: string; headers: http.IncomingHttpHeaders }> = []
  let refuse: (b: string) => boolean = () => false
  let results: Array<Record<string, unknown>> = []

  beforeEach(async () => {
    seen = []; results = []; refuse = () => false
    stub = http.createServer((req, res) => {
      const c: Buffer[] = []
      req.on('data', (d) => c.push(d))
      req.on('end', () => {
        const b = Buffer.concat(c).toString('utf8')
        seen.push({ body: b, headers: req.headers })
        if (refuse(b)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"model"}'); return }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE)
      })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    proxy = createProxyServer({
      upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false,
      onResult: (r) => results.push(r as unknown as Record<string, unknown>),
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    port = (proxy.address() as { port: number }).port
  })
  afterEach(() => { stub.close(); proxy.close() })

  function post(b: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
      req.on('error', reject); req.write(b); req.end()
    })
  }

  it('sends the routed model, strips the tag, and reports the routing facts', async () => {
    setRoute('t1', 'haiku')
    const b = body('claude-opus-5-5', `${TOOLS},"system":[{"type":"text","text":"s","cache_control":{"type":"ephemeral","ttl":"1h"}}]`)
    expect(await post(b, { [ROUTE_HEADER]: 't1' })).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].body).toContain(`"model":"${DEFAULT_MODEL_IDS.haiku}"`)
    expect(seen[0].headers[ROUTE_HEADER]).toBeUndefined()
    expect(results[0]).toMatchObject({ terminal: 't1', main: true, ttl1h: true, model: 'haiku' })
    expect(results[0].refused).toBeUndefined()
  })

  it('a refused model is retried as asked, reported, and not tried again', async () => {
    setRoute('t1', 'haiku')
    refuse = (s) => s.includes('haiku')
    const b = body('claude-opus-5-5')
    expect(await post(b, { [ROUTE_HEADER]: 't1' })).toBe(200)
    expect(seen).toHaveLength(2)
    expect(seen[1].body).toContain('"model":"claude-opus-5-5"')
    expect(results[0]).toMatchObject({ terminal: 't1', main: true, refused: 'haiku', model: 'opus' })
    seen = []
    setRoute('t1', 'haiku')
    expect(await post(b, { [ROUTE_HEADER]: 't1' })).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].body).toContain('"model":"claude-opus-5-5"')
  })

  it('an unrouted request passes through with its own model', async () => {
    refuse = () => true // a 400 on an unrouted request reaches the client as it is
    expect(await post(body('claude-opus-5-5'), { [ROUTE_HEADER]: 't9' })).toBe(400)
    expect(seen).toHaveLength(1)
    expect(seen[0].body).toContain('"model":"claude-opus-5-5"')
  })
})
