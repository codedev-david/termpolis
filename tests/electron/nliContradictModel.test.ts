// Covers nliContradict's REAL model path by mocking the bundled transformers.js pipeline, so the
// cross-encoder closure (label→score extraction, env lockdown) is exercised without a real model.
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (input: { text: string; text_pair: string }) =>
    /nocon/.test(input.text)
      ? [{ label: 'neutral', score: 0.9 }, { label: 'entailment', score: 0.1 }]
      : [{ label: 'contradiction', score: 0.82 }, { label: 'neutral', score: 0.18 }],
  env: { allowRemoteModels: true, allowLocalModels: false },
}))

import { getNliScorer, detectConflictsNli, _resetNliForTests } from '../../src/main/nliContradict'

afterEach(() => _resetNliForTests())

describe('nliContradict — real transformers.js path (mocked model)', () => {
  it('builds a scorer that reads the contradiction probability from the model output', async () => {
    const scorer = await getNliScorer()
    expect(scorer).not.toBeNull()
    expect(await scorer!('some premise', 'some hypothesis')).toBeCloseTo(0.82)
    expect(await scorer!('nocon premise', 'some hypothesis')).toBe(0) // no contradiction label → 0
  })

  it('caches the loaded scorer across calls', async () => {
    const a = await getNliScorer()
    const b = await getNliScorer()
    expect(a).toBe(b)
  })

  it('detectConflictsNli uses the loaded model when enabled', async () => {
    // enable → getNliScorer path; the mock scores everything as a contradiction (0.82 ≥ 0.6)
    const { setNliConflictsEnabled } = await import('../../src/main/nliContradict')
    setNliConflictsEnabled(true)
    const lessons = [
      { source: 'claude', content: 'Use Postgres for the sync store' },
      { source: 'codex', content: 'Use MySQL for the sync store' },
    ]
    const conflicts = await detectConflictsNli(lessons)
    expect(conflicts).toHaveLength(1)
  })
})
