// Main-thread health + the int8 quantization RECOMMENDATION.
//
// The recommendation is the whole feature. A toggle that says "save 4x RAM!" is an upsell; the
// thing that makes this honest is that it must be willing to say **do not turn this on** — and
// specifically to say "your main thread IS stalling, but not because of the vectors, so this
// will not help you." Those are the branches that matter most here.
//
// quantizationAdvice is PURE (numbers in, advice out), so every verdict is pinned exactly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  quantizationAdvice,
  processHealth,
  startProcessHealth,
  stopProcessHealth,
  _resetProcessHealthForTests,
  STALL_MS,
  VECTOR_RAM_FLOOR_BYTES,
  VECTOR_SHARE_FLOOR,
} from '../../src/main/processHealth'

const MB = 1048576
/** A vector set of a given size, in the exact-float mode (4 B per component). */
const vec = (ramMB: number, quantized = false) => ({
  vectors: Math.round((ramMB * MB) / (384 * (quantized ? 1 : 4))),
  quantized,
  ramBytes: ramMB * MB,
  ramBytesInt8: quantized ? ramMB * MB : (ramMB * MB) / 4,
})
const health = (o: Partial<{ rssBytes: number; loopDelayP99Ms: number; gcMaxPauseMs: number }> = {}) => ({
  rssBytes: o.rssBytes ?? 1000 * MB,
  loopDelayP99Ms: o.loopDelayP99Ms ?? 5,
  gcMaxPauseMs: o.gcMaxPauseMs ?? 3,
})

afterEach(() => {
  stopProcessHealth()
  _resetProcessHealthForTests()
})

describe('quantizationAdvice — the burden of proof sits on ENABLING', () => {
  it('small vectors + healthy thread => not-needed (this is David today, and forever for most users)', () => {
    const a = quantizationAdvice(vec(163), health()) // ~106k vectors, the real current corpus
    expect(a.verdict).toBe('not-needed')
    expect(a.headline).toMatch(/not needed/i)
    expect(a.detail).toMatch(/leave it off/i)
  })

  it('small vectors STILL says not-needed even when the thread is badly stalling', () => {
    // The saving is irrelevant at this size, so no amount of jank makes this the right lever.
    const a = quantizationAdvice(vec(163), health({ loopDelayP99Ms: 400, gcMaxPauseMs: 300 }))
    expect(a.verdict).toBe('not-needed')
  })

  // THE INTEGRITY TEST. This is the verdict a dishonest panel would never render.
  it('stalling thread + vectors a SMALL SHARE of memory => wont-help, and says so plainly', () => {
    const a = quantizationAdvice(
      vec(300), // over the 256 MB floor, so "big enough to matter" in absolute terms…
      health({ rssBytes: 8000 * MB, loopDelayP99Ms: 220, gcMaxPauseMs: 180 }), // …but only ~4% of RSS
    )
    expect(a.verdict).toBe('wont-help')
    expect(a.headline).toMatch(/not because of the vectors/i)
    expect(a.detail).toMatch(/would not fix the stalls/i)
    expect(a.detail).toMatch(/look elsewhere/i)
  })

  it('stalling thread + vectors a LARGE share => recommended, with the evidence quoted back', () => {
    const a = quantizationAdvice(
      vec(1500),
      health({ rssBytes: 2600 * MB, loopDelayP99Ms: 180, gcMaxPauseMs: 120 }),
    )
    expect(a.verdict).toBe('recommended')
    expect(a.headline).toMatch(/worth turning on/i)
    expect(a.detail).toContain('180') // it cites THIS machine's numbers, not a generic pitch
    expect(a.detail).toContain('120')
    expect(a.detail).toMatch(/reversible/i)
  })

  it('big vectors but a healthy thread => optional, and refuses to invent a problem', () => {
    const a = quantizationAdvice(vec(1500), health({ rssBytes: 2600 * MB }))
    expect(a.verdict).toBe('optional')
    expect(a.detail).toMatch(/no problem to fix/i)
  })

  it('already on => enabled, and tells you it is safe to go back', () => {
    const a = quantizationAdvice(vec(400, true), health())
    expect(a.verdict).toBe('enabled')
    expect(a.savingBytes).toBe(0) // nothing left to save
    expect(a.detail).toMatch(/switch back/i)
    expect(a.detail).toMatch(/lose nothing/i)
  })

  it('reports the saving as the float→int8 delta (3/4 of current), never a negative', () => {
    const a = quantizationAdvice(vec(400), health())
    expect(a.savingBytes).toBe(400 * MB - 100 * MB)
    // A degenerate store must not produce a negative "saving".
    const z = quantizationAdvice({ vectors: 0, quantized: false, ramBytes: 0, ramBytesInt8: 0 }, health())
    expect(z.savingBytes).toBe(0)
  })

  it('a zero RSS (unreadable) cannot divide-by-zero into a bogus share', () => {
    const a = quantizationAdvice(vec(1500), { rssBytes: 0, loopDelayP99Ms: 200, gcMaxPauseMs: 200 })
    // share computes to 0 → below the floor → it must NOT claim the vectors are the cause.
    expect(a.verdict).toBe('wont-help')
  })

  describe('the thresholds are exact, not vibes', () => {
    it(`p99 exactly ${STALL_MS} ms counts as stalling`, () => {
      const at = quantizationAdvice(vec(1500), health({ rssBytes: 2600 * MB, loopDelayP99Ms: STALL_MS }))
      const below = quantizationAdvice(vec(1500), health({ rssBytes: 2600 * MB, loopDelayP99Ms: STALL_MS - 1 }))
      expect(at.verdict).toBe('recommended')
      expect(below.verdict).toBe('optional')
    })

    it('a long GC pause alone is enough to count as stalling (loop p99 can look fine)', () => {
      const a = quantizationAdvice(
        vec(1500),
        health({ rssBytes: 2600 * MB, loopDelayP99Ms: 2, gcMaxPauseMs: STALL_MS }),
      )
      expect(a.verdict).toBe('recommended')
    })

    it(`vectors below ${VECTOR_RAM_FLOOR_BYTES / MB} MB are never "big enough to matter"`, () => {
      const under = quantizationAdvice(vec(255), health({ rssBytes: 300 * MB, loopDelayP99Ms: 500 }))
      expect(under.verdict).toBe('not-needed')
    })

    it(`a vector share below ${VECTOR_SHARE_FLOOR * 100}% is never blamed for the stalls`, () => {
      // 300 MB of vectors in a 1600 MB process = 18.75%, just under the bar.
      const a = quantizationAdvice(vec(300), health({ rssBytes: 1600 * MB, loopDelayP99Ms: 300 }))
      expect(a.verdict).toBe('wont-help')
      // Nudge the share over the bar and the verdict flips.
      const b = quantizationAdvice(vec(300), health({ rssBytes: 1400 * MB, loopDelayP99Ms: 300 }))
      expect(b.verdict).toBe('recommended')
    })
  })
})

describe('processHealth — live sampling', () => {
  beforeEach(() => { _resetProcessHealthForTests() })

  it('reports real process memory even before sampling starts (never throws)', () => {
    const h = processHealth()
    expect(h.rssBytes).toBeGreaterThan(0)
    expect(h.heapUsedBytes).toBeGreaterThan(0)
    expect(h.sampleWindowMs).toBe(0) // not started → no window
    expect(h.gcTimeFraction).toBe(0) // and therefore no rate, rather than a divide-by-zero
  })

  it('starting begins a sample window, and the window grows with wall clock', () => {
    let t = 1000
    startProcessHealth(() => t)
    t = 6000
    const h = processHealth(() => t)
    expect(h.sampleWindowMs).toBe(5000)
  })

  it('start is idempotent — a second call does not reset the window', () => {
    let t = 1000
    startProcessHealth(() => t)
    t = 3000
    startProcessHealth(() => t) // ignored
    t = 4000
    expect(processHealth(() => t).sampleWindowMs).toBe(3000) // still measured from 1000
  })

  it('exposes the loop-delay percentiles and GC counters as numbers, not undefined', () => {
    startProcessHealth()
    const h = processHealth()
    for (const k of ['loopDelayP50Ms', 'loopDelayP99Ms', 'loopDelayMaxMs', 'gcMajorCount', 'gcTotalPauseMs', 'gcMaxPauseMs'] as const) {
      expect(typeof h[k]).toBe('number')
      expect(Number.isFinite(h[k])).toBe(true)
    }
  })

  it('the packed vectors are counted in arrayBuffers, not the V8 heap', () => {
    // This is why the panel reads arrayBufferBytes: a Float32Array is off-heap. If we watched
    // heapUsed we would be watching the wrong number entirely.
    const before = processHealth().arrayBufferBytes
    const big = new Float32Array(8 * 1024 * 1024) // 32 MB
    big[0] = 1 // keep it alive
    const after = processHealth().arrayBufferBytes
    expect(after).toBeGreaterThan(before)
    expect(big[0]).toBe(1)
  })

  it('stop is safe, and safe to call twice', () => {
    startProcessHealth()
    expect(() => { stopProcessHealth(); stopProcessHealth() }).not.toThrow()
  })

  it('survives a platform with no event-loop monitor (reports zeroes, does not crash)', () => {
    // Degrade rather than explode: a missing perf_hooks capability must not take out Settings.
    const spy = vi.spyOn(process, 'memoryUsage')
    spy.mockReturnValue({ rss: 100, heapTotal: 50, heapUsed: 40, external: 5, arrayBuffers: 10 } as never)
    const h = processHealth()
    expect(h.rssBytes).toBe(100)
    expect(h.arrayBufferBytes).toBe(10)
    spy.mockRestore()
  })
})

// ---------------------------------------------------------------------------------------------
// STALL RECORDING — the freezes the user actually feels.
//
// David: "the whole app freezes up for 2-3 seconds and says not responding, then goes back."
// That is the main-thread event loop not being served. Windows paints "(Not Responding)" and every
// window dies at once, because main pumps every PTY and serves all IPC.
//
// A percentile CANNOT show you this: one 2.5s stop-the-world pause barely moves a p99 over a 60s
// window, so a dashboard of healthy averages will insist nothing is wrong while the app freezes
// twice a minute. Freezes must be recorded as discrete EVENTS, with a cause.
// ---------------------------------------------------------------------------------------------
import {
  recentStalls,
  markBusy,
  clearBusy,
  tracked,
  trackedAsync,
  currentBreadcrumb,
  initStallLog,
  persistedStalls,
  _pushStallForTests,
  _clearStallsForTests,
  STALL_RECORD_MS,
  type Stall,
} from '../../src/main/processHealth'
import * as nfs from 'node:fs'
import * as nos from 'node:os'
import * as npath from 'node:path'

const stall = (o: Partial<Stall> = {}): Stall => ({
  ts: 1000,
  startedAt: 1000 - 2400,
  durationMs: 2400,
  cause: 'gc',
  gcPauseMs: 2350,
  heapUsedMB: 1100,
  rssMB: 1500,
  breadcrumb: null,
  ...o,
})

describe('stall recording', () => {
  beforeEach(() => { _clearStallsForTests(); clearBusy() })
  afterEach(() => { _clearStallsForTests(); clearBusy() })

  it('starts empty — no freezes is a real answer, not a missing one', () => {
    expect(recentStalls()).toEqual([])
  })

  it('records a freeze with its duration, cause, and the heap at the time', () => {
    _pushStallForTests(stall())
    const [s] = recentStalls()
    expect(s.durationMs).toBe(2400)
    expect(s.cause).toBe('gc')
    expect(s.heapUsedMB).toBe(1100) // the number that explains the freeze
    expect(s.rssMB).toBe(1500)
  })

  it('returns a COPY — a caller cannot corrupt the history it is reading', () => {
    _pushStallForTests(stall())
    const a = recentStalls()
    a.push(stall({ durationMs: 9999 }))
    expect(recentStalls()).toHaveLength(1)
  })

  it('the threshold is a freeze you would notice, not a hiccup', () => {
    // 400ms: below this it is lag; above it the app stops answering.
    expect(STALL_RECORD_MS).toBeGreaterThanOrEqual(250)
    expect(STALL_RECORD_MS).toBeLessThanOrEqual(1000)
  })

  it('a GC-caused freeze is labelled GC — not "unknown"', () => {
    _pushStallForTests(stall({ cause: 'gc', gcPauseMs: 2350, durationMs: 2400 }))
    expect(recentStalls()[0].cause).toBe('gc')
  })

  it('synchronous work is labelled by its BREADCRUMB, so the culprit has a name', () => {
    _pushStallForTests(stall({ cause: 'sync-work', gcPauseMs: 0, breadcrumb: 'memory: persist HNSW index' }))
    const [s] = recentStalls()
    expect(s.cause).toBe('sync-work')
    expect(s.breadcrumb).toBe('memory: persist HNSW index')
  })
})

describe('breadcrumbs', () => {
  beforeEach(() => { _clearStallsForTests(); clearBusy() })
  afterEach(() => { clearBusy() })

  it('tracked() runs the work and returns its value', () => {
    expect(tracked('indexing', () => 6 * 7)).toBe(42)
  })

  it('tracked() clears the breadcrumb even when the work throws', () => {
    // A breadcrumb left behind would mis-attribute the NEXT freeze to work that already finished —
    // which is worse than no breadcrumb, because it is confidently wrong.
    expect(() => tracked('boom', () => { throw new Error('x') })).toThrow('x')
    _pushStallForTests(stall({ cause: 'sync-work', breadcrumb: null }))
    expect(recentStalls()[0].breadcrumb).toBeNull()
  })

  it('markBusy / clearBusy are a matched pair', () => {
    expect(() => { markBusy('a'); clearBusy() }).not.toThrow()
  })
})

// The breadcrumb is the whole point of recording a stall: "sync-work, 2.8s" tells you the app froze,
// but not what froze it, which is the only question worth answering.
//
// HISTORY, because the first explanation was wrong and the wrong one is seductive: these marks first
// shipped with ZERO call sites, so the obvious diagnosis was "wire them up". They were wired up — and
// every stall STILL recorded `breadcrumb: null`, on freezes up to 18.8 seconds, because the watchdog
// read the label only AFTER the frozen work's `finally` had already cleared it. Call sites were never
// the problem; the sampling model was.
//
// The tests below check that a label is set and cleared correctly, which is necessary and NOT
// sufficient — every one of them passed throughout the entire period the panel was naming nothing.
// The tests that actually hold the feature up are in tests/electron/stallAttribution.test.ts, and
// they work by genuinely freezing the event loop and letting the real watchdog observe it.
describe('breadcrumbs name the work that froze the thread', () => {
  beforeEach(() => { _clearStallsForTests(); clearBusy() })
  afterEach(() => { _clearStallsForTests(); clearBusy() })

  it('trackedAsync attaches the label across awaits and returns the value', async () => {
    let seen: string | null = 'not-run'
    const v = await trackedAsync('code-graph:sweep', async () => {
      await new Promise((r) => setImmediate(r)) // a real macrotask boundary, as the sweep has
      seen = currentBreadcrumb()
      return 42
    })
    expect(v).toBe(42)
    expect(seen).toBe('code-graph:sweep')
    expect(currentBreadcrumb()).toBeNull() // and it lets go afterwards
  })

  it('trackedAsync clears the breadcrumb even when the work rejects', async () => {
    await expect(trackedAsync('memory:compact', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(currentBreadcrumb()).toBeNull()
  })

  it('nested work reports the INNERMOST label, and finishing it restores the outer one', () => {
    // A sweep persists the graph inside itself. With a single breadcrumb slot the inner clear() would
    // erase the outer label and a later freeze would be attributed to nothing at all.
    const inner = tracked('code-graph:sweep', () => {
      const deepest = tracked('code-graph:persist', () => currentBreadcrumb())
      return { deepest, afterInner: currentBreadcrumb() }
    })
    expect(inner.deepest).toBe('code-graph:persist') // most specific true answer wins
    expect(inner.afterInner).toBe('code-graph:sweep') // outer label survived the inner clear
    expect(currentBreadcrumb()).toBeNull()
  })
})

// A freeze you can no longer see is a freeze you cannot fix. Stalls used to live only in memory, so
// they died with the process — and a freeze bad enough to care about is usually one the user
// restarted the app to escape, which erased the only record of it.
describe('stalls survive the process that had them', () => {
  let dir: string
  beforeEach(() => {
    dir = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'stalllog-'))
    _clearStallsForTests()
  })
  afterEach(() => {
    _resetProcessHealthForTests()
    try { nfs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('reads back stalls appended on a previous run', () => {
    initStallLog(dir)
    const a = stall({ ts: 1, durationMs: 2777, cause: 'sync-work', breadcrumb: 'code-graph:sweep' })
    const b = stall({ ts: 2, durationMs: 900, cause: 'gc', breadcrumb: null })
    nfs.appendFileSync(npath.join(dir, 'stalls.jsonl'), JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n')

    const got = persistedStalls()
    expect(got).toHaveLength(2)
    expect(got[0].breadcrumb).toBe('code-graph:sweep') // the answer, straight off disk
    expect(got[0].durationMs).toBe(2777)
    expect(got[1].cause).toBe('gc')
  })

  it('skips a torn line rather than losing the whole history', () => {
    initStallLog(dir)
    const good = JSON.stringify(stall({ durationMs: 500 }))
    nfs.appendFileSync(npath.join(dir, 'stalls.jsonl'), `${good}\n{"half-written`)
    expect(persistedStalls()).toHaveLength(1)
  })

  it('returns nothing (never throws) when no log has been initialised', () => {
    _resetProcessHealthForTests()
    expect(persistedStalls()).toEqual([])
  })
})
