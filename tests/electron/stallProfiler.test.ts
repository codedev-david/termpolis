// Naming the freeze NOBODY predicted.
//
// A manual breadcrumb can only name work someone thought to label in advance. That is fine for the
// five heavy operations we already knew about — and useless for the sixth, which is the one that
// will actually freeze you next. The V8 sampling profiler needs no foresight: it samples on its own
// native thread, so it keeps walking the JS stack while this thread is completely dead.
//
// Two halves, tested separately:
//   - attributeProfile() is PURE (profile in, frames out) — every edge pinned against a synthetic
//     profile, no timing, no flake.
//   - the live sampler is tested by ACTUALLY FREEZING THE THREAD and asserting it gets named.

import { describe, it, expect, afterEach } from 'vitest'
import {
  attributeProfile,
  startStallProfiler,
  stopStallProfiler,
  isStallProfilerRunning,
  sampleStallWindow,
  rotateStallProfileIfStale,
  _resetStallProfilerForTests,
  PROFILE_ROTATE_MS,
  type CpuProfile,
  type ClockAnchor,
} from '../../src/main/stallProfiler'

afterEach(() => { stopStallProfiler(); _resetStallProfilerForTests() })

// A profile whose monotonic clock starts at 1_000_000 us and whose wall clock starts at epoch 5000.
const anchor: ClockAnchor = { epochMs: 5000, monotonicUs: 1_000_000 }

const profile = (nodes: CpuProfile['nodes'], samples: number[], deltasUs: number[]): CpuProfile => ({
  nodes,
  startTime: 1_000_000,
  samples,
  timeDeltas: deltasUs,
})

describe('attributeProfile — what the CPU was actually running', () => {
  it('names a JS function and charges it the time it held the thread', () => {
    const p = profile(
      [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
       { id: 2, callFrame: { functionName: 'reloadFromImpl', url: '/app/src/main/swarmMemory.ts', lineNumber: 346 } }],
      [2, 2, 2],
      [10_000, 10_000, 10_000], // 3 samples, 10 ms apart
    )
    const got = attributeProfile(p, anchor, 5000, 6000)
    expect(got.frames).toEqual([
      { fn: 'reloadFromImpl', file: 'swarmMemory.ts', line: 347, ms: 30 }, // V8 lines are 0-based
    ])
    expect(got.sampleCount).toBe(3)
  })

  it('a NATIVE leaf is reported at the nearest location in OUR code, not blamed on "read"', () => {
    // A 464 MB readFileSync samples as a native `read` with no source location at all. Reporting
    // "read" alone is true and completely useless; it has to point back at the caller.
    const p = profile(
      [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
       { id: 2, callFrame: { functionName: 'reloadFromImpl', url: '/app/src/main/swarmMemory.ts', lineNumber: 376 }, children: [3] },
       { id: 3, callFrame: { functionName: 'readFileSync', url: 'node:fs', lineNumber: 440 }, children: [4] },
       { id: 4, callFrame: { functionName: 'read', url: '', lineNumber: -1 } }],
      [4, 4],
      [10_000, 10_000],
    )
    const [f] = attributeProfile(p, anchor, 5000, 6000).frames
    expect(f.fn).toBe('read')              // what the CPU was in
    expect(f.file).toBe('swarmMemory.ts')  // ...and whose fault that is
    expect(f.line).toBe(377)
  })

  it('climbs PAST node internals to reach our code', () => {
    const p = profile(
      [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
       { id: 2, callFrame: { functionName: 'compactSelfShardImpl', url: '/app/src/main/swarmMemory.ts', lineNumber: 2599 }, children: [3] },
       { id: 3, callFrame: { functionName: 'writeFileSync', url: 'node:fs', lineNumber: 2200 } }],
      [3],
      [10_000],
    )
    const [f] = attributeProfile(p, anchor, 5000, 6000).frames
    expect(f.file).toBe('swarmMemory.ts') // NOT 'node:fs' — nobody can go and fix node:fs
    expect(f.fn).toBe('writeFileSync')
  })

  it('reports GC as its own frame AND as a separate total — an independent witness', () => {
    // The PerformanceObserver delivers GC entries through the event loop, so it can under-report a
    // freeze's own GC. The sampler saw the collector directly. This is the cross-check.
    const p = profile(
      [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3] },
       { id: 2, callFrame: { functionName: 'buildLexicalIndex', url: '/app/src/main/lexicalIndex.ts', lineNumber: 40 } },
       { id: 3, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } }],
      [2, 3, 3, 2],
      [10_000, 10_000, 10_000, 10_000],
    )
    const got = attributeProfile(p, anchor, 5000, 6000)
    expect(got.gcMs).toBe(20)
    expect(got.frames.map((f) => f.fn)).toContain('(garbage collector)')
  })

  it('(idle) is never blamed for a freeze — it is the opposite of one', () => {
    const p = profile(
      [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3] },
       { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
       { id: 3, callFrame: { functionName: 'realWork', url: '/app/src/main/x.ts', lineNumber: 9 } }],
      [2, 2, 2, 3],
      [10_000, 10_000, 10_000, 10_000],
    )
    const got = attributeProfile(p, anchor, 5000, 6000)
    expect(got.frames.map((f) => f.fn)).toEqual(['realWork'])
  })

  it('only counts samples INSIDE the freeze window — a stack from before it is not evidence', () => {
    // Samples at epoch 5010, 5020, 5030. Window is 5015-5025, so exactly one qualifies.
    const p = profile(
      [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
       { id: 2, callFrame: { functionName: 'hot', url: '/app/src/main/x.ts', lineNumber: 1 } }],
      [2, 2, 2],
      [10_000, 10_000, 10_000],
    )
    expect(attributeProfile(p, anchor, 5015, 5025).sampleCount).toBe(1)
    expect(attributeProfile(p, anchor, 5000, 5030).sampleCount).toBe(3)
  })

  it('the same native leaf under two different callers stays two findings, not one', () => {
    const p = profile(
      [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 4] },
       { id: 2, callFrame: { functionName: 'loadShard', url: '/app/src/main/swarmMemory.ts', lineNumber: 10 }, children: [3] },
       { id: 3, callFrame: { functionName: 'read', url: '', lineNumber: -1 } },
       { id: 4, callFrame: { functionName: 'sweepGraph', url: '/app/src/main/codeGraph.ts', lineNumber: 20 }, children: [5] },
       { id: 5, callFrame: { functionName: 'read', url: '', lineNumber: -1 } }],
      [3, 5],
      [10_000, 10_000],
    )
    const got = attributeProfile(p, anchor, 5000, 6000)
    expect(got.frames).toHaveLength(2) // merging these would hide WHICH read froze you
    expect(got.frames.map((f) => f.file).sort()).toEqual(['codeGraph.ts', 'swarmMemory.ts'])
  })

  it('an empty profile is an empty answer, not a crash', () => {
    expect(attributeProfile(profile([], [], []), anchor, 0, 1).frames).toEqual([])
    expect(attributeProfile({ nodes: [], startTime: 0 }, anchor, 0, 1).sampleCount).toBe(0)
  })
})

// --- the live sampler, against a REAL frozen thread ---------------------------------------------

// Each of these gets its OWN function, called exactly once. That is not fussiness: V8 inlines a hot
// callee into its caller and the callee then vanishes from the profile's leaf frames (see the module
// header). Re-using one helper across tests would make the second assertion depend on JIT state —
// which is how this test failed the first time I wrote it.
function chewTheCpuForAWhile(ms: number): number {
  let x = 0
  const end = Date.now() + ms
  while (Date.now() < end) { for (let i = 1; i < 200_000; i++) x += Math.sqrt(i) / i }
  return x
}
function grindAwayAtTheHeap(ms: number): number {
  let x = 0
  const end = Date.now() + ms
  while (Date.now() < end) { for (let i = 1; i < 200_000; i++) x += Math.cbrt(i) / i }
  return x
}

describe('the live sampler names work that nobody labelled', () => {
  it('samples straight through a frozen thread and names the function that froze it', () => {
    // THE POINT OF THE WHOLE FILE. `chewTheCpuForAWhile` has no breadcrumb, no tracked() wrapper, and
    // nobody predicted it. The event loop is completely dead while it runs. It still gets named.
    expect(startStallProfiler()).toBe(true)
    expect(isStallProfilerRunning()).toBe(true)

    const from = Date.now()
    const burned = chewTheCpuForAWhile(900)
    const to = Date.now()

    const got = sampleStallWindow(from, to)
    expect(got).not.toBeNull()
    expect(got!.sampleCount).toBeGreaterThan(10) // it really did keep sampling while JS was blocked
    expect(got!.frames.some((f) => f.fn === 'chewTheCpuForAWhile')).toBe(true)
    expect(burned).toBeGreaterThan(0) // (and V8 did not optimise the work away)
  })

  it('charges the freeze to the frame roughly in proportion to the time it actually held', () => {
    startStallProfiler()
    const from = Date.now()
    grindAwayAtTheHeap(800)
    const to = Date.now()

    const hot = sampleStallWindow(from, to)!.frames.find((f) => f.fn === 'grindAwayAtTheHeap')
    expect(hot).toBeDefined()
    expect(hot!.ms).toBeGreaterThan(300) // it owned most of the window; exact ms is sampling-dependent
    expect(hot!.ms).toBeLessThanOrEqual(to - from + 50)
  })

  it('a window with nothing in it yields no frames rather than an invented culprit', () => {
    startStallProfiler()
    const got = sampleStallWindow(1, 2) // an epoch window from 1970 — nothing can be in it
    expect(got).not.toBeNull()
    expect(got!.frames).toEqual([])
  })

  it('rotates the live profile so its own harvest never becomes a freeze', () => {
    let t = 1_000_000
    startStallProfiler(() => t)
    expect(rotateStallProfileIfStale(() => t)).toBe(false) // fresh — nothing to do
    t += PROFILE_ROTATE_MS + 1
    expect(rotateStallProfileIfStale(() => t)).toBe(true) // stale — rotated
    expect(isStallProfilerRunning()).toBe(true) // and it re-armed, rather than giving up
  })

  it('degrades to null instead of throwing when the profiler was never armed', () => {
    _resetStallProfilerForTests()
    expect(isStallProfilerRunning()).toBe(false)
    expect(sampleStallWindow(0, 1)).toBeNull()
    expect(rotateStallProfileIfStale()).toBe(false)
    expect(() => stopStallProfiler()).not.toThrow()
  })

  it('stop is idempotent, and start after stop re-arms cleanly', () => {
    startStallProfiler()
    stopStallProfiler()
    stopStallProfiler()
    expect(isStallProfilerRunning()).toBe(false)
    expect(startStallProfiler()).toBe(true)
    expect(isStallProfilerRunning()).toBe(true)
  })
})
