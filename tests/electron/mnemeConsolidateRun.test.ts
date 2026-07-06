import { describe, it, expect, vi } from 'vitest'
import { runConsolidation } from '../../src/main/mnemeConsolidateRun'
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
})
