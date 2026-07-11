// Covers crossEncoderRerank's REAL model-load path by mocking the bundled transformers.js pipeline,
// so the relevance-scorer closure (score extraction, array-vs-object output, env lockdown) is
// exercised without a real cross-encoder model — mirrors nliContradictModel.test.ts.
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (input: { text: string; text_pair: string }) =>
    /obj/.test(input.text)
      ? { label: 'relevant', score: 0.7 } // object (not array) output branch
      : /empty/.test(input.text)
        ? [] // empty output → no element → score 0
        : [{ label: 'relevant', score: 0.91 }], // array output branch
  env: { allowRemoteModels: true, allowLocalModels: false },
}))

import { getRerankScorer, _resetRerankForTests } from '../../src/main/crossEncoderRerank'

afterEach(() => _resetRerankForTests())

describe('crossEncoderRerank — real transformers.js path (mocked model)', () => {
  it('builds a scorer that reads the relevance score from the model output (array + object + empty)', async () => {
    const scorer = await getRerankScorer()
    expect(scorer).not.toBeNull()
    expect(await scorer!('a query', 'a doc')).toBeCloseTo(0.91) // array → out[0].score
    expect(await scorer!('obj query', 'a doc')).toBeCloseTo(0.7) // object → out.score
    expect(await scorer!('empty query', 'a doc')).toBe(0) // empty array → 0
  })

  it('caches the loaded scorer across calls', async () => {
    const a = await getRerankScorer()
    const b = await getRerankScorer()
    expect(a).toBe(b)
  })
})
