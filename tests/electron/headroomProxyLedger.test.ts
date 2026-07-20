import { describe, it, expect, beforeEach } from 'vitest'
const { recordProxyResult, summarizeProxySavings, loadProxyBase, resetProxyLedger } =
  await import('../../src/main/headroomProxy/proxyLedger')
const { ccrRetrieve, resetCcr } = await import('../../src/main/headroom/ccrStore')

function result(over: Record<string, unknown> = {}) {
  return {
    kind: 'result' as const,
    changed: true,
    stats: { trBlocks: 1, trOrigChars: 8000, trCompChars: 2000, images: 0, imgOrigBytes: 0, imgCompBytes: 0 },
    usage: { input_tokens: 8, cache_read_input_tokens: 78824, cache_creation_input_tokens: 500, output_tokens: 100 },
    stashes: [{ token: 'hr_abc', original: 'the full original tool result' }],
    status: 200,
    ...over,
  }
}

describe('proxy ledger', () => {
  beforeEach(() => { resetProxyLedger(); resetCcr() })

  it('accumulates real savings + usage and computes % saved', () => {
    recordProxyResult(result())
    const r = summarizeProxySavings()
    expect(r.session.requests).toBe(1)
    expect(r.session.textOrigTokens).toBe(2000) // ceil(8000/4)
    expect(r.session.textSavedTokens).toBe(1500) // ceil((8000-2000)/4)
    expect(r.session.savedPct).toBe(75)
    expect(r.session.cacheReadTokens).toBe(78824)
  })

  it('makes proxy-compressed originals retrievable via CCR (retrieve_full)', () => {
    recordProxyResult(result())
    expect(ccrRetrieve('hr_abc')).toBe('the full original tool result')
  })

  it('folds a persisted cumulative baseline into the cumulative total', () => {
    loadProxyBase({ requests: 10, textSavedTokens: 50000, textOrigTokens: 100000 })
    recordProxyResult(result())
    const r = summarizeProxySavings()
    expect(r.cumulative.requests).toBe(11)
    expect(r.cumulative.textSavedTokens).toBe(51500)
  })

  it('never produces negative savings on a pathological (grew) result', () => {
    recordProxyResult(result({ stats: { trOrigChars: 100, trCompChars: 500, images: 0, imgOrigBytes: 0, imgCompBytes: 0 }, stashes: [] }))
    expect(summarizeProxySavings().session.textSavedTokens).toBe(0)
  })
})
