import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initMetrics,
  recordMetric,
  metricsSummary,
  summarizeMetrics,
  EMBED_RECENT_WINDOW,
  _resetMetricsForTests,
  type MetricEvent,
} from '../../src/main/metricsLedger'

describe('metricsLedger — summarizeMetrics (pure aggregation)', () => {
  it('returns safe zero/healthy defaults for no events', () => {
    const s = summarizeMetrics([], 1000)
    expect(s.recalls).toBe(0)
    expect(s.recallFiredRate).toBe(0)
    expect(s.avgHits).toBe(0)
    expect(s.tokensInjected).toBe(0)
    expect(s.lessonsLearned).toBe(0)
    expect(s.crossAgentRecalls).toBe(0)
    // no failures observed => healthy
    expect(s.embedAvailability).toBe(1)
    expect(s.writeDurability).toBe(1)
    expect(s.teachingMatrix).toEqual({})
  })

  it('aggregates recall events: fired-rate, avg hits/score, and path mix', () => {
    const evs: MetricEvent[] = [
      { t: 'recall', ts: 1, hits: 4, topScore: 0.8, path: 'vector', ms: 10 },
      { t: 'recall', ts: 2, hits: 0, topScore: 0, path: 'vector', ms: 6 },
      { t: 'recall', ts: 3, hits: 2, topScore: 0.5, path: 'keyword', ms: 20 },
      { t: 'recall', ts: 4, hits: 1, topScore: 0.9, path: 'cache', ms: 1 },
    ]
    const s = summarizeMetrics(evs, 100)
    expect(s.recalls).toBe(4)
    expect(s.recallFiredRate).toBeCloseTo(3 / 4) // 3 of 4 returned hits
    expect(s.avgHits).toBeCloseTo((4 + 0 + 2 + 1) / 4)
    expect(s.avgLatencyMs).toBeCloseTo(8) // MEDIAN of [1,6,10,20] = (6+10)/2, not the mean 9.25
    expect(s.byPath).toEqual({ vector: 2, keyword: 1, cache: 1 })
  })

  it('reports MEDIAN recall latency so a cold-start outlier does not skew it', () => {
    const evs: MetricEvent[] = [
      { t: 'recall', ts: 1, hits: 1, topScore: 0.5, path: 'vector', ms: 1500 }, // first recall = model cold-load
      { t: 'recall', ts: 2, hits: 1, topScore: 0.5, path: 'vector', ms: 20 },
      { t: 'recall', ts: 3, hits: 1, topScore: 0.5, path: 'vector', ms: 25 },
      { t: 'recall', ts: 4, hits: 1, topScore: 0.5, path: 'vector', ms: 18 },
      { t: 'recall', ts: 5, hits: 1, topScore: 0.5, path: 'vector', ms: 22 },
    ]
    const s = summarizeMetrics(evs, 100)
    // mean would be ~317ms (red); median of [18,20,22,25,1500] = 22ms (green) — the honest steady state
    expect(s.avgLatencyMs).toBe(22)
  })

  it('computes embedding availability from embed events', () => {
    const s = summarizeMetrics(
      [
        { t: 'embed', ts: 1, available: true },
        { t: 'embed', ts: 2, available: true },
        { t: 'embed', ts: 3, available: false },
        { t: 'embed', ts: 4, available: true },
      ],
      100,
    )
    expect(s.embedAvailability).toBeCloseTo(3 / 4)
  })

  it('computes write durability from write events', () => {
    const s = summarizeMetrics(
      [
        { t: 'write', ts: 1, ok: true },
        { t: 'write', ts: 2, ok: true },
        { t: 'write', ts: 3, ok: false },
      ],
      100,
    )
    expect(s.writes).toBe(3)
    expect(s.writeDurability).toBeCloseTo(2 / 3)
  })

  it('sums injected tokens and estimates tokens saved from reuse', () => {
    const s = summarizeMetrics(
      [
        { t: 'inject', ts: 1, tokens: 1000 },
        { t: 'inject', ts: 2, tokens: 2000 },
        { t: 'feedback', ts: 3, helpful: true },
        { t: 'feedback', ts: 4, helpful: true },
        { t: 'feedback', ts: 5, helpful: false },
      ],
      100,
    )
    expect(s.tokensInjected).toBe(3000)
    expect(s.injects).toBe(2)
    expect(s.feedbackCount).toBe(3)
    expect(s.feedbackHelpfulRate).toBeCloseTo(2 / 3)
    expect(s.reusedSolutions).toBe(2)
    // estimate = reusedSolutions * avg injected tokens per inject = 2 * (3000/2) = 3000
    expect(s.tokensSavedEstimate).toBe(3000)
  })

  it('sums lessons learned from reflect events', () => {
    const s = summarizeMetrics(
      [
        { t: 'reflect', ts: 1, lessons: 2 },
        { t: 'reflect', ts: 2, lessons: 3 },
      ],
      100,
    )
    expect(s.lessonsLearned).toBe(5)
  })

  it('builds the cross-agent teaching matrix and counts only cross-agent reuse', () => {
    const s = summarizeMetrics(
      [
        { t: 'cross_recall', ts: 1, author: 'gemini', reader: 'claude' },
        { t: 'cross_recall', ts: 2, author: 'gemini', reader: 'claude' },
        { t: 'cross_recall', ts: 3, author: 'claude', reader: 'codex' },
        { t: 'cross_recall', ts: 4, author: 'claude', reader: 'claude' }, // self-reuse, not teaching
      ],
      100,
    )
    expect(s.teachingMatrix.gemini.claude).toBe(2)
    expect(s.teachingMatrix.claude.codex).toBe(1)
    expect(s.teachingMatrix.claude.claude).toBe(1)
    // crossAgentRecalls counts only author != reader
    expect(s.crossAgentRecalls).toBe(3)
  })
})

describe('metricsLedger — persistence (device-local JSONL)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-metrics-'))
    _resetMetricsForTests()
    initMetrics(dir)
  })
  afterEach(() => {
    _resetMetricsForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes events to memory-metrics.jsonl in the given dir', () => {
    recordMetric({ t: 'reflect', ts: 1, lessons: 1 })
    expect(fs.existsSync(path.join(dir, 'memory-metrics.jsonl'))).toBe(true)
  })

  it('replays persisted events on re-init', () => {
    recordMetric({ t: 'recall', ts: 1, hits: 3, topScore: 0.7, path: 'vector', ms: 5 })
    recordMetric({ t: 'reflect', ts: 2, lessons: 4 })
    _resetMetricsForTests()
    initMetrics(dir)
    const s = metricsSummary(100)
    expect(s.recalls).toBe(1)
    expect(s.lessonsLearned).toBe(4)
  })

  it('tolerates corrupt / blank lines on load', () => {
    const fp = path.join(dir, 'memory-metrics.jsonl')
    fs.writeFileSync(fp, 'not json\n\n' + JSON.stringify({ t: 'reflect', ts: 9, lessons: 2 }) + '\n')
    _resetMetricsForTests()
    initMetrics(dir)
    expect(metricsSummary(100).lessonsLearned).toBe(2)
  })

  it('works in-memory when not initialized (no file, no throw)', () => {
    _resetMetricsForTests()
    recordMetric({ t: 'reflect', ts: 1, lessons: 7 })
    expect(metricsSummary(100).lessonsLearned).toBe(7)
  })
})

// Embedder STATUS and embedder HISTORY are different questions, and one number used to answer both —
// badly. Found on a real install: 44 of 99 lifetime recalls ran semantic, but 49 of the 55 failures
// came from ONE nine-minute outage weeks earlier. The tile, labelled "whether the local semantic model
// is up", read 44% — under the 50% "bad" cut, so it glowed red while semantic recall worked perfectly.
// A lifetime average has no decay: it would have stayed red forever.
describe('embedder: status now, history separately', () => {
  const embeds = (...available: boolean[]): MetricEvent[] =>
    available.map((a, i) => ({ t: 'embed', ts: i + 1, available: a }))

  it('reports the CURRENT state from the most recent observation, not the lifetime average', () => {
    // Exactly the shape of the real ledger: a long-past outage, healthy ever since.
    const s = summarizeMetrics([...embeds(...Array(49).fill(false)), ...embeds(...Array(8).fill(true))], 100)
    expect(s.embedUp).toBe(true) // it is working NOW — the only question the tile claimed to answer
    expect(s.embedAvailability).toBeCloseTo(8 / 57, 3) // history is kept, honestly, and reported apart
  })

  it('a live outage is visible even when the lifetime average is excellent', () => {
    const s = summarizeMetrics([...embeds(...Array(99).fill(true)), ...embeds(false)], 100)
    expect(s.embedUp).toBe(false) // the mirror image: a great average must not hide a real outage
    expect(s.embedAvailability).toBeCloseTo(0.99, 2)
  })

  it('the recent window is bounded, so a fixed outage ages out instead of haunting the tile', () => {
    const s = summarizeMetrics(embeds(...Array(EMBED_RECENT_WINDOW + 30).fill(false), ...Array(EMBED_RECENT_WINDOW).fill(true)), 100)
    expect(s.embedRecentTotal).toBe(EMBED_RECENT_WINDOW)
    expect(s.embedRecentUp).toBe(EMBED_RECENT_WINDOW) // the old failures have fallen out of the window
  })

  it('a brain that has never searched reports null, not a fabricated verdict', () => {
    const s = summarizeMetrics([], 100)
    expect(s.embedUp).toBeNull()
    expect(s.embedRecentTotal).toBe(0)
  })
})
