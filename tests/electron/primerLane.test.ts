// @vitest-environment node
// The newest-first listing behind the primer's freshness lane: what it asks the store for, what it hands the builder,
// and that it runs every row through the correction overlay. The store itself (superseded, suppressed) is covered in
// swarmMemory.test.ts, and the whole chain against the real store in primerLaneStore.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { createPrimerRecent } from '../../src/main/primerLane'
import { applyCorrection, applyOverlayToEntries, emptyOverlay } from '../../src/main/memoryCorrection'
import type { MemoryEntry } from '../../src/main/swarmMemory'

const entry = (over: Record<string, unknown> = {}): MemoryEntry =>
  ({ id: 'm1', ts: 1_700_000_000_000, agentId: 'claude-history', kind: 'message', content: 'user: how do I cut a release?', tags: [], ...over }) as unknown as MemoryEntry

/** The overlay the app uses, built the way the store builds it: a log of corrections. */
const overlayOf = (...corrections: Array<{ id: string; kind: 'retract' | 'amend' | 'demote'; replacement?: string }>) => {
  const overlay = emptyOverlay()
  for (const c of corrections) applyCorrection(overlay, { ...c, reason: 'test', by: 'user' })
  return <T extends { id: string; content: string; score?: number }>(rows: T[]) => applyOverlayToEntries(overlay, rows)
}
const nothingCorrected = overlayOf()

describe('createPrimerRecent', () => {
  it('asks the store for what a search would return, in the window and the scope the primer asked for', async () => {
    const list = vi.fn().mockResolvedValue([])
    const recent = createPrimerRecent({ list, correct: nothingCorrected })
    await recent({ limit: 24, project: 'C:/repos/termpolis', since: 1234 })
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith({ limit: 24, project: 'C:/repos/termpolis', since: 1234, active: true })
  })

  it('leaves the scope and the window out when the primer names none', async () => {
    const list = vi.fn().mockResolvedValue([])
    await createPrimerRecent({ list, correct: nothingCorrected })({ limit: 9 })
    expect(list).toHaveBeenCalledWith({ limit: 9, project: undefined, since: undefined, active: true })
  })

  it('hands the builder exactly the fields it reads, scored zero because a lane is ordered by time and not by score', async () => {
    const full = entry({
      id: 'm7', ts: 1_700_000_100_000, agentId: 'mneme', kind: 'fact', source: 'claude', project: 'termpolis', projectKey: 'abc123abc123abcd',
      memoryType: 'procedural', tags: ['x'], content: 'Never call app.quit() from will-quit because it re-enters the sequence.',
      importance: 0.8, hash: 'h', embedding: [0.1, 0.2], originEpisode: 'ep',
    })
    const out = await createPrimerRecent({ list: async () => [full], correct: nothingCorrected })({ limit: 5 })
    expect(out).toEqual([{
      id: 'm7', content: full.content, source: 'claude', kind: 'fact', score: 0, project: 'termpolis', projectKey: 'abc123abc123abcd',
      ts: 1_700_000_100_000, tags: ['x'], agentId: 'mneme', memoryType: 'procedural', correction: undefined,
    }])
    expect(Object.keys(out[0])).not.toContain('embedding') // a vector never travels into a digest
  })

  it('keeps the order of the listing', async () => {
    const rows = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]
    const out = await createPrimerRecent({ list: async () => rows, correct: nothingCorrected })({ limit: 5 })
    expect(out.map((h) => h.id)).toEqual(['a', 'b', 'c'])
  })

  describe('through the correction overlay', () => {
    const rows = () => [
      entry({ id: 'live', content: 'a live memory' }),
      entry({ id: 'gone', content: 'a retracted memory' }),
      entry({ id: 'fixed', content: 'an amended memory, as first written' }),
      entry({ id: 'weak', content: 'a demoted memory' }),
    ]
    const correct = overlayOf({ id: 'gone', kind: 'retract' }, { id: 'fixed', kind: 'amend', replacement: 'an amended memory, as corrected' }, { id: 'weak', kind: 'demote' })

    it('drops what a person retracted', async () => {
      const out = await createPrimerRecent({ list: async () => rows(), correct })({ limit: 5 })
      expect(out.map((h) => h.id)).toEqual(['live', 'fixed', 'weak'])
    })

    it('hands over the replacement text of an amended memory, and marks it and the demoted one as corrected for the builder', async () => {
      const out = await createPrimerRecent({ list: async () => rows(), correct })({ limit: 5 })
      const byId = Object.fromEntries(out.map((h) => [h.id, h]))
      expect(byId.fixed.content).toBe('an amended memory, as corrected')
      expect(byId.fixed.correction?.kind).toBe('amend')
      expect(byId.weak.correction?.kind).toBe('demote')
      expect(byId.live.correction).toBeUndefined()
    })

    it('applies the overlay to the rows the store returned and nothing else, so it is asked for after the listing', async () => {
      const order: string[] = []
      const list = vi.fn(async () => { order.push('list'); return [entry({ id: 'live' })] })
      const spy = vi.fn(<T,>(r: T[]) => { order.push('correct'); return r as never })
      await createPrimerRecent({ list, correct: spy as never })({ limit: 5 })
      expect(order).toEqual(['list', 'correct'])
    })
  })

  it('lets a failing store reach the builder, which treats a broken lane as no lane', async () => {
    const recent = createPrimerRecent({ list: async () => { throw new Error('memory host down') }, correct: nothingCorrected })
    await expect(recent({ limit: 5 })).rejects.toThrow('memory host down')
  })

  it('answers an empty listing with an empty lane', async () => {
    expect(await createPrimerRecent({ list: async () => [], correct: nothingCorrected })({ limit: 5 })).toEqual([])
  })
})
