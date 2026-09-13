import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/*
 * The proxy's whole contract is "never throw, never hang, never lie". Every arm below is one of the
 * failure shapes it is built to absorb — a client that vanished mid-stream, a response object whose
 * socket is already gone, an upstream that answers without a status line, a consumer that throws.
 * Reaching those against a real socket is impossible (statusCode is always set, writeHead never
 * throws), so the upstream side is a stand-in: `agentMod.request` is mocked on BOTH schemes and the
 * server handler is driven directly with a synthetic req/res pair. `http.createServer` stays real —
 * only `http.request` is replaced — so the module under test is otherwise untouched.
 */
const ctl = vi.hoisted(() => {
  interface Call {
    opts: Record<string, unknown>
    cb: (up: unknown) => void
    body: Buffer | null
    onError: Array<(e: Error) => void>
  }
  const state = {
    calls: [] as Call[],
    /** set to make agentMod.request throw synchronously, the way an invalid method/header does */
    throwOnRequest: null as Error | null,
    request(opts: Record<string, unknown>, cb: (up: unknown) => void): unknown {
      if (state.throwOnRequest) throw state.throwOnRequest
      const call: Call = { opts, cb, body: null, onError: [] }
      state.calls.push(call)
      return {
        on(ev: string, h: (e: Error) => void) { if (ev === 'error') call.onError.push(h); return this },
        end(b?: Buffer) { call.body = b ?? null },
      }
    },
    reset(): void { state.calls = []; state.throwOnRequest = null },
  }
  return state
})

vi.mock('https', () => {
  const request = (o: Record<string, unknown>, c: (up: unknown) => void): unknown => ctl.request(o, c)
  return { request, default: { request } }
})
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>()
  const request = (o: Record<string, unknown>, c: (up: unknown) => void): unknown => ctl.request(o, c)
  return { ...actual, default: actual, request }
})

const { createProxyServer, setPrefixDecay } = await import('../../src/main/headroomProxy/proxyMain')
const {
  setProxySpawner, startProxy, stopProxy, setProxyMode, setProxyThinkingCap, setProxyDecay, _resetProxyForTest,
} = await import('../../src/main/headroomProxy/proxySupervisor')
type ProxyTransport = import('../../src/main/headroomProxy/proxySupervisor').ProxyTransport
type ProxyResult = import('../../src/main/headroomProxy/proxyMain').ProxyResult

/* ── synthetic req/res/upstream ─────────────────────────────────────────────────────────────── */

type Handler = (arg?: unknown) => void

interface FakeReq {
  url?: string
  method?: string
  headers: Record<string, string>
  on(ev: string, h: Handler): FakeReq
  emit(ev: string, a?: unknown): void
}

function makeReq(url: string | undefined, method: string, headers: Record<string, string> = {}): FakeReq {
  const hs: Record<string, Handler[]> = {}
  return {
    url,
    method,
    headers,
    on(ev, h) { (hs[ev] ||= []).push(h); return this },
    emit(ev, a) { for (const h of hs[ev] || []) h(a) },
  }
}

class FakeRes {
  headersSent = false
  head: [number, unknown] | null = null
  chunks: Buffer[] = []
  ended = false
  endedBody = ''
  destroyed = false
  writeHeadThrows = false
  writeThrows = false
  endThrows = false
  destroyThrows = false
  writeHead(code: number, headers?: unknown): void {
    if (this.writeHeadThrows) throw new Error('socket already gone')
    this.head = [code, headers]
    this.headersSent = true
  }
  write(c: Buffer): boolean {
    if (this.writeThrows) throw new Error('client gone')
    this.chunks.push(Buffer.from(c))
    return true
  }
  end(body?: unknown): void {
    if (this.endThrows) throw new Error('already ended')
    if (body != null) this.endedBody = String(body)
    this.ended = true
  }
  destroy(): void {
    if (this.destroyThrows) throw new Error('no socket')
    this.destroyed = true
  }
  get text(): string { return Buffer.concat(this.chunks).toString('utf8') }
}

interface FakeUp {
  statusCode: number | undefined
  headers: Record<string, string>
  on(ev: string, h: Handler): FakeUp
  emit(ev: string, a?: unknown): void
}

function makeUp(statusCode: number | undefined, headers: Record<string, string> = {}): FakeUp {
  const hs: Record<string, Handler[]> = {}
  return {
    statusCode,
    headers,
    on(ev, h) { (hs[ev] ||= []).push(h); return this },
    emit(ev, a) { for (const h of hs[ev] || []) h(a) },
  }
}

type Server = ReturnType<typeof createProxyServer>

/** Feed one request through the server's handler exactly as Node would. */
async function drive(server: Server, req: FakeReq, res: FakeRes, chunks: unknown[] = []): Promise<void> {
  ;(server as unknown as { emit(ev: string, a: unknown, b: unknown): boolean }).emit('request', req, res)
  for (const c of chunks) req.emit('data', c)
  req.emit('end')
  await Promise.resolve()
  await Promise.resolve()
}

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":900,"cache_creation_input_tokens":7}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":33}}',
  '',
].join('\n')

const BIG = Array.from({ length: 140 }, (_, i) => `log line ${i} with enough content to be worth eliding`).join('\n')
const COMPRESSIBLE = JSON.stringify({
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: BIG }] }],
})

beforeEach(() => { ctl.reset(); setPrefixDecay(false) })
afterEach(() => { setPrefixDecay(false) })

/* ── proxyMain: upstream target selection ───────────────────────────────────────────────────── */

describe('headroom proxy — upstream target selection', () => {
  it('defaults to https on 443, rewrites Host, and re-states content-length for the SHRUNKEN body', async () => {
    const srv = createProxyServer({ upstreamHost: 'api.anthropic.com' }) // useHttps omitted → https
    const res = new FakeRes()
    await drive(srv, makeReq('/v1/messages?beta=true', 'POST', {
      'content-type': 'application/json',
      host: '127.0.0.1:9931', // what the client dialled — must NOT reach Anthropic
      'content-length': String(Buffer.byteLength(COMPRESSIBLE)),
    }), res, [Buffer.from(COMPRESSIBLE)])

    expect(ctl.calls).toHaveLength(1)
    const c = ctl.calls[0]
    expect(c.opts.port).toBe(443)
    expect(c.opts.hostname).toBe('api.anthropic.com')
    expect(c.opts.path).toBe('/v1/messages?beta=true')
    expect(c.opts.method).toBe('POST')
    const headers = c.opts.headers as Record<string, unknown>
    expect(headers.host).toBe('api.anthropic.com')
    expect(headers['content-type']).toBe('application/json') // client headers otherwise pass through

    expect(c.body).not.toBeNull()
    expect(c.body!.length).toBeLessThan(Buffer.byteLength(COMPRESSIBLE)) // it really did compress
    // The stale client content-length would truncate the rewritten body upstream — the single most
    // damaging thing this proxy could get wrong, and invisible until Anthropic rejects the JSON.
    expect(headers['content-length']).toBe(c.body!.length)
  })

  it('falls back to plain http on 80 when https is switched off and no port is given', async () => {
    const srv = createProxyServer({ upstreamHost: 'proxy.internal.example', useHttps: false })
    await drive(srv, makeReq('/health', 'GET', {}), new FakeRes())
    expect(ctl.calls[0].opts.port).toBe(80)
    expect(ctl.calls[0].opts.hostname).toBe('proxy.internal.example')
  })

  it('an explicit upstreamPort wins over the scheme default', async () => {
    const srv = createProxyServer({ upstreamHost: '127.0.0.1', useHttps: false, upstreamPort: 8123 })
    await drive(srv, makeReq('/v1/messages', 'POST', {}), new FakeRes(), [Buffer.from(COMPRESSIBLE)])
    expect(ctl.calls[0].opts.port).toBe(8123)
  })
})

/* ── proxyMain: what does and does not get rewritten ────────────────────────────────────────── */

describe('headroom proxy — only POST /v1/messages is rewritten', () => {
  function srv(sink: { results: ProxyResult[] }): Server {
    return createProxyServer({ upstreamHost: 'api.anthropic.com', onResult: (r) => sink.results.push(r) })
  }

  it('a GET to /v1/messages is forwarded byte-for-byte and never reported to the ledger', async () => {
    const sink = { results: [] as ProxyResult[] }
    const s = srv(sink)
    const res = new FakeRes()
    await drive(s, makeReq('/v1/messages', 'GET', {}), res, [Buffer.from(COMPRESSIBLE)])

    expect(ctl.calls[0].body!.toString('utf8')).toBe(COMPRESSIBLE) // identical to the POST fixture
    const up = makeUp(200, {})
    ctl.calls[0].cb(up)
    up.emit('data', Buffer.from(SSE))
    up.emit('end')
    expect(sink.results).toEqual([]) // nothing was rewritten, so there is nothing to account for
    expect(res.ended).toBe(true)
  })

  it('a request that arrives with no url at all is treated as pass-through, not as /v1/messages', async () => {
    const sink = { results: [] as ProxyResult[] }
    const s = srv(sink)
    const res = new FakeRes()
    await drive(s, makeReq(undefined, 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    expect(ctl.calls[0].opts.path).toBeUndefined()
    expect(ctl.calls[0].body!.toString('utf8')).toBe(COMPRESSIBLE)
    const up = makeUp(200, {})
    ctl.calls[0].cb(up)
    up.emit('end')
    expect(sink.results).toEqual([])
  })

  it('a stash consumer that throws does not cost the request — the compressed body still ships', async () => {
    const s = createProxyServer({
      upstreamHost: 'api.anthropic.com',
      onStash: () => { throw new Error('main process window gone') },
    })
    const res = new FakeRes()
    await drive(s, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    expect(ctl.calls).toHaveLength(1)
    expect(ctl.calls[0].body!.length).toBeLessThan(Buffer.byteLength(COMPRESSIBLE))
    expect(ctl.calls[0].body!.toString('utf8')).toContain('retrieve_full')
  })
})

/* ── proxyMain: response-path failures ──────────────────────────────────────────────────────── */

describe('headroom proxy — a dead client response never takes the child down', () => {
  let results: ProxyResult[] = []
  let server: Server
  beforeEach(() => {
    results = []
    server = createProxyServer({ upstreamHost: 'api.anthropic.com', onResult: (r) => results.push(r) })
  })

  it('a writeHead that throws destroys the response and stops the stream dead', async () => {
    const res = new FakeRes()
    res.writeHeadThrows = true
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    const up = makeUp(200, {})
    expect(() => ctl.calls[0].cb(up)).not.toThrow()
    expect(res.destroyed).toBe(true)

    up.emit('data', Buffer.from(SSE)) // no listeners were ever attached — this must be inert
    up.emit('end')
    expect(res.chunks).toEqual([])
    expect(res.ended).toBe(false)
    expect(results).toEqual([]) // a response the client never saw must not be billed as savings
  })

  it('a writeHead that throws on a response whose destroy ALSO throws is still swallowed', async () => {
    const res = new FakeRes()
    res.writeHeadThrows = true
    res.destroyThrows = true
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])
    expect(() => ctl.calls[0].cb(makeUp(200, {}))).not.toThrow()
    expect(res.destroyed).toBe(false)
    expect(results).toEqual([])
  })

  it('a client that vanishes mid-stream still yields real usage to the ledger', async () => {
    const res = new FakeRes()
    res.writeThrows = true // every res.write() now throws, as it does on a reset socket
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    const up = makeUp(200, { 'content-encoding': 'identity' })
    ctl.calls[0].cb(up)
    expect(() => { up.emit('data', Buffer.from(SSE)); up.emit('end') }).not.toThrow()

    // The tokens were spent upstream whether or not the client was there to receive them.
    expect(results).toHaveLength(1)
    expect(results[0].usage).toEqual({
      input_tokens: 11, cache_read_input_tokens: 900, cache_creation_input_tokens: 7, output_tokens: 33,
    })
    expect(results[0].status).toBe(200)
  })

  it('a res.end that throws at the close of the stream still yields the result', async () => {
    const res = new FakeRes()
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])
    const up = makeUp(200, {})
    ctl.calls[0].cb(up)
    res.endThrows = true
    expect(() => { up.emit('data', Buffer.from(SSE)); up.emit('end') }).not.toThrow()
    expect(results).toHaveLength(1)
    expect(results[0].usage.output_tokens).toBe(33)
  })

  it('an upstream response with no status line becomes a 502 to the client and status 0 on the ledger', async () => {
    const res = new FakeRes()
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    const up = makeUp(undefined, {}) // no content-encoding either → decoded as raw utf8
    ctl.calls[0].cb(up)
    up.emit('data', Buffer.from(SSE))
    up.emit('end')

    expect(res.head?.[0]).toBe(502)
    expect(res.text).toContain('message_start') // the bytes still reach the client verbatim
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe(0) // never NaN/undefined on the savings record
    expect(results[0].usage.input_tokens).toBe(11)
  })

  it('a result consumer that throws is swallowed — the client response is already complete', async () => {
    const s = createProxyServer({
      upstreamHost: 'api.anthropic.com',
      onResult: () => { throw new Error('ledger flush exploded') },
    })
    const res = new FakeRes()
    await drive(s, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])
    const up = makeUp(200, {})
    ctl.calls[0].cb(up)
    expect(() => { up.emit('data', Buffer.from(SSE)); up.emit('end') }).not.toThrow()
    expect(res.ended).toBe(true)
  })

  it('an upstream stream error ends the client response and reports NO result', async () => {
    const res = new FakeRes()
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])
    const up = makeUp(200, {})
    ctl.calls[0].cb(up)
    up.emit('data', Buffer.from('event: message_start\n'))
    up.emit('error', new Error('ECONNRESET mid-stream'))

    expect(res.ended).toBe(true) // the client is released rather than left hanging on an open body
    expect(results).toEqual([]) // a truncated stream has no trustworthy usage to record
  })

  it('an upstream stream error whose res.end also throws is swallowed', async () => {
    const res = new FakeRes()
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])
    const up = makeUp(200, {})
    ctl.calls[0].cb(up)
    res.endThrows = true
    expect(() => up.emit('error', new Error('ECONNRESET'))).not.toThrow()
    expect(results).toEqual([])
  })
})

/* ── proxyMain: request-path failures ───────────────────────────────────────────────────────── */

describe('headroom proxy — an unreachable upstream answers 502 rather than hanging', () => {
  let server: Server
  beforeEach(() => { server = createProxyServer({ upstreamHost: 'api.anthropic.com' }) })

  it('a connection error before headers returns 502 with the upstream reason', async () => {
    const res = new FakeRes()
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])
    for (const h of ctl.calls[0].onError) h(new Error('connect ECONNREFUSED'))

    expect(res.head?.[0]).toBe(502)
    expect(res.head?.[1]).toEqual({ 'content-type': 'text/plain' })
    expect(res.endedBody).toBe('headroom proxy upstream error: connect ECONNREFUSED')
  })

  it('a connection error AFTER the status line does not overwrite it', async () => {
    const res = new FakeRes()
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])
    ctl.calls[0].cb(makeUp(200, {})) // headers already committed to the client
    for (const h of ctl.calls[0].onError) h(new Error('socket hang up'))

    expect(res.head?.[0]).toBe(200) // a second writeHead here would throw inside Node
    expect(res.ended).toBe(true)
  })

  it('a request that cannot even be constructed returns 502 and forwards nothing', async () => {
    ctl.throwOnRequest = new Error('Method must be a valid HTTP token')
    const res = new FakeRes()
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    expect(ctl.calls).toEqual([])
    expect(res.head?.[0]).toBe(502)
    expect(res.endedBody).toBe('headroom proxy request error: Method must be a valid HTTP token')
  })

  it('a request construction failure on an already-committed response does not double-commit it', async () => {
    ctl.throwOnRequest = new Error('invalid header value')
    const res = new FakeRes()
    res.headersSent = true // an earlier write already put a status line on the wire
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    expect(res.head).toBeNull() // no second writeHead attempted
    expect(res.endedBody).toBe('headroom proxy request error: invalid header value')
  })

  it('a request construction failure still delivers the reason when writeHead itself throws', async () => {
    ctl.throwOnRequest = new Error('boom')
    const res = new FakeRes()
    res.writeHeadThrows = true
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])

    expect(res.head).toBeNull()
    expect(res.endedBody).toBe('headroom proxy request error: boom')
  })

  it('a request construction failure onto a wholly dead response object is swallowed', async () => {
    ctl.throwOnRequest = new Error('boom')
    const res = new FakeRes()
    res.writeHeadThrows = true
    res.endThrows = true
    await expect(drive(server, makeReq('/v1/messages', 'POST', {}), res, [Buffer.from(COMPRESSIBLE)])).resolves.toBeUndefined()
    expect(res.ended).toBe(false)
    expect(ctl.calls).toEqual([])
  })
})

describe('headroom proxy — a broken client request is absorbed, not propagated', () => {
  let server: Server
  beforeEach(() => { server = createProxyServer({ upstreamHost: 'api.anthropic.com' }) })

  it('an error on the inbound request destroys the response and never reaches upstream', async () => {
    const res = new FakeRes()
    const req = makeReq('/v1/messages', 'POST', {})
    ;(server as unknown as { emit(ev: string, a: unknown, b: unknown): boolean }).emit('request', req, res)
    req.emit('error', new Error('client aborted'))
    expect(res.destroyed).toBe(true)
    expect(ctl.calls).toEqual([])
  })

  it('an inbound error on a response whose destroy throws is swallowed', () => {
    const res = new FakeRes()
    res.destroyThrows = true
    const req = makeReq('/v1/messages', 'POST', {})
    ;(server as unknown as { emit(ev: string, a: unknown, b: unknown): boolean }).emit('request', req, res)
    expect(() => req.emit('error', new Error('client aborted'))).not.toThrow()
    expect(res.destroyed).toBe(false)
  })

  it('a body the runtime hands us in a form we cannot concat answers 502 instead of crashing', async () => {
    const res = new FakeRes()
    // A stream that yielded strings rather than Buffers: Buffer.concat throws, rejecting handle().
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, ['not-a-buffer'])
    expect(res.head?.[0]).toBe(502)
    expect(res.ended).toBe(true)
    expect(ctl.calls).toEqual([])
  })

  it('the same failure on an already-committed response ends it without a second status line', async () => {
    const res = new FakeRes()
    res.headersSent = true
    await drive(server, makeReq('/v1/messages', 'POST', {}), res, ['not-a-buffer'])
    expect(res.head).toBeNull()
    expect(res.ended).toBe(true)
  })
})

/* ── proxyMain: setPrefixDecay ──────────────────────────────────────────────────────────────── */

const decayLines = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `  const ${tag}${i} = compute(${i}) // a reasonably long source line`).join('\n')

/** 160 messages — comfortably past DECAY_FIRST_THRESHOLD (128), so the first 64 age out. */
const DECAY_BODY = JSON.stringify({
  messages: Array.from({ length: 160 }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: [i % 2 === 0
      ? { type: 'tool_use', id: `t${i}`, name: 'Write', input: { file_path: `/f${i}.ts`, content: decayLines(40, `a${i}`) } }
      : { type: 'tool_result', tool_use_id: `t${i - 1}`, content: decayLines(40, `r${i}`) }],
  })),
})
const AGED_OUT = "Aged out of this conversation's active context"

describe('headroom proxy — prefix decay is opt-in and only a literal true opts in', () => {
  let stashed: Array<{ token: string; original: string }> = []
  let server: Server

  beforeEach(() => {
    stashed = []
    server = createProxyServer({
      upstreamHost: 'api.anthropic.com',
      onStash: (s) => { stashed.push(...s) },
    })
  })

  /** Push DECAY_BODY through and return exactly what the upstream would have received. */
  async function forwarded(): Promise<string> {
    ctl.reset()
    await drive(server, makeReq('/v1/messages', 'POST', {}), new FakeRes(), [Buffer.from(DECAY_BODY)])
    return ctl.calls[0].body!.toString('utf8')
  }

  it('ages out the head of a long conversation when switched on, and not before', async () => {
    setPrefixDecay(false)
    const off = await forwarded()
    expect(off).not.toContain(AGED_OUT) // the default must never break the prompt cache

    setPrefixDecay(true)
    const on = await forwarded()
    expect(on).toContain(AGED_OUT)
    expect(on.length).toBeLessThan(off.length)
  })

  it('never mints a decay token the main process was not handed first', async () => {
    setPrefixDecay(true)
    stashed = []
    const on = await forwarded()
    const tokens = [...on.matchAll(/token \\"(hr_[0-9a-f]+)\\"/g)].map((m) => m[1])
    expect(tokens.length).toBeGreaterThan(0)
    const committed = new Set(stashed.map((s) => s.token))
    // A token in the body with no committed original is a handle retrieve_full can never redeem.
    for (const t of tokens) expect(committed.has(t)).toBe(true)
  })

  it('a garbled or absent decay flag leaves the transform OFF rather than half-enabling it', async () => {
    setPrefixDecay(false)
    const off = await forwarded()

    for (const garbled of ['true', 1, {}, [], 'yes', null, undefined, NaN]) {
      setPrefixDecay(garbled)
      const out = await forwarded()
      expect(out).not.toContain(AGED_OUT)
      expect(out).toBe(off) // byte-identical to OFF — a truthy value must not partially apply it
    }

    setPrefixDecay(true) // and the real flag still works after all of that
    expect(await forwarded()).toContain(AGED_OUT)
  })
})

/* ── proxySupervisor: thinking cap + decay push ─────────────────────────────────────────────── */

interface FakeChild {
  posted: Array<Record<string, unknown>>
  exit: () => void
  postThrows: boolean
}
let children: FakeChild[] = []

function makeSpawner(opts: { postThrows?: boolean } = {}) {
  return (): ProxyTransport => {
    let onMsg: (m: unknown) => void = () => {}
    let onExit: (c: number) => void = () => {}
    const child: FakeChild = { posted: [], exit: () => onExit(1), postThrows: !!opts.postThrows }
    children.push(child)
    return {
      postMessage: (m: unknown) => {
        if (child.postThrows) throw new Error('IPC channel closed')
        const msg = m as { kind?: string; port?: number }
        child.posted.push(msg as Record<string, unknown>)
        if (msg?.kind === 'init') onMsg({ kind: 'ready', port: msg.port })
      },
      onMessage: (cb: (m: unknown) => void) => { onMsg = cb },
      onExit: (cb: (c: number) => void) => { onExit = cb },
      kill: () => {},
      pid: 99,
    }
  }
}

const initOf = (c: FakeChild): Record<string, unknown> | undefined => c.posted.find((m) => m.kind === 'init')
const configsOf = (c: FakeChild): Array<Record<string, unknown>> => c.posted.filter((m) => m.kind === 'config')
const lastConfig = (c: FakeChild): Record<string, unknown> | undefined => configsOf(c).at(-1)

describe('proxy supervisor — thinking cap and prefix decay ride the config channel', () => {
  beforeEach(() => {
    _resetProxyForTest()
    // _resetProxyForTest() leaves proxyThinkingCap/proxyDecay where they were — clear them by hand
    // so one test's ceiling cannot leak into the next one's init frame.
    setProxyThinkingCap(0)
    setProxyDecay(false)
    children = []
    setProxySpawner(makeSpawner())
  })
  afterEach(() => {
    setProxyThinkingCap(0)
    setProxyDecay(false)
    stopProxy()
    _resetProxyForTest()
  })

  it('pushes a live cap to the running child and floors a fractional budget', () => {
    startProxy({ port: 7301 })
    setProxyThinkingCap(8192.9)
    expect(lastConfig(children[0])).toEqual({ kind: 'config', mode: 'aggressive', thinkingCap: 8192, decay: false })
  })

  it('normalises every non-positive or non-finite budget to 0 (off), never to NaN or a negative', () => {
    startProxy({ port: 7302 })
    for (const bad of [0, -1, -4096, NaN, Infinity, -Infinity]) {
      setProxyThinkingCap(bad)
      expect(lastConfig(children[0])?.thinkingCap).toBe(0)
    }
  })

  it('re-carries the cap on the init of the next respawn, so a new child cannot revert to the full budget', () => {
    startProxy({ port: 7303 })
    setProxyThinkingCap(4096)
    children[0].exit()
    expect(children).toHaveLength(2)
    expect(initOf(children[1])).toMatchObject({ thinkingCap: 4096, mode: 'aggressive', decay: false })
  })

  it('turns decay on only for a literal true, and carries the result to the next child', () => {
    startProxy({ port: 7304 })

    setProxyDecay(true)
    expect(lastConfig(children[0])?.decay).toBe(true)

    // index.ts feeds this straight off an IPC settings payload, so a garbled value must not stick.
    setProxyDecay('yes' as unknown as boolean)
    expect(lastConfig(children[0])?.decay).toBe(false)

    children[0].exit()
    expect(initOf(children[1])).toMatchObject({ decay: false })
  })

  it('both settings applied before any child exists still ride the very first init', () => {
    setProxyThinkingCap(2048)
    setProxyDecay(true)
    expect(children).toHaveLength(0) // nothing to post to yet — and that must not throw

    startProxy({ port: 7305 })
    expect(initOf(children[0])).toMatchObject({ thinkingCap: 2048, decay: true, port: 7305 })
  })

  it('a push that fails on a collapsing child is not lost — the next child gets it on init', () => {
    startProxy({ port: 7306 })
    children[0].postThrows = true // IPC gone, but exit has not fired yet

    expect(() => setProxyThinkingCap(1024)).not.toThrow()
    expect(() => setProxyDecay(true)).not.toThrow()
    expect(configsOf(children[0])).toEqual([]) // nothing got through

    children[0].exit()
    expect(initOf(children[1])).toMatchObject({ thinkingCap: 1024, decay: true })
  })

  it('the cap and decay survive a mode change rather than being reset by it', () => {
    startProxy({ port: 7307 })
    setProxyThinkingCap(3000)
    setProxyDecay(true)
    setProxyMode('conservative')
    expect(lastConfig(children[0])).toEqual({ kind: 'config', mode: 'conservative', thinkingCap: 3000, decay: true })
  })
})
