import { describe, it, expect, beforeEach } from 'vitest'
const { recordProxyResult, summarizeProxySavings, loadProxyBase, resetProxyLedger, FLOOR_PCT } =
  await import('../../src/main/headroomProxy/proxyLedger')

/**
 * A lifetime AVERAGE cannot settle whether a per-request FLOOR holds — roughly half the mass of
 * any distribution sits below its own mean. Until v1.34.0 the only thing on disk was cumulative
 * totals, which made "50% savings at all times" not merely unproven but unmeasurable. These
 * counters exist so the claim can be falsified by the app itself.
 */

/** One request: `orig` chars of compressible text, `comp` chars after. */
function request(orig: number, comp: number, tuOrig = 0, tuComp = 0) {
  return {
    kind: 'result' as const,
    changed: true,
    stats: { trBlocks: 1, trOrigChars: orig, trCompChars: comp, tuBlocks: tuOrig > 0 ? 1 : 0, tuOrigChars: tuOrig, tuCompChars: tuComp, images: 0, imgOrigBytes: 0, imgCompBytes: 0 },
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    stashes: [],
  }
}

describe('per-request floor evidence', () => {
  beforeEach(() => resetProxyLedger())

  it('starts at 100% worst-case so a fresh ledger never reports a breach it never saw', () => {
    const { cumulative } = summarizeProxySavings()
    expect(cumulative.worstSavedPct).toBe(100)
    expect(cumulative.belowFloorRequests).toBe(0)
    expect(cumulative.floorEligibleRequests).toBe(0)
  })

  it('counts a request that missed the floor, and remembers how badly', () => {
    recordProxyResult(request(40000, 32000)) // 20% saved
    const { session } = summarizeProxySavings()
    expect(session.floorEligibleRequests).toBe(1)
    expect(session.belowFloorRequests).toBe(1)
    expect(session.worstSavedPct).toBe(20)
  })

  it('does not count a request that comfortably cleared the floor', () => {
    recordProxyResult(request(40000, 8000)) // 80% saved
    const { session } = summarizeProxySavings()
    expect(session.floorEligibleRequests).toBe(1)
    expect(session.belowFloorRequests).toBe(0)
    expect(session.worstSavedPct).toBe(80)
  })

  it('ratchets the worst case DOWN only — a later good request cannot erase a bad one', () => {
    recordProxyResult(request(40000, 32000)) // 20%
    recordProxyResult(request(40000, 4000)) // 90%
    expect(summarizeProxySavings().session.worstSavedPct).toBe(20)
  })

  it('excludes requests with too little text to reach the floor at all', () => {
    // A turn whose entire payload is one 200-char tool result is not a compression failure; it is
    // a turn with nothing to compress. Counting it would smear the evidence without informing it.
    recordProxyResult(request(400, 400))
    const { session } = summarizeProxySavings()
    expect(session.floorEligibleRequests).toBe(0)
    expect(session.belowFloorRequests).toBe(0)
    expect(session.worstSavedPct).toBe(100)
  })

  it('judges a request on BOTH wire surfaces together, not tool_result alone', () => {
    // tool_result alone would read 0% here; with the tool_use half included it clears the floor.
    // Splitting the denominator per surface would let either one alone trigger a false breach.
    recordProxyResult(request(20000, 20000, 20000, 0))
    const { session } = summarizeProxySavings()
    expect(session.worstSavedPct).toBe(50)
    expect(session.belowFloorRequests).toBe(0)
  })

  it('takes the MINIMUM of disk and session worst-case, never the sum', () => {
    // These are floors, not quantities. Summing two 100s would report a 200% worst case, and the
    // controller reading it would conclude everything was fine forever.
    loadProxyBase({ worstSavedPct: 31, floorEligibleRequests: 900, belowFloorRequests: 40 })
    recordProxyResult(request(40000, 4000)) // 90% this session
    const { cumulative } = summarizeProxySavings()
    expect(cumulative.worstSavedPct).toBe(31)
    expect(cumulative.floorEligibleRequests).toBe(901)
  })

  it('carries the floor forward from an OLD on-disk ledger that predates these fields', () => {
    // v1.33 wrote proxy-totals.json without them. Defaulting the worst case to 0 would make every
    // upgraded install look like it had catastrophically breached the floor on day one.
    loadProxyBase({ requests: 62716, textOrigTokens: 894908529, textSavedTokens: 450150158 })
    const { cumulative } = summarizeProxySavings()
    expect(cumulative.worstSavedPct).toBe(100)
    expect(cumulative.floorEligibleRequests).toBe(0)
    expect(cumulative.toolUseOrigTokens).toBe(0)
    expect(cumulative.savedPct).toBe(50) // the historical figure survives the schema change
  })

  it('exports the floor as a shared constant so the meter and the controller cannot drift apart', () => {
    expect(FLOOR_PCT).toBe(50)
  })
})
