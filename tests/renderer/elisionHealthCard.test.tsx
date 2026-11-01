// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ElisionHealthCard } from '../../src/renderer/src/components/SettingsPane/ElisionHealthCard'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'
import type { ElisionClassView, ElisionHealthView } from '../../src/renderer/src/types'

/**
 * R1 criterion 5. The card answers the question the app could not answer before: how often does
 * the model ask for elided text back, by kind of result, and does eliding it at first sight pay at
 * that rate. These fixtures are what the main process sends; the card's job is to say it plainly.
 */

const cls = (over: Partial<ElisionClassView> = {}): ElisionClassView => ({
  key: 'compact|Read|4-10k', kind: 'compact', tool: 'Read', band: '4-10k',
  elided: 100, redeemed: 66, ratePct: 66, recentElided: 0, recentRedeemed: 0, recentRatePct: null,
  breakEvenPct: 40.2, netUnitsPer1000: -8_635_000, verdict: 'costs', basis: 'all-time',
  ...over,
})
const view = (over: Partial<ElisionHealthView> = {}): ElisionHealthView => ({
  windowSize: 2000, classes: [cls()], elided: 100, redeemed: 66, legacyRedeemed: 0, recentElided: 0, recentRedeemed: 0,
  firstSight: { verdict: 'costs', basis: 'all-time', elided: 100, ratePct: 66, breakEvenPct: 40.2, netUnits: -863_500 },
  regime: 'unknown',
  turns: { count: 230, units: 3_910_000, unitsPerTurn: 17_000, costBasis: 'measured', observed: 1000, sharePct: 23 },
  ...over,
})

type Api = Record<string, ReturnType<typeof vi.fn> | undefined>
const api = (): Api => (window as unknown as { termpolis: Api }).termpolis
const serve = (v: ElisionHealthView | null): void => {
  api().tokenSavingsGetElisionHealth = vi.fn().mockResolvedValue(v ? { success: true, data: v } : { success: false, error: 'boom' })
}
beforeEach(() => { ;(window as unknown as { termpolis: Api }).termpolis = {} })

describe('Elision health card — what it says', () => {
  it('shows the redemption rate and the break-even for each class', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    const row = await screen.findByTestId('hr-elision-row-compact|Read|4-10k')
    expect(row).toHaveTextContent('Read')
    expect(row).toHaveTextContent('4-10k')
    expect(within(row).getByTestId('hr-elision-elided')).toHaveTextContent('100')
    expect(within(row).getByTestId('hr-elision-rate')).toHaveTextContent('66%')
    expect(within(row).getByTestId('hr-elision-breakeven')).toHaveTextContent('40%')
    expect(within(row).getByTestId('hr-elision-verdict-cell')).toHaveTextContent('Costs')
  })

  it('says in a sentence that eliding at first sight is costing money, with the rate and the break-even', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-elision-verdict')
    expect(v).toHaveTextContent('costing')
    expect(v).toHaveTextContent('863,500 billed units')
    expect(v).toHaveTextContent('the model asked for 66% of them back')
    expect(v).toHaveTextContent('pays only below 40%')
    expect(v.getAttribute('data-verdict')).toBe('costs')
  })

  it('says it is paying when it is', async () => {
    serve(view({
      classes: [cls({ ratePct: 13, redeemed: 13, breakEvenPct: 40.2, netUnitsPer1000: 9_120_000, verdict: 'pays' })],
      firstSight: { verdict: 'pays', basis: 'all-time', elided: 100, ratePct: 13, breakEvenPct: 40.2, netUnits: 912_000 },
    }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-elision-verdict')
    expect(v).toHaveTextContent('saving')
    expect(v).toHaveTextContent('912,000 billed units')
    expect(v).toHaveTextContent('pays up to 40%')
    expect(v.getAttribute('data-verdict')).toBe('pays')
  })

  it('names the window when the verdict rests on the recent results, and all time when it does not', async () => {
    serve(view({ firstSight: { ...view().firstSight, basis: 'recent', elided: 640 } }))
    const { unmount } = render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-verdict')).toHaveTextContent('last 640 results of this run')
    unmount()
    serve(view({ firstSight: { ...view().firstSight, basis: 'all-time', elided: 5000 } }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-verdict')).toHaveTextContent('all 5,000 results so far')
  })

  it('declines to give a verdict with too few results, and says how many it needs', async () => {
    serve(view({
      classes: [cls({ elided: 12, redeemed: 9, ratePct: 75, breakEvenPct: null, netUnitsPer1000: null, verdict: 'unknown', basis: null })],
      firstSight: { verdict: 'unknown', basis: null, elided: 0, ratePct: null, breakEvenPct: null, netUnits: 0 },
    }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-elision-verdict')
    expect(v).toHaveTextContent('Not enough results yet to say')
    expect(v).toHaveTextContent('30')
    expect(v.getAttribute('data-verdict')).toBe('unknown')
    const row = screen.getByTestId('hr-elision-row-compact|Read|4-10k')
    expect(within(row).getByTestId('hr-elision-rate')).toHaveTextContent('75%')
    expect(within(row).getByTestId('hr-elision-verdict-cell')).toHaveTextContent('Too few')
    expect(within(row).getByTestId('hr-elision-breakeven')).toHaveTextContent('—')
  })

  it('shows rates but no verdict for the kinds a policy does not choose between', async () => {
    serve(view({ classes: [
      cls(),
      cls({ key: 'decay|Bash|1.6-4k', kind: 'decay', tool: 'Bash', band: '1.6-4k', elided: 900, redeemed: 90, ratePct: 10, breakEvenPct: null, netUnitsPer1000: null, verdict: 'unknown', basis: null }),
    ] }))
    render(<ElisionHealthCard />)
    const row = await screen.findByTestId('hr-elision-row-decay|Bash|1.6-4k')
    expect(row).toHaveTextContent('Aged out')
    expect(within(row).getByTestId('hr-elision-rate')).toHaveTextContent('10%')
    expect(within(row).getByTestId('hr-elision-breakeven')).toHaveTextContent('—')
    expect(within(row).getByTestId('hr-elision-verdict-cell')).toHaveTextContent('—')
  })

  it('labels every kind in words', async () => {
    const kinds: Array<[ElisionClassView['kind'], string]> = [['compact', 'Compacted at first sight'], ['dedup', 'Repeat collapsed'], ['diff', 'Sent as a patch'], ['decay', 'Aged out']]
    serve(view({ classes: kinds.map(([kind], i) => cls({ key: `${kind}|Read|4-10k`, kind, elided: 100 - i })) }))
    render(<ElisionHealthCard />)
    for (const [kind, label] of kinds) expect(await screen.findByTestId(`hr-elision-row-${kind}|Read|4-10k`)).toHaveTextContent(label)
  })

  it('names tools and sizes the way a person would', async () => {
    serve(view({ classes: [
      cls({ key: 'compact|mcp|<1.6k', tool: 'mcp', band: '<1.6k', elided: 50 }),
      cls({ key: 'compact|other|40k+', tool: 'other', band: '40k+', elided: 40 }),
    ] }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-row-compact|mcp|<1.6k')).toHaveTextContent('MCP tools')
    expect(screen.getByTestId('hr-elision-row-compact|mcp|<1.6k')).toHaveTextContent('under 1.6k chars')
    expect(screen.getByTestId('hr-elision-row-compact|other|40k+')).toHaveTextContent('Other tools')
    expect(screen.getByTestId('hr-elision-row-compact|other|40k+')).toHaveTextContent('40k+ chars')
  })

  it('shows the recent rate beside the all-time one when the window has results', async () => {
    serve(view({ classes: [cls({ recentElided: 200, recentRedeemed: 150, recentRatePct: 75 })] }))
    render(<ElisionHealthCard />)
    const row = await screen.findByTestId('hr-elision-row-compact|Read|4-10k')
    expect(within(row).getByTestId('hr-elision-recent')).toHaveTextContent('75%')
    expect(within(row).getByTestId('hr-elision-recent')).toHaveTextContent('200')
  })

  it('shows a dash for a recent rate with nothing behind it', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    expect(within(await screen.findByTestId('hr-elision-row-compact|Read|4-10k')).getByTestId('hr-elision-recent')).toHaveTextContent('—')
  })
})

describe('Elision health card — regime, turns and notes', () => {
  it('calls out a rise in the rate the model asks for text back', async () => {
    serve(view({ regime: 'rising' }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-regime')).toHaveTextContent('asking for elided text back more often')
  })

  it('calls out a fall, and says nothing when steady or unknown', async () => {
    serve(view({ regime: 'falling' }))
    const { unmount } = render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-regime')).toHaveTextContent('less often')
    unmount()
    for (const regime of ['steady', 'unknown'] as const) {
      serve(view({ regime }))
      const r = render(<ElisionHealthCard />)
      await screen.findByTestId('hr-elision-verdict')
      expect(screen.queryByTestId('hr-elision-regime')).toBeNull()
      r.unmount()
    }
  })

  it('reports the retrieval turns: how many, what they cost and what share of responses', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    const t = await screen.findByTestId('hr-elision-turns')
    expect(t).toHaveTextContent('230 turns that only fetched elided text')
    expect(t).toHaveTextContent('23% of responses')
    expect(t).toHaveTextContent('3,910,000 billed units')
    expect(t).toHaveTextContent('17,000')
    expect(t).toHaveTextContent('measured')
  })

  it('says the cost per turn is an assumption until enough turns have been seen', async () => {
    serve(view({ turns: { count: 4, units: 70_000, unitsPerTurn: 16_800, costBasis: 'assumed', observed: 90, sharePct: 4.4 } }))
    render(<ElisionHealthCard />)
    const t = await screen.findByTestId('hr-elision-turns')
    expect(t).toHaveTextContent('4 turns')
    expect(t).toHaveTextContent('4.4% of responses')
    expect(t).toHaveTextContent('assumed')
    expect(t).toHaveTextContent('16,800')
  })

  it('says there are none yet rather than showing zeros', async () => {
    serve(view({ turns: { count: 0, units: 0, unitsPerTurn: 16_800, costBasis: 'assumed', observed: 0, sharePct: null } }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-turns')).toHaveTextContent('No turns that only fetched elided text yet')
  })

  it('counts a single turn in the singular and leaves out a share it cannot compute', async () => {
    serve(view({ turns: { count: 1, units: 20_000, unitsPerTurn: 16_800, costBasis: 'assumed', observed: 0, sharePct: null } }))
    render(<ElisionHealthCard />)
    const t = await screen.findByTestId('hr-elision-turns')
    expect(t).toHaveTextContent('1 turn that only fetched elided text')
    expect(t).not.toHaveTextContent('of responses')
  })

  it('notes the redemptions of text the ledger could not class (older versions, earlier launches), only when there are some', async () => {
    serve(view({ legacyRedeemed: 1234 }))
    const { unmount } = render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-legacy')).toHaveTextContent('1,234 retrievals were of text elided before this version counted by kind, or in an earlier launch of the app, so no row above includes them')
    unmount()
    serve(view({ legacyRedeemed: 1 }))
    const one = render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-legacy')).toHaveTextContent('1 retrieval was of text elided before this version counted by kind, or in an earlier launch of the app, so no row above includes it')
    one.unmount()
    serve(view({ legacyRedeemed: 0 }))
    render(<ElisionHealthCard />)
    await screen.findByTestId('hr-elision-verdict')
    expect(screen.queryByTestId('hr-elision-legacy')).toBeNull()
  })

  it('states that the break-even is an estimate and what it assumes', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    const note = await screen.findByTestId('hr-elision-estimate')
    expect(note).toHaveTextContent('estimate')
    expect(note).toHaveTextContent('11 billed units')
    expect(note).toHaveTextContent('four characters')
  })
})

describe('Elision health card — states and controls', () => {
  it('shows an empty state before anything has been elided', async () => {
    serve(view({ classes: [], elided: 0, redeemed: 0, firstSight: { verdict: 'unknown', basis: null, elided: 0, ratePct: null, breakEvenPct: null, netUnits: 0 } }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-empty')).toHaveTextContent('Nothing has been elided yet')
    expect(screen.queryByTestId('hr-elision-table')).toBeNull()
  })

  it('says it is unavailable when the main process cannot answer', async () => {
    serve(null)
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-unavailable')).toHaveTextContent('unavailable')
  })

  it('says it is unavailable when the bridge does not exist, or throws', async () => {
    const { unmount } = render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-unavailable')).toBeInTheDocument()
    unmount()
    api().tokenSavingsGetElisionHealth = vi.fn().mockRejectedValue(new Error('ipc closed'))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-unavailable')).toBeInTheDocument()
  })

  it('shows the busiest classes and lets the rest be opened', async () => {
    const many = Array.from({ length: 12 }, (_, i) => cls({ key: `compact|Read|4-10k#${i}`, elided: 1000 - i }))
    serve(view({ classes: many }))
    render(<ElisionHealthCard />)
    await screen.findByTestId('hr-elision-table')
    expect(screen.getAllByTestId(/^hr-elision-row-/)).toHaveLength(8)
    const more = screen.getByTestId('hr-elision-more')
    expect(more).toHaveTextContent('Show all 12')
    fireEvent.click(more)
    expect(screen.getAllByTestId(/^hr-elision-row-/)).toHaveLength(12)
    expect(screen.getByTestId('hr-elision-more')).toHaveTextContent('Show fewer')
    fireEvent.click(screen.getByTestId('hr-elision-more'))
    expect(screen.getAllByTestId(/^hr-elision-row-/)).toHaveLength(8)
  })

  it('has no show-all control when everything already fits', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    await screen.findByTestId('hr-elision-table')
    expect(screen.queryByTestId('hr-elision-more')).toBeNull()
  })

  it('refreshes on demand', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    await screen.findByTestId('hr-elision-verdict')
    const get = api().tokenSavingsGetElisionHealth as ReturnType<typeof vi.fn>
    expect(get).toHaveBeenCalledTimes(1)
    get.mockResolvedValueOnce({ success: true, data: view({ firstSight: { ...view().firstSight, verdict: 'pays', netUnits: 5000 } }) })
    fireEvent.click(screen.getByTestId('hr-elision-refresh'))
    await waitFor(() => expect(screen.getByTestId('hr-elision-verdict').getAttribute('data-verdict')).toBe('pays'))
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('keeps what it had when a refresh fails, instead of blanking the card', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    await screen.findByTestId('hr-elision-verdict')
    const get = api().tokenSavingsGetElisionHealth as ReturnType<typeof vi.fn>
    get.mockResolvedValueOnce({ success: false, error: 'busy' })
    fireEvent.click(screen.getByTestId('hr-elision-refresh'))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('hr-elision-verdict')).toBeInTheDocument()
    expect(screen.queryByTestId('hr-elision-unavailable')).toBeNull()
  })
})

describe('Elision health card — in Token Savings settings', () => {
  const base: Api = {
    tokenSavingsGetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, mode: 'aggressive', steering: true, thinkingCap: 0, adaptiveSteering: false, floorControl: true, prefixDecay: true, wireProxy: true } }),
    tokenSavingsSetSettings: vi.fn(),
    tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 0, events: 0, byTool: {} }, cumulative: { netSaved: 0, events: 0, byTool: {} } } }),
    tokenSavingsGetProxyReceipt: vi.fn().mockResolvedValue({ success: false, error: 'none' }),
    tokenSavingsGetUnifiedReceipt: vi.fn().mockResolvedValue({ success: false, error: 'none' }),
  }

  it('sits between the headline receipt and the proxy card', async () => {
    ;(window as unknown as { termpolis: Api }).termpolis = { ...base }
    serve(view())
    const { container } = render(<TokenSavingsSettings />)
    const card = await screen.findByTestId('hr-elision-health')
    const order = Array.from(container.querySelectorAll('.hr-unified-receipt, [data-testid="hr-elision-health"], .hr-proxy-receipt'))
    expect(order).toHaveLength(3)
    expect(order[0].className).toContain('hr-unified-receipt')
    expect(order[1]).toBe(card)
    expect(order[2].className).toContain('hr-proxy-receipt')
  })

  it('does not take the rest of the settings down with it when the card has nothing', async () => {
    ;(window as unknown as { termpolis: Api }).termpolis = { ...base }
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-elision-unavailable')).toBeInTheDocument()
    expect(await screen.findByTestId('hr-toggle-proxy')).toBeInTheDocument()
  })
})
