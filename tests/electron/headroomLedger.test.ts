import { describe, it, expect, beforeEach } from 'vitest'
const { recordEvent, summarizeSavings, resetLedger } =
  await import('../../src/main/headroom/savingsLedger')

describe('savings ledger', () => {
  beforeEach(() => resetLedger())

  it('sums compress savings into session + cumulative', () => {
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 1000 })
    recordEvent({ tool: 'read_output', kind: 'compress', savedTokens: 500 })
    const r = summarizeSavings()
    expect(r.session.netSaved).toBe(1500)
    expect(r.session.byTool.code_search).toBe(1000)
    expect(r.session.events).toBe(2)
    expect(r.cumulative.netSaved).toBe(1500)
  })

  it('keeps give-backs OUT of netSaved and in their own field (v1.34.0 attribution)', () => {
    // netSaved is GROSS compression savings. Folding give-backs into it is exactly how the
    // receipt came to read -4,600,801 while the proxy beside it had saved +450M: retrieve_full
    // was charged here even when the wire proxy had issued the token. unifiedReceipt subtracts
    // givebackTokens once, across both layers.
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 1000 })
    recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -400 })
    const s = summarizeSavings().session
    expect(s.netSaved).toBe(1000)
    expect(s.givebackTokens).toBe(400)
    expect(s.retrieves).toBe(1)
    expect(s.byTool.retrieve_full).toBeUndefined() // a retrieve is not a per-tool saving
    expect(s.events).toBe(2)
  })

  it('records the pre-compression size so the receipt has an honest denominator', () => {
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 900, origTokens: 1200 })
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 100 }) // legacy call, no origTokens
    expect(summarizeSavings().session.origTokens).toBe(1200)
  })

  it('resetLedger clears session but callers can still summarize', () => {
    recordEvent({ tool: 'x', kind: 'compress', savedTokens: 10 })
    resetLedger()
    expect(summarizeSavings().session.netSaved).toBe(0)
  })
})
