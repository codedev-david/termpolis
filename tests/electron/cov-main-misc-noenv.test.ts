// crossEncoderRerank's model load against a transformers build that exposes NO `env`.
//
// The other two model-path suites (crossEncoderRerankModel / ...ModelFail) both mock `env` as an
// object, so the `if (mod.env)` guard is only ever taken one way there. A transformers.js build
// without an `env` export is not hypothetical — the export has moved between majors — and the guard
// is what stops the load from dying on `Cannot set property of undefined`. It also means the remote
// lockdown genuinely cannot be applied on such a build, which is worth having pinned in a test:
// the local-only guarantee then rests on the model simply not being present, and getRerankScorer
// stays best-effort rather than becoming a hard failure.
//
// vi.mock is per-FILE, so this needs its own file rather than another case in the existing one.
import { describe, it, expect, afterEach, vi } from 'vitest'

// vi.hoisted, not a plain const: vi.mock is hoisted above the module body, and a factory that
// closes over an ordinary top-level variable throws — which getRerankScorer's own try/catch would
// silently swallow into `null`, making this suite look like the no-model path instead of failing.
const { pipelineCalls } = vi.hoisted(() => ({ pipelineCalls: [] as Array<[string, string]> }))

vi.mock('@huggingface/transformers', () => ({
  // `env: undefined`, not an omitted key. On a REAL module namespace a missing export simply reads
  // as undefined, which is the case under test; but vitest fronts a factory mock with a proxy that
  // THROWS on any export the factory did not declare, and that throw lands in getRerankScorer's own
  // try/catch — so an omitted key would quietly test the no-model path instead of this one.
  env: undefined,
  pipeline: async (task: string, model: string) => {
    pipelineCalls.push([task, model])
    return async (_input: { text: string; text_pair: string }) => [{ label: 'relevant', score: 0.42 }]
  },
}))

import { getRerankScorer, _resetRerankForTests } from '../../src/main/crossEncoderRerank'

afterEach(() => {
  _resetRerankForTests()
  pipelineCalls.length = 0
})

describe('crossEncoderRerank — a transformers build with no `env` export', () => {
  it('still builds a working scorer instead of throwing on the lockdown write', async () => {
    const scorer = await getRerankScorer()
    expect(scorer).not.toBeNull()
    expect(await scorer!('a query', 'a doc')).toBeCloseTo(0.42)
  })

  it('asks for the relevance cross-encoder, not the NLI entailment model', async () => {
    await getRerankScorer()
    // nliContradict.ts loads a deberta NLI model that scores entailment/contradiction between two
    // statements — the wrong signal for query→doc relevance, and an easy thing to copy by accident
    // since the two loaders are otherwise near-identical.
    expect(pipelineCalls).toEqual([['text-classification', 'Xenova/ms-marco-MiniLM-L-6-v2']])
  })
})
