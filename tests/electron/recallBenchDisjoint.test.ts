import { describe, it, expect } from 'vitest'
import { buildDisjointProbes, buildProbes, type BenchMemory } from '../../src/main/recallBench'

// WHY THIS PROBE KIND EXISTS.
//
// Every probe the bench had was built from the target's OWN words. A 'cue' query is a
// literal subset of the memory it must retrieve; a 'link' query is memory A's terms
// aiming at memory B, and A and B are linked precisely because they talk about the same
// thing, so they share vocabulary. Plain keyword matching therefore scores near the
// ceiling on both — which is exactly what was measured: recall@10 pinned at 1.0 with no
// room left for a change to show up in.
//
// That is a broken instrument, not a good result. A benchmark a keyword index already
// aces cannot tell you whether embeddings, reranking, graph fusion or pseudo-relevance
// feedback earn their cost. It reports 1.0 before and 1.0 after, and every one of those
// tiers stays dark because nothing can justify turning it on.
//
// A disjoint probe removes the shortcut: take the link pair the graph already asserts,
// then DELETE from the query every term that also occurs in the target. What remains
// shares zero vocabulary with the answer, so a lexical index has nothing to match on and
// the only way through is meaning or the graph itself. Nothing is synthesised — the
// relevance signal is still the human/agent-asserted edge, which is the rule this file
// has followed since it was written.

const mem = (id: string, content: string, links?: string[]): BenchMemory => ({
  id,
  content,
  ts: 1_700_000_000_000,
  project: '/repos/alpha',
  links,
})

describe('buildDisjointProbes — a query that shares no words with its answer', () => {
  it('strips every term the target also contains', () => {
    const memories = [
      mem('a', 'pty disposal deadlock when panes close concurrently', ['b']),
      mem('b', 'serialize disposal behind a mutex so concurrently closing panes cannot race'),
    ]
    const [probe] = buildDisjointProbes(memories)

    const target = memories[1].content.toLowerCase()
    for (const term of probe.query.split(' ')) {
      expect(target).not.toContain(term)
    }
    expect(probe.relevant).toEqual(['b'])
    expect(probe.kind).toBe('disjoint')
  })

  it('keeps the terms that are genuinely the querying memory\'s own', () => {
    const memories = [
      mem('a', 'pty disposal deadlock when panes close concurrently', ['b']),
      mem('b', 'serialize disposal behind a mutex so concurrently closing panes cannot race'),
    ]
    const [probe] = buildDisjointProbes(memories)
    // 'deadlock' is in A and not in B, so it survives; 'disposal' is in both, so it goes.
    expect(probe.query).toContain('deadlock')
    expect(probe.query).not.toContain('disposal')
  })

  it('drops a pair with nothing left to ask with, rather than emitting a one-word coin flip', () => {
    // A is a near-restatement of B: after removing the shared vocabulary almost nothing
    // remains, and a single leftover term is noise, not a question.
    const memories = [
      mem('a', 'the tokenizer skips null bytes entirely', ['b']),
      mem('b', 'tokenizer skips null bytes entirely always'),
    ]
    expect(buildDisjointProbes(memories)).toHaveLength(0)
  })

  it('ignores edges pointing outside the benchmarked set, and self-links', () => {
    const memories = [
      mem('a', 'pty disposal deadlock when panes close concurrently', ['a', 'nowhere']),
    ]
    expect(buildDisjointProbes(memories)).toHaveLength(0)
  })

  it('is deterministic — the same store yields the identical probe set twice', () => {
    // A probe set that shifts between runs confounds every delta with the probes moving,
    // which is the one thing this whole file is built to avoid.
    const memories = [
      mem('a', 'pty disposal deadlock when panes close concurrently', ['b']),
      mem('b', 'serialize disposal behind a mutex so concurrently closing panes cannot race', ['a']),
    ]
    expect(buildDisjointProbes(memories)).toEqual(buildDisjointProbes(memories))
  })
})

describe('buildProbes includes the disjoint slice', () => {
  it('reports disjoint probes alongside link, cue and temporal', () => {
    // Slices are scored separately on purpose, so a tier that lifts disjoint recall
    // while leaving cue flat is visible instead of being averaged into nothing.
    const memories = [
      mem('a', 'pty disposal deadlock when panes close concurrently', ['b']),
      mem('b', 'serialize disposal behind a mutex so concurrently closing panes cannot race'),
    ]
    expect(buildProbes(memories).some((p) => p.kind === 'disjoint')).toBe(true)
  })
})
