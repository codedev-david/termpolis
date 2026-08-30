// recallBench.ts
//
// A continuously-scored benchmark for the brain, built from the brain's own contents.
//
// WHY: "it learns" and "it remembers" are the app's headline claims and they were the
// only ones with no number behind them. `recallMetrics` has had the IR maths since the
// observability work, and the CI gate proves cross-agent recall *functions* — a memory
// written by one agent is readable by another. Neither says whether recall got BETTER
// or WORSE after a change to chunking, embedding, ranking or decay. Every such change
// has therefore shipped on judgement, which is exactly how a retrieval system rots:
// each individual change looks reasonable and the aggregate silently degrades.
//
// THE HARD PART IS THE PROBES, NOT THE SCORING. A benchmark needs (query, relevant-set)
// pairs, and hand-labelling them for a store that grows daily is not sustainable. So
// every probe here is derived from a relevance signal ALREADY PRESENT in real data:
//
//   'link'    — the knowledge graph. A links to B, so a query built from A should
//               retrieve B. Human- or agent-asserted relatedness; the strongest signal
//               available and the only one nobody synthesised for the benchmark's sake.
//   'cue'     — partial recall. A minority of a memory's distinctive terms should
//               retrieve the whole memory. This is what real recall looks like: the
//               user never repeats the stored text, they remember a fragment.
//   'temporal'— a later memory's terms should still reach the earlier memory it builds
//               on, which is the case decay and pruning break first.
//
// Slices are reported separately on purpose: a change that lifts 'cue' while wrecking
// 'link' nets out flat in a single average, and that average is how a regression hides.
//
// Pure. The searcher is injected, so the whole benchmark runs against a fake in unit
// tests and against the real store from the CLI.

import { evaluate, evaluateSlices, type TaggedQuery, type EvalSummary } from './recallMetrics'

export type ProbeKind = 'link' | 'cue' | 'temporal'

export interface BenchMemory {
  id: string
  content: string
  ts: number
  project?: string
  /** Ids this memory links to in the knowledge graph. */
  links?: string[]
}

export interface Probe {
  query: string
  relevant: string[]
  kind: ProbeKind
}

/** Words carrying no retrieval signal. Deliberately short: an aggressive stop list
 *  would strip domain terms and make the benchmark measure the stop list. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'as', 'it', 'its', 'we', 'you', 'they', 'not', 'no', 'so', 'do',
  'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'when',
])

/** Distinctive terms, longest first.
 *
 *  Length is a crude proxy for specificity but a robust one here, and critically it is
 *  DETERMINISTIC — a benchmark whose probes shift between runs cannot detect a
 *  regression, because every delta is confounded with the probe set changing. Ties
 *  break on first appearance for the same reason. */
export function distinctiveTerms(content: string, limit = 12): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of content.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    const term = raw.replace(/^[./-]+|[./-]+$/g, '')
    if (term.length < 4 || STOP.has(term) || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
  }
  return terms
    .map((term, i) => ({ term, i }))
    .sort((a, b) => b.term.length - a.term.length || a.i - b.i)
    .slice(0, limit)
    .map(t => t.term)
}

/** The fraction of a memory's distinctive terms a 'cue' probe gets. A third is the
 *  point where the query stops being a near-copy of the stored text — above it the
 *  benchmark measures string matching rather than retrieval. */
export const CUE_FRACTION = 1 / 3

export function buildCueProbe(memory: BenchMemory): Probe | null {
  const terms = distinctiveTerms(memory.content)
  const take = Math.floor(terms.length * CUE_FRACTION)
  // Fewer than two cue terms is a coin flip, not a probe.
  if (take < 2) return null
  return { query: terms.slice(0, take).join(' '), relevant: [memory.id], kind: 'cue' }
}

export function buildLinkProbes(memories: BenchMemory[]): Probe[] {
  const known = new Set(memories.map(m => m.id))
  const probes: Probe[] = []
  for (const memory of memories) {
    const targets = (memory.links ?? []).filter(id => known.has(id) && id !== memory.id)
    if (targets.length === 0) continue
    const terms = distinctiveTerms(memory.content, 8)
    if (terms.length < 2) continue
    probes.push({ query: terms.join(' '), relevant: targets, kind: 'link' })
  }
  return probes
}

/** Temporal probes: query with a recent memory's terms, expect an older memory from the
 *  same project back. Relevance is "same project, written earlier" — weaker than a link,
 *  which is why it is its own slice rather than mixed into the headline number. */
export function buildTemporalProbes(memories: BenchMemory[], windowMs = 30 * 86_400_000): Probe[] {
  const sorted = [...memories].sort((a, b) => a.ts - b.ts)
  const midpoint = Math.floor(sorted.length / 2)
  const recent = sorted.slice(midpoint)
  const probes: Probe[] = []
  for (const memory of recent) {
    if (!memory.project) continue
    const older = sorted.filter(
      m => m.project === memory.project && m.ts < memory.ts && memory.ts - m.ts <= windowMs && m.id !== memory.id,
    )
    if (older.length === 0) continue
    const terms = distinctiveTerms(memory.content, 6)
    if (terms.length < 2) continue
    probes.push({ query: terms.join(' '), relevant: older.map(m => m.id), kind: 'temporal' })
  }
  return probes
}

export function buildProbes(memories: BenchMemory[]): Probe[] {
  const cue = memories.map(buildCueProbe).filter((p): p is Probe => p !== null)
  return [...buildLinkProbes(memories), ...cue, ...buildTemporalProbes(memories)]
}

export type Searcher = (query: string, limit: number) => Promise<{ id: string }[]>

export interface BenchResult {
  overall: EvalSummary
  slices: Record<string, EvalSummary>
  probes: number
  /** Probes that returned nothing at all — tracked separately because a searcher that
   *  errors or times out scores 0 identically to one that ranks badly, and those are
   *  very different bugs. */
  empty: number
  durationMs: number
}

export const BENCH_K = [1, 5, 10]
/** Retrieval depth. Larger than max(BENCH_K) so recall@10 is measured against a full
 *  ranking rather than one already truncated at 10. */
export const BENCH_LIMIT = 20

export async function runBench(
  probes: Probe[],
  search: Searcher,
  opts: { now?: () => number; limit?: number } = {},
): Promise<BenchResult> {
  const now = opts.now ?? Date.now
  const started = now()
  const limit = opts.limit ?? BENCH_LIMIT
  const queries: TaggedQuery[] = []
  let empty = 0

  for (const probe of probes) {
    let hits: { id: string }[] = []
    try {
      hits = await search(probe.query, limit)
    } catch {
      // A failed search is a scored zero, not a skipped probe: silently dropping it
      // would make a broken searcher look like a smaller, healthier benchmark.
      hits = []
    }
    if (hits.length === 0) empty++
    queries.push({ rankedIds: hits.map(h => h.id), relevant: new Set(probe.relevant), scenario: probe.kind })
  }

  return {
    overall: evaluate(queries, BENCH_K),
    slices: evaluateSlices(queries, BENCH_K),
    probes: probes.length,
    empty,
    durationMs: now() - started,
  }
}

export interface BenchBaseline {
  mrr: number
  recallAt5: number
  ts: number
}

export function baselineFrom(result: BenchResult, ts = Date.now()): BenchBaseline {
  return { mrr: result.overall.mrr, recallAt5: result.overall.recallAtK[5] ?? 0, ts }
}

/** How far a metric may fall before it is a regression. Absolute, not relative: a 2-point
 *  drop matters the same whether the baseline was 0.9 or 0.4, and a relative tolerance
 *  would quietly permit large absolute losses from a low baseline. */
export const REGRESSION_TOLERANCE = 0.02

export interface RegressionVerdict {
  regressed: boolean
  reasons: string[]
  deltas: { mrr: number; recallAt5: number }
}

/** The CI gate. Compares a fresh run to the committed baseline. */
export function checkRegression(result: BenchResult, baseline: BenchBaseline | null): RegressionVerdict {
  const mrrDelta = result.overall.mrr - (baseline?.mrr ?? 0)
  const recallDelta = (result.overall.recallAtK[5] ?? 0) - (baseline?.recallAt5 ?? 0)
  const deltas = { mrr: mrrDelta, recallAt5: recallDelta }
  // No baseline means this run establishes one. Failing here would make the gate
  // impossible to adopt.
  if (!baseline) return { regressed: false, reasons: ['no baseline; recording this run'], deltas }

  const reasons: string[] = []
  if (mrrDelta < -REGRESSION_TOLERANCE) reasons.push(`MRR fell ${(-mrrDelta).toFixed(3)} (${baseline.mrr.toFixed(3)} → ${result.overall.mrr.toFixed(3)})`)
  if (recallDelta < -REGRESSION_TOLERANCE) reasons.push(`recall@5 fell ${(-recallDelta).toFixed(3)} (${baseline.recallAt5.toFixed(3)} → ${(result.overall.recallAtK[5] ?? 0).toFixed(3)})`)
  return { regressed: reasons.length > 0, reasons, deltas }
}

export function formatBench(result: BenchResult): string {
  const line = (label: string, s: EvalSummary): string =>
    `  ${label.padEnd(10)} n=${String(s.n).padStart(4)}  MRR ${s.mrr.toFixed(3)}  R@1 ${(s.recallAtK[1] ?? 0).toFixed(3)}  R@5 ${(s.recallAtK[5] ?? 0).toFixed(3)}  nDCG@10 ${(s.ndcgAtK[10] ?? 0).toFixed(3)}`
  return [
    `Recall benchmark — ${result.probes} probes, ${result.empty} empty, ${result.durationMs}ms`,
    line('overall', result.overall),
    ...Object.entries(result.slices).map(([tag, summary]) => line(tag, summary)),
  ].join('\n')
}
