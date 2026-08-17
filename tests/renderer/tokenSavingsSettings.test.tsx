// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'
import { billBreakdown } from '../../src/main/headroom/effectiveUnits'

const proxyTotals = (over: Record<string, number> = {}) => ({
  requests: 40, textOrigTokens: 200000, textSavedTokens: 100000, savedPct: 50,
  images: 3, imageOrigBytes: 0, imageSavedBytes: 0,
  cacheReadTokens: 900000, cacheCreationTokens: 20000, inputTokens: 500, outputTokens: 8000, retrieves: 0, givebackTokens: 0, ...over,
})

const unifiedTotals = (over: Record<string, number> = {}) => {
  const t = {
    requests: 40, wireOrigTokens: 200000, wireSavedTokens: 100000,
    images: 3, imageOrigBytes: 0, imageSavedBytes: 0,
    toolOrigTokens: 0, toolSavedTokens: 0, toolEvents: 0, byTool: {},
    retrieves: 0, givebackTokens: 0, grossSavedTokens: 100000, netSavedTokens: 100000, savedPct: 50,
    cacheReadTokens: 900000, cacheCreationTokens: 20000, inputTokens: 500, outputTokens: 8000,
    retrieveMisses: 0,
    sysTokensPerRequest: 0, toolsTokensPerRequest: 0, tpToolsTokensPerRequest: 0, toolCount: 0,
    steeredRequests: 0, unsteeredRequests: 0, steeredAvgOutput: 0, unsteeredAvgOutput: 0,
    ...over,
  }
  // Derived, not hand-written: an override that moves a token counter has to move the bill too,
  // or the fixture would assert against a breakdown the counters never could have produced.
  return { ...t, bill: billBreakdown(t, t.netSavedTokens) }
}

beforeEach(() => {
  ;(window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis = {
    tokenSavingsGetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, mode: 'balanced', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: false } }),
    tokenSavingsSetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: false, mode: 'balanced', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: false } }),
    tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 12345, events: 3, byTool: {} }, cumulative: { netSaved: 99999, events: 40, byTool: {} } } }),
    tokenSavingsGetProxyReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: proxyTotals({ savedPct: 50, textSavedTokens: 100000 }), cumulative: proxyTotals({ savedPct: 47, textSavedTokens: 2500000 }) } }),
    tokenSavingsGetUnifiedReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: unifiedTotals({ netSavedTokens: 100000 }), cumulative: unifiedTotals({ netSavedTokens: 2400000, grossSavedTokens: 2500000, givebackTokens: 100000, retrieves: 12, savedPct: 47 }) } }),
  }
})

describe('TokenSavingsSettings', () => {
  it('shows the always-on Claude proxy compression headline (% saved + tokens + cache health)', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-proxy-session-pct')).toHaveTextContent('50%'))
    expect(screen.getByTestId('hr-proxy-cumulative-pct')).toHaveTextContent('47%')
    expect(screen.getByTestId('hr-proxy-cumulative-saved')).toHaveTextContent('2,500,000')
    expect(screen.getByTestId('hr-proxy-cache-health')).toHaveTextContent('healthy')
  })

  it('scopes the headline % to tool output and shows the honest share of TOTAL input', async () => {
    render(<TokenSavingsSettings />)
    // The big % is explicitly captioned as tool-output shrink, NOT total spend.
    await waitFor(() => expect(screen.getByTestId('hr-proxy-session-pct')).toHaveTextContent('50%'))
    expect(screen.getByTestId('hr-proxy-session-pct').parentElement).toHaveTextContent('of compressible wire text · this session')
    // Honest denominator: session textSaved 100000 over ingested (500 + 900000 + 20000 + 100000) ≈ 10%;
    // cumulative textSaved 2500000 over (500 + 900000 + 20000 + 2500000) ≈ 73%. Far below the 50% headline.
    const share = screen.getByTestId('hr-proxy-share-total')
    expect(share).toHaveTextContent('≈10% of all input tokens you sent this session')
    expect(share).toHaveTextContent('≈73% all-time')
  })

  it('hides the share-of-total line until real usage is captured (no bogus 100%)', async () => {
    ;(window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis.tokenSavingsGetProxyReceipt =
      vi.fn().mockResolvedValue({
        success: true,
        data: {
          session: proxyTotals({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
          cumulative: proxyTotals({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
        },
      })
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-proxy-session-pct')).toBeTruthy())
    expect(screen.queryByTestId('hr-proxy-share-total')).toBeNull()
  })

  it('still renders the tool-output receipt and toggle', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-session-saved')).toHaveTextContent('12,345'))
    expect(screen.getByTestId('hr-cumulative-saved')).toHaveTextContent('99,999')
  })

  it('toggling tool-output compression calls setSettings with the inverse', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => screen.getByTestId('hr-toggle-enabled'))
    fireEvent.click(screen.getByTestId('hr-toggle-enabled'))
    await waitFor(() => expect(
      (window as unknown as { termpolis: { tokenSavingsSetSettings: ReturnType<typeof vi.fn> } }).termpolis.tokenSavingsSetSettings,
    ).toHaveBeenCalledWith({ enabled: false }))
  })

  it('gives the aggressiveness select an explicit dark bg + light text (readable contrast, not grey-on-white)', async () => {
    render(<TokenSavingsSettings />)
    const sel = await screen.findByTestId('hr-mode')
    // An unstyled native select inherited light-grey text on the OS-default light background.
    expect(sel.className).toContain('bg-[#2d2d2d]')
    expect(sel.className).toContain('text-[#d4d4d4]')
    // Options carry the dark bg too so the OPEN dropdown list stays legible on Electron/Windows.
    sel.querySelectorAll('option').forEach((o) => expect(o.className).toContain('bg-[#2d2d2d]'))
  })
})

/**
 * The receipt's job is to be believed, which means it has to be checkable. A single percentage —
 * whichever one flatters most — is what turned this dashboard into a claim rather than a
 * measurement. These tests pin the three denominators, the per-surface split, and the per-request
 * floor evidence, because each one is a different way for the headline to be quietly wrong.
 */
describe('TokenSavingsSettings — honest reporting', () => {
  const withData = (proxyOver: Record<string, number> = {}, unifiedOver: Record<string, number> = {}) => {
    const api = (window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis
    api.tokenSavingsGetProxyReceipt = vi.fn().mockResolvedValue({
      success: true,
      data: { session: proxyTotals(proxyOver), cumulative: proxyTotals(proxyOver) },
    })
    api.tokenSavingsGetUnifiedReceipt = vi.fn().mockResolvedValue({
      success: true,
      data: { session: unifiedTotals(unifiedOver), cumulative: unifiedTotals(unifiedOver) },
    })
  }

  it('states all three denominators, not just the flattering one', async () => {
    withData()
    render(<TokenSavingsSettings />)
    const d = await screen.findByTestId('hr-denominators')
    expect(d).toHaveTextContent('50%') // of compressible text
    // Each number is captioned with what it is a fraction OF, so none of them can be read as "my
    // bill dropped by half".
    expect(d).toHaveTextContent('of every input token you sent')
    expect(d).toHaveTextContent('of what the conversation actually cost')
  })

  it('reports the effective-cost share as the SMALLEST of the three', async () => {
    // Headroom removes tokens from the input side, and most input arrives as cache reads billed at
    // a tenth of rate. If this figure ever came out largest, the weighting would be inverted.
    withData()
    render(<TokenSavingsSettings />)
    const cost = Number((await screen.findByTestId('hr-denom-cost')).textContent!.replace('%', ''))
    const wire = Number(screen.getByTestId('hr-denom-wire').textContent!.replace('%', ''))
    const input = Number(screen.getByTestId('hr-denom-input').textContent!.replace('%', ''))
    expect(cost).toBeLessThanOrEqual(input)
    expect(input).toBeLessThanOrEqual(wire)
  })

  it('shows the worst single request, not just the average', async () => {
    withData({}, { worstSavedPct: 18, belowFloorRequests: 7, floorEligibleRequests: 400 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-floor-worst')).toHaveTextContent('18%')
    expect(screen.getByTestId('hr-floor-below')).toHaveTextContent('7')
    expect(screen.getByTestId('hr-floor-evidence')).toHaveTextContent('of 400 substantial requests')
  })

  it('states the prefix it cannot reach, and how much of it is our own', async () => {
    withData({}, { sysTokensPerRequest: 3100, toolsTokensPerRequest: 9400, tpToolsTokensPerRequest: 2200, toolCount: 38 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-prefix-head')).toHaveTextContent('3,100 tokens of system prompt')
    expect(screen.getByTestId('hr-prefix-tp')).toHaveTextContent('2,200')
  })

  it('stays silent about the prefix head until a request has actually been measured', async () => {
    withData({}, {})
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-denominators')
    expect(screen.queryByTestId('hr-prefix-head')).toBeNull()
  })

  it('reports steering as two observed means rather than a saving', async () => {
    withData({}, { steeredRequests: 900, unsteeredRequests: 120, steeredAvgOutput: 640, unsteeredAvgOutput: 1180 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-steer-on')).toHaveTextContent('640')
    expect(screen.getByTestId('hr-steer-off')).toHaveTextContent('1,180')
    expect(screen.getByTestId('hr-steering-observed')).toHaveTextContent('not a controlled comparison')
  })

  it('will not compare steering against an arm with no requests in it', async () => {
    withData({}, { steeredRequests: 900, unsteeredRequests: 0, steeredAvgOutput: 640 })
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-denominators')
    expect(screen.queryByTestId('hr-steering-observed')).toBeNull()
  })

  it('raises an alarm when a retrieve_full found nothing', async () => {
    withData({}, { retrieveMisses: 3 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-retrieve-misses')).toHaveTextContent('3 retrieve_full calls found nothing')
  })

  it('says nothing about retrieval when every token resolved', async () => {
    withData({}, {})
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-denominators')
    expect(screen.queryByTestId('hr-retrieve-misses')).toBeNull()
  })

  it('hides the floor evidence entirely rather than claiming a perfect 100% on no data', async () => {
    withData({}, { floorEligibleRequests: 0 })
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-denominators')
    expect(screen.queryByTestId('hr-floor-evidence')).toBeNull()
  })

  it('breaks the two wire surfaces apart so neither can hide behind the other', async () => {
    withData({ textOrigTokens: 200000, textSavedTokens: 100000, toolUseOrigTokens: 80000, toolUseSavedTokens: 60000 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-surface-tr')).toHaveTextContent('100,000')
    expect(screen.getByTestId('hr-surface-tu')).toHaveTextContent('60,000')
  })

  it('offers the max tier the floor controller escalates into', async () => {
    render(<TokenSavingsSettings />)
    const sel = await screen.findByTestId('hr-mode')
    expect([...sel.querySelectorAll('option')].map((o) => o.getAttribute('value')))
      .toEqual(['conservative', 'balanced', 'aggressive', 'max'])
  })

  it('exposes floor control ON and prefix decay OFF, and can toggle each', async () => {
    render(<TokenSavingsSettings />)
    const floor = await screen.findByTestId('hr-toggle-floor') as HTMLInputElement
    const decay = screen.getByTestId('hr-toggle-decay') as HTMLInputElement
    expect(floor.checked).toBe(true)
    // Driven by the mocked settings above, not by the shipped default — which is ON as of
    // v1.36.0. What is pinned here is that the box mirrors settings and sends the inverse.
    expect(decay.checked).toBe(false)
    fireEvent.click(decay)
    await waitFor(() => expect(
      (window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis.tokenSavingsSetSettings,
    ).toHaveBeenCalledWith({ prefixDecay: true }))
  })
})

/**
 * Session depth is the one figure on this receipt that is about the conversation rather than
 * about the bytes, so it has to be legible on its own terms: what a turn costs now, what the
 * same user shallow sessions cost, and the caveat that makes the comparison honest.
 */
describe('TokenSavingsSettings - session depth advisory', () => {
  const withDepth = (depth: unknown) => {
    const api = (window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis
    api.tokenSavingsGetUnifiedReceipt = vi.fn().mockResolvedValue({
      success: true,
      data: { session: unifiedTotals(), cumulative: unifiedTotals(), depth },
    })
  }

  it('prices the turn at both depths and keeps the caveat next to the number', async () => {
    withDepth({ messages: 412, bandIndex: 6, unitsPerTurnNow: 41375, unitsPerTurnFresh: 19200, savingPerTurn: 22175, savingPct: 54, requestsNow: 900, requestsFresh: 120 })
    render(<TokenSavingsSettings />)
    const el = await screen.findByTestId('hr-session-depth')
    expect(el).toHaveTextContent('412 messages deep')
    expect(screen.getByTestId('hr-depth-now')).toHaveTextContent('41,375')
    expect(screen.getByTestId('hr-depth-fresh')).toHaveTextContent('19,200')
    expect(screen.getByTestId('hr-depth-pct')).toHaveTextContent('54')
    expect(el).toHaveTextContent('22,175')
    // The write is inside the fresh figure - without that line the number reads as free money.
    expect(el).toHaveTextContent('already includes the cost of writing a new prefix')
    expect(el).toHaveTextContent('not a controlled comparison')
  })


  it('shows nothing at all rather than a placeholder when the curve cannot support advice', async () => {
    withDepth(null)
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByTestId('hr-proxy-session-pct')).toBeTruthy())
    expect(screen.queryByTestId('hr-session-depth')).toBeNull()
  })
})

