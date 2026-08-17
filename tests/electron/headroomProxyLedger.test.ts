import { describe, it, expect, beforeEach } from 'vitest'
const { recordProxyResult, summarizeProxySavings, loadProxyBase, resetProxyLedger, resetProxyCounters } =
  await import('../../src/main/headroomProxy/proxyLedger')
const { ccrRetrieve, resetCcr } = await import('../../src/main/headroom/ccrStore')
const { currentDepthCurve, resetDepthCurveAll } = await import('../../src/main/headroom/sessionDepth')

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

const head = { sysChars: 4000, toolsChars: 18000, tpToolsChars: 9000, toolCount: 34 }

describe('proxy ledger', () => {
  beforeEach(() => { resetProxyLedger(); resetCcr() })

  it('accumulates the prefix head and keeps tool count as a high-water mark', () => {
    recordProxyResult(result({ stats: { ...head } }) as never)
    recordProxyResult(result({ stats: { ...head, toolCount: 12 } }) as never)
    const c = summarizeProxySavings().cumulative
    expect(c.sysChars).toBe(8000)
    expect(c.toolsChars).toBe(36000)
    expect(c.tpToolsChars).toBe(18000)
    // Summing would say 46 tools. Two requests that each saw 34 saw 34.
    expect(c.maxToolCount).toBe(34)
  })

  it('splits output tokens by whether the request was steered', () => {
    recordProxyResult(result({ stats: { ...head, steered: true }, usage: { output_tokens: 600 } }) as never)
    recordProxyResult(result({ stats: { ...head, steered: true }, usage: { output_tokens: 800 } }) as never)
    recordProxyResult(result({ stats: { ...head }, usage: { output_tokens: 2000 } }) as never)
    const c = summarizeProxySavings().cumulative
    expect(c.steeredRequests).toBe(2)
    expect(c.steeredOutputTokens).toBe(1400)
    expect(c.unsteeredRequests).toBe(1)
    // The two arms must reconstruct the total exactly, or one of them is lying.
    expect(c.steeredOutputTokens + c.unsteeredOutputTokens).toBe(c.outputTokens)
  })

  it('folds the new counters into the cumulative baseline without summing the high-water mark', () => {
    loadProxyBase({ sysChars: 1000, toolsChars: 5000, maxToolCount: 40, steeredRequests: 3 })
    recordProxyResult(result({ stats: { ...head, steered: true } }) as never)
    const c = summarizeProxySavings().cumulative
    expect(c.sysChars).toBe(5000)
    expect(c.maxToolCount).toBe(40)
    expect(c.steeredRequests).toBe(4)
  })

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

  it('resetProxyCounters zeroes the lifetime meter (session + base) but keeps recording', () => {
    loadProxyBase({ requests: 5, textOrigTokens: 100_000, textSavedTokens: 40_000 }) // prior lifetime history
    recordProxyResult(result())
    expect(summarizeProxySavings().cumulative.textOrigTokens).toBeGreaterThan(0)

    resetProxyCounters()
    const after = summarizeProxySavings()
    expect(after.cumulative.requests).toBe(0)
    expect(after.cumulative.textOrigTokens).toBe(0)
    expect(after.cumulative.textSavedTokens).toBe(0)
    expect(after.cumulative.savedPct).toBe(0)
    expect(after.session.requests).toBe(0)

    // Unlike resetProxyLedger(), the flush wiring is preserved, so the meter keeps recording.
    recordProxyResult(result())
    const post = summarizeProxySavings()
    expect(post.session.requests).toBe(1)
    expect(post.session.textOrigTokens).toBe(2000)
    expect(post.session.textSavedTokens).toBe(1500)
  })
})

/**
 * The depth curve and the token ledger are fed from the SAME record call on purpose: two meters
 * updated from two places drift, and a drifted curve gives cost advice about a conversation that
 * is not the one being billed.
 */
describe('proxy ledger feeds the depth curve', () => {
  beforeEach(() => { resetProxyLedger(); resetCcr(); resetDepthCurveAll() })

  it('records one depth sample per recorded request, from the same usage block', () => {
    const head = { trBlocks: 1, trOrigChars: 8000, trCompChars: 2000, images: 0, imgOrigBytes: 0, imgCompBytes: 0, msgCount: 300 }
    recordProxyResult(result({ stats: head }) as never)
    const c = currentDepthCurve()
    expect(c.lastMessages).toBe(300)
    expect(c.bands[5].requests).toBe(1)
    expect(c.bands[5].readTokens).toBe(78824)
    expect(c.bands[5].writeTokens).toBe(500)
  })

  it('skips the curve, not the ledger, when a request carried no message count', () => {
    recordProxyResult(result() as never)
    expect(summarizeProxySavings().session.requests).toBe(1)
    expect(currentDepthCurve().bands.every((b) => b.requests === 0)).toBe(true)
  })
})

