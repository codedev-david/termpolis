import { describe, it, expect, vi } from 'vitest'
import { caseBody, realistic, editLoop, longRun, conversationCases, FIRST_MESSAGE } from './fixtures/lateGoldenCases'

/**
 * The compression path must read no clock and no random number: identical bytes in, identical bytes out,
 * or the compressed prefix differs from turn to turn and the prompt cache is lost on every request.
 * noNondeterministicCompression.test.ts sweeps the source for the words that read one, and a sweep of
 * words is only as good as the words: a clock or a generator reached through an alias or a cast
 * (`const R = Math; R.random()`, `(Date as unknown as () => string)()`, `const pf = performance; pf.now()`)
 * does not contain them. This is the other half. It RUNS the code, with a counter on every source of time
 * and of randomness the runtime has, and asserts that nothing was called: it cannot be spelled around.
 *
 * What runs: the rewriter under the three behaviours a request can get (Late, the holdout and the kill
 * switch), with the decay pass on, over bodies of every shape the fixtures make; the arm choice; the stub
 * tally; the stash metadata and its two stamps; and the two readers of the answer stream. Bodies hold no
 * image: the image path calls a third-party encoder that times itself, which is the same code in v1.54.4
 * and is outside what this holds.
 */

const hits = vi.hoisted(() => ({ armed: false, what: [] as string[] }))
const note = (what: string): void => { if (hits.armed) hits.what.push(what) }

vi.mock('crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('crypto')>()
  const wrapped: Record<string, unknown> = { ...real }
  for (const name of ['randomBytes', 'randomUUID', 'randomInt', 'randomFill', 'randomFillSync', 'getRandomValues', 'pseudoRandomBytes', 'generateKeySync', 'generatePrimeSync']) {
    const fn = (real as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function') wrapped[name] = (...a: unknown[]): unknown => { note(`crypto.${name}`); return (fn as (...b: unknown[]) => unknown)(...a) }
  }
  return { ...wrapped, default: wrapped }
})

/** Every source of time and randomness the runtime offers, counted while `hits.armed`. Returns the undo. */
function watchEverything(): () => void {
  const undo: Array<() => void> = []
  const wrap = <T extends object, K extends keyof T>(obj: T, key: K, label: string): void => {
    const original = obj[key]
    if (typeof original !== 'function') return
    const counted = function (this: unknown, ...a: unknown[]): unknown { note(label); return (original as (...b: unknown[]) => unknown).apply(this, a) }
    // Members of the function (process.hrtime.bigint) ride along, so wrapping the function leaves them callable.
    Object.assign(counted, original)
    Object.defineProperty(obj, key, { configurable: true, writable: true, value: counted })
    undo.push(() => { Object.defineProperty(obj, key, { configurable: true, writable: true, value: original }) })
  }
  wrap(Date, 'now', 'Date.now')
  wrap(Math, 'random', 'Math.random')
  wrap(performance, 'now', 'performance.now')
  // The member first, so the function's wrapper carries the counted one.
  wrap(process.hrtime, 'bigint', 'process.hrtime.bigint')
  wrap(process, 'hrtime', 'process.hrtime')
  wrap(process, 'uptime', 'process.uptime')
  wrap(process, 'cpuUsage', 'process.cpuUsage')
  wrap(process, 'memoryUsage', 'process.memoryUsage')
  wrap(globalThis.crypto, 'getRandomValues', 'globalThis.crypto.getRandomValues')
  wrap(globalThis.crypto, 'randomUUID', 'globalThis.crypto.randomUUID')
  // `new Date()` and `Date()` read the clock without going through Date.now.
  const RealDate = globalThis.Date
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget): object { note(args.length === 0 ? 'new Date()' : 'new Date(x)'); return Reflect.construct(target, args, newTarget) as object },
    apply(target, thisArg, args): unknown { note('Date()'); return Reflect.apply(target, thisArg, args) },
  })
  undo.push(() => { globalThis.Date = RealDate })
  return () => { for (const u of undo.reverse()) u() }
}

/** Run `fn` with everything watched, and say what it read. */
function reads(fn: () => void): string[] {
  const unwatch = watchEverything()
  hits.what = []
  hits.armed = true
  try { fn() } finally { hits.armed = false; unwatch() }
  return [...hits.what]
}

const WIRE = '../../src/main/headroomProxy/wireCompress'
type Wire = typeof import('../../src/main/headroomProxy/wireCompress')
async function launch(policy: 'late' | 'legacy'): Promise<Wire> {
  vi.resetModules()
  const m = (await import(WIRE)) as Wire
  m.setWireWindow(m.windowForMode('aggressive'))
  m.setFirstSightPolicy(policy)
  return m
}

/** A first message that lands in the holdout, found by search so no hash value is written down here. */
async function holdoutFirstMessage(): Promise<string> {
  const { armForBody } = await import('../../src/main/headroom/elisionPolicy')
  for (let i = 0; i < 400; i++) {
    const first = `${FIRST_MESSAGE} (${i})`
    if (armForBody({ messages: [{ role: 'user', content: first }] }) === 'holdout') return first
  }
  throw new Error('no holdout opening found in 400 tries')
}

describe('the watcher sees every source it is there to see (the net is not vacuous)', () => {
  it.each<[string, () => void]>([
    ['Date.now', () => { Date.now() }],
    ['new Date()', () => { void new Date() }],
    ['Date()', () => { void (Date as unknown as () => string)() }],
    ['Math.random', () => { const R = Math; void R.random() }],
    ['performance.now', () => { const pf = performance; void pf.now() }],
    ['process.hrtime', () => { process.hrtime() }],
    ['process.hrtime.bigint', () => { process.hrtime.bigint() }],
    ['globalThis.crypto.getRandomValues', () => { globalThis.crypto.getRandomValues(new Uint8Array(4)) }],
    ['globalThis.crypto.randomUUID', () => { globalThis.crypto.randomUUID() }],
  ])('reports %s, however it is reached', (label, call) => {
    expect(reads(call)).toContain(label)
  })

  it('reports the crypto module\'s random functions, through the module the code under test imports', async () => {
    const crypto = await import('crypto')
    expect(reads(() => { crypto.randomBytes(4) })).toEqual(['crypto.randomBytes'])
    expect(reads(() => { crypto.randomUUID() })).toEqual(['crypto.randomUUID'])
    expect(reads(() => { crypto.randomInt(10) })).toEqual(['crypto.randomInt'])
  })

  it('reports nothing for work that reads neither, and puts everything back afterwards', () => {
    expect(reads(() => { JSON.stringify({ a: [1, 2, 3] }); [3, 1, 2].sort() })).toEqual([])
    expect(Date.now()).toBeGreaterThan(0)
    expect(typeof Math.random()).toBe('number')
    expect(new Date(0).getTime()).toBe(0)
  })
})

describe('the compression path reads no clock and no random number, run and counted', () => {
  it('the rewriter, under Late, the holdout and the kill switch, over every shape of body, with the decay pass on', async () => {
    const holdoutFirst = await holdoutFirstMessage()
    const bodies = (first: string): string[] => [
      ...conversationCases(first).map((c) => c.body),
      realistic(first),
      editLoop(first),
      longRun(first, 140), // past the decay threshold, so the ageing-out pass runs
      caseBody('Read', 'code', 80_000, 'string', first),
      caseBody('Bash', 'log', 45_000, 'blocks', first),
    ]
    const seen: string[] = []
    for (const [policy, first] of [['late', FIRST_MESSAGE], ['late', holdoutFirst], ['legacy', FIRST_MESSAGE]] as const) {
      const wire = await launch(policy)
      const list = bodies(first)
      expect(list.length).toBeGreaterThan(10)
      seen.push(...reads(() => { for (const raw of list) wire.rewriteMessagesBody(raw, { decay: true }) }))
    }
    expect(seen).toEqual([])
  })

  it('the arm choice and the stub tally, the stash metadata and its stamps', async () => {
    const { armOf, armForBody } = await import('../../src/main/headroom/elisionPolicy')
    const { classifyMessages, classifyForwardedResults } = await import('../../src/main/headroomProxy/forwardedKinds')
    const { makeMeta, stampModel, stampPolicy } = await import('../../src/main/headroom/elisionMeta')
    const body = JSON.parse(longRun(FIRST_MESSAGE, 30)) as { messages: unknown[] }
    const stashes = [{ token: 'hr_aaaaaaaaaaaaaaaa', original: 'x'.repeat(100), meta: makeMeta('compact', 'Bash', 100, 20) }]
    expect(reads(() => {
      for (let i = 0; i < 50; i++) {
        armOf(body); armForBody(body); classifyMessages(body.messages); classifyForwardedResults(JSON.stringify(body))
        makeMeta('dedup', 'Read', 5000, 90)
        stampModel(stashes, 'claude-opus-5-5'); stampPolicy(stashes, 'late'); stampPolicy(stashes, 'legacy')
      }
    })).toEqual([])
  })

  it('the readers of the answer stream', async () => {
    const { parseUsageFromSse, parseTurnShapeFromSse } = await import('../../src/main/headroomProxy/usageParse')
    const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    const sse =
      ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 3, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 10, output_tokens: 1 } } }) +
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'ToolSearch', input: {} } }) +
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"select:mcp__termpolis__retrieve_full"}' } }) +
      ev('content_block_stop', { index: 0 }) +
      ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 90 } })
    expect(reads(() => { for (let i = 0; i < 50; i++) { parseUsageFromSse(sse); parseTurnShapeFromSse(sse); parseTurnShapeFromSse('not a stream') } })).toEqual([])
  })
})
