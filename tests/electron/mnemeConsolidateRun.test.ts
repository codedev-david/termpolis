import { describe, it, expect, vi } from 'vitest'
import { runConsolidation, runSummarization, defaultSummarize } from '../../src/main/mnemeConsolidateRun'
import type { ConsolEntry } from '../../src/main/mnemeConsolidate'

const DAY = 86_400_000

describe('mnemeConsolidateRun — the consolidation "sleep" pass', () => {
  it('merges near-duplicates and decays cold noise via the forget primitive', () => {
    const now = 20 * DAY
    const A: ConsolEntry = { id: 'a', content: 'the widget fix', ts: now - 1000, kind: 'note', memoryType: 'episodic', importance: 0.3, useCount: 0, tags: [], hasEdges: false }
    const B: ConsolEntry = { id: 'b', content: 'the widget fix again (longer)', ts: now - 900, kind: 'note', memoryType: 'episodic', importance: 0.3, useCount: 0, tags: [], hasEdges: false }
    const C: ConsolEntry = { id: 'c', content: 'a very old cold message', ts: 0, kind: 'message', memoryType: 'episodic', importance: 0.1, useCount: 0, tags: [], hasEdges: false }

    // A and B are near-duplicates; everything else is dissimilar.
    const simOf = (x: ConsolEntry, y: ConsolEntry): number =>
      (x.id === 'a' && y.id === 'b') || (x.id === 'b' && y.id === 'a') ? 0.95 : 0

    const forgotten: string[] = []
    const res = runConsolidation({
      candidates: () => [A, B, C],
      simOf,
      forget: (id) => forgotten.push(id),
      now,
    })

    // A is dropped as B's duplicate (B is longer); C is decayed as ancient cold noise.
    expect(forgotten).toContain('a')
    expect(forgotten).toContain('c')
    expect(forgotten).not.toContain('b') // the kept representative survives
    expect(res.mergedDuplicates).toBe(1)
    expect(res.decayedCold).toBe(1)
  })

  it('never double-forgets and survives a forget failure', () => {
    const now = 30 * DAY
    // One ancient cold entry that both a (degenerate) merge and decay could target.
    const C: ConsolEntry = { id: 'c', content: 'cold', ts: 0, kind: 'message', memoryType: 'episodic', importance: 0, useCount: 0, tags: [], hasEdges: false }
    const forget = vi.fn((id: string) => {
      if (id === 'boom') throw new Error('disk full')
    })
    const res = runConsolidation({ candidates: () => [C], simOf: () => 0, forget, now })
    expect(res.decayedCold).toBe(1)
    expect(forget).toHaveBeenCalledWith('c')
  })

  it('does nothing on an empty store', () => {
    const res = runConsolidation({ candidates: () => [], simOf: () => 0, forget: () => {}, now: 0 })
    expect(res).toEqual({ mergedDuplicates: 0, decayedCold: 0 })
  })

  it('swallows forget failures in BOTH the merge and decay passes (best-effort)', () => {
    const now = 20 * DAY
    const A: ConsolEntry = { id: 'a', content: 'dup one', ts: now - 1000, kind: 'note', memoryType: 'episodic', importance: 0.3, useCount: 0, tags: [], hasEdges: false }
    const B: ConsolEntry = { id: 'b', content: 'dup one but a longer version', ts: now - 900, kind: 'note', memoryType: 'episodic', importance: 0.3, useCount: 0, tags: [], hasEdges: false }
    const C: ConsolEntry = { id: 'c', content: 'ancient cold message', ts: 0, kind: 'message', memoryType: 'episodic', importance: 0.1, useCount: 0, tags: [], hasEdges: false }
    const simOf = (x: ConsolEntry, y: ConsolEntry): number => ((x.id === 'a' && y.id === 'b') || (x.id === 'b' && y.id === 'a') ? 0.95 : 0)
    const res = runConsolidation({ candidates: () => [A, B, C], simOf, forget: () => { throw new Error('store locked') }, now })
    expect(res.mergedDuplicates).toBe(0) // merge forget threw → not counted (catch exercised)
    expect(res.decayedCold).toBe(0) // decay forget threw → not counted (catch exercised)
  })

  it('does not double-forget an entry already dropped in the merge pass (dedup skip)', () => {
    const now = 40 * DAY
    const A: ConsolEntry = { id: 'a', content: 'cold dup', ts: 0, kind: 'message', memoryType: 'episodic', importance: 0.1, useCount: 0, tags: [], hasEdges: false }
    const B: ConsolEntry = { id: 'b', content: 'cold dup but longer', ts: now - 100, kind: 'note', memoryType: 'episodic', importance: 0.3, useCount: 0, tags: [], hasEdges: false }
    const simOf = (x: ConsolEntry, y: ConsolEntry): number => ((x.id === 'a' && y.id === 'b') || (x.id === 'b' && y.id === 'a') ? 0.95 : 0)
    const forgotten: string[] = []
    runConsolidation({ candidates: () => [A, B], simOf, forget: (id) => forgotten.push(id), now })
    expect(forgotten.filter((id) => id === 'a')).toHaveLength(1) // merged once; decay saw it in `done` and skipped
  })

  it('honours an explicit forgetCap so one pass can never mass-delete', () => {
    const now = 100 * DAY
    const cold: ConsolEntry[] = ['c1', 'c2', 'c3'].map((id) => ({
      id, content: id, ts: 0, kind: 'message', memoryType: 'episodic',
      importance: 0.1, useCount: 0, tags: [], hasEdges: false,
    }))

    const capped: string[] = []
    expect(
      runConsolidation({ candidates: () => cold, simOf: () => 0, forget: (id) => capped.push(id), now }, { forgetCap: 1 }),
    ).toEqual({ mergedDuplicates: 0, decayedCold: 1 })
    expect(capped).toHaveLength(1)

    // Same input, no cap → all three cold entries go, proving the cap did the limiting.
    const uncapped: string[] = []
    expect(
      runConsolidation({ candidates: () => cold, simOf: () => 0, forget: (id) => uncapped.push(id), now }),
    ).toEqual({ mergedDuplicates: 0, decayedCold: 3 })
    expect(uncapped.sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('forgets a duplicate only once when the same memory reaches it through two merge groups', () => {
    const now = 10 * DAY
    const base = {
      ts: now - 1000, kind: 'note' as const, memoryType: 'episodic' as const,
      useCount: 0, tags: [] as string[], hasEdges: false,
    }
    const k1: ConsolEntry = { ...base, id: 'k1', content: 'the retry backoff is wrong', importance: 0.9 }
    const k2: ConsolEntry = { ...base, id: 'k2', content: 'the retry backoff is still wrong', importance: 0.9 }
    // The store handed back the same memory twice (overlapping pages), and planMerges
    // tracks group membership by ARRAY INDEX — so id 'dup' lands in BOTH groups' drop lists.
    const dup1: ConsolEntry = { ...base, id: 'dup', content: 'backoff bug', importance: 0.2 }
    const dup2: ConsolEntry = { ...base, id: 'dup', content: 'backoff bug', importance: 0.2 }
    const simOf = (a: ConsolEntry, b: ConsolEntry): number =>
      (a === k1 && b === dup1) || (a === k2 && b === dup2) ? 0.95 : 0

    const forgotten: string[] = []
    const res = runConsolidation({
      candidates: () => [k1, dup1, k2, dup2], simOf, forget: (id) => forgotten.push(id), now,
    })

    expect(forgotten).toEqual(['dup']) // the second group's drop is skipped, not forgotten again
    expect(res.mergedDuplicates).toBe(1) // …and it is not counted twice either
  })
})

const entry = (over: Partial<ConsolEntry> & { id: string }): ConsolEntry => ({
  content: 'content', ts: 0, kind: 'note', memoryType: 'episodic',
  importance: 0.3, useCount: 0, tags: [], hasEdges: false, ...over,
})

// Four mutually-similar memories → planMerges makes ONE group of 4, which is exactly the
// default summary threshold. 'k' wins mergeKeepCmp on importance, so it is the group key.
const CLUSTER: ConsolEntry[] = [
  entry({ id: 'k', content: 'the login bug is in the token refresh path', importance: 0.9, ts: 10 }),
  entry({ id: 'd1', content: 'token refresh path bug', ts: 20 }),
  entry({ id: 'd2', content: 'refresh token bug again', ts: 30 }),
  entry({ id: 'd3', content: 'the same refresh bug', ts: 40 }),
]
const allSimilar = () => 0.95

describe('mnemeConsolidateRun — the additive summarization pass', () => {
  it('writes one rollup summary per cluster and links every member with part-of', async () => {
    const links: Array<[string, string, string]> = []
    const write = vi.fn().mockResolvedValue({ id: 'sum-1' })

    const res = await runSummarization({
      candidates: () => CLUSTER,
      simOf: allSimilar,
      write,
      link: (from, to, relation) => { links.push([from, to, relation]) },
      now: 100,
    })

    expect(res).toEqual({ summarized: 1 })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toMatchObject({
      agentId: 'mneme', kind: 'note', memoryType: 'summary', importance: 0.5,
    })
    expect(write.mock.calls[0][0].content).toContain('Summary of 4 related memories:')
    // ADDITIVE: the kept representative is summarized alongside the drops, never deleted.
    expect(links.map((l) => l[0]).sort()).toEqual(['d1', 'd2', 'd3', 'k'])
    expect(links.every((l) => l[1] === 'sum-1' && l[2] === 'part-of')).toBe(true)
  })

  it('uses an injected summarizer and an explicit minSize when supplied', async () => {
    const write = vi.fn().mockResolvedValue({ id: 's' })
    const summarize = vi.fn(() => 'an LLM-written digest')

    const res = await runSummarization(
      { candidates: () => CLUSTER.slice(0, 2), simOf: allSimilar, write, link: () => {}, summarize, now: 0 },
      { minSize: 2 },
    )

    expect(res).toEqual({ summarized: 1 })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0][0].map((m: ConsolEntry) => m.id)).toEqual(['k', 'd1'])
    expect(write.mock.calls[0][0].content).toBe('an LLM-written digest')
  })

  it('leaves a cluster below the default threshold alone', async () => {
    const write = vi.fn()
    const res = await runSummarization({
      candidates: () => CLUSTER.slice(0, 3), simOf: allSimilar, write, link: () => {}, now: 0,
    })
    expect(res).toEqual({ summarized: 0 })
    expect(write).not.toHaveBeenCalled()
  })

  it('does nothing when nothing is similar enough to cluster', async () => {
    const write = vi.fn()
    const res = await runSummarization({
      candidates: () => CLUSTER, simOf: () => 0, write, link: () => {}, now: 0,
    })
    expect(res).toEqual({ summarized: 0 })
    expect(write).not.toHaveBeenCalled()
  })

  it('does not count or link a summary whose write returned no usable id', async () => {
    for (const bad of [undefined, null, {}, { id: '' }]) {
      const link = vi.fn()
      const res = await runSummarization({
        candidates: () => CLUSTER,
        simOf: allSimilar,
        write: vi.fn().mockResolvedValue(bad as { id: string }),
        link,
        now: 0,
      })
      expect(res).toEqual({ summarized: 0 })
      expect(link).not.toHaveBeenCalled()
    }
  })

  it('swallows a summary write failure — consolidation is best-effort', async () => {
    const link = vi.fn()
    const res = await runSummarization({
      candidates: () => CLUSTER,
      simOf: allSimilar,
      write: vi.fn().mockRejectedValue(new Error('store locked')),
      link,
      now: 0,
    })
    expect(res).toEqual({ summarized: 0 })
    expect(link).not.toHaveBeenCalled()
  })

  it('still counts the summary when linking a member throws, and tries every member', async () => {
    const link = vi.fn(() => { throw new Error('graph locked') })
    const res = await runSummarization({
      candidates: () => CLUSTER,
      simOf: allSimilar,
      write: vi.fn().mockResolvedValue({ id: 'sum-1' }),
      link,
      now: 0,
    })
    expect(res).toEqual({ summarized: 1 })
    expect(link).toHaveBeenCalledTimes(4) // one throw does not abort the remaining links
  })

  it('defaultSummarize heads with the count, collapses whitespace and caps the digest at 6 members', () => {
    const many = Array.from({ length: 9 }, (_, i) => entry({ id: `m${i}`, content: `line\n  ${i}\tvalue  ` }))
    const lines = defaultSummarize(many).split('\n')
    expect(lines[0]).toBe('Summary of 9 related memories:')
    expect(lines).toHaveLength(7) // header + at most 6 member lines
    expect(lines[1]).toBe('- line 0 value')
    expect(lines[6]).toBe('- line 5 value')
  })

  it('defaultSummarize clips each member line to 140 characters', () => {
    const line = defaultSummarize([entry({ id: 'x', content: 'y'.repeat(300) })]).split('\n')[1]
    expect(line).toBe(`- ${'y'.repeat(140)}`)
  })
})
