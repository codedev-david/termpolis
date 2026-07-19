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

  it('nets out retrieves honestly (no inflation)', () => {
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 1000 })
    recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -400 })
    expect(summarizeSavings().session.netSaved).toBe(600)
  })

  it('resetLedger clears session but callers can still summarize', () => {
    recordEvent({ tool: 'x', kind: 'compress', savedTokens: 10 })
    resetLedger()
    expect(summarizeSavings().session.netSaved).toBe(0)
  })
})
