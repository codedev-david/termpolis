import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as http from 'http'

/**
 * D11 for the handler. The counters of headroomLateWork, headroomObservationCost and headroomLateCost call
 * rewriteMessagesBody directly, so work added AROUND it in createProxyServer (a second rewrite of the body, a stray parse
 * of it, a stall before the first byte) was invisible to every test. This sends a body of about a megabyte through the real
 * server, under each policy, and holds what the request costs to what it cost in v1.54.4, which a reviewer measured the
 * same way and found unchanged under Legacy: ONE parse of the whole body, and no more than the two stringifies of about its
 * size that the rewrite makes (one to check the round trip, one of what it sends on).
 *
 * The counts hold the structure and the time holds the stalls: a pass-through of the same bytes is the yardstick for a
 * stall that does not depend on the body (on a body of a few hundred bytes, where the rewrite itself costs nothing), in
 * one process, interleaved, best of several rounds, with a wide margin, because a timing test that fails under load is
 * a defect. A delay under about 100 ms is below what that can see (so is a copy of the body); the count and the
 * import-closure test (headroomProxyChildImports: the child imports no fs, no child_process, no os) hold the rest.
 */

const POLICIES = ['legacy', 'late'] as const
type Policy = (typeof POLICIES)[number]
type Kind = 'changing' | 'unchanged'

interface Wire {
  setFirstSightPolicy: (p: string) => void
  rewriteMessagesBody: (raw: string, opts?: { decay?: boolean }) => unknown
}
interface Main {
  applyProxyConfig: (m: unknown) => void
  createProxyServer: (o: Record<string, unknown>) => http.Server
  resultFrame: (r: never) => unknown
  stashFrame: (s: never) => unknown
}

const rows = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag} row ${i} of the output with some padding to make it long enough to matter`).join('\n')
/** A conversation of about `bytes`: results big enough for the rewrite to change (`changing`), or all too small to (`unchanged`). */
function bodyOf(kind: Kind, bytes: number): string {
  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'look at the build' }]
  const per = kind === 'changing' ? 60_000 : 900
  for (let i = 0; i < Math.ceil(bytes / per); i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/f${i}` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: rows(Math.floor(per / 70), `f${i}`) }] })
  }
  return JSON.stringify({ model: 'x', messages })
}

describe.each(POLICIES)('what one request costs the proxy handler under %s', (policy: Policy) => {
  let wire: Wire
  let stub: http.Server
  let proxy: http.Server
  let port = 0
  const BODIES: Record<Kind, string> = { changing: '', unchanged: '' }

  beforeAll(async () => {
    vi.resetModules()
    wire = (await import('../../src/main/headroomProxy/wireCompress')) as unknown as Wire
    const main = (await import('../../src/main/headroomProxy/proxyMain')) as unknown as Main
    wire.setFirstSightPolicy(policy)
    main.applyProxyConfig({ mode: 'aggressive', thinkingCap: 0, decay: true, firstSight: policy })
    stub = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n') })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    // The two callbacks are the child's: each builds its frame and hands it to the pipe, which is a structured clone and
    // not a JSON text (parentPort.postMessage), so nothing here serializes it. Both frames carried the stashes in v1.54.4 too.
    const frames: unknown[] = []
    proxy = main.createProxyServer({
      upstreamHost: '127.0.0.1', upstreamPort: (stub.address() as { port: number }).port, useHttps: false,
      onStash: (s: never) => { frames.push(main.stashFrame(s)); frames.length = 0 },
      onResult: (r: never) => { frames.push(main.resultFrame(r)); frames.length = 0 },
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    port = (proxy.address() as { port: number }).port
    BODIES.changing = bodyOf('changing', 1_000_000)
    BODIES.unchanged = bodyOf('unchanged', 1_000_000)
  })
  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()))
    await new Promise<void>((r) => stub.close(() => r()))
  })

  /** Time to the first byte of the answer, in ms; the whole answer is drained before it returns. `at` is the port asked: the proxy's, or the stub's own. */
  function ttfb(path: string, body: string, at: number = port): Promise<number> {
    return new Promise((resolve, reject) => {
      const t0 = process.hrtime.bigint()
      const req = http.request({ host: '127.0.0.1', port: at, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6
        res.resume(); res.on('end', () => resolve(ms))
      })
      req.on('error', reject); req.write(body); req.end()
    })
  }

  it.each(['changing', 'unchanged'] as const)('parses a %s body once and stringifies it no more than the rewrite does', async (kind: Kind) => {
    const body = BODIES[kind]
    expect(body.length).toBeGreaterThan(900_000)
    const parse = vi.spyOn(JSON, 'parse')
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      await ttfb('/v1/messages', body)
      const wholeParses = parse.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).length >= body.length * 0.9)
      const sizes = stringify.mock.results.filter((r) => typeof r.value === 'string').map((r) => (r.value as string).length)
      // One parse of the whole body: a second rewrite, or any other read of it as JSON, is a second.
      expect(wholeParses).toHaveLength(1)
      // The stringifies of about its size: the round-trip check, and (for a body that is not changed) one of what it keeps.
      // A frame that carried the body, or a second rewrite, would be another.
      expect(sizes.filter((n) => n >= body.length * 0.5).length).toBeLessThanOrEqual(kind === 'changing' ? 1 : 2)
      // Nothing is made larger than the body it came from.
      expect(Math.max(...sizes)).toBeLessThanOrEqual(body.length * 1.02)
    } finally {
      parse.mockRestore(); stringify.mockRestore()
    }
  }, 120_000)

  // A stall that does not depend on the body (a sleep, a spin, a file read, a call to another process) is the same few
  // hundred milliseconds on a body of a few hundred bytes, where the rewrite itself costs nothing. So it is held there,
  // against the same bytes sent straight to the upstream with no proxy in between: a yardstick that went through the
  // proxy too (its pass-through path for a request it does not rewrite) would carry a stall in the handler as well, and
  // see none (it did: the first version of this test passed a sleep of 400 ms and a spin of 300 for that reason), and one
  // bounded by a multiple of the rewrite of a big body grows with a busy machine and lets a stall through.
  // Interleaved, best of fifteen rounds, with 100 ms to spare: a slow moment of the machine is a slow moment of both.
  it('answers a request with nothing to rewrite within 100 ms of the upstream answering it direct: nothing stalls the first byte', async () => {
    const tiny = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'run the build' }] })
    const upstream = (stub.address() as { port: number }).port
    let direct = Infinity
    let proxied = Infinity
    for (let round = 0; round < 15; round++) {
      direct = Math.min(direct, await ttfb('/v1/messages', tiny, upstream))
      proxied = Math.min(proxied, await ttfb('/v1/messages', tiny))
    }
    // Measured here: the proxy adds a millisecond or two.
    expect(proxied, `through the proxy ${proxied.toFixed(1)} ms, direct to the upstream ${direct.toFixed(1)} ms`).toBeLessThanOrEqual(direct + 100)
  }, 120_000)

  // The time a body that is rewritten adds is what it costs to rewrite it, once: nothing else. This is the part of that a
  // test can hold without flaking: the rewrite path answers a big body in no more than a generous multiple of the
  // rewrite called directly (the counts above hold what it does, and the three of them together hold the shape).
  it('answers a big body within a few times the rewrite alone, which is only a net for a stall as long as the rewrite itself', async () => {
    const out: Record<Kind, { rewrite: number; direct: number }> = { changing: { rewrite: 1e9, direct: 1e9 }, unchanged: { rewrite: 1e9, direct: 1e9 } }
    for (let round = 0; round < 5; round++) {
      for (const kind of ['changing', 'unchanged'] as const) {
        out[kind].rewrite = Math.min(out[kind].rewrite, await ttfb('/v1/messages', BODIES[kind]))
        const t0 = process.hrtime.bigint()
        wire.rewriteMessagesBody(BODIES[kind], { decay: true })
        out[kind].direct = Math.min(out[kind].direct, Number(process.hrtime.bigint() - t0) / 1e6)
      }
    }
    for (const kind of ['changing', 'unchanged'] as const) expect(out[kind].rewrite, `${kind}: ${JSON.stringify(out[kind])}`).toBeLessThanOrEqual(4 * out[kind].direct + 250)
  }, 120_000)
})
