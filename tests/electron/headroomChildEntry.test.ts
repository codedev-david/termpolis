import { describe, it, expect, vi, afterEach } from 'vitest'
import * as http from 'http'

/**
 * The proxy child's message handler is the one link in the first-sight chain that no other test
 * can reach: it sits inside the utilityProcess entry that proxyMain.ts excludes from coverage,
 * because the real entry only runs in a forked process. Everything either side of it is held (the
 * supervisor posts the policy on init and on every config frame, applyProxyConfig applies it), but
 * if the handler stopped passing a frame to applyProxyConfig the child would stay on the legacy
 * policy for the whole run, silently: no error anywhere, v1.54's behaviour, and a Settings pane
 * saying Late. So the entry is run here against a stand-in for the parent port, the way the fork
 * runs it, and what it does to the compressor is read back.
 */

// The server the entry starts, kept so each test can close it.
const servers = vi.hoisted(() => [] as Array<{ close: (cb?: () => void) => void }>)
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>()
  const createServer = (...args: Parameters<typeof actual.createServer>): ReturnType<typeof actual.createServer> => {
    const s = actual.createServer(...args)
    servers.push(s)
    return s
  }
  return { ...actual, default: { ...actual, createServer }, createServer }
})

// The entry hard-wires useHttps, so the one test that sends a request through the child answers its
// upstream call here: a 200 whose body is `upstream.sse`, in two pieces the way a stream arrives.
const upstream = vi.hoisted(() => ({ sse: '' }))
vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>()
  const { EventEmitter } = await import('events')
  const request = (_opts: unknown, cb: (up: unknown) => void): unknown => {
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & { end: (b?: unknown) => void; destroy: () => void }
    req.destroy = () => {}
    req.end = () => {
      const up = new EventEmitter() as InstanceType<typeof EventEmitter> & { statusCode: number; headers: Record<string, string> }
      up.statusCode = 200
      up.headers = { 'content-type': 'text/event-stream' }
      setImmediate(() => {
        cb(up)
        setImmediate(() => { up.emit('data', Buffer.from(upstream.sse, 'utf8')); up.emit('end') })
      })
    }
    return req
  }
  return { ...actual, default: { ...actual, request }, request }
})

type Frame = { data: unknown }
interface FakePort {
  handlers: Array<(e: Frame) => void>
  posted: Array<Record<string, unknown>>
  /** Frame kinds the port refuses, the way a closed channel to the main process does. */
  refuses: Set<string>
  on(ev: string, cb: (e: Frame) => void): void
  postMessage(m: unknown): void
  send(data: unknown): void
}
function makePort(): FakePort {
  const port: FakePort = {
    handlers: [],
    posted: [],
    refuses: new Set(),
    on(ev, cb) { if (ev === 'message') port.handlers.push(cb) },
    postMessage(m) {
      if (port.refuses.has((m as { kind?: string }).kind ?? '')) throw new Error('the channel to the main process is closed')
      port.posted.push(m as Record<string, unknown>)
    },
    send(data) { for (const h of port.handlers) h({ data }) },
  }
  return port
}

const processHandlers = (): { exception: Function[]; rejection: Function[] } => ({
  exception: process.listeners('uncaughtException'),
  rejection: process.listeners('unhandledRejection'),
})

// What this worker had registered before any child ran, so only the children's handlers are removed.
const baseline = processHandlers()

/** A fresh child: new module registry, the port in place, the entry run by importing proxyMain. */
async function launchChild(): Promise<{ port: FakePort; wire: typeof import('../../src/main/headroomProxy/wireCompress') }> {
  vi.resetModules()
  const port = makePort()
  ;(process as unknown as { parentPort?: unknown }).parentPort = port
  await import('../../src/main/headroomProxy/proxyMain')
  const wire = await import('../../src/main/headroomProxy/wireCompress')
  return { port, wire }
}

afterEach(async () => {
  delete (process as unknown as { parentPort?: unknown }).parentPort
  // The entry keeps the child alive on an uncaught error; those handlers are the child's, not this worker's.
  for (const h of process.listeners('uncaughtException')) if (!baseline.exception.includes(h)) process.off('uncaughtException', h as never)
  for (const h of process.listeners('unhandledRejection')) if (!baseline.rejection.includes(h)) process.off('unhandledRejection', h as never)
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { try { s.close(() => resolve()) } catch { resolve() } })))
})

const ready = (port: FakePort): boolean => port.posted.some((m) => m.kind === 'ready')

describe('the proxy child entry and the first-sight policy', () => {
  it('is legacy until a frame says otherwise: a child nothing has configured is v1.54', async () => {
    const { wire } = await launchChild()
    expect(wire.getFirstSightPolicy()).toBe('legacy')
  })

  it('takes the policy its init frame carries, starts serving, and ignores every later frame', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    await vi.waitFor(() => expect(ready(port)).toBe(true), { timeout: 5_000 })

    // The supervisor puts the policy it froze on every frame; a Settings flip never reaches this far,
    // and a frame that did carry another one could not change the run.
    port.send({ kind: 'config', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
    expect(wire.getFirstSightPolicy()).toBe('late')
  })

  it('takes a legacy init the same way, and a later late frame does not turn it on', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
    expect(wire.getFirstSightPolicy()).toBe('legacy')
    port.send({ kind: 'config', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    // The frame came after the one resolution the run gets, so it is not applied: this is legacy
    // that was chosen, not legacy that was never set.
    expect(wire.getFirstSightPolicy()).toBe('legacy')
    await vi.waitFor(() => expect(ready(port)).toBe(true), { timeout: 5_000 })
  })

  it('takes the policy from a config frame that arrives before the init, when it is the first to carry one', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'config', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    expect(ready(port)).toBe(false) // a config frame starts no server
  })

  it('a child respawned by the supervisor is configured again from its init, as a new process', async () => {
    const first = await launchChild()
    first.port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(first.wire.getFirstSightPolicy()).toBe('late')
    await vi.waitFor(() => expect(ready(first.port)).toBe(true), { timeout: 5_000 })

    const second = await launchChild()
    expect(second.wire.getFirstSightPolicy()).toBe('legacy') // a new process starts unconfigured
    second.port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(second.wire.getFirstSightPolicy()).toBe('late')
    await vi.waitFor(() => expect(ready(second.port)).toBe(true), { timeout: 5_000 })
  })

  it('does not take a second init for a server it already runs', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    await vi.waitFor(() => expect(ready(port)).toBe(true), { timeout: 5_000 })
    expect(servers.length).toBe(1)
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    // A server is created in the handler itself, so a second one would already be here.
    expect(servers.length).toBe(1)
  })

  it('does not throw on a frame with no data, or one that is not an object', async () => {
    const { port, wire } = await launchChild()
    expect(() => { for (const h of port.handlers) { h(undefined as never); h({ data: null }); h({ data: 'x' }); h({ data: { kind: 'other' } }) } }).not.toThrow()
    expect(wire.getFirstSightPolicy()).toBe('legacy')
  })
})

/**
 * What the child posts to the main process. The two lambdas that build the frames sit in the same
 * excluded entry, and the ledgers read what they carry: the retrieval-turn charge (the ToolSearch hop
 * included) rides on the result's `turn`, the stub-kind tally and the first-sight arms on its `stats`,
 * and the class of every stash on the stash's `meta`. A frame built inline without one of them would
 * read as zero in production and leave every unit test green, because the tests build their own frames
 * with resultFrame and stashFrame. So a request is sent through the entry itself, to an upstream that
 * answers from a script, and the frames that come out are read.
 */
const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const answer = (call: { name: string; input: string }): string =>
  ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 52_000, output_tokens: 1 } } }) +
  ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: call.name, input: {} } }) +
  ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: call.input } }) +
  ev('content_block_stop', { index: 0 }) +
  ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 90 } })
const RETRIEVE_CALL = { name: 'mcp__termpolis__retrieve_full', input: '{"token":"hr_0123456789abcdef"}' }
const SEARCH_CALL = { name: 'ToolSearch', input: '{"query":"select:mcp__termpolis__retrieve_full","max_results":1}' }
const USAGE = { input_tokens: 3, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 10, output_tokens: 90 }

const LISTING = Array.from({ length: 120 }, (_, i) => `line ${i} of a long listing that will be shortened by the window ${i * 3}`).join('\n')
const requestBody = (tools: string[], tail: string = LISTING): object => ({
  model: 'claude-opus-5-5',
  max_tokens: 10,
  tools: tools.map((name) => ({ name, description: 'x', input_schema: { type: 'object' } })),
  messages: [
    { role: 'user', content: 'first prompt of the conversation' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: tail }] },
  ],
})

function post(port: number, body: object): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      res.on('data', () => {})
      res.on('end', () => resolve(res.statusCode ?? 0))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(data)
  })
}

/** A child on the legacy policy, serving; resolves with its port and the frames it has posted so far. */
async function servingChild(): Promise<{ port: FakePort; listenOn: number }> {
  const { port } = await launchChild()
  port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
  await vi.waitFor(() => expect(ready(port)).toBe(true), { timeout: 5_000 })
  return { port, listenOn: (port.posted.find((m) => m.kind === 'ready') as { port: number }).port }
}

type Meta = { kind: string; tool?: string; chars: number; view: number }
type PostedResult = { changed: boolean; status: number; turn?: Record<string, unknown>; usage: unknown; stashes: Array<{ meta?: Meta }>; stats?: { convKey: number; retrieveOffer: string; kinds: Record<string, number> } }
const frames = (port: FakePort, kind: string): Array<Record<string, unknown>> => port.posted.filter((m) => m.kind === kind)

describe('what the proxy child posts to the main process', () => {
  it('posts the originals it set aside with their class, then the turn, the stats and the usage once the answer is in', async () => {
    upstream.sse = answer(RETRIEVE_CALL)
    const { port, listenOn } = await servingChild()
    expect(await post(listenOn, requestBody(['mcp__termpolis__retrieve_full']))).toBe(200)
    await vi.waitFor(() => expect(frames(port, 'result')).toHaveLength(1), { timeout: 5_000 })

    const stashFrames = frames(port, 'stash') as unknown as Array<{ stashes: Array<{ token: string; meta?: Meta }> }>
    expect(stashFrames).toHaveLength(1)
    expect(stashFrames[0].stashes).toHaveLength(1)
    // The class of what was set aside travels with it: the ledgers count a retrieval against it.
    expect(stashFrames[0].stashes[0].meta).toMatchObject({ kind: 'compact', tool: 'Bash' })
    // Committed on the request path, ahead of the answer the token rides back in.
    expect(port.posted.findIndex((m) => m.kind === 'stash')).toBeLessThan(port.posted.findIndex((m) => m.kind === 'result'))

    const result = frames(port, 'result')[0] as unknown as PostedResult
    expect(result).toMatchObject({ kind: 'result', changed: true, status: 200 })
    expect(result.turn).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
    expect(result.usage).toEqual(USAGE)
    expect(result.stats!.convKey).toBeGreaterThan(0)
    expect(result.stats!.retrieveOffer).toBe('direct')
    expect(result.stats!.kinds.compact).toBe(1)
    // The backstop carries the same originals, class and all.
    expect(result.stashes).toHaveLength(1)
    expect(result.stashes[0].meta).toEqual(stashFrames[0].stashes[0].meta)
  })

  it('posts the hop of a ToolSearch turn and the way the request could have asked, for a tool that has to be loaded first', async () => {
    upstream.sse = answer(SEARCH_CALL)
    const { port, listenOn } = await servingChild()
    expect(await post(listenOn, requestBody(['ToolSearch']))).toBe(200)
    await vi.waitFor(() => expect(frames(port, 'result')).toHaveLength(1), { timeout: 5_000 })
    const result = frames(port, 'result')[0] as unknown as PostedResult
    expect(result.turn).toEqual({ toolCalls: 1, retrieveCalls: 0, pure: false, hop: true })
    expect(result.stats!.retrieveOffer).toBe('deferred')
    expect(result.usage).toEqual(USAGE)
  })

  it('posts a result and no stash for a request it did not shorten', async () => {
    upstream.sse = answer(RETRIEVE_CALL)
    const { port, listenOn } = await servingChild()
    expect(await post(listenOn, requestBody(['mcp__termpolis__retrieve_full'], 'a short answer'))).toBe(200)
    await vi.waitFor(() => expect(frames(port, 'result')).toHaveLength(1), { timeout: 5_000 })
    expect(frames(port, 'stash')).toHaveLength(0)
    const result = frames(port, 'result')[0] as unknown as PostedResult
    expect(result).toMatchObject({ changed: false, status: 200, stashes: [] })
    expect(result.turn).toEqual({ toolCalls: 1, retrieveCalls: 1, pure: true })
    expect(result.usage).toEqual(USAGE)
  })

  it('reports a stash it cannot post on the error channel, and the request goes on to its answer', async () => {
    upstream.sse = answer(RETRIEVE_CALL)
    const { port, listenOn } = await servingChild()
    port.refuses.add('stash')
    expect(await post(listenOn, requestBody(['mcp__termpolis__retrieve_full']))).toBe(200)
    await vi.waitFor(() => expect(frames(port, 'result')).toHaveLength(1), { timeout: 5_000 })
    expect(frames(port, 'stash')).toHaveLength(0)
    const errors = frames(port, 'error') as unknown as Array<{ message: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('stash commit dropped (1 originals)')
    expect(errors[0].message).toContain('the channel to the main process is closed')
    // The result still carries the originals: the backstop that ccrPut's content key makes idempotent.
    expect((frames(port, 'result')[0] as unknown as PostedResult).stashes).toHaveLength(1)
  })

  it('keeps serving when the result cannot be posted either', async () => {
    upstream.sse = answer(RETRIEVE_CALL)
    const { port, listenOn } = await servingChild()
    port.refuses.add('stash'); port.refuses.add('result'); port.refuses.add('error')
    expect(await post(listenOn, requestBody(['mcp__termpolis__retrieve_full']))).toBe(200)
    // A second request is answered all the same: nothing the channel refuses stops the child.
    expect(await post(listenOn, requestBody(['mcp__termpolis__retrieve_full']))).toBe(200)
    expect(frames(port, 'result')).toHaveLength(0)
  })
})
