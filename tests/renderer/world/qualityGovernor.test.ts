// qualityGovernor: the rule that picks the 3D map's quality tier from the frame times (look spec §5.1, plan Task 3).
// Pure: the windows are given as traces of frame gaps, cut as the renderer cuts them (120 frames or 2 s).
import { describe, expect, test } from 'vitest'
import { frameStats } from '../../../src/renderer/src/world/engine/frameSampler'
import {
  createGovernor, DROP_P95_MS, DROP_WINDOWS, LOCKOUT_DROPS, MAX_RISES, MIN_WINDOW_FRAMES, RISE_HOLD_MS, RISE_P95_MS,
  SLOW_WINDOW_MS, WINDOW_FRAMES, WINDOW_MS, type Governor,
} from '../../../src/renderer/src/world/engine/qualityGovernor'
import type { TierName } from '../../../src/renderer/src/world/engine/tierBudget'

/** A trace cut into windows as the renderer cuts it: WINDOW_FRAMES frames, or WINDOW_MS of them, whichever first. */
function cut(gaps: readonly number[]): number[][] {
  const out: number[][] = []
  let w: number[] = []
  let ms = 0
  for (const g of gaps) {
    w.push(g)
    ms += g
    if (w.length >= WINDOW_FRAMES || ms >= WINDOW_MS) { out.push(w); w = []; ms = 0 }
  }
  return out
}
/** Feeds each window of `gaps` to `g`; the tiers it changed to, in order. */
function feed(g: Governor, gaps: readonly number[]): TierName[] {
  const seen: TierName[] = []
  for (const w of cut(gaps)) {
    const t = g.onWindow(frameStats(w), w.reduce((a, b) => a + b, 0))
    if (t !== null) seen.push(t)
  }
  return seen
}
/** One window of `n` frames of `ms` each. */
const win = (g: Governor, ms: number, n = WINDOW_FRAMES): TierName | null => g.onWindow(frameStats(Array(n).fill(ms)), ms * n)
const steady = (ms: number, seconds: number): number[] => Array(Math.round((seconds * 1000) / ms)).fill(ms)

/**
 * The spike's High run (look test perf.json, v1, Intel Arc at 1920x1080): 904 frames, p50 13.4, p95 14.3, p99 19.8 and
 * worst 90.7 ms by nearest rank. perf.json keeps the stats, not the gaps, so the trace is built to have exactly those
 * stats, its slow frames spread through the run (a fixed shuffle), as a GC pause or a label relayout falls.
 */
function spikeHighTrace(): number[] {
  const n = 904
  const sorted: number[] = []
  for (let i = 1; i <= n; i++) {
    if (i <= 452) sorted.push(12 + (1.4 * i) / 452) // up to p50 13.4
    else if (i <= 859) sorted.push(13.4 + (0.9 * (i - 452)) / 407) // up to p95 14.3
    else if (i <= 895) sorted.push(14.3 + (5.5 * (i - 859)) / 36) // up to p99 19.8
    else sorted.push(i === n ? 90.7 : 19.8 + (40 * (i - 895)) / 8)
  }
  return sorted.map((_, i) => sorted[(i * 377) % n]) // 377 and 904 share no factor: every gap once
}

describe('qualityGovernor', () => {
  test('the spike trace has the stats perf.json recorded', () => {
    const s = frameStats(spikeHighTrace())
    expect([s.frames, s.worst]).toEqual([904, 90.7])
    expect(s.p50).toBeCloseTo(13.4, 9)
    expect(s.p95).toBeCloseTo(14.3, 9)
    expect(s.p99).toBeCloseTo(19.8, 9)
  })

  test('the constants are the spec\'s', () => {
    expect([DROP_P95_MS, RISE_P95_MS, DROP_WINDOWS, RISE_HOLD_MS, MAX_RISES, LOCKOUT_DROPS, MIN_WINDOW_FRAMES, WINDOW_FRAMES, WINDOW_MS])
      .toEqual([{ high: 18.5, low: 33 }, { low: 10, flat: 20 }, 2, 10_000, 1, 2, 30, 120, 2000])
    expect(SLOW_WINDOW_MS).toBe(1000)
  })

  test('two windows over 18.5 ms p95 drop High to Low; one does not', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    expect(win(g, 20)).toBeNull()
    expect(win(g, 15)).toBeNull() // a window in budget ends the run
    expect(win(g, 20)).toBeNull()
    expect(win(g, 18.5)).toBeNull() // at 18.5 it is in budget: over means above
    expect(win(g, 20)).toBeNull()
    expect(g.tier()).toBe('high')
    expect(win(g, 20)).toBe('low')
    expect([g.tier(), g.drops()]).toEqual(['low', 1])
    // 20 ms is in Low's budget: it stays
    expect(feed(g, steady(20, 30))).toEqual([])
  })

  test('a fast machine never drops: the spike\'s High run, played for a minute', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    const minute: number[] = []
    while (minute.reduce((a, b) => a + b, 0) < 60_000) minute.push(...spikeHighTrace())
    expect(feed(g, minute)).toEqual([])
    expect([g.tier(), g.drops()]).toEqual(['high', 0])
  })

  test('two windows over 33 ms drop Low to Flat; Flat is the last step the governor takes', () => {
    const g = createGovernor({ start: 'low', mode: 'auto' })
    expect(feed(g, steady(30, 20))).toEqual([]) // in Low's budget
    expect(win(g, 34)).toBeNull()
    expect(win(g, 34)).toBe('flat')
    // Flat has nowhere lower to go: the 2D map is the viewer's, after a second lost context or the watchdog's last step
    expect(feed(g, steady(200, 30))).toEqual([])
    expect([g.tier(), g.drops()]).toEqual(['flat', 1])
  })

  test('High in software (3 to 6 frames a second) reaches Flat through Low in four windows, one step at a time', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    // 2 s windows of 300 ms frames (6 a window, under MIN_WINDOW_FRAMES but slow frames all through them)
    expect(feed(g, steady(300, 4.2))).toEqual(['low'])
    expect(feed(g, steady(150, 4.2))).toEqual(['flat'])
    expect(g.drops()).toBe(2)
  })

  test('a window under 30 frames is ignored, unless its frames are slow enough to fill a second', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    expect(win(g, 30, MIN_WINDOW_FRAMES - 1)).toBeNull() // 870 ms of frames: too few to judge
    expect(win(g, 30, MIN_WINDOW_FRAMES - 1)).toBeNull()
    expect(g.tier()).toBe('high')
    // an ignored window neither counts nor ends a run
    expect(win(g, 20)).toBeNull()
    expect(win(g, 15, 10)).toBeNull()
    expect(win(g, 20)).toBe('low')
    // at Low: 29 frames of 35 ms fill 1015 ms, so they count
    expect(win(g, 35, MIN_WINDOW_FRAMES - 1)).toBeNull()
    expect(win(g, 35, MIN_WINDOW_FRAMES - 1)).toBe('flat')
    // 30 frames are enough to judge, whatever their time
    const h = createGovernor({ start: 'high', mode: 'auto' })
    expect(win(h, 19, MIN_WINDOW_FRAMES)).toBeNull()
    expect(win(h, 19, MIN_WINDOW_FRAMES)).toBe('low')
  })

  test('a rise needs 10 s of windows under 60% of the higher budget, and happens at most once', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    expect(feed(g, steady(40, 4))).toEqual(['low'])
    expect(feed(g, steady(40, 4))).toEqual(['flat'])
    // At Flat, under 20 ms rises to Low after 10 s of such windows (each 120 frames of 19 ms, 2280 ms): the fifth
    for (let i = 0; i < 4; i++) expect(win(g, 19)).toBeNull()
    expect(win(g, 21)).toBeNull() // one over 60% starts the hold again
    for (let i = 0; i < 4; i++) expect(win(g, 19)).toBeNull()
    expect(win(g, 19, MIN_WINDOW_FRAMES - 1)).toBeNull() // too short to judge: it adds nothing to the hold
    expect(win(g, 19)).toBe('low')
    expect(g.tier()).toBe('low')
    // At Low: 10 ms is not under 10, and 9 ms for a minute would rise to High, but the one rise is spent
    expect(feed(g, steady(10, 30))).toEqual([])
    expect(feed(g, steady(9, 60))).toEqual([])
    expect(g.tier()).toBe('low')
  })

  test('a rise to High needs windows under 10 ms (60% of 16.7)', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    expect(feed(g, steady(20, 4))).toEqual(['low'])
    expect(feed(g, steady(10, 30))).toEqual([]) // not under 10
    expect(feed(g, steady(9.9, RISE_HOLD_MS / 1000 - 1))).toEqual([])
    expect(feed(g, steady(9.9, 3))).toEqual(['high'])
  })

  test('a tier dropped from twice is never re-entered in auto mode', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    expect(feed(g, steady(20, 4))).toEqual(['low']) // High dropped from once
    // The person picks High, then Auto again: auto mode goes on from the tier on screen
    expect(g.choose('high')).toBe('high')
    expect(g.choose('auto')).toBe('high')
    expect(feed(g, steady(20, 4))).toEqual(['low']) // twice: High is locked out
    // the rise is not spent, but High is out of reach: a minute of fast frames stays at Low
    expect(feed(g, steady(9, 60))).toEqual([])
    expect(g.tier()).toBe('low')
    // picked again, High is drawn (a chosen tier is the person's); back in Auto it is left at once
    expect(g.choose('high')).toBe('high')
    expect(g.choose('auto')).toBe('low')
    // a tier dropped from once can still be risen to: Low here
    const s = createGovernor({ start: 'low', mode: 'auto' })
    expect(feed(s, steady(40, 4))).toEqual(['flat'])
    expect(feed(s, steady(15, RISE_HOLD_MS / 1000 + 3))).toEqual(['low'])
  })

  test('a user-chosen tier is never changed by the frame times', () => {
    const g = createGovernor({ start: 'high', mode: 'user' })
    expect(feed(g, steady(300, 30))).toEqual([])
    expect([g.tier(), g.auto(), g.drops()]).toEqual(['high', false, 0])
    const f = createGovernor({ start: 'flat', mode: 'user' })
    expect(feed(f, steady(5, 30))).toEqual([])
    expect(f.tier()).toBe('flat')
    // chosen while windows ran: the run so far is forgotten, and Auto starts a run of its own
    const a = createGovernor({ start: 'high', mode: 'auto' })
    expect(win(a, 20)).toBeNull()
    expect(a.choose('low')).toBe('low')
    expect(a.choose('high')).toBe('high')
    expect(a.choose('auto')).toBe('high')
    expect(a.auto()).toBe(true)
    expect(win(a, 20)).toBeNull()
    expect(win(a, 20)).toBe('low')
  })

  test('a context restore starts one tier lower, in either mode, and counts as a drop', () => {
    const g = createGovernor({ start: 'high', mode: 'auto' })
    expect(g.onContextRestored()).toBe('low')
    expect(g.drops()).toBe(1)
    expect(g.onContextRestored()).toBe('flat')
    expect(g.onContextRestored()).toBe('flat')
    expect(g.drops()).toBe(2)
    const u = createGovernor({ start: 'high', mode: 'user' })
    expect(u.onContextRestored()).toBe('low')
    expect(u.auto()).toBe(false)
    // a restore ends a run under way: the next window starts a new one
    const r = createGovernor({ start: 'high', mode: 'auto' })
    expect(win(r, 40)).toBeNull()
    expect(r.onContextRestored()).toBe('low')
    expect(win(r, 40)).toBeNull()
    expect(win(r, 40)).toBe('flat')
    // a restore counts toward the lockout: High lost twice is not risen to again
    const l = createGovernor({ start: 'high', mode: 'auto' })
    l.onContextRestored()
    l.choose('high')
    l.choose('auto')
    l.onContextRestored()
    expect(feed(l, steady(9, 60))).toEqual([])
    expect(l.tier()).toBe('low')
  })

  test('stepDown (the first-frame watchdog) goes one tier at a time, and says when there is none left', () => {
    const g = createGovernor({ start: 'high', mode: 'user' })
    expect(g.stepDown()).toBe('low')
    expect(g.stepDown()).toBe('flat')
    expect(g.stepDown()).toBeNull()
    expect([g.tier(), g.drops()]).toEqual(['flat', 2])
  })
})
