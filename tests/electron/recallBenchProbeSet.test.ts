import { describe, it, expect } from 'vitest'
import {
  baselineFrom,
  checkRegression,
  PROBE_SET_VERSION,
  type BenchBaseline,
  type BenchResult,
} from '../../src/main/recallBench'

// A baseline is only meaningful against the probe set it was measured on.
//
// v1.47 added the 'disjoint' slice, which is deliberately hard — it strips the target's
// own vocabulary out of the query. Adding it drags the OVERALL average down on a system
// that has not changed at all, and the overall average is what the regression gate reads.
// Every user with a `recall-baseline.json` on disk from a previous run would therefore be
// told, on their very next run, that recall had regressed. It had not. The instrument
// changed.
//
// This is the exact confound the benchmark was written to avoid — its own header says a
// probe set that shifts between runs "cannot detect a regression, because every delta is
// confounded with the probe set changing". So the baseline carries the probe-set version
// it was taken under, and a baseline from a different one is not compared: it is retired
// and re-recorded, the same as having no baseline at all.

const resultWith = (mrr: number, recallAt5: number): BenchResult =>
  ({
    overall: { n: 10, mrr, recallAtK: { 1: 0.5, 5: recallAt5, 10: 0.9 }, ndcgAtK: { 10: 0.8 } },
    slices: {},
    probes: 10,
    empty: 0,
    durationMs: 1,
  }) as unknown as BenchResult

describe('the regression gate is scoped to the probe set it was measured on', () => {
  it('stamps the current probe-set version onto a new baseline', () => {
    // `toBe(PROBE_SET_VERSION)` alone would pass vacuously while both sides are
    // undefined, which is exactly the state this test was written in.
    expect(typeof PROBE_SET_VERSION).toBe('number')
    expect(PROBE_SET_VERSION).toBeGreaterThanOrEqual(2)
    expect(baselineFrom(resultWith(0.9, 0.9)).probeSet).toBe(PROBE_SET_VERSION)
  })

  it('refuses to call it a regression when the probe set changed underneath', () => {
    const old: BenchBaseline = {
      mrr: 0.95,
      recallAt5: 0.98,
      ts: 1,
      probeSet: PROBE_SET_VERSION - 1,
    }
    // A drop far past the tolerance — and still not a regression, because the two
    // numbers were never measuring the same thing.
    const verdict = checkRegression(resultWith(0.55, 0.6), old)
    expect(verdict.regressed).toBe(false)
    expect(verdict.reasons.join(' ')).toMatch(/probe set/i)
  })

  it('treats a baseline written before the field existed as retired, not as version zero', () => {
    // Every baseline already on a user's disk looks like this.
    const legacy = { mrr: 0.95, recallAt5: 0.98, ts: 1 } as BenchBaseline
    expect(checkRegression(resultWith(0.55, 0.6), legacy).regressed).toBe(false)
  })

  it('still catches a real regression within the same probe set', () => {
    // The guard must not become a blanket amnesty — that would silently disable the gate.
    const same = baselineFrom(resultWith(0.95, 0.98))
    const verdict = checkRegression(resultWith(0.55, 0.6), same)
    expect(verdict.regressed).toBe(true)
    expect(verdict.reasons.join(' ')).toMatch(/MRR fell/)
  })

  it('still passes an unchanged system within the same probe set', () => {
    const same = baselineFrom(resultWith(0.9, 0.9))
    expect(checkRegression(resultWith(0.9, 0.9), same).regressed).toBe(false)
  })
})
