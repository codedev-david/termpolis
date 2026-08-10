import { describe, it, expect, beforeEach } from 'vitest'
const { loadCumulativeBase, summarizeSavings, resetLedger, recordEvent } =
  await import('../../src/main/headroom/savingsLedger')

/**
 * Existing installs already have a headroom-totals.json written under the OLD semantics, where
 * give-backs lived inside netSaved and inside byTool.retrieve_full. Loading it verbatim would
 * bury the historical -4.6M inside what is now a GROSS field and the unified receipt would then
 * subtract it a second time. The bottom line must not move — only its attribution.
 */
describe('savingsLedger — pre-1.34 baseline migration', () => {
  beforeEach(() => resetLedger())

  it('lifts a legacy give-back out of netSaved into its own field', () => {
    loadCumulativeBase({ netSaved: -4_600_801, events: 2425, byTool: { retrieve_full: -4_600_801 } })
    const c = summarizeSavings().cumulative
    expect(c.netSaved).toBe(0)                  // gross: nothing was ever compressed by this layer
    expect(c.givebackTokens).toBe(4_600_801)    // the reversal cost, now where it belongs
    expect(c.retrieves).toBe(2425)              // inferred from the event count
    expect(c.byTool.retrieve_full).toBeUndefined()
    expect(c.events).toBe(2425)
  })

  it('preserves real per-tool savings alongside the lifted give-back', () => {
    loadCumulativeBase({ netSaved: 1500, events: 10, byTool: { code_search: 4000, retrieve_full: -2500 } })
    const c = summarizeSavings().cumulative
    expect(c.netSaved).toBe(4000)               // 1500 + 2500 lifted back out
    expect(c.givebackTokens).toBe(2500)
    expect(c.byTool).toEqual({ code_search: 4000 })
  })

  it('leaves an already-migrated file completely alone', () => {
    loadCumulativeBase({ netSaved: 9000, events: 5, byTool: { code_search: 9000 }, origTokens: 20_000, givebackTokens: 700, retrieves: 3 })
    const c = summarizeSavings().cumulative
    expect(c.netSaved).toBe(9000)
    expect(c.givebackTokens).toBe(700)
    expect(c.retrieves).toBe(3)
    expect(c.origTokens).toBe(20_000)
  })

  it('does not touch a POSITIVE byTool.retrieve_full — that is not the legacy shape', () => {
    loadCumulativeBase({ netSaved: 100, events: 1, byTool: { retrieve_full: 100 } })
    const c = summarizeSavings().cumulative
    expect(c.netSaved).toBe(100)
    expect(c.givebackTokens).toBe(0)
    expect(c.byTool.retrieve_full).toBe(100)
  })

  it('tolerates a file missing every new field', () => {
    loadCumulativeBase({ netSaved: 42 })
    const c = summarizeSavings().cumulative
    expect(c).toEqual({ netSaved: 42, events: 0, byTool: {}, origTokens: 0, givebackTokens: 0, retrieves: 0 })
  })

  it("does not alias the caller's byTool object", () => {
    const disk = { netSaved: 10, events: 1, byTool: { code_search: 10 } }
    loadCumulativeBase(disk)
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 5, origTokens: 20 })
    expect(disk.byTool.code_search).toBe(10)                       // the parsed file is untouched
    expect(summarizeSavings().cumulative.byTool.code_search).toBe(15)
  })
})
