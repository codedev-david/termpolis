// Does a freeze actually get NAMED?
//
// This file exists because the old suite said yes and the shipped app said `breadcrumb: null`, seven
// times out of seven, on freezes up to 18.8 seconds long.
//
// The old tests passed because none of them ever ran the watchdog. They hand-pushed a Stall with the
// label already filled in and asserted the field came back (`_pushStallForTests({breadcrumb: 'x'})`
// -> `expect(...breadcrumb).toBe('x')`), or they called `currentBreadcrumb()` from INSIDE the tracked
// block. Both are true. Neither is the question. The watchdog reads the label from OUTSIDE the block,
// after the thread comes back — and by then `finally { clearBusy() }` has already destroyed it.
//
// So: these tests block the event loop FOR REAL, let the REAL watchdog fire, and assert on what it
// actually recorded. They are slow on purpose. A test for a freeze that never freezes anything is
// how we got here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as nfs from 'node:fs'
import * as nos from 'node:os'
import * as npath from 'node:path'
import {
  startProcessHealth,
  stopProcessHealth,
  _resetProcessHealthForTests,
  _clearStallsForTests,
  recentStalls,
  attributeSpans,
  tracked,
  trackedAsync,
  markBusy,
  clearBusy,
  initStallLog,
  persistedStalls,
  STALL_RECORD_MS,
} from '../../src/main/processHealth'

/** Hold the thread. No awaits, no yields — exactly what a freeze IS. */
function blockFor(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* the event loop is now dead, which is the point */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Long enough that the 250 ms watchdog is unambiguously late (STALL_RECORD_MS = 400). */
const FREEZE_MS = 1200

beforeEach(() => { _resetProcessHealthForTests(); _clearStallsForTests(); clearBusy() })
afterEach(() => { stopProcessHealth(); _resetProcessHealthForTests(); _clearStallsForTests(); clearBusy() })

describe('the watchdog names the work that actually froze the thread', () => {
  it('attributes a REAL synchronous freeze to the operation that caused it', async () => {
    // THE REGRESSION TEST. On the old code this records `breadcrumb: null` — the label is cleared by
    // tracked()'s own `finally` microseconds before the watchdog timer is allowed to run.
    startProcessHealth(Date.now, false) // stacks off: this is about the LABEL surviving
    await sleep(300) // let one healthy tick establish a baseline

    tracked('memory:load-shard', () => blockFor(FREEZE_MS))

    await sleep(400) // let the watchdog fire now that the thread is free again
    const [s, ...rest] = recentStalls()
    expect(rest).toHaveLength(0)
    expect(s).toBeDefined()
    expect(s.durationMs).toBeGreaterThanOrEqual(STALL_RECORD_MS)
    expect(s.breadcrumb).toBe('memory:load-shard') // <- the whole bug, in one assertion
    expect(s.cause).toBe('sync-work')
  })

  it('says how much of the freeze the operation accounts for, not just its name', async () => {
    startProcessHealth(Date.now, false)
    await sleep(300)
    tracked('memory:compact', () => blockFor(FREEZE_MS))
    await sleep(400)

    const [s] = recentStalls()
    expect(s.spans?.[0].label).toBe('memory:compact')
    // It held the thread for essentially the entire freeze — that is the claim worth making.
    expect(s.spans?.[0].ms).toBeGreaterThan(FREEZE_MS * 0.8)
    // And NEVER more than the freeze itself. An earlier draft attributed against the whole gap since
    // the previous tick, which includes healthy time, and cheerfully reported "0.8s of a 0.6s freeze".
    expect(s.spans?.[0].ms).toBeLessThanOrEqual(s.durationMs)
  })

  it('no operation can ever own more of the freeze than the freeze lasted', async () => {
    // The invariant behind the arithmetic on every row of the panel.
    startProcessHealth(Date.now, false)
    await sleep(300)
    markBusy('memory:load-shard') // opened well BEFORE the freeze...
    await sleep(300)
    tracked('memory:build-index', () => blockFor(FREEZE_MS)) // ...and still open across it
    clearBusy('memory:load-shard')
    await sleep(400)

    const [s] = recentStalls()
    for (const sp of s.spans ?? []) expect(sp.ms).toBeLessThanOrEqual(s.durationMs)
    expect(s.spans?.map((x) => x.label)).toEqual(
      expect.arrayContaining(['memory:load-shard', 'memory:build-index']),
    )
  })

  it('bare markBusy/clearBusy around blocking work survives too (the memory:load-shard shape)', async () => {
    // swarmMemory.ts does exactly this, by hand, around a 464 MB read + 108k decrypts.
    startProcessHealth(Date.now, false)
    await sleep(300)
    markBusy('memory:load-shard')
    blockFor(FREEZE_MS)
    clearBusy('memory:load-shard')
    await sleep(400)

    expect(recentStalls()[0]?.breadcrumb).toBe('memory:load-shard')
  })

  it('an async op whose awaits never yield is still named (the v1.25.11 code-graph shape)', async () => {
    // `await` on an ALREADY-RESOLVED promise schedules a microtask, which does NOT return to the
    // event loop. The sweep looked cooperative and was in fact one unbroken 2.7 s block.
    startProcessHealth(Date.now, false)
    await sleep(300)
    await trackedAsync('code-graph:sweep', async () => {
      for (let i = 0; i < 3; i++) { await Promise.resolve(); blockFor(500) }
    })
    await sleep(400)

    expect(recentStalls()[0]?.breadcrumb).toBe('code-graph:sweep')
  })

  it('records when the freeze BEGAN, not just when the thread came back', async () => {
    startProcessHealth(Date.now, false)
    await sleep(300)
    const before = Date.now()
    tracked('memory:compact', () => blockFor(FREEZE_MS))
    await sleep(400)

    const [s] = recentStalls()
    expect(s.startedAt).toBeGreaterThanOrEqual(before - 300)
    expect(s.startedAt).toBeLessThan(s.ts)
    expect(s.ts - s.startedAt).toBe(s.durationMs)
  })

  it('a healthy thread records nothing — "no freezes" stays a real answer', async () => {
    startProcessHealth(Date.now, false)
    await sleep(900) // several ticks, no blocking
    expect(recentStalls()).toEqual([])
  })

  it('work that finished LONG before the freeze is not blamed for it', async () => {
    startProcessHealth(Date.now, false)
    await sleep(300)
    tracked('memory:compact', () => { /* instant */ })
    await sleep(600) // it is now firmly in the past
    tracked('code-graph:persist', () => blockFor(FREEZE_MS))
    await sleep(400)

    const [s] = recentStalls()
    expect(s.breadcrumb).toBe('code-graph:persist')
    expect(s.spans?.map((x) => x.label)).not.toContain('memory:compact')
  })
})

// The log is read on the MAIN THREAD, every 3 seconds, for as long as the panel is open. Left
// unbounded it grows forever, and the freeze panel becomes a freeze cause — so it is capped, only its
// tail is read, and the trim REWRITES THE FILE. A bug in that rewrite destroys the very evidence this
// whole feature exists to preserve, which is why it is tested against a real freeze rather than trusted.
describe('the stall log is a diagnostic, not an archive', () => {
  let dir: string
  const fatStall = (i: number): string => JSON.stringify({
    ts: i, startedAt: i - 500, durationMs: 500, cause: 'sync-work', gcPauseMs: 0,
    heapUsedMB: 100, rssMB: 200, breadcrumb: 'old:' + 'x'.repeat(400),
  })

  beforeEach(() => {
    dir = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'stalltrim-'))
    _resetProcessHealthForTests()
    _clearStallsForTests()
  })
  afterEach(() => {
    stopProcessHealth()
    _resetProcessHealthForTests()
    try { nfs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('caps the file once it outgrows its budget, WITHOUT corrupting the records it keeps', async () => {
    initStallLog(dir)
    const p = npath.join(dir, 'stalls.jsonl')
    nfs.writeFileSync(p, Array.from({ length: 1500 }, (_, i) => fatStall(i)).join('\n') + '\n')
    const before = nfs.statSync(p).size
    expect(before).toBeGreaterThan(512 * 1024) // over the cap, so the next append must trim

    startProcessHealth(Date.now, false)
    await sleep(300)
    tracked('memory:compact', () => blockFor(FREEZE_MS)) // a REAL freeze -> append -> trim
    await sleep(400)

    expect(nfs.statSync(p).size).toBeLessThan(before)
    const kept = persistedStalls()
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThanOrEqual(100)
    // Every retained record is intact — the rewrite tore nothing in half...
    for (const s of kept) expect(typeof s.durationMs).toBe('number')
    // ...and the freeze that TRIGGERED the trim is still the newest thing in the log.
    expect(kept[kept.length - 1].breadcrumb).toBe('memory:compact')
  })

  it('reads only the tail of a huge log, and never parses the half-record it sliced into', () => {
    // Reading from the middle of the file lands mid-line. That fragment is not a record and must be
    // dropped, not fed to JSON.parse and silently counted as a torn line.
    initStallLog(dir)
    nfs.writeFileSync(
      npath.join(dir, 'stalls.jsonl'),
      Array.from({ length: 1500 }, (_, i) => fatStall(i)).join('\n') + '\n',
    )
    const got = persistedStalls()
    expect(got.length).toBeGreaterThan(0)
    for (const s of got) expect(s.breadcrumb).toMatch(/^old:x+$/) // every one whole
  })
})

// The overlap maths, pinned exactly. These are the shapes that a live-variable breadcrumb got wrong,
// so they are worth stating as facts rather than trusting to a 1.2 s integration test.
describe('attributeSpans — what overlapped the window the thread was gone for', () => {
  const open = (label: string, startedAt: number, depth = 0) => ({ label, startedAt, depth })
  const done = (label: string, startedAt: number, endedAt: number, depth = 0) =>
    ({ label, startedAt, endedAt, depth })

  it('credits a span with only the part of it that lands INSIDE the freeze', () => {
    // Ran 0-1000; the thread was only observed gone from 600-1000. It owns 400 ms of that window.
    const got = attributeSpans(600, 1000, [], [done('memory:load-shard', 0, 1000)])
    expect(got).toEqual([{ label: 'memory:load-shard', ms: 400 }])
  })

  it('a span still OPEN when the tick fires is credited to the end of the window', () => {
    const got = attributeSpans(1000, 2000, [open('code-graph:sweep', 1200)], [])
    expect(got).toEqual([{ label: 'code-graph:sweep', ms: 800 }])
  })

  it('nested work reports BOTH, outer first — "the sweep froze you, and this is which part"', () => {
    const got = attributeSpans(0, 1000, [], [
      done('code-graph:sweep', 0, 1000, 0),
      done('code-graph:persist', 700, 900, 1), // inside the sweep
    ])
    expect(got).toEqual([
      { label: 'code-graph:sweep', ms: 1000 },
      { label: 'code-graph:persist', ms: 200 },
    ])
  })

  it('a wrapper that is ENTIRELY one inner op does not out-rank the op it wraps', () => {
    // Coextensive spans cannot be told apart by time — only by nesting depth. Getting this from the
    // incidental order they happened to be closed in is how implicit assumptions become bugs.
    const got = attributeSpans(0, 1000, [], [
      done('outer', 0, 1000, 0),
      done('inner', 0, 1000, 1),
    ])
    expect(got[0].label).toBe('inner')
    expect(got[1].label).toBe('outer') // still reported — the wrapper is context, not noise
  })

  it('a span entirely before the window earns nothing (no confidently-wrong attribution)', () => {
    expect(attributeSpans(1000, 2000, [], [done('memory:compact', 0, 900)])).toEqual([])
  })

  it('a span entirely after the window earns nothing', () => {
    expect(attributeSpans(0, 500, [], [done('memory:compact', 600, 900)])).toEqual([])
  })

  it('the same label running twice inside one freeze is summed, not double-listed', () => {
    const got = attributeSpans(0, 1000, [], [
      done('memory:load-shard', 100, 300),
      done('memory:load-shard', 500, 800),
    ])
    expect(got).toEqual([{ label: 'memory:load-shard', ms: 500 }])
  })

  it('concurrent unrelated work is ranked by how much of the freeze each one owns', () => {
    const got = attributeSpans(0, 1000, [], [
      done('memory:compact', 0, 200),
      done('code-graph:sweep', 100, 900),
    ])
    expect(got.map((s) => s.label)).toEqual(['code-graph:sweep', 'memory:compact'])
    expect(got[0].ms).toBe(800)
  })

  it('nothing labelled => nothing claimed. It says null rather than guessing.', () => {
    expect(attributeSpans(0, 1000, [], [])).toEqual([])
  })
})
