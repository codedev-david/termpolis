import { describe, it, expect, vi } from 'vitest'
import {
  runWeave,
  WEAVE_REL_CODE,
  WEAVE_REL_KNOWLEDGE,
  type WeaveEntry,
  type WeaveNeighbour,
  type WeaveDeps,
} from '../../src/main/mnemeWeave'

type Edge = { from: string; to: string; relation: string; weight: number }

function harness(
  candidates: WeaveEntry[],
  neighbourMap: Record<string, WeaveNeighbour[]>,
  extra: Partial<WeaveDeps> = {},
): { deps: WeaveDeps; edges: Edge[] } {
  const edges: Edge[] = []
  const deps: WeaveDeps = {
    candidates: () => candidates,
    neighbours: (id) => neighbourMap[id] ?? [],
    link: (from, to, relation, weight) => { edges.push({ from, to, relation, weight }) },
    ...extra,
  }
  return { deps, edges }
}

describe('runWeave — background connection-miner (C4)', () => {
  it('mints a CROSS-REPO code analogy for near code chunks in different repos', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'b', source: 'code', projectKey: 'repoB' },
    ]
    const { deps, edges } = harness(cands, { a: [{ id: 'b', score: 0.9, projectKey: 'repoB' }] })
    const stats = runWeave(deps, { cosineFloor: 0.82 })
    expect(edges).toEqual([{ from: 'a', to: 'b', relation: WEAVE_REL_CODE, weight: 0.9 }])
    expect(stats.codeAnalogies).toBe(1)
    expect(stats.knowledgeAnalogies).toBe(0)
  })

  it('mints a CROSS-REPO knowledge analogy for near decisions in different repos', () => {
    const cands: WeaveEntry[] = [
      { id: 'd1', kind: 'decision', memoryType: 'semantic', projectKey: 'repoA' },
      { id: 'd2', kind: 'decision', memoryType: 'semantic', projectKey: 'repoB' },
    ]
    const { deps, edges } = harness(cands, { d1: [{ id: 'd2', score: 0.88, projectKey: 'repoB' }] })
    const stats = runWeave(deps)
    expect(edges).toEqual([{ from: 'd1', to: 'd2', relation: WEAVE_REL_KNOWLEDGE, weight: 0.88 }])
    expect(stats.knowledgeAnalogies).toBe(1)
  })

  it('does NOT mint within the same repo, or below the cosine floor', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'b', source: 'code', projectKey: 'repoA' }, // same repo
      { id: 'c', source: 'code', projectKey: 'repoB' },
    ]
    const { deps, edges } = harness(cands, {
      a: [
        { id: 'b', score: 0.95, projectKey: 'repoA' }, // same repo → skip
        { id: 'c', score: 0.5, projectKey: 'repoB' }, // below floor → skip
      ],
    })
    const stats = runWeave(deps, { cosineFloor: 0.82 })
    expect(edges).toEqual([])
    expect(stats.minted).toBe(0)
  })

  it('is idempotent across two passes and symmetric (A~B == B~A)', () => {
    const cands: WeaveEntry[] = [
      { id: 'b', source: 'code', projectKey: 'repoB' },
      { id: 'a', source: 'code', projectKey: 'repoA' },
    ]
    // Both sides see each other as neighbours — must still be ONE canonical edge.
    const nmap = {
      a: [{ id: 'b', score: 0.9, projectKey: 'repoB' }],
      b: [{ id: 'a', score: 0.9, projectKey: 'repoA' }],
    }
    const { deps, edges } = harness(cands, nmap)
    runWeave(deps)
    runWeave(deps) // second pass
    const keys = new Set(edges.map((e) => `${e.from}\0${e.to}\0${e.relation}`))
    expect(keys.size).toBe(1) // one canonical edge despite 2 passes × 2 directions
    expect([...keys][0]).toBe(`a\0b\0${WEAVE_REL_CODE}`) // canonicalized a<b
  })

  it('respects maxPerPass', () => {
    const cands: WeaveEntry[] = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, source: 'code', projectKey: `repo${i}` }))
    const nmap: Record<string, WeaveNeighbour[]> = {}
    for (let i = 0; i < 5; i++) nmap[`s${i}`] = cands.filter((c) => c.id !== `s${i}`).map((c) => ({ id: c.id, score: 0.9, projectKey: c.projectKey }))
    const { deps, edges } = harness(cands, nmap)
    const stats = runWeave(deps, { maxPerPass: 3 })
    expect(stats.minted).toBe(3)
    expect(edges).toHaveLength(3)
  })

  it('bridge miner backfills codeRefs on un-anchored code-referencing memories only', () => {
    const cands: WeaveEntry[] = [
      { id: 'm1', kind: 'fact', projectKey: 'repoA', entities: ['loader.ts'], hasCodeRefs: false },
      { id: 'm2', kind: 'fact', projectKey: 'repoA', entities: ['loader.ts'], hasCodeRefs: true }, // already anchored → skip
      { id: 'm3', kind: 'fact', projectKey: 'repoA', entities: [] }, // no entities → skip
    ]
    const backfilled: Array<{ id: string; refs: unknown }> = []
    const { deps } = harness(cands, {}, {
      resolveCode: (_names, key) => [{ file: 'src/loader.ts', symbol: 'load', symbolId: 'src/loader.ts#load@1', projectKey: key }],
      backfillCodeRefs: (id, refs) => backfilled.push({ id, refs }),
    })
    const stats = runWeave(deps)
    expect(stats.bridged).toBe(1)
    expect(backfilled.map((b) => b.id)).toEqual(['m1'])
  })

  it('bridge miner skips when resolver finds nothing', () => {
    const cands: WeaveEntry[] = [{ id: 'm1', projectKey: 'repoA', entities: ['NothingHere'] }]
    const backfilled: string[] = []
    const { deps } = harness(cands, {}, {
      resolveCode: () => [],
      backfillCodeRefs: (id) => backfilled.push(id),
    })
    expect(runWeave(deps).bridged).toBe(0)
    expect(backfilled).toEqual([])
  })

  it('is best-effort — throwing neighbours / link / resolveCode / backfill never break the pass', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA', entities: ['x.ts'] },
      { id: 'b', source: 'code', projectKey: 'repoB' },
    ]
    const deps: WeaveDeps = {
      candidates: () => cands,
      neighbours: (id) => { if (id === 'a') throw new Error('nn down'); return [] },
      link: () => { throw new Error('edge down') },
      resolveCode: () => { throw new Error('graph down') },
      backfillCodeRefs: () => { throw new Error('write down') },
    }
    expect(() => runWeave(deps)).not.toThrow()
  })

  it('ignores an unscoped memory (no projectKey) for analogies', () => {
    const cands: WeaveEntry[] = [{ id: 'a', source: 'code' }] // no projectKey
    const { deps, edges } = harness(cands, { a: [{ id: 'b', score: 0.99, projectKey: 'repoB' }] })
    runWeave(deps)
    expect(edges).toEqual([])
  })

  it('classifies by the source end when the neighbour is not itself a candidate', () => {
    // `e` is a decision (not code) and its neighbour is NOT in the candidate set → the
    // neighbour-classification branch falls back to `e`, yielding a knowledge analogy.
    const cands: WeaveEntry[] = [{ id: 'd1', kind: 'decision', memoryType: 'semantic', projectKey: 'repoA' }]
    const { deps, edges } = harness(cands, { d1: [{ id: 'stranger', score: 0.9, projectKey: 'repoB' }] })
    const stats = runWeave(deps)
    expect(edges).toEqual([{ from: 'd1', to: 'stranger', relation: WEAVE_REL_KNOWLEDGE, weight: 0.9 }])
    expect(stats.knowledgeAnalogies).toBe(1)
  })
})
