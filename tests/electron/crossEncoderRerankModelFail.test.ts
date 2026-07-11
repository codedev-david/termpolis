// Covers crossEncoderRerank's model-load FAILURE path: when the transformers.js pipeline throws
// (no local model), getRerankScorer returns null and stays null on subsequent calls (loadAttempted).
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => { throw new Error('no local reranker model') },
  env: {}, // truthy → exercises the env-lockdown branch before the throw
}))

import { getRerankScorer, _resetRerankForTests } from '../../src/main/crossEncoderRerank'

afterEach(() => _resetRerankForTests())

describe('crossEncoderRerank — model-load failure path (mocked throw)', () => {
  it('returns null on load failure and does not retry the load', async () => {
    expect(await getRerankScorer()).toBeNull() // catch → null, loadAttempted set
    expect(await getRerankScorer()).toBeNull() // if (loadAttempted) return null
  })
})
