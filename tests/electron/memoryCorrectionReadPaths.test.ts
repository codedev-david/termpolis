import { describe, it, expect } from 'vitest'
import {
  emptyOverlay,
  applyCorrection,
  applyOverlayToEntries,
  DEMOTE_FACTOR,
} from '../../src/main/memoryCorrection'

// A correction has to bind to the MEMORY, not to the one tool the user happened to
// notice the bad fact in. Through v1.46 the overlay was applied at exactly one call
// site — `memory_search` — so a retracted memory still reached agents verbatim via
// memory_list / memory_related / memory_graph / memory_pool / memory_anticipate /
// memory_primer. Retracting a wrong fact and then watching an agent quote it back is
// worse than never having the retract button, because the user believes it worked.
//
// Those read paths return rows WITHOUT a `score` (a list is not a ranking), which is
// why applyOverlayToRecall — typed on RecallCandidate — could not be reused as-is.

const overlayWith = (...inputs: Parameters<typeof applyCorrection>[1][]) => {
  const o = emptyOverlay()
  for (const i of inputs) applyCorrection(o, i)
  return o
}

describe('applyOverlayToEntries — corrections bind to the memory, not to one tool', () => {
  it('drops a retracted memory from an unscored list', () => {
    const overlay = overlayWith({ id: 'm1', kind: 'retract', reason: 'wrong', by: 'david' })
    const rows = [
      { id: 'm1', content: 'the api key lives in .env' },
      { id: 'm2', content: 'the build runs on node 22' },
    ]

    expect(applyOverlayToEntries(overlay, rows).map((r) => r.id)).toEqual(['m2'])
  })

  it('serves the replacement text for an amended memory', () => {
    const overlay = overlayWith({
      id: 'm1',
      kind: 'amend',
      reason: 'moved',
      by: 'david',
      replacement: 'the api key lives in the keychain',
    })
    const rows = [{ id: 'm1', content: 'the api key lives in .env' }]

    const out = applyOverlayToEntries(overlay, rows)
    expect(out[0].content).toBe('the api key lives in the keychain')
    expect(out[0].correction).toEqual({ kind: 'amend', reason: 'moved', by: 'david' })
  })

  it('keeps a demoted memory but scales a score when the row carries one', () => {
    const overlay = overlayWith({ id: 'm1', kind: 'demote', reason: 'shaky', by: 'david' })
    const rows = [{ id: 'm1', content: 'maybe', score: 0.8 }]

    const out = applyOverlayToEntries(overlay, rows)
    expect(out).toHaveLength(1)
    expect(out[0].score).toBeCloseTo(0.8 * DEMOTE_FACTOR)
    expect(out[0].correction?.kind).toBe('demote')
  })

  it('leaves an unscored demoted row in place rather than inventing a score', () => {
    const overlay = overlayWith({ id: 'm1', kind: 'demote', reason: 'shaky', by: 'david' })
    const rows = [{ id: 'm0', content: 'first' }, { id: 'm1', content: 'second' }]

    const out = applyOverlayToEntries(overlay, rows)
    // A list has no ranking to demote within — order is preserved and no `score`
    // key is fabricated, which would make the row look ranked to its caller.
    expect(out.map((r) => r.id)).toEqual(['m0', 'm1'])
    expect('score' in out[1]).toBe(false)
  })

  it('passes untouched rows through unchanged', () => {
    const rows = [{ id: 'm9', content: 'untouched' }]
    expect(applyOverlayToEntries(emptyOverlay(), rows)).toEqual(rows)
  })
})
