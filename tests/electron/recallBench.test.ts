import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  distinctiveTerms,
  buildCueProbe,
  buildLinkProbes,
  buildTemporalProbes,
  buildProbes,
  runBench,
  baselineFrom,
  checkRegression,
  formatBench,
  CUE_FRACTION,
  BENCH_K,
  BENCH_LIMIT,
  REGRESSION_TOLERANCE,
  type BenchMemory,
  type BenchResult,
} from '../../src/main/recallBench'
import {
  initRecallBench,
  loadBenchBaseline,
  saveBenchBaseline,
  resetRecallBenchStore,
} from '../../src/main/recallBenchStore'

const DAY = 86_400_000

describe('recallBench/distinctiveTerms', () => {
  it('drops stop words and short tokens', () => {
    expect(distinctiveTerms('the proxy is in the pipeline and it was slow')).toEqual(['pipeline', 'proxy', 'slow'])
  })

  it('orders by length, breaking ties on first appearance — deterministic across runs', () => {
    const once = distinctiveTerms('alpha gamma delta epsilonx')
    expect(once).toEqual(['epsilonx', 'alpha', 'gamma', 'delta'])
    expect(distinctiveTerms('alpha gamma delta epsilonx')).toEqual(once)
  })

  it('deduplicates repeats so a repeated word cannot dominate a probe', () => {
    expect(distinctiveTerms('compression compression compression memory')).toEqual(['compression', 'memory'])
  })

  it('keeps dotted and slashed identifiers but strips their edges', () => {
    expect(distinctiveTerms('see src/main/proxy.ts now')).toEqual(['src/main/proxy.ts'])
  })

  it('honours the limit', () => {
    expect(distinctiveTerms('alpha bravo charlie delta echo', 2)).toHaveLength(2)
  })

  it('returns nothing for content with no signal', () => {
    expect(distinctiveTerms('the a of to in on at')).toEqual([])
    expect(distinctiveTerms('')).toEqual([])
  })
})

describe('recallBench/buildCueProbe', () => {
  it('queries with a minority of terms — partial recall, not a near-copy', () => {
    const content = 'compression proxy pipeline embedder retrieval baseline telemetry vitest windows'
    const probe = buildCueProbe({ id: 'm1', content, ts: 0 })!
    const all = distinctiveTerms(content)
    expect(probe.kind).toBe('cue')
    expect(probe.relevant).toEqual(['m1'])
    expect(probe.query.split(' ')).toHaveLength(Math.floor(all.length * CUE_FRACTION))
    expect(probe.query.split(' ').length).toBeLessThan(all.length)
  })

  it('refuses a probe that would be a coin flip', () => {
    expect(buildCueProbe({ id: 'm1', content: 'alpha bravo charlie', ts: 0 })).toBeNull()
    expect(buildCueProbe({ id: 'm1', content: 'the of to', ts: 0 })).toBeNull()
  })
})

describe('recallBench/buildLinkProbes', () => {
  const mems: BenchMemory[] = [
    { id: 'a', content: 'compression proxy pipeline', ts: 1, links: ['b'] },
    { id: 'b', content: 'embedder retrieval baseline', ts: 2 },
  ]

  it('turns a graph edge into a probe: A queries, B must come back', () => {
    const [probe] = buildLinkProbes(mems)
    expect(probe).toMatchObject({ kind: 'link', relevant: ['b'] })
    expect(probe.query).toContain('compression')
  })

  it('ignores edges to memories outside the sampled set', () => {
    expect(buildLinkProbes([{ id: 'a', content: 'compression proxy pipeline', ts: 1, links: ['gone'] }])).toEqual([])
  })

  it('ignores a self-link, which would score trivially', () => {
    expect(buildLinkProbes([{ id: 'a', content: 'compression proxy pipeline', ts: 1, links: ['a'] }])).toEqual([])
  })

  it('skips a linked memory whose content has too little signal to query with', () => {
    expect(buildLinkProbes([
      { id: 'a', content: 'the of to', ts: 1, links: ['b'] },
      { id: 'b', content: 'embedder retrieval', ts: 2 },
    ])).toEqual([])
  })

  it('handles a memory with no links field at all', () => {
    expect(buildLinkProbes([{ id: 'a', content: 'compression proxy', ts: 1 }])).toEqual([])
  })
})

describe('recallBench/buildTemporalProbes', () => {
  const mems: BenchMemory[] = [
    { id: 'old', content: 'postgres migration rollback', ts: 0, project: 'p' },
    { id: 'mid', content: 'schema indexes tuning', ts: DAY, project: 'p' },
    { id: 'new', content: 'connection pooling limits', ts: 2 * DAY, project: 'p' },
  ]

  it('queries with a recent memory and expects the earlier ones it builds on', () => {
    const probes = buildTemporalProbes(mems)
    expect(probes.length).toBeGreaterThan(0)
    expect(probes[0].kind).toBe('temporal')
    expect(probes[0].relevant).toContain('old')
  })

  it('respects the window, which is what decay and pruning break first', () => {
    expect(buildTemporalProbes([
      { id: 'old', content: 'postgres migration rollback', ts: 0, project: 'p' },
      { id: 'new', content: 'connection pooling limits', ts: 400 * DAY, project: 'p' },
    ], 30 * DAY)).toEqual([])
  })

  it('never crosses projects', () => {
    expect(buildTemporalProbes([
      { id: 'old', content: 'postgres migration rollback', ts: 0, project: 'p' },
      { id: 'new', content: 'connection pooling limits', ts: DAY, project: 'q' },
    ])).toEqual([])
  })

  it('skips memories with no project', () => {
    expect(buildTemporalProbes([
      { id: 'old', content: 'postgres migration rollback', ts: 0 },
      { id: 'new', content: 'connection pooling limits', ts: DAY },
    ])).toEqual([])
  })

  it('skips a recent memory with too little signal to query with', () => {
    expect(buildTemporalProbes([
      { id: 'old', content: 'postgres migration rollback', ts: 0, project: 'p' },
      { id: 'new', content: 'the of to a', ts: DAY, project: 'p' },
    ])).toEqual([])
  })
})

describe('recallBench/buildProbes', () => {
  it('produces all three slices from one memory sample', () => {
    const mems: BenchMemory[] = [
      { id: 'a', content: 'compression proxy pipeline embedder retrieval baseline telemetry', ts: 0, project: 'p', links: ['b'] },
      { id: 'b', content: 'windows coverage vitest branches threshold electron sandbox', ts: DAY, project: 'p' },
    ]
    const kinds = new Set(buildProbes(mems).map(p => p.kind))
    expect(kinds).toEqual(new Set(['link', 'cue', 'temporal']))
  })

  it('returns nothing for an empty brain rather than throwing', () => {
    expect(buildProbes([])).toEqual([])
  })
})

describe('recallBench/runBench', () => {
  const probes = [
    { query: 'q1', relevant: ['a'], kind: 'cue' as const },
    { query: 'q2', relevant: ['b'], kind: 'link' as const },
  ]

  it('scores a perfect searcher at MRR 1 and slices by probe kind', async () => {
    const res = await runBench(probes, async q => [{ id: q === 'q1' ? 'a' : 'b' }])
    expect(res.overall.mrr).toBe(1)
    expect(res.probes).toBe(2)
    expect(res.empty).toBe(0)
    expect(Object.keys(res.slices).sort()).toEqual(['cue', 'link'])
    expect(res.overall.recallAtK[5]).toBe(1)
  })

  it('scores a rank-2 hit at 0.5, so ordering is actually graded', async () => {
    const res = await runBench([probes[0]], async () => [{ id: 'z' }, { id: 'a' }])
    expect(res.overall.mrr).toBe(0.5)
  })

  it('scores a thrown search as zero rather than dropping the probe', async () => {
    const res = await runBench(probes, async () => { throw new Error('index closed') })
    expect(res.probes).toBe(2)
    expect(res.empty).toBe(2)
    expect(res.overall.mrr).toBe(0)
  })

  it('counts empty results separately — a broken searcher is not a bad ranker', async () => {
    const res = await runBench(probes, async q => (q === 'q1' ? [] : [{ id: 'z' }]))
    expect(res.empty).toBe(1)
  })

  it('retrieves deeper than the largest reported cutoff', async () => {
    const search = vi.fn(async () => [])
    await runBench([probes[0]], search)
    expect(search).toHaveBeenCalledWith('q1', BENCH_LIMIT)
    expect(BENCH_LIMIT).toBeGreaterThan(Math.max(...BENCH_K))
  })

  it('honours an explicit limit and an injected clock', async () => {
    const search = vi.fn(async () => [])
    let t = 0
    const res = await runBench([probes[0]], search, { limit: 3, now: () => (t += 10) })
    expect(search).toHaveBeenCalledWith('q1', 3)
    expect(res.durationMs).toBe(10)
  })

  it('handles an empty probe set', async () => {
    const res = await runBench([], async () => [])
    expect(res).toMatchObject({ probes: 0, empty: 0 })
    expect(res.overall.n).toBe(0)
  })
})

describe('recallBench/checkRegression', () => {
  const result = (mrr: number, recallAt5: number): BenchResult => ({
    overall: { n: 10, mrr, recallAtK: { 1: 0, 5: recallAt5, 10: 0 }, ndcgAtK: { 1: 0, 5: 0, 10: 0 } },
    slices: {},
    probes: 10,
    empty: 0,
    durationMs: 1,
  })

  it('treats a missing baseline as a recording run, not a failure', () => {
    const v = checkRegression(result(0.4, 0.4), null)
    expect(v.regressed).toBe(false)
    expect(v.reasons).toEqual(['no baseline; recording this run'])
  })

  it('passes an unchanged run', () => {
    expect(checkRegression(result(0.8, 0.9), { mrr: 0.8, recallAt5: 0.9, ts: 0 }).regressed).toBe(false)
  })

  it('tolerates noise below the threshold', () => {
    const v = checkRegression(result(0.8 - REGRESSION_TOLERANCE / 2, 0.9), { mrr: 0.8, recallAt5: 0.9, ts: 0 })
    expect(v.regressed).toBe(false)
    expect(v.deltas.mrr).toBeLessThan(0)
  })

  it('fails on an MRR drop and names both numbers', () => {
    const v = checkRegression(result(0.6, 0.9), { mrr: 0.8, recallAt5: 0.9, ts: 0 })
    expect(v.regressed).toBe(true)
    expect(v.reasons[0]).toContain('MRR fell 0.200')
    expect(v.reasons[0]).toContain('0.800 → 0.600')
    expect(v.deltas.mrr).toBeCloseTo(-0.2)
  })

  it('fails on a recall@5 drop independently of MRR', () => {
    const v = checkRegression(result(0.8, 0.5), { mrr: 0.8, recallAt5: 0.9, ts: 0 })
    expect(v.regressed).toBe(true)
    expect(v.reasons.join(' ')).toContain('recall@5 fell')
    expect(v.reasons.join(' ')).not.toContain('MRR fell')
  })

  it('reports both when both fall', () => {
    expect(checkRegression(result(0.1, 0.1), { mrr: 0.8, recallAt5: 0.9, ts: 0 }).reasons).toHaveLength(2)
  })

  it('never fails an improvement', () => {
    expect(checkRegression(result(0.95, 0.99), { mrr: 0.8, recallAt5: 0.9, ts: 0 }).regressed).toBe(false)
  })

  it('handles a result missing the @5 cutoff', () => {
    const r = result(0.8, 0)
    delete r.overall.recallAtK[5]
    expect(checkRegression(r, null).deltas.recallAt5).toBe(0)
  })
})

describe('recallBench/baselineFrom and formatBench', () => {
  const res: BenchResult = {
    overall: { n: 12, mrr: 0.812345, recallAtK: { 1: 0.5, 5: 0.75, 10: 0.9 }, ndcgAtK: { 10: 0.8 } },
    slices: { cue: { n: 6, mrr: 0.9, recallAtK: { 1: 0.6, 5: 0.8 }, ndcgAtK: { 10: 0.85 } } },
    probes: 12,
    empty: 1,
    durationMs: 42,
  }

  it('records only the two gated metrics plus a timestamp', () => {
    expect(baselineFrom(res, 99)).toEqual({ mrr: 0.812345, recallAt5: 0.75, ts: 99 })
  })

  it('defaults the baseline timestamp to now', () => {
    expect(baselineFrom(res).ts).toBeGreaterThan(0)
  })

  it('treats a missing @5 as zero rather than undefined', () => {
    expect(baselineFrom({ ...res, overall: { ...res.overall, recallAtK: {} } }, 1).recallAt5).toBe(0)
  })

  it('prints overall and every slice on its own line', () => {
    const text = formatBench(res)
    expect(text).toContain('12 probes, 1 empty, 42ms')
    expect(text).toContain('overall')
    expect(text).toContain('cue')
    expect(text).toContain('MRR 0.812')
    expect(text.split('\n')).toHaveLength(3)
  })
})

describe('recallBenchStore', () => {
  let tmp: string

  beforeEach(() => {
    resetRecallBenchStore()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-bench-'))
    initRecallBench(tmp)
  })

  afterEach(() => {
    resetRecallBenchStore()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* windows lock */ }
  })

  it('rejects an empty userData path', () => {
    expect(() => initRecallBench('')).toThrow('userDataPath required')
  })

  it('round-trips a baseline', () => {
    expect(saveBenchBaseline({ mrr: 0.8, recallAt5: 0.9, ts: 7 })).toBe(true)
    expect(loadBenchBaseline()).toEqual({ mrr: 0.8, recallAt5: 0.9, ts: 7 })
  })

  it('reports no baseline before one is saved — a run never re-baselines itself', () => {
    expect(loadBenchBaseline()).toBeNull()
  })

  it('reads a corrupt baseline as none, so the gate cannot fail for a non-recall reason', () => {
    fs.writeFileSync(path.join(tmp, 'recall-baseline.json'), '{ not json', 'utf8')
    expect(loadBenchBaseline()).toBeNull()
    expect(checkRegression({ overall: { n: 1, mrr: 0, recallAtK: {}, ndcgAtK: {} }, slices: {}, probes: 1, empty: 0, durationMs: 1 }, loadBenchBaseline()).regressed).toBe(false)
  })

  it('rejects a structurally wrong baseline rather than half-parsing it', () => {
    fs.writeFileSync(path.join(tmp, 'recall-baseline.json'), JSON.stringify({ mrr: 'high' }), 'utf8')
    expect(loadBenchBaseline()).toBeNull()
  })

  it('defaults a missing timestamp instead of discarding usable metrics', () => {
    fs.writeFileSync(path.join(tmp, 'recall-baseline.json'), JSON.stringify({ mrr: 0.5, recallAt5: 0.6 }), 'utf8')
    expect(loadBenchBaseline()).toEqual({ mrr: 0.5, recallAt5: 0.6, ts: 0 })
  })

  it('is inert without an init rather than writing to an arbitrary path', () => {
    resetRecallBenchStore()
    expect(loadBenchBaseline()).toBeNull()
    expect(saveBenchBaseline({ mrr: 1, recallAt5: 1, ts: 1 })).toBe(false)
  })

  it('reports a failed save instead of claiming success', () => {
    resetRecallBenchStore()
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x', 'utf8')
    initRecallBench(path.join(tmp, 'blocker', 'sub'))
    expect(saveBenchBaseline({ mrr: 1, recallAt5: 1, ts: 1 })).toBe(false)
    expect(loadBenchBaseline()).toBeNull()
  })
})
