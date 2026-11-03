import { describe, it, expect, vi, afterAll } from 'vitest'
import { caseBody, realistic, editLoop, longRun, conversationCases, FIRST_MESSAGE } from './fixtures/lateGoldenCases'

/**
 * The compression path must read no clock and no random number: identical bytes in, identical bytes out,
 * or the compressed prefix differs from turn to turn and the prompt cache is lost on every request.
 * noNondeterministicCompression.test.ts sweeps the source for the words that read one, and a sweep of
 * words is only as good as the words: a clock or a generator reached through an alias or a cast
 * (`const R = Math; R.random()`, `(Date as unknown as () => string)()`, `const pf = performance; pf.now()`)
 * does not contain them. This is the other half. It RUNS the code, with a counter on every source of time
 * and of randomness the runtime has, and asserts that nothing was called.
 *
 * The counters go in once, at the top of this file, before any module under test is first evaluated, and stay
 * until the file is done. A counter installed later (around each run, say) cannot see a clock that a module took
 * as an alias when it was evaluated (`const clock = Date.now`, `const R = Math`) and calls under another name:
 * the alias holds the unwrapped function. With the counters first, the alias holds the counted one. What this
 * still cannot see is a source of time that is not on the list below: a formatter that reads the current time
 * inside the engine (`new Intl.DateTimeFormat().format()`), a native binding, a timer that is read back, a clock
 * of another realm. That is why the static sweep stays beside it, and why the sweep refuses the words Date, Intl,
 * performance, globalThis and Math.random outright.
 *
 * A named import from the process module (`import { hrtime as h } from 'process'`) is held by the static sweep ONLY, and
 * that is deliberate: the counters sit on the global `process`, while a named import reads the value Node put in the
 * module's namespace the first time anything imported it, which can be before these counters were installed. One
 * runner saw such an import and another did not, so this file does not claim it. The sweep refuses the names hrtime,
 * uptime, cpuUsage, memoryUsage and resourceUsage and the modules process and perf_hooks, wherever they are spelled.
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

// Installed before anything below imports the code under test, and undone when this file is done.
const unwatchAll = watchEverything()
afterAll(() => { unwatchAll() })

/** Run `fn` and say what it read. Everything is already watched; this only arms the counter around the call. */
function reads(fn: () => void): string[] {
  hits.what = []
  hits.armed = true
  try { fn() } finally { hits.armed = false }
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

  it('reports a clock or a generator a module took as an alias when it was first evaluated, not only one read by name at call time', async () => {
    vi.resetModules()
    const aliased = await import('./fixtures/clockAliasedAtLoad')
    expect(reads(() => { aliased.readAliasedClock() })).toEqual(['Date.now'])
    expect(reads(() => { aliased.readAliasedDate() })).toEqual(['new Date()'])
    expect(reads(() => { aliased.readAliasedRandom() })).toEqual(['Math.random'])
    expect(reads(() => { aliased.readAliasedStopwatch() })).toEqual(['performance.now'])
  })

  it('reports nothing for work that reads neither, and leaves every watched function working', () => {
    expect(reads(() => { JSON.stringify({ a: [1, 2, 3] }); [3, 1, 2].sort() })).toEqual([])
    expect(Date.now()).toBeGreaterThan(0)
    expect(typeof Math.random()).toBe('number')
    expect(new Date(0).getTime()).toBe(0)
    expect(new Date(0) instanceof Date).toBe(true)
    expect(typeof performance.now()).toBe('number')
    expect(process.hrtime.bigint()).toBeGreaterThan(0n)
    expect(Array.isArray(process.hrtime())).toBe(true)
  })

  it('counts nothing while it is not armed: the framework reads the clock between tests', () => {
    hits.what = []
    Date.now(); Math.random(); performance.now(); void new Date()
    expect(hits.what).toEqual([])
  })

  it('puts back exactly what a watch replaced when it is undone', () => {
    const before = { now: Date.now, random: Math.random, perf: performance.now, D: globalThis.Date, hr: process.hrtime, big: process.hrtime.bigint, uuid: globalThis.crypto.randomUUID }
    const undo = watchEverything()
    expect(Date.now).not.toBe(before.now)
    expect(globalThis.Date).not.toBe(before.D)
    expect(process.hrtime.bigint).not.toBe(before.big)
    undo()
    expect(Date.now).toBe(before.now)
    expect(Math.random).toBe(before.random)
    expect(performance.now).toBe(before.perf)
    expect(globalThis.Date).toBe(before.D)
    expect(process.hrtime).toBe(before.hr)
    expect(process.hrtime.bigint).toBe(before.big)
    expect(globalThis.crypto.randomUUID).toBe(before.uuid)
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
