import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initMemoryGraph, addMemoryEdge, graphStats, graphCreatorStats, edgeKeysIncident, _resetGraphForTests,
} from '../../src/main/memoryGraph'
import {
  runWeave,
  weaveAnchors,
  weaveEdgeKey,
  WEAVE_REL_CODE,
  WEAVE_REL_KNOWLEDGE,
  WEAVE_REL_EXPLAINS,
  WEAVE_COSINE_FLOOR,
  WEAVE_MAX_PER_PASS,
  WEAVE_MAX_EXPLAINS_PER_PASS,
  type WeaveEntry,
  type WeaveNeighbour,
  type WeaveDeps,
  type WeaveStats,
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

/** The explains-miner fixture: one indexed code chunk + one decision that talks about the file. */
const CODE_CHUNK: WeaveEntry = {
  id: 'code1',
  kind: 'note',
  source: 'code',
  projectKey: 'repoA',
  filePath: 'C:/repos/termpolis/src/main/loader.ts',
}
const DECISION: WeaveEntry = {
  id: 'dec1',
  kind: 'decision',
  memoryType: 'semantic',
  projectKey: 'repoA',
  codeRefs: [{ file: 'src/main/loader.ts', symbol: 'load', symbolId: 'src/main/loader.ts#load@1', projectKey: 'repoA' }],
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

  it('does NOT mint below the cosine floor', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'c', source: 'code', projectKey: 'repoB' },
    ]
    const { deps, edges } = harness(cands, { a: [{ id: 'c', score: 0.5, projectKey: 'repoB' }] })
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

  it('is best-effort — throwing neighbours / link / resolveCode / backfill / anchorsOf never break the pass', () => {
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
      anchorsOf: () => { throw new Error('anchors down') },
    }
    expect(() => runWeave(deps)).not.toThrow()
  })

  it('best-effort, ON A REAL PAIR — a throwing link / anchorsOf drops the EDGE, not the pass', () => {
    // The throwing-neighbours case above never reaches the link/anchor code at all. This one
    // walks an actual above-floor pair, so the graph write and the anchor resolver really do
    // blow up mid-pass: the pass must survive and count nothing it failed to draw.
    const deps: WeaveDeps = {
      candidates: () => [CODE_CHUNK, DECISION],
      neighbours: (id) => (id === 'code1' ? [{ id: 'dec1', score: 0.9, projectKey: 'repoA' }] : []),
      link: () => { throw new Error('edge down') },
      anchorsOf: (e) => { if (e.id === 'dec1') throw new Error('anchors down'); return weaveAnchors(e) },
    }
    let stats: WeaveStats | undefined
    expect(() => { stats = runWeave(deps) }).not.toThrow()
    expect(stats?.minted).toBe(0) // link threw → the analogy is never counted
    expect(stats?.codeAnalogies).toBe(0)
    expect(stats?.explains).toBe(0) // anchorsOf threw → no anchors → no overlap → no explains
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

describe('runWeave — the v1.24 RELAXATION (the weave was dormant: 3 edges in a real brain)', () => {
  it('NOW mints an INTRA-repo code analogy (previously skipped by the cross-repo-only guard)', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'b', source: 'code', projectKey: 'repoA' }, // SAME repo — used to be skipped
    ]
    const { deps, edges } = harness(cands, { a: [{ id: 'b', score: 0.95, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges).toEqual([{ from: 'a', to: 'b', relation: WEAVE_REL_CODE, weight: 0.95 }])
    expect(stats.codeAnalogies).toBe(1)
  })

  it('NOW mints an INTRA-repo knowledge analogy', () => {
    const cands: WeaveEntry[] = [
      { id: 'd1', kind: 'decision', memoryType: 'semantic', projectKey: 'repoA' },
      { id: 'd2', kind: 'lesson', memoryType: 'semantic', projectKey: 'repoA' },
    ]
    const { deps, edges } = harness(cands, { d1: [{ id: 'd2', score: 0.8, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges).toEqual([{ from: 'd1', to: 'd2', relation: WEAVE_REL_KNOWLEDGE, weight: 0.8 }])
    expect(stats.knowledgeAnalogies).toBe(1)
  })

  it('defaults the floor to WEAVE_COSINE_FLOOR (0.72) — a 0.75 pair that the old 0.82 floor rejected now links', () => {
    expect(WEAVE_COSINE_FLOOR).toBe(0.72)
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'b', source: 'code', projectKey: 'repoA' },
    ]
    const { deps, edges } = harness(cands, { a: [{ id: 'b', score: 0.75, projectKey: 'repoA' }] })
    runWeave(deps) // default floor
    expect(edges).toHaveLength(1)
  })

  it('still respects the floor — a pair just BELOW WEAVE_COSINE_FLOOR is not linked', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'b', source: 'code', projectKey: 'repoA' },
    ]
    const { deps, edges } = harness(cands, { a: [{ id: 'b', score: 0.71, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges).toEqual([])
    expect(stats.minted).toBe(0)
  })

  it('the floor stays overridable per pass', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'b', source: 'code', projectKey: 'repoA' },
    ]
    const { deps, edges } = harness(cands, { a: [{ id: 'b', score: 0.75, projectKey: 'repoA' }] })
    runWeave(deps, { cosineFloor: 0.9 }) // stricter than the default → nothing
    expect(edges).toEqual([])
  })

  it('NEVER self-links, even when the neighbour source hands back the memory itself', () => {
    const cands: WeaveEntry[] = [{ id: 'a', source: 'code', projectKey: 'repoA' }]
    // A same-repo self-neighbour is exactly what the old cross-repo guard used to absorb.
    const { deps, edges } = harness(cands, { a: [{ id: 'a', score: 1, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges).toEqual([])
    expect(stats.minted).toBe(0)
  })

  it('never links the SAME pair twice in one pass (duplicate neighbour rows + both directions)', () => {
    const cands: WeaveEntry[] = [
      { id: 'a', source: 'code', projectKey: 'repoA' },
      { id: 'b', source: 'code', projectKey: 'repoA' },
    ]
    const { deps, edges } = harness(cands, {
      a: [
        { id: 'b', score: 0.9, projectKey: 'repoA' },
        { id: 'b', score: 0.9, projectKey: 'repoA' }, // duplicate row
      ],
      b: [{ id: 'a', score: 0.9, projectKey: 'repoA' }], // reverse direction
    })
    const stats = runWeave(deps)
    expect(edges).toEqual([{ from: 'a', to: 'b', relation: WEAVE_REL_CODE, weight: 0.9 }])
    expect(stats.minted).toBe(1)
  })

  it('exports WEAVE_MAX_PER_PASS and uses it as the default analogy bound', () => {
    expect(WEAVE_MAX_PER_PASS).toBe(200)
    // 21 same-repo code chunks all mutually near → 210 canonical pairs, bounded to 200.
    const cands: WeaveEntry[] = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, source: 'code', projectKey: 'repoA' }))
    const nmap: Record<string, WeaveNeighbour[]> = {}
    for (const c of cands) nmap[c.id] = cands.filter((o) => o.id !== c.id).map((o) => ({ id: o.id, score: 0.9, projectKey: 'repoA' }))
    const { deps, edges } = harness(cands, nmap, { neighbours: (id) => nmap[id] ?? [] })
    const stats = runWeave(deps, { neighbourK: 20 }) // default maxPerPass
    expect(stats.minted).toBe(WEAVE_MAX_PER_PASS)
    expect(edges).toHaveLength(WEAVE_MAX_PER_PASS)
  })
})

describe('runWeave — the `explains` miner ("what is this code FOR?")', () => {
  it('mints semantic --explains--> code when they share a FILE and clear the floor', () => {
    const cands = [CODE_CHUNK, DECISION]
    const { deps, edges } = harness(cands, {
      code1: [{ id: 'dec1', score: 0.8, projectKey: 'repoA' }],
    })
    const stats = runWeave(deps)
    const explains = edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)
    expect(explains).toEqual([{ from: 'dec1', to: 'code1', relation: WEAVE_REL_EXPLAINS, weight: 0.8 }])
    expect(stats.explains).toBe(1)
  })

  it('points the edge SEMANTIC -> CODE regardless of which end the pass walks from', () => {
    const cands = [CODE_CHUNK, DECISION]
    // Walk from the DECISION side this time — direction must still be dec1 -> code1.
    const { deps, edges } = harness(cands, {
      dec1: [{ id: 'code1', score: 0.9, projectKey: 'repoA' }],
    })
    runWeave(deps)
    const explains = edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)
    expect(explains).toEqual([{ from: 'dec1', to: 'code1', relation: WEAVE_REL_EXPLAINS, weight: 0.9 }])
  })

  it('mints on a SYMBOL overlap too (entity names / codeRefs symbols, not just files)', () => {
    const code: WeaveEntry = {
      id: 'code2',
      source: 'code',
      projectKey: 'repoA',
      codeRefs: [{ file: 'src/main/other.ts', symbol: 'parseTree', symbolId: 'src/main/other.ts#parseTree@9', projectKey: 'repoA' }],
    }
    const lesson: WeaveEntry = { id: 'lesson1', kind: 'note', memoryType: 'semantic', projectKey: 'repoA', entities: ['parseTree'] }
    const { deps, edges } = harness([code, lesson], { code2: [{ id: 'lesson1', score: 0.78, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([
      { from: 'lesson1', to: 'code2', relation: WEAVE_REL_EXPLAINS, weight: 0.78 },
    ])
    expect(stats.explains).toBe(1)
  })

  it('does NOT mint without a symbol/file overlap, however near the pair is', () => {
    const stranger: WeaveEntry = {
      id: 'dec2',
      kind: 'decision',
      memoryType: 'semantic',
      projectKey: 'repoA',
      codeRefs: [{ file: 'src/main/unrelated.ts', projectKey: 'repoA' }],
    }
    const { deps, edges } = harness([CODE_CHUNK, stranger], { code1: [{ id: 'dec2', score: 0.99, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([])
    expect(stats.explains).toBe(0)
  })

  it('does NOT mint below the floor even with a perfect anchor overlap', () => {
    const { deps, edges } = harness([CODE_CHUNK, DECISION], {
      code1: [{ id: 'dec1', score: 0.71, projectKey: 'repoA' }], // just under 0.72
    })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([])
    expect(stats.explains).toBe(0)
  })

  it('needs exactly ONE code end — code~code and semantic~semantic never explain', () => {
    const code2: WeaveEntry = { id: 'code2', source: 'code', projectKey: 'repoA', filePath: 'src/main/loader.ts' }
    const dec2: WeaveEntry = { ...DECISION, id: 'dec2' }
    const { deps, edges } = harness([CODE_CHUNK, code2, DECISION, dec2], {
      code1: [{ id: 'code2', score: 0.95, projectKey: 'repoA' }], // code ~ code
      dec1: [{ id: 'dec2', score: 0.95, projectKey: 'repoA' }], // semantic ~ semantic
    })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([])
    expect(stats.explains).toBe(0)
  })

  it('does NOT let a bare ENTITY node claim to explain code (a name is not an explanation)', () => {
    const entity: WeaveEntry = {
      id: 'ent1',
      memoryType: 'entity',
      projectKey: 'repoA',
      entities: ['loader.ts'], // overlaps the chunk's file
    }
    const { deps, edges } = harness([CODE_CHUNK, entity], { code1: [{ id: 'ent1', score: 0.95, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([])
    expect(stats.explains).toBe(0)
  })

  it('skips a neighbour that is not itself a candidate (its kind + anchors are unknowable)', () => {
    const { deps, edges } = harness([CODE_CHUNK], { code1: [{ id: 'stranger', score: 0.95, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([])
    expect(stats.explains).toBe(0)
  })

  it('mints for an UNSCOPED semantic memory (the analogy repo guard must not gate the bridge)', () => {
    const unscoped: WeaveEntry = { ...DECISION, id: 'dec3', projectKey: undefined }
    const { deps, edges } = harness([CODE_CHUNK, unscoped], { dec3: [{ id: 'code1', score: 0.9, projectKey: 'repoA' }] })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([
      { from: 'dec3', to: 'code1', relation: WEAVE_REL_EXPLAINS, weight: 0.9 },
    ])
    expect(stats.explains).toBe(1)
  })

  it('never mints the same explains edge twice (both directions in one pass)', () => {
    const { deps, edges } = harness([CODE_CHUNK, DECISION], {
      code1: [{ id: 'dec1', score: 0.9, projectKey: 'repoA' }],
      dec1: [{ id: 'code1', score: 0.9, projectKey: 'repoA' }],
    })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toHaveLength(1)
    expect(stats.explains).toBe(1)
  })

  it('is bounded per pass by maxExplainsPerPass (default WEAVE_MAX_EXPLAINS_PER_PASS)', () => {
    expect(WEAVE_MAX_EXPLAINS_PER_PASS).toBe(100)
    const cands: WeaveEntry[] = [CODE_CHUNK]
    const nmap: Record<string, WeaveNeighbour[]> = { code1: [] }
    for (let i = 0; i < 10; i++) {
      cands.push({ ...DECISION, id: `d${i}` })
      nmap.code1.push({ id: `d${i}`, score: 0.9, projectKey: 'repoA' })
    }
    const { deps, edges } = harness(cands, nmap, { neighbours: (id) => nmap[id] ?? [] })
    const stats = runWeave(deps, { neighbourK: 10, maxExplainsPerPass: 4 })
    expect(stats.explains).toBe(4)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toHaveLength(4)
  })

  it('has its OWN budget — a saturated analogy bound must not starve the explains bridge', () => {
    const cands = [CODE_CHUNK, DECISION, { id: 'x', source: 'code', projectKey: 'repoB' } as WeaveEntry]
    const { deps, edges } = harness(cands, {
      code1: [
        { id: 'x', score: 0.99, projectKey: 'repoB' }, // an analogy that eats the whole bound
        { id: 'dec1', score: 0.9, projectKey: 'repoA' }, // the explains pair
      ],
    })
    const stats = runWeave(deps, { maxPerPass: 1 })
    expect(stats.codeAnalogies).toBe(1)
    expect(stats.explains).toBe(1) // still drawn
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toHaveLength(1)
    expect(stats.minted).toBe(2) // minted totals BOTH miners
  })

  it('uses an injected anchorsOf when supplied (the code graph can answer instead of the projection)', () => {
    // Neither memory carries anchors in its projection — only the injected resolver knows.
    const code: WeaveEntry = { id: 'c9', source: 'code', projectKey: 'repoA' }
    const dec: WeaveEntry = { id: 'k9', kind: 'decision', memoryType: 'semantic', projectKey: 'repoA' }
    const { deps, edges } = harness([code, dec], { c9: [{ id: 'k9', score: 0.9, projectKey: 'repoA' }] }, {
      anchorsOf: (e) => (e.id === 'c9' || e.id === 'k9' ? ['src/main/thing.ts'] : []),
    })
    const stats = runWeave(deps)
    expect(edges.filter((e) => e.relation === WEAVE_REL_EXPLAINS)).toEqual([
      { from: 'k9', to: 'c9', relation: WEAVE_REL_EXPLAINS, weight: 0.9 },
    ])
    expect(stats.explains).toBe(1)
  })
})

// B2 — the miner's real defect was never "it draws nothing". It drew 297,013 log lines for ~9,959
// distinct edges: `weaveCandidates` hands back the newest ~300 memories, which barely move between
// 30-min ticks, so the whole 200-edge budget went on pairs that were already on the graph. `hasEdge`
// makes the budget mean NEW work, and makes `stats.minted` mean discovery instead of churn.
describe('runWeave — hasEdge: the per-pass budget is for NEW edges', () => {
  const PAIR: WeaveEntry[] = [
    { id: 'a', source: 'code', projectKey: 'repoA' },
    { id: 'b', source: 'code', projectKey: 'repoA' },
  ]
  const NEAR = { a: [{ id: 'b', score: 0.9, projectKey: 'repoA' }] }

  it('skips a pair the graph already has, and does not count it as minted', () => {
    const { deps, edges } = harness(PAIR, NEAR, { hasEdge: () => true })
    const stats = runWeave(deps)
    expect(edges).toEqual([])
    expect(stats.minted).toBe(0)
    expect(stats.codeAnalogies).toBe(0)
    expect(stats.considered).toBe(2) // the pass RAN — this is not a dead miner
  })

  it('is asked with the canonical from/to/relation the edge would be minted under', () => {
    const asked: string[] = []
    const { deps } = harness(PAIR, NEAR, {
      hasEdge: (from, to, relation) => { asked.push(weaveEdgeKey(from, to, relation)); return false },
    })
    runWeave(deps)
    expect(asked).toEqual([weaveEdgeKey('a', 'b', WEAVE_REL_CODE)])
  })

  it('still mints when hasEdge says the pair is new', () => {
    const { deps, edges } = harness(PAIR, NEAR, { hasEdge: () => false })
    expect(runWeave(deps).minted).toBe(1)
    expect(edges).toHaveLength(1)
  })

  it('mints when hasEdge throws — a snapshot hiccup never costs the pass an edge', () => {
    const { deps, edges } = harness(PAIR, NEAR, { hasEdge: () => { throw new Error('host down') } })
    expect(() => runWeave(deps)).not.toThrow()
    expect(edges).toHaveLength(1)
  })

  it('spends the budget on the NEW pairs instead of the head of the window', () => {
    // Four mutually-near chunks, budget 2, and the first pairs the pass reaches already exist.
    // Before hasEdge the budget was consumed re-minting those and the new pairs were never reached.
    const cands: WeaveEntry[] = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, source: 'code', projectKey: 'repoA' }))
    const nmap: Record<string, WeaveNeighbour[]> = {}
    for (const c of cands) nmap[c.id] = cands.filter((o) => o.id !== c.id).map((o) => ({ id: o.id, score: 0.9, projectKey: 'repoA' }))
    const known = new Set([weaveEdgeKey('s0', 's1', WEAVE_REL_CODE), weaveEdgeKey('s0', 's2', WEAVE_REL_CODE)])
    const { deps, edges } = harness(cands, nmap, {
      neighbours: (id) => nmap[id] ?? [],
      hasEdge: (from, to, relation) => known.has(weaveEdgeKey(from, to, relation)),
    })
    const stats = runWeave(deps, { maxPerPass: 2, neighbourK: 3 })
    expect(stats.minted).toBe(2)
    expect(edges.map((e) => `${e.from}-${e.to}`)).toEqual(['s0-s3', 's1-s2'])
  })

  it('checks hasEdge at most once per pair — the in-pass `seen` set still short-circuits', () => {
    let calls = 0
    const { deps } = harness(PAIR, {
      a: [{ id: 'b', score: 0.9, projectKey: 'repoA' }, { id: 'b', score: 0.9, projectKey: 'repoA' }],
      b: [{ id: 'a', score: 0.9, projectKey: 'repoA' }],
    }, { hasEdge: () => { calls++; return false } })
    runWeave(deps)
    expect(calls).toBe(1)
  })
})

// B2 ACCEPTANCE — everything above is a fake `link`. This wires the miner to the REAL graph module,
// exactly the way index.ts does (a pre-pass key snapshot + addMemoryEdge), and asserts the two things
// the roadmap actually asks for: the graph is NOT empty after a pass, and a second pass over an
// unchanged window neither mints nor grows the append-log.
describe('runWeave against the REAL graph (B2 acceptance)', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-real-')); _resetGraphForTests(); initMemoryGraph(tmp) })
  afterEach(() => { _resetGraphForTests(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  const logLines = (): string[] => {
    const p = path.join(tmp, 'memory-graph.jsonl')
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
  }

  /** The candidate window the indexer would hand the miner — deliberately IDENTICAL every pass. */
  const cands: WeaveEntry[] = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, source: 'code', projectKey: 'repoA' }))
  const nmap: Record<string, WeaveNeighbour[]> = {}
  for (const c of cands) nmap[c.id] = cands.filter((o) => o.id !== c.id).map((o) => ({ id: o.id, score: 0.9, projectKey: 'repoA' }))

  /** One indexer tick: snapshot the keys around the window, mine, write through addMemoryEdge. */
  const pass = (withSnapshot: boolean): number => {
    const known = withSnapshot ? new Set(edgeKeysIncident(cands.map((c) => c.id))) : undefined
    return runWeave({
      candidates: () => cands,
      neighbours: (id) => nmap[id] ?? [],
      link: (from, to, relation, weight) => { addMemoryEdge({ from, to, relation, weight, createdBy: 'weave' }) },
      ...(known ? { hasEdge: (f: string, t: string, r: string) => known.has(weaveEdgeKey(f, t, r)) } : {}),
    }, { neighbourK: 5 }).minted
  }

  it('draws a non-empty graph, then stops re-drawing it', () => {
    const minted = pass(true)
    expect(minted).toBe(15) // C(6,2) canonical pairs
    // THE acceptance criterion: the miner produced a graph, and it is not empty.
    expect(graphStats().edges).toBe(15)
    expect(graphStats().edges).toBeGreaterThan(0)
    expect(graphCreatorStats()).toEqual({ weave: 15 })
    const afterFirst = logLines().length
    expect(afterFirst).toBe(15)

    // Pass 2, same window: every pair is already on the graph, so nothing is minted and nothing
    // is written — but the graph must still be there. An empty graph here is the regression.
    expect(pass(true)).toBe(0)
    expect(logLines()).toHaveLength(afterFirst)
    expect(graphStats().edges).toBe(15)
    expect(graphCreatorStats()).toEqual({ weave: 15 })
  })

  it('the append gate holds even for a miner that does NOT check hasEdge', () => {
    pass(true)
    const afterFirst = logLines().length
    // An older/unwired caller re-mints all 15 pairs. They dedup in memory, so the log must not grow.
    expect(pass(false)).toBe(15)
    expect(logLines()).toHaveLength(afterFirst)
    expect(graphStats().edges).toBe(15)
  })
})

describe('weaveAnchors — the file/symbol overlap signal', () => {
  it('normalizes codeRefs, filePath and entities to lowercase tokens + bare basenames', () => {
    const a = weaveAnchors({ id: 'x', filePath: 'C:/Repos/Termpolis/src/main/Loader.ts' })
    expect(a).toContain('loader.ts') // basename, so a chunk path matches a repo-relative codeRef
    expect(a).toContain('c:/repos/termpolis/src/main/loader.ts')

    const b = weaveAnchors({
      id: 'y',
      codeRefs: [{ file: 'src\\main\\Loader.ts', symbol: 'Load', symbolId: 'src/main/loader.ts#load@1' }],
      entities: ['ParseTree'],
    })
    expect(b).toContain('loader.ts') // backslash paths normalize the same way
    expect(b).toContain('load')
    expect(b).toContain('parsetree')
    expect(b).toContain('src/main/loader.ts#load@1')
  })

  it('is empty for a memory with no anchors at all', () => {
    expect(weaveAnchors({ id: 'z' })).toEqual([])
    expect(weaveAnchors({ id: 'z', entities: ['', '   '] })).toEqual([])
  })
})
