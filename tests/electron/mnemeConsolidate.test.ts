import { describe, it, expect } from 'vitest'
import {
  decayScore,
  planForget,
  planMerges,
  planSummaries,
  type ConsolEntry,
} from '../../src/main/mnemeConsolidate'

const DAY = 86_400_000
const NOW = 100 * DAY

// An episodic memory with sensible defaults; override per test.
const ep = (over: Partial<ConsolEntry>): ConsolEntry => ({
  id: 'e',
  content: 'episodic chatter line',
  ts: 0,
  memoryType: 'episodic',
  ...over,
})

// A bare merge candidate; override per test.
const cm = (over: Partial<ConsolEntry>): ConsolEntry => ({
  id: 'm',
  content: 'content',
  ts: 0,
  ...over,
})

// simOf that returns `val` only for the unordered id pair {x,y}, else 0.
const pairSim =
  (x: string, y: string, val = 1) =>
  (a: ConsolEntry, b: ConsolEntry): number =>
    (a.id === x && b.id === y) || (a.id === y && b.id === x) ? val : 0

describe('mnemeConsolidate', () => {
  describe('decayScore — importance × recency × capped-usage nudge, clamped [0,1]', () => {
    it('gives a fresh, fully-important memory the max score (deltaT 0, recency 1)', () => {
      expect(decayScore({ id: 'a', content: 'x', ts: 1000, importance: 1, useCount: 0 }, 1000)).toBe(1)
    })

    it('halves at exactly one half-life (30 days) and decays toward 0 for ancient memories', () => {
      expect(decayScore({ id: 'a', content: 'x', ts: 0, importance: 1, useCount: 0 }, 30 * DAY)).toBeCloseTo(0.5, 10)
      expect(decayScore({ id: 'a', content: 'x', ts: 0, importance: 1, useCount: 0 }, 3650 * DAY)).toBeCloseTo(0, 5)
    })

    it('defaults importance to 0.5 when absent', () => {
      expect(decayScore({ id: 'a', content: 'x', ts: 1000, useCount: 0 }, 1000)).toBeCloseTo(0.5, 10)
    })

    it('collapses to 0 for a zero-importance memory no matter how recent or used', () => {
      expect(decayScore({ id: 'a', content: 'x', ts: 1000, importance: 0, useCount: 1_000_000 }, 1000)).toBe(0)
    })

    it('lifts the score with usage, monotonically, and caps the nudge at +20%', () => {
      const base = { id: 'a', content: 'x', ts: 1000, importance: 0.5 }
      const u0 = decayScore({ ...base, useCount: 0 }, 1000)
      const u5 = decayScore({ ...base, useCount: 5 }, 1000)
      const uBig = decayScore({ ...base, useCount: 1_000_000 }, 1000)
      expect(u0).toBeCloseTo(0.5, 10)
      expect(u5).toBeGreaterThan(u0)
      expect(uBig).toBeGreaterThan(u5)
      expect(uBig).toBeCloseTo(0.6, 10) // 0.5 * (1 + capped 0.2)
    })

    it('defaults useCount to 0 when absent (no nudge)', () => {
      const withField = decayScore({ id: 'a', content: 'x', ts: 1000, importance: 0.5, useCount: 0 }, 1000)
      const without = decayScore({ id: 'a', content: 'x', ts: 1000, importance: 0.5 }, 1000)
      expect(without).toBe(withField)
    })

    it('honors an injected half-life', () => {
      // ts is one custom half-life (10d) old → recency 0.5
      expect(decayScore({ id: 'a', content: 'x', ts: 0, importance: 1, useCount: 0 }, 10 * DAY, { halfLifeMs: 10 * DAY }))
        .toBeCloseTo(0.5, 10)
    })

    it('a non-positive half-life disables recency entirely → score 0 (guard branch)', () => {
      expect(decayScore({ id: 'a', content: 'x', ts: 0, importance: 1, useCount: 0 }, 1000, { halfLifeMs: 0 })).toBe(0)
    })

    it('clamps into [0,1]: over-unit importance → 1, negative importance → 0', () => {
      expect(decayScore({ id: 'a', content: 'x', ts: 1000, importance: 5, useCount: 0 }, 1000)).toBe(1)
      expect(decayScore({ id: 'a', content: 'x', ts: 1000, importance: -1, useCount: 0 }, 1000)).toBe(0)
    })

    it('clamps a future-dated timestamp (peer clock skew) to deltaT 0, not a boost', () => {
      const future = decayScore({ id: 'a', content: 'x', ts: 5000, importance: 1, useCount: 0 }, 1000) // ts > now
      const fresh = decayScore({ id: 'a', content: 'x', ts: 1000, importance: 1, useCount: 0 }, 1000)
      expect(future).toBe(fresh)
    })
  })

  describe('planForget — forget aged, low-value chatter below the keep bar', () => {
    it('forgets an old, low-importance episodic memory', () => {
      expect(planForget([ep({ id: 'old', ts: NOW - 20 * DAY, importance: 0.05 })], NOW)).toEqual(['old'])
    })

    it('keeps a memory that is neither episodic nor a raw message', () => {
      const e = ep({ id: 'sem', memoryType: 'semantic', kind: 'fact', ts: NOW - 20 * DAY, importance: 0.01 })
      expect(planForget([e], NOW)).toEqual([])
    })

    it('forgets a raw `message` even when memoryType is undefined', () => {
      const e: ConsolEntry = { id: 'msg', content: 'log line', ts: NOW - 20 * DAY, kind: 'message', importance: 0.02 }
      expect(planForget([e], NOW)).toEqual(['msg'])
    })

    it('keeps a tagged memory (tags are a curation signal)', () => {
      expect(planForget([ep({ id: 'tagged', ts: NOW - 20 * DAY, importance: 0.01, tags: ['keep'] })], NOW)).toEqual([])
    })

    it('an EMPTY tags array does not protect a memory (present-but-empty ≠ tagged)', () => {
      expect(planForget([ep({ id: 'empty', ts: NOW - 20 * DAY, importance: 0.02, tags: [] })], NOW)).toEqual(['empty'])
    })

    it('keeps a memory that has graph edges', () => {
      expect(planForget([ep({ id: 'linked', ts: NOW - 20 * DAY, importance: 0.01, hasEdges: true })], NOW)).toEqual([])
    })

    it('keeps a memory younger than the 14-day age floor', () => {
      expect(planForget([ep({ id: 'young', ts: NOW - 10 * DAY, importance: 0.001 })], NOW)).toEqual([])
    })

    it('keeps an old memory whose decay is still above the keep bar (important)', () => {
      // importance 1, ~20d old → decay ≈ 0.63, not < 0.15 → retained
      expect(planForget([ep({ id: 'important', ts: NOW - 20 * DAY, importance: 1 })], NOW)).toEqual([])
    })

    it('honors a custom keepAbove threshold', () => {
      const e = ep({ id: 'mid', ts: NOW - 20 * DAY, importance: 0.5 }) // decay ≈ 0.315
      expect(planForget([e], NOW)).toEqual([]) // default 0.15: 0.315 not below → keep
      expect(planForget([e], NOW, { keepAbove: 0.4 })).toEqual(['mid']) // 0.315 < 0.4 → forget
    })

    it('orders lowest keep-score first and caps the count', () => {
      const entries = [
        ep({ id: 'c', ts: NOW - 20 * DAY, importance: 0.15 }), // ≈ 0.0945
        ep({ id: 'a', ts: NOW - 20 * DAY, importance: 0.03 }), // ≈ 0.0189
        ep({ id: 'b', ts: NOW - 20 * DAY, importance: 0.08 }), // ≈ 0.0504
      ]
      expect(planForget(entries, NOW)).toEqual(['a', 'b', 'c']) // weakest first
      expect(planForget(entries, NOW, { cap: 2 })).toEqual(['a', 'b']) // capped to the two weakest
      expect(planForget(entries, NOW, { cap: 0 })).toEqual([]) // cap 0 forgets nothing
    })

    it('breaks ties deterministically by id when scores are equal (both sort directions)', () => {
      // Scrambled order so the id comparator resolves both < (-1) and ≥ (1).
      const entries = ['b', 'a', 'd', 'c'].map((id) => ep({ id, ts: NOW - 20 * DAY, importance: 0.05 }))
      expect(planForget(entries, NOW)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('returns [] for empty input', () => {
      expect(planForget([], NOW)).toEqual([])
    })
  })

  describe('planMerges — greedy near-duplicate grouping, keep the best of each group', () => {
    it('merges a near-dup pair (keep highest importance) and ignores singletons', () => {
      const entries = [
        cm({ id: 'A', importance: 0.9 }),
        cm({ id: 'B', importance: 0.3 }),
        cm({ id: 'C', importance: 0.5 }), // similar to nothing → singleton
      ]
      expect(planMerges(entries, pairSim('A', 'B'))).toEqual([{ keep: 'A', drop: ['B'] }])
    })

    it('treats the threshold as inclusive (≥), grouping at exactly the bar', () => {
      const two = [cm({ id: 'P', ts: 1 }), cm({ id: 'Q', ts: 2 })]
      expect(planMerges(two, () => 0.92)).toHaveLength(1) // 0.92 ≥ 0.92 → merge
      expect(planMerges(two, () => 0.91)).toEqual([]) // 0.91 < 0.92 → no merge
    })

    it('honors a custom threshold', () => {
      const two = [cm({ id: 'P' }), cm({ id: 'Q' })]
      expect(planMerges(two, () => 0.8)).toEqual([]) // default 0.92 → below
      expect(planMerges(two, () => 0.8, { threshold: 0.75 })).toHaveLength(1) // custom bar → merge
    })

    it('tie-breaks equal importance by keeping the LONGEST content (defaults undefined importance to 0.5)', () => {
      const entries = [cm({ id: 'L', content: 'aaaaa' }), cm({ id: 'S', content: 'aa' })] // both importance undefined
      expect(planMerges(entries, () => 1)).toEqual([{ keep: 'L', drop: ['S'] }])
    })

    it('tie-breaks equal importance AND length by keeping the EARLIEST ts', () => {
      const entries = [
        cm({ id: 'E', content: 'abc', ts: 50, importance: 0.4 }),
        cm({ id: 'F', content: 'xyz', ts: 100, importance: 0.4 }),
      ]
      expect(planMerges(entries, () => 1)).toEqual([{ keep: 'E', drop: ['F'] }])
    })

    it('skips already-grouped members when a later seed scans (assigned-guard branch)', () => {
      // A~C but not A~B: seed A grabs C (skipping B); seed B then finds C already
      // assigned and is left a singleton → only the A/C group is emitted.
      const entries = [
        cm({ id: 'A', importance: 0.7 }),
        cm({ id: 'B', importance: 0.6 }),
        cm({ id: 'C', importance: 0.2 }),
      ]
      expect(planMerges(entries, pairSim('A', 'C'))).toEqual([{ keep: 'A', drop: ['C'] }])
    })

    it('returns [] for empty or single-element input (nothing to merge)', () => {
      expect(planMerges([], () => 1)).toEqual([])
      expect(planMerges([cm({ id: 'solo' })], () => 1)).toEqual([])
    })
  })

  describe('planSummaries — roll up large clusters into one summary spec each', () => {
    const grp = (key: string, n: number) => ({
      key,
      members: Array.from({ length: n }, (_, i) => cm({ id: `${key}-${i}` })),
    })

    it('summarizes only groups at/above minSize (default 4); smaller ones are left alone', () => {
      const out = planSummaries([grp('g3', 3), grp('g4', 4), grp('g5', 5)])
      expect(out).toEqual([
        { key: 'g4', memberIds: ['g4-0', 'g4-1', 'g4-2', 'g4-3'], sourceCount: 4 },
        { key: 'g5', memberIds: ['g5-0', 'g5-1', 'g5-2', 'g5-3', 'g5-4'], sourceCount: 5 },
      ])
    })

    it('honors a custom minSize', () => {
      const groups = [grp('g2', 2), grp('g3', 3)]
      expect(planSummaries(groups)).toEqual([]) // default 4 → both too small
      const out = planSummaries(groups, { minSize: 2 })
      expect(out.map((s) => s.key)).toEqual(['g2', 'g3'])
      expect(out.map((s) => s.sourceCount)).toEqual([2, 3])
    })

    it('returns [] for no groups', () => {
      expect(planSummaries([])).toEqual([])
    })
  })
})
