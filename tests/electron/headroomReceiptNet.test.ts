import { describe, it, expect, beforeEach } from 'vitest'
import { billBreakdown } from '../../src/main/headroom/effectiveUnits'
import { resetLedger } from '../../src/main/headroom/savingsLedger'
import { resetCcr } from '../../src/main/headroom/ccrStore'
import { resetDepthCurveAll } from '../../src/main/headroom/sessionDepth'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'
const { summarizeUnifiedSavings } = await import('../../src/main/headroom/unifiedReceipt')
const { resetProxyLedger, recordProxyResult, recordProxyGiveback, loadProxyBase } = await import('../../src/main/headroomProxy/proxyLedger')

/**
 * R1 criterion 4. The headline is billed units avoided NET of the turns that fetched elided text.
 * The receipt used to credit every elided token for every request that re-sent it and charge a
 * retrieval only the size of the text that came back; the 15% of the bill that the retrieval TURNS
 * cost never appeared. These pin the arithmetic against numbers worked out by hand, so a change to
 * the formula cannot pass by agreeing with itself.
 */

// A synthetic ledger, small enough to do on paper:
//   cache read   1,000,000 tokens x 0.1  =   100,000 units
//   cache write    100,000 tokens x 1.25 =   125,000 units
//   fresh input     10,000 tokens x 1    =    10,000 units
//   output          20,000 tokens x 5    =   100,000 units   -> the bill is 335,000 units
//   blended prefix weight = (100,000 + 125,000) / 1,100,000 = 9/44 units per prefix token
//   500,000 tokens kept off the wire (net of what came back) -> 500,000 x 9/44 = 102,272.7 units
const LEDGER = { cacheReadTokens: 1_000_000, cacheCreationTokens: 100_000, inputTokens: 10_000, outputTokens: 20_000 }
const NET_SAVED = 500_000
const BILL = 335_000
const GROSS_AVOIDED = 500_000 * (225_000 / 1_100_000)

describe('billBreakdown nets the retrieval turns', () => {
  it('without any retrieval turns it reads exactly as it did before', () => {
    const b = billBreakdown(LEDGER, NET_SAVED)
    expect(b.total).toBe(BILL)
    expect(b.grossAvoided).toBeCloseTo(102_272.727, 3)
    expect(b.retrievalTurnUnits).toBe(0)
    expect(b.avoided).toBe(b.grossAvoided)
    // 102,272.7 / (335,000 + 102,272.7) = 23.39%
    expect(b.totalBillSavedPct).toBe(Math.round((GROSS_AVOIDED / (BILL + GROSS_AVOIDED)) * 1000) / 10)
    expect(b.totalBillSavedPct).toBe(23.4)
  })

  it('subtracts the turns that only fetched elided text, and divides by the counterfactual bill', () => {
    const b = billBreakdown({ ...LEDGER, retrievalTurnUnits: 30_000 }, NET_SAVED)
    const avoided = GROSS_AVOIDED - 30_000 //                           72,272.7 units
    const counterfactual = BILL + avoided //                            407,272.7 units: what it would have cost
    expect(b.grossAvoided).toBeCloseTo(GROSS_AVOIDED, 6)
    expect(b.retrievalTurnUnits).toBe(30_000)
    expect(b.avoided).toBeCloseTo(avoided, 6)
    expect(b.total).toBe(BILL) // the invoice itself is untouched: those turns are already in it
    expect(b.totalBillSavedPct).toBe(Math.round((avoided / counterfactual) * 1000) / 10)
    expect(b.totalBillSavedPct).toBe(17.7) // 72,272.7 / 407,272.7, against 23.4 before the charge
  })

  it('reports a negative when the retrieval turns cost more than the elision saved, never clamped', () => {
    // 10,000 tokens kept off the wire are worth 2,045 units; the turns that fetched text cost 5,000.
    const b = billBreakdown({ ...LEDGER, retrievalTurnUnits: 5_000 }, 10_000)
    const gross = 10_000 * (225_000 / 1_100_000)
    const avoided = gross - 5_000
    expect(b.retrievalTurnUnits).toBeGreaterThan(b.grossAvoided)
    expect(b.avoided).toBeCloseTo(avoided, 6)
    expect(b.avoided).toBeLessThan(0)
    expect(b.totalBillSavedPct).toBe(Math.round((avoided / (BILL + avoided)) * 1000) / 10)
    expect(b.totalBillSavedPct).toBe(-0.9)
  })

  it('goes further negative when the tokens kept off the wire are themselves net negative', () => {
    const b = billBreakdown({ ...LEDGER, retrievalTurnUnits: 5_000 }, -10_000)
    expect(b.avoided).toBeCloseTo(-10_000 * (225_000 / 1_100_000) - 5_000, 6)
    expect(b.totalBillSavedPct).toBeLessThan(-0.9)
  })

  it('is all zeros, never NaN, on an untouched ledger, with or without the field', () => {
    for (const t of [
      { cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0 },
      { cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0, retrievalTurnUnits: 0 },
    ]) {
      const b = billBreakdown(t, 0)
      for (const v of Object.values(b)) expect(Number.isNaN(v)).toBe(false)
      expect(b.avoided).toBe(0)
      expect(b.totalBillSavedPct).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The whole path: proxy results in, the unified receipt out.

type Turn = { toolCalls: number; retrieveCalls: number; pure: boolean }
const PURE: Turn = { toolCalls: 1, retrieveCalls: 1, pure: true }
const MIXED: Turn = { toolCalls: 2, retrieveCalls: 1, pure: false }

function result(read: number, create: number, out: number, trOrig: number, trComp: number, turn?: Turn): ProxyResultMsg {
  return {
    kind: 'result', changed: true, status: 200, stashes: [], turn,
    stats: { trBlocks: 1, trOrigChars: trOrig, trCompChars: trComp, images: 0, imgOrigBytes: 0, imgCompBytes: 0 },
    usage: { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: out },
  } as unknown as ProxyResultMsg
}

describe('the unified receipt', () => {
  beforeEach(() => { resetLedger(); resetProxyLedger(); resetCcr(); resetDepthCurveAll() })

  it('carries the retrieval-turn count and units, session and cumulative apart', () => {
    loadProxyBase({ retrievalTurns: 4, retrievalTurnUnits: 50_000 })
    recordProxyResult(result(100_000, 0, 140, 0, 0, PURE)) //   0.1 x 100,000 + 5 x 140 = 10,700
    recordProxyResult(result(200_000, 0, 60, 0, 0, MIXED)) //   not a retrieval turn
    const r = summarizeUnifiedSavings()
    expect(r.session.retrievalTurns).toBe(1)
    expect(r.session.retrievalTurnUnits).toBeCloseTo(10_700, 6)
    expect(r.cumulative.retrievalTurns).toBe(5)
    expect(r.cumulative.retrievalTurnUnits).toBeCloseTo(60_700, 6)
  })

  // The pane labels its first figure "net of the text fetched back" and its third "net of the text fetched back and of
  // the turns that fetched it", so those are the two bases held here: the share of the text Headroom may touch takes
  // give-back and asked-back off, and the turns, which cost units and not tokens, come off only the bill.
  it('takes the text fetched back off the first denominator figure, and the turns that fetched it off the bill alone', () => {
    const ledger = { textOrigTokens: 200_000, textSavedTokens: 100_000 }
    loadProxyBase({ ...ledger })
    expect(summarizeUnifiedSavings().cumulative.savedPct).toBe(50) // 100,000 removed of 200,000
    resetProxyLedger()
    loadProxyBase({ ...ledger, givebackTokens: 15_000, askedBackTokens: 5_000 })
    let c = summarizeUnifiedSavings().cumulative
    expect(c.grossSavedTokens).toBe(100_000)
    expect(c.netSavedTokens).toBe(80_000) //  100,000 - 15,000 given back - 5,000 asked back
    expect(c.savedPct).toBe(40) //             80,000 of 200,000
    expect(c.retrievalTurnUnits).toBe(0)
    resetProxyLedger()
    // Turns that fetched text cost units: they move the bill, not the share of text.
    loadProxyBase({ ...ledger, givebackTokens: 15_000, askedBackTokens: 5_000, retrievalTurns: 3, retrievalTurnUnits: 60_000 })
    c = summarizeUnifiedSavings().cumulative
    expect(c.savedPct).toBe(40)
    expect(c.bill.avoided).toBeCloseTo(c.bill.grossAvoided - 60_000, 6)
  })

  // The pane's coverage caveat divides one by the other: a ledger from before v1.55 holds responses and no read
  // shapes, and a total that took turnRequests from requests would read as fully netted and never show the caveat.
  it('counts the responses whose turn was read apart from every response, so an upgraded ledger is not read as fully netted', () => {
    loadProxyBase({ requests: 477_099, turnRequests: 0 })
    let u = summarizeUnifiedSavings()
    expect(u.cumulative.requests).toBe(477_099)
    expect(u.cumulative.turnRequests).toBe(0)
    expect(u.session.requests).toBe(0)
    expect(u.session.turnRequests).toBe(0)
    recordProxyResult(result(1_000, 0, 1, 0, 0, MIXED)) // a child that reads the shape of the turn
    recordProxyResult(result(1_000, 0, 1, 0, 0)) //        one that predates it: a response, and not a read one
    u = summarizeUnifiedSavings()
    expect(u.session.requests).toBe(2)
    expect(u.session.turnRequests).toBe(1)
    expect(u.cumulative.requests).toBe(477_101)
    expect(u.cumulative.turnRequests).toBe(1)
  })

  it('prices the headline from the same counters: avoided = kept off the bill - retrieval turns', () => {
    // 800,000 chars in, 200,000 out = 150,000 tokens removed; 10,000 handed back by one retrieve_full.
    recordProxyResult(result(900_000, 90_000, 8_000, 800_000, 200_000)) //    an ordinary request
    recordProxyResult(result(100_000, 10_000, 12_000, 0, 0, PURE)) //         a retrieval turn
    recordProxyGiveback(10_000, { token: 'hr_0000000000000001' })
    const c = summarizeUnifiedSavings().cumulative
    const read = 1_000_000, create = 100_000, out = 20_000
    expect(c.cacheReadTokens).toBe(read)
    expect(c.cacheCreationTokens).toBe(create)
    expect(c.outputTokens).toBe(out)
    expect(c.netSavedTokens).toBe(150_000 - 10_000)
    const turnUnits = 0.1 * 100_000 + 5 * 12_000 //                            70,000
    expect(c.retrievalTurnUnits).toBe(turnUnits)
    const total = 0.1 * read + 1.25 * create + 5 * out //                      335,000
    const weight = (0.1 * read + 1.25 * create) / (read + create) //           9/44
    const gross = 140_000 * weight
    const avoided = gross - turnUnits
    expect(c.bill.total).toBeCloseTo(total, 6)
    expect(c.bill.grossAvoided).toBeCloseTo(gross, 6)
    expect(c.bill.avoided).toBeCloseTo(avoided, 6)
    expect(c.bill.totalBillSavedPct).toBe(Math.round((avoided / (total + avoided)) * 1000) / 10)
  })

  it('reads negative for a ledger whose retrieval turns outweigh what was removed', () => {
    recordProxyResult(result(1_000_000, 0, 1_000, 40_000, 36_000)) //          1,000 tokens removed
    for (let i = 0; i < 3; i++) recordProxyResult(result(500_000, 0, 200, 0, 0, PURE)) // 3 x 51,000 units
    const c = summarizeUnifiedSavings().cumulative
    expect(c.retrievalTurnUnits).toBe(3 * (0.1 * 500_000 + 5 * 200))
    expect(c.bill.avoided).toBeLessThan(0)
    expect(c.bill.totalBillSavedPct).toBeLessThan(0)
  })

  it('shows no retrieval charge for a ledger that never saw a pure retrieval turn', () => {
    recordProxyResult(result(900_000, 90_000, 8_000, 800_000, 200_000, MIXED))
    const c = summarizeUnifiedSavings().cumulative
    expect(c.retrievalTurns).toBe(0)
    expect(c.bill.retrievalTurnUnits).toBe(0)
    expect(c.bill.avoided).toBe(c.bill.grossAvoided)
  })
})
