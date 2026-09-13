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

  it('raises an alarm when content this app had cached was destroyed', async () => {
    withData({}, { retrieveMisses: 3 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-retrieve-misses')).toHaveTextContent(
      '3 retrieve_full calls asked for content this app had cached and then dropped'
    )
  })

  it('does NOT raise the alarm for a handle it has no record of issuing', async () => {
    // The reported defect. Tokens are content hashes, so a typo of a live token is the same shape
    // as the real one; reading shape as proof of issuance put "should never happen" in front of
    // four calls that had destroyed nothing. These belong in the quiet line, alarm dark.
    withData({}, { retrieveUnknownTokens: 4, retrieveBadTokens: 1 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-retrieve-bad-tokens')).toHaveTextContent(
      '5 retrieve_full calls used a handle this app has no record of issuing'
    )
    expect(screen.queryByTestId('hr-retrieve-misses')).toBeNull()
  })

  it('raises the alarm on a destroyed record even before anyone asks for it back', async () => {
    // An unbacked eviction is the same broken promise caught a step earlier: the store dropped the
    // only copy. Waiting for a retrieve_full to fail would report the loss only if someone happened
    // to ask, which is the difference between a measurement and a coincidence.
    withData({}, { unbackedEvictions: 2 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-unbacked-evictions')).toHaveTextContent(
      '2 cached originals were dropped this session with no copy on disk behind them'
    )
  })

  it('reports content the cache aged out as gone, without telling anyone to report it', async () => {
    // A bounded cache doing its job is not a defect. Wording this like the loss alarm would send
    // the user to file a bug about the 200 MB limit working exactly as specified.
    withData({}, { retrieveExpired: 3 })
    render(<TokenSavingsSettings />)
    const el = await screen.findByTestId('hr-retrieve-expired')
    expect(el).toHaveTextContent('3 retrieve_full calls asked for content the cache had already aged out')
    expect(el.textContent).not.toMatch(/[Rr]eport this/)
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

// ===========================================================================
// The write path: every control on this pane, and what it actually sends.
// ===========================================================================

type Api = Record<string, ReturnType<typeof vi.fn>>
const tpApi = (): Api => (window as unknown as { termpolis: Api }).termpolis

const BASE_SETTINGS = {
  enabled: true, mode: 'balanced' as const, steering: true,
  thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: false,
}

/**
 * The real handler merges the patch into the stored settings and hands the whole record back, so
 * the pane re-renders from what was actually persisted. The default mock at the top of this file
 * resolves to a FIXED object instead, which cannot tell "the box mirrors the write" from "the box
 * mirrors a constant" — and it would mask the failure mode that matters here, a control sending a
 * whole-settings overwrite that silently reverts its neighbours. So these tests write against a
 * store that really applies the patch.
 */
const echoSettings = (): void => {
  let current: Record<string, unknown> = { ...BASE_SETTINGS }
  tpApi().tokenSavingsGetSettings = vi.fn().mockResolvedValue({ success: true, data: { ...current } })
  tpApi().tokenSavingsSetSettings = vi.fn(async (patch: Record<string, unknown>) => {
    current = { ...current, ...patch }
    return { success: true, data: { ...current } }
  })
}

const lastPatch = (): Record<string, unknown> => {
  const calls = tpApi().tokenSavingsSetSettings.mock.calls
  return calls[calls.length - 1][0] as Record<string, unknown>
}

describe('TokenSavingsSettings — what each control writes', () => {
  it('sends only the changed tier, and shows the tier that came back', async () => {
    echoSettings()
    render(<TokenSavingsSettings />)
    const sel = (await screen.findByTestId('hr-mode')) as HTMLSelectElement
    expect(sel.value).toBe('balanced')

    fireEvent.change(sel, { target: { value: 'aggressive' } })

    await waitFor(() => expect(tpApi().tokenSavingsSetSettings).toHaveBeenCalled())
    // A partial patch, not the whole record: main merges, so sending the rest would race any
    // change the floor controller made since this pane last read the store.
    expect(lastPatch()).toEqual({ mode: 'aggressive' })
    await waitFor(() => expect((screen.getByTestId('hr-mode') as HTMLSelectElement).value).toBe('aggressive'))
  })

  it('sends the inverse of the floor box without disturbing the other toggles', async () => {
    echoSettings()
    render(<TokenSavingsSettings />)
    const floor = (await screen.findByTestId('hr-toggle-floor')) as HTMLInputElement
    expect(floor.checked).toBe(true)

    fireEvent.click(floor)

    await waitFor(() => expect(tpApi().tokenSavingsSetSettings).toHaveBeenCalledWith({ floorControl: false }))
    await waitFor(() => expect((screen.getByTestId('hr-toggle-floor') as HTMLInputElement).checked).toBe(false))
    // The neighbours are read back from the SAME response — a control that shipped the whole
    // settings object would have reset these to its own stale copy.
    expect((screen.getByTestId('hr-toggle-enabled') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('hr-toggle-steering') as HTMLInputElement).checked).toBe(true)
  })

  it('turning steering off greys out the adaptive-strength box that depends on it', async () => {
    echoSettings()
    render(<TokenSavingsSettings />)
    const steering = (await screen.findByTestId('hr-toggle-steering')) as HTMLInputElement
    expect((screen.getByTestId('hr-toggle-adaptive') as HTMLInputElement).disabled).toBe(false)

    fireEvent.click(steering)

    await waitFor(() => expect(tpApi().tokenSavingsSetSettings).toHaveBeenCalledWith({ steering: false }))
    // Adapting the strength of steering that is off is not a setting, it is a contradiction.
    await waitFor(() => expect((screen.getByTestId('hr-toggle-adaptive') as HTMLInputElement).disabled).toBe(true))
    expect((screen.getByTestId('hr-toggle-steering') as HTMLInputElement).checked).toBe(false)
  })

  it('sends the inverse of the adaptive-steering box while steering is on', async () => {
    echoSettings()
    render(<TokenSavingsSettings />)
    const adaptive = (await screen.findByTestId('hr-toggle-adaptive')) as HTMLInputElement
    expect(adaptive.checked).toBe(true)

    fireEvent.click(adaptive)

    await waitFor(() => expect(tpApi().tokenSavingsSetSettings).toHaveBeenCalledWith({ adaptiveSteering: false }))
    await waitFor(() => expect((screen.getByTestId('hr-toggle-adaptive') as HTMLInputElement).checked).toBe(false))
  })

  it('sends the thinking cap as a NUMBER, not the string the select hands over', async () => {
    echoSettings()
    render(<TokenSavingsSettings />)
    const cap = (await screen.findByTestId('hr-thinking-cap')) as HTMLSelectElement
    expect(cap.value).toBe('0') // 0 = off, the shipped default

    fireEvent.change(cap, { target: { value: '8000' } })

    await waitFor(() => expect(tpApi().tokenSavingsSetSettings).toHaveBeenCalled())
    // The wire clamp compares this against Anthropic's 1024 floor. A string '8000' would sort
    // wrong there and serialise into the request body as a string, so the conversion is the
    // whole job of this handler.
    expect(lastPatch()).toEqual({ thinkingCap: 8000 })
    expect(typeof lastPatch().thinkingCap).toBe('number')
    await waitFor(() => expect((screen.getByTestId('hr-thinking-cap') as HTMLSelectElement).value).toBe('8000'))
  })

  it('offers off plus four ceilings, none of them under Anthropic own 1024 floor', async () => {
    echoSettings()
    render(<TokenSavingsSettings />)
    const cap = (await screen.findByTestId('hr-thinking-cap')) as HTMLSelectElement
    const values = [...cap.querySelectorAll('option')].map((o) => Number(o.getAttribute('value')))
    expect(values).toEqual([0, 16000, 8000, 4000, 2000])
    // Anything between 1 and 1023 would be silently raised by the wire clamp, so listing it
    // would promise a budget the proxy never applies.
    expect(values.filter((v) => v > 0 && v < 1024)).toEqual([])
  })
})

// ===========================================================================
// Receipts from a main process older than one of the counters.
//
// Every figure on this pane arrives over IPC from a main process that may predate the counter
// being rendered — an app updated while a receipt was already on disk is the ordinary case, not
// a hypothetical. The `?? 0` arms are the whole of what stands between that and a dashboard
// reading "undefined tokens" or "NaN%", so they are asserted on rendered text.
// ===========================================================================

/** Spread into a fixture to OMIT a counter rather than zero it: `undefined` is what an older
 *  main process sends, and it is the only input that reaches the fallback arms at all. */
const partial = (over: Record<string, unknown>): Record<string, number> => over as Record<string, number>

const withReceipts = (o: {
  proxySession?: Record<string, unknown>
  proxyCumulative?: Record<string, unknown>
  unifiedSession?: Record<string, unknown>
  unifiedCumulative?: Record<string, unknown>
}): void => {
  tpApi().tokenSavingsGetProxyReceipt = vi.fn().mockResolvedValue({
    success: true,
    data: {
      session: proxyTotals(partial(o.proxySession ?? {})),
      cumulative: proxyTotals(partial(o.proxyCumulative ?? {})),
    },
  })
  tpApi().tokenSavingsGetUnifiedReceipt = vi.fn().mockResolvedValue({
    success: true,
    data: {
      session: unifiedTotals(partial(o.unifiedSession ?? {})),
      cumulative: unifiedTotals(partial(o.unifiedCumulative ?? {})),
    },
  })
}

describe('TokenSavingsSettings — counters an older receipt never wrote', () => {
  it('renders the floor evidence with zeros when the per-request columns are missing', async () => {
    withReceipts({ unifiedCumulative: { floorEligibleRequests: 400 } }) // worst/below never written
    render(<TokenSavingsSettings />)

    const ev = await screen.findByTestId('hr-floor-evidence')
    expect(screen.getByTestId('hr-floor-worst')).toHaveTextContent('0%')
    expect(screen.getByTestId('hr-floor-below')).toHaveTextContent('0')
    expect(ev).toHaveTextContent('of 400 substantial requests')
    expect(ev.textContent).not.toMatch(/undefined|NaN/)
  })

  it('renders the untouched-prefix line with zeros for the fields an older receipt omits', async () => {
    withReceipts({
      unifiedCumulative: {
        toolsTokensPerRequest: 9400,
        sysTokensPerRequest: undefined,
        tpToolsTokensPerRequest: undefined,
        toolCount: undefined,
      },
    })
    render(<TokenSavingsSettings />)

    const head = await screen.findByTestId('hr-prefix-head')
    expect(head).toHaveTextContent('about 0 tokens of system prompt')
    expect(head).toHaveTextContent('9,400 tokens of tool schemas')
    expect(head).toHaveTextContent('0 tools')
    expect(screen.getByTestId('hr-prefix-tp')).toHaveTextContent('0')
    expect(head.textContent).not.toMatch(/undefined|NaN/)
  })

  it('renders both steering means as 0 when the averages are missing but the arms are not', async () => {
    withReceipts({
      unifiedCumulative: {
        steeredRequests: 900, unsteeredRequests: 120,
        steeredAvgOutput: undefined, unsteeredAvgOutput: undefined,
      },
    })
    render(<TokenSavingsSettings />)

    expect(await screen.findByTestId('hr-steer-on')).toHaveTextContent('0')
    expect(screen.getByTestId('hr-steer-off')).toHaveTextContent('0')
    const obs = screen.getByTestId('hr-steering-observed')
    expect(obs).toHaveTextContent('across 900')
    expect(obs).toHaveTextContent('across 120')
    expect(obs.textContent).not.toMatch(/undefined|NaN/)
  })

  it('says "call", singular, for exactly one destroyed retrieve, and 0 for a session that never counted', async () => {
    // One lost original is the whole point of this alarm — it must not read "1 ... calls asked".
    withReceipts({ unifiedCumulative: { retrieveMisses: 1 }, unifiedSession: { retrieveMisses: undefined } })
    render(<TokenSavingsSettings />)

    const el = await screen.findByTestId('hr-retrieve-misses')
    expect(el).toHaveTextContent('1 retrieve_full call asked for content this app had cached and then dropped')
    expect(el.textContent).not.toMatch(/\bcalls\b/)
    expect(el).toHaveTextContent('(0 this session)')
  })

  it('says "original was", singular, for exactly one unbacked eviction', async () => {
    withReceipts({ unifiedSession: { unbackedEvictions: 1 } })
    render(<TokenSavingsSettings />)

    const el = await screen.findByTestId('hr-unbacked-evictions')
    expect(el).toHaveTextContent('1 cached original was dropped this session with no copy on disk behind them')
    expect(el.textContent).not.toMatch(/originals were/)
  })

  it('says "call asked", singular, for one expired retrieve — and still does not tell anyone to report it', async () => {
    withReceipts({ unifiedCumulative: { retrieveExpired: 1 } })
    render(<TokenSavingsSettings />)

    const el = await screen.findByTestId('hr-retrieve-expired')
    expect(el).toHaveTextContent('1 retrieve_full call asked for content the cache had already aged out')
    expect(el).toHaveTextContent('working as designed')
    expect(el.textContent).not.toMatch(/[Rr]eport this/)
  })

  it('counts a lone bad-token call when the unknown-token counter was never written', async () => {
    // The two columns are summed. Missing one must not take the other down with it, or a
    // mistyped-handle report disappears the moment either counter is absent.
    withReceipts({ unifiedCumulative: { retrieveBadTokens: 1, retrieveUnknownTokens: undefined } })
    render(<TokenSavingsSettings />)

    const el = await screen.findByTestId('hr-retrieve-bad-tokens')
    expect(el).toHaveTextContent('1 retrieve_full call used a handle this app has no record of issuing')
    expect(el.textContent).not.toMatch(/\bcalls\b/)
    // Still not lost content — the alarm stays dark.
    expect(screen.queryByTestId('hr-retrieve-misses')).toBeNull()
  })

  it('counts unknown-token calls when the bad-token counter was never written', async () => {
    withReceipts({ unifiedCumulative: { retrieveUnknownTokens: 2, retrieveBadTokens: undefined } })
    render(<TokenSavingsSettings />)

    expect(await screen.findByTestId('hr-retrieve-bad-tokens'))
      .toHaveTextContent('2 retrieve_full calls used a handle this app has no record of issuing')
    expect(screen.queryByTestId('hr-retrieve-misses')).toBeNull()
  })

  it('reports 0 KB rather than NaN when images were counted but their bytes were not', async () => {
    withReceipts({ proxyCumulative: { images: 3, imageSavedBytes: undefined } })
    render(<TokenSavingsSettings />)

    const kb = await screen.findByTestId('hr-image-bytes')
    expect(kb).toHaveTextContent('0 KB of upload saved')
    expect(kb.textContent).not.toMatch(/NaN/)
  })

  it('still splits the two wire surfaces when only the tool-input columns exist', async () => {
    // tool_result counters absent, tool_use present: the split has to keep showing the half it
    // has rather than hiding both, because that half is the one billed on every later turn.
    withReceipts({
      proxyCumulative: {
        textOrigTokens: undefined, textSavedTokens: undefined,
        toolUseOrigTokens: 80000, toolUseSavedTokens: 60000,
      },
    })
    render(<TokenSavingsSettings />)

    const split = await screen.findByTestId('hr-surface-split')
    expect(screen.getByTestId('hr-surface-tr')).toHaveTextContent('0')
    expect(split).toHaveTextContent('0 of 0 tokens removed')
    expect(screen.getByTestId('hr-surface-tu')).toHaveTextContent('60,000')
    expect(split).toHaveTextContent('60,000 of 80,000 tokens removed')
    expect(split.textContent).not.toMatch(/undefined|NaN/)
  })
})

