import { describe, it, expect, beforeEach } from 'vitest'
const { summarizeUnifiedSavings } = await import('../../src/main/headroom/unifiedReceipt')
import { recordEvent, resetLedger, loadCumulativeBase } from '../../src/main/headroom/savingsLedger'
import { resetProxyLedger, loadProxyBase, recordProxyGiveback, recordProxyResult } from '../../src/main/headroomProxy/proxyLedger'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'

const proxyResult = (origChars: number, compChars: number): ProxyResultMsg =>
  ({ stats: { trOrigChars: origChars, trCompChars: compChars, trBlocks: 1, images: 0, imgOrigBytes: 0, imgCompBytes: 0 } } as unknown as ProxyResultMsg)

/**
 * One number, honestly computed, across BOTH compression surfaces. Before v1.34.0 the Settings
 * receipt showed the tool ledger alone — reading -4,600,801 — while the proxy ledger beside it
 * had actually saved 450,150,158. Same app, same session, two ledgers, no view that summed them.
 */
describe('unified savings receipt', () => {
  beforeEach(() => { resetLedger(); resetProxyLedger() })

  it('sums both layers into one gross figure', () => {
    recordProxyResult(proxyResult(4000, 1000))        // 1000 orig tokens, 750 saved
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 250, origTokens: 400 })
    const s = summarizeUnifiedSavings().session
    expect(s.wireOrigTokens).toBe(1000)
    expect(s.wireSavedTokens).toBe(750)
    expect(s.toolOrigTokens).toBe(400)
    expect(s.toolSavedTokens).toBe(250)
    expect(s.grossSavedTokens).toBe(1000)
  })

  it('subtracts each give-back EXACTLY ONCE, whichever layer issued the token', () => {
    recordProxyResult(proxyResult(4000, 1000))
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 250, origTokens: 400 })
    recordProxyGiveback(300)                                                  // proxy-issued token
    recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -100 }) // tool-issued token
    const s = summarizeUnifiedSavings().session
    expect(s.retrieves).toBe(2)
    expect(s.givebackTokens).toBe(400)
    expect(s.grossSavedTokens).toBe(1000)
    expect(s.netSavedTokens).toBe(600)
  })

  it('states savedPct against the true combined denominator', () => {
    recordProxyResult(proxyResult(4000, 2000))  // 1000 orig, 500 saved
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 100, origTokens: 1000 })
    const s = summarizeUnifiedSavings().session
    expect(s.savedPct).toBe(30) // 600 / 2000
  })

  it('reports 0% rather than NaN when nothing has been compressed yet', () => {
    const s = summarizeUnifiedSavings().session
    expect(s.savedPct).toBe(0)
    expect(s.netSavedTokens).toBe(0)
    expect(Number.isFinite(s.savedPct)).toBe(true)
  })

  it('can read net-negative honestly rather than hiding it', () => {
    // If reversals really do exceed savings, the receipt must say so — that is the whole point of
    // fixing the attribution rather than clamping the number at zero.
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 10, origTokens: 100 })
    recordProxyGiveback(500)
    expect(summarizeUnifiedSavings().session.netSavedTokens).toBe(-490)
  })

  it('carries the on-disk baseline into cumulative while session stays session', () => {
    loadProxyBase({ requests: 62_716, textOrigTokens: 894_908_529, textSavedTokens: 450_150_158, outputTokens: 77_852_303 })
    // Verbatim the shape found in the real headroom-totals.json on disk.
    loadCumulativeBase({ netSaved: -4_600_801, events: 2425, byTool: { retrieve_full: -4_600_801 } })
    const r = summarizeUnifiedSavings()
    expect(r.session.grossSavedTokens).toBe(0)
    expect(r.cumulative.grossSavedTokens).toBe(450_150_158)
    expect(r.cumulative.givebackTokens).toBe(4_600_801)
    expect(r.cumulative.netSavedTokens).toBe(445_549_357)
    expect(r.cumulative.savedPct).toBe(50) // the honest headline, replacing "-4,600,801"
  })

  it('passes observed usage through so the pane can show where spend actually is', () => {
    loadProxyBase({ cacheReadTokens: 4_293_489_065, cacheCreationTokens: 161_580_040, inputTokens: 2_243_305, outputTokens: 77_852_303 })
    const c = summarizeUnifiedSavings().cumulative
    expect(c.cacheReadTokens).toBe(4_293_489_065)
    expect(c.outputTokens).toBe(77_852_303)
  })

  it('copies byTool rather than aliasing the live ledger', () => {
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 250, origTokens: 400 })
    const s = summarizeUnifiedSavings().session
    s.byTool.code_search = 99999
    expect(summarizeUnifiedSavings().session.byTool.code_search).toBe(250)
  })
})

/**
 * The wire has two compressible surfaces, and until v1.34.0 the unified headline counted only
 * one of them. Reporting tool_result alone was accurate about a slice while implying it described
 * the wire — the same category of error the unified receipt was built to end.
 */
describe('unified receipt — both wire surfaces', () => {
  beforeEach(() => { resetLedger(); resetProxyLedger() })

  const bothSurfaces = (trOrig: number, trComp: number, tuOrig: number, tuComp: number): ProxyResultMsg =>
    ({ stats: { trOrigChars: trOrig, trCompChars: trComp, trBlocks: 1, tuOrigChars: tuOrig, tuCompChars: tuComp, tuBlocks: 1, images: 0, imgOrigBytes: 0, imgCompBytes: 0 } } as unknown as ProxyResultMsg)

  it('counts tool_use savings in the headline, not just tool_result', () => {
    recordProxyResult(bothSurfaces(4000, 1000, 8000, 2000)) // 1000+2000 orig tokens, 750+1500 saved
    const { cumulative } = summarizeUnifiedSavings()
    expect(cumulative.wireOrigTokens).toBe(3000)
    expect(cumulative.wireSavedTokens).toBe(2250)
    expect(cumulative.netSavedTokens).toBe(2250)
    expect(cumulative.savedPct).toBe(75)
  })

  it('breaks the tool_use half out so the dashboard can show which surface earned what', () => {
    recordProxyResult(bothSurfaces(4000, 1000, 8000, 2000))
    const { cumulative } = summarizeUnifiedSavings()
    expect(cumulative.toolUseOrigTokens).toBe(2000)
    expect(cumulative.toolUseSavedTokens).toBe(1500)
  })

  it('carries the per-request floor evidence through to the receipt', () => {
    loadProxyBase({ worstSavedPct: 37, belowFloorRequests: 12, floorEligibleRequests: 400 })
    const { cumulative } = summarizeUnifiedSavings()
    expect(cumulative.worstSavedPct).toBe(37)
    expect(cumulative.belowFloorRequests).toBe(12)
    expect(cumulative.floorEligibleRequests).toBe(400)
  })

  it('still subtracts a give-back exactly once when both surfaces contributed', () => {
    recordProxyResult(bothSurfaces(4000, 1000, 8000, 2000)) // 2250 saved
    recordProxyGiveback(250)
    const { cumulative } = summarizeUnifiedSavings()
    expect(cumulative.grossSavedTokens).toBe(2250)
    expect(cumulative.netSavedTokens).toBe(2000)
    expect(cumulative.retrieves).toBe(1)
  })
})
