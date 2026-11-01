// @vitest-environment jsdom
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ElisionHealthCard } from '../../src/renderer/src/components/SettingsPane/ElisionHealthCard'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'
import type { ArmComparisonView, ArmSummaryView, ElisionClassView, ElisionHealthView } from '../../src/renderer/src/types'

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
const arm = (over: Partial<ArmSummaryView> = {}): ArmSummaryView => ({
  requests: 0, working: 0, turns: 0, groups: 0, sharePct: null, unitsPerRequest: null, unitsPerWorking: null, turnUnitsPerWorking: null, ...over,
})
const arms = (over: Partial<ArmComparisonView> = {}): ArmComparisonView => ({
  minRequests: 500, late: arm(), holdout: arm(), legacy: arm(),
  verdict: 'not-enough-data', costDeltaPct: null, costMarginPct: null, turnVerdict: null, shareDeltaPts: null, shareMarginPts: null,
  ...over,
})
const view = (over: Partial<ElisionHealthView> = {}): ElisionHealthView => ({
  windowSize: 2000, classes: [cls()], elided: 100, redeemed: 66, legacyRedeemed: 0, recentElided: 0, recentRedeemed: 0,
  firstSight: { verdict: 'costs', basis: 'all-time', elided: 100, ratePct: 66, breakEvenPct: 40.2, netUnits: -863_500 },
  regime: 'unknown',
  turns: { count: 230, units: 3_910_000, unitsPerTurn: 17_000, costBasis: 'measured', hops: 0, observed: 1000, askable: 0, unaskable: 0, shareBasis: 'responses', sharePct: 23 },
  arms: arms(),
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
    serve(view({ turns: { count: 4, units: 70_000, unitsPerTurn: 16_800, costBasis: 'assumed', hops: 0, observed: 90, askable: 0, unaskable: 0, shareBasis: 'responses', sharePct: 4.4 } }))
    render(<ElisionHealthCard />)
    const t = await screen.findByTestId('hr-elision-turns')
    expect(t).toHaveTextContent('4 turns')
    expect(t).toHaveTextContent('4.4% of responses')
    expect(t).toHaveTextContent('assumed')
    expect(t).toHaveTextContent('16,800')
  })

  it('says there are none yet rather than showing zeros', async () => {
    serve(view({ turns: { count: 0, units: 0, unitsPerTurn: 16_800, costBasis: 'assumed', hops: 0, observed: 0, askable: 0, unaskable: 0, shareBasis: 'responses', sharePct: null } }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-turns')).toHaveTextContent('No turns that only fetched elided text yet')
  })

  it('counts a single turn in the singular and leaves out a share it cannot compute', async () => {
    serve(view({ turns: { count: 1, units: 20_000, unitsPerTurn: 16_800, costBasis: 'assumed', hops: 0, observed: 0, askable: 0, unaskable: 0, shareBasis: 'responses', sharePct: null } }))
    render(<ElisionHealthCard />)
    const t = await screen.findByTestId('hr-elision-turns')
    expect(t).toHaveTextContent('1 turn that only fetched elided text')
    expect(t).not.toHaveTextContent('of responses')
  })

  // R1 criterion 10 on the card: the rate is over the requests that could ask, and the card says so.
  it('takes the share over the requests that could ask, and says how many could not', async () => {
    serve(view({ turns: { count: 230, units: 3_910_000, unitsPerTurn: 17_000, costBasis: 'measured', hops: 0, observed: 1000, askable: 800, unaskable: 200, shareBasis: 'could-ask', sharePct: 28.8 } }))
    render(<ElisionHealthCard />)
    const t = await screen.findByTestId('hr-elision-turns')
    expect(t).toHaveTextContent('230 turns that only fetched elided text')
    expect(t).toHaveTextContent('28.8% of the 800 responses to requests that could ask')
    expect(t).not.toHaveTextContent('of responses)')
    expect(t).toHaveTextContent('200 responses came from requests with no way to ask, and are left out of the rate')
  })

  it('does not mention requests that could not ask when there were none', async () => {
    serve(view({ turns: { count: 230, units: 3_910_000, unitsPerTurn: 17_000, costBasis: 'measured', hops: 0, observed: 800, askable: 800, unaskable: 0, shareBasis: 'could-ask', sharePct: 28.8 } }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-turns')).not.toHaveTextContent('no way to ask')
  })

  it('says how many asks took a second turn to load the tool first, and that the cost includes it', async () => {
    serve(view({ turns: { count: 100, units: 2_000_000, unitsPerTurn: 20_000, costBasis: 'measured', hops: 40, observed: 1000, askable: 1000, unaskable: 0, shareBasis: 'could-ask', sharePct: 10 } }))
    render(<ElisionHealthCard />)
    const t = await screen.findByTestId('hr-elision-turns')
    expect(t).toHaveTextContent('40 of them were preceded by a turn that only loaded the tool')
    expect(t).toHaveTextContent('that turn is in the cost')
  })

  it('says it in the singular for one', async () => {
    serve(view({ turns: { count: 3, units: 60_000, unitsPerTurn: 20_000, costBasis: 'assumed', hops: 1, observed: 10, askable: 10, unaskable: 0, shareBasis: 'could-ask', sharePct: 30 } }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-turns')).toHaveTextContent('1 of them was preceded by a turn that only loaded the tool')
  })

  it('leaves the hop sentence out when no ask needed one', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-elision-turns')).not.toHaveTextContent('only loaded the tool')
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

describe('Elision health card — late compared with the holdout', () => {
  const late = arm({ requests: 1_800, working: 1_700, turns: 100, groups: 18, sharePct: 5.6, unitsPerRequest: 31_000, unitsPerWorking: 32_800, turnUnitsPerWorking: 900 })
  const holdout = arm({ requests: 600, working: 450, turns: 150, groups: 9, sharePct: 25, unitsPerRequest: 28_400, unitsPerWorking: 37_900, turnUnitsPerWorking: 6_000 })

  it('says so when it has too little to compare, with how far each arm has got', async () => {
    serve(view({ arms: arms({ late: arm({ requests: 212, groups: 4, working: 200 }), holdout: arm({ requests: 31, groups: 2, working: 30 }) }) }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-arms-verdict')
    expect(v.getAttribute('data-verdict')).toBe('not-enough-data')
    expect(v).toHaveTextContent('Not enough data yet')
    expect(v).toHaveTextContent('500 requests')
    expect(v).toHaveTextContent('5 different groups')
    expect(v).toHaveTextContent('late 212 requests in 4 groups')
    expect(v).toHaveTextContent('the holdout 31 in 2 groups')
  })

  it('says "1 group" in the singular', async () => {
    serve(view({ arms: arms({ late: arm({ requests: 600, groups: 1, working: 600 }), holdout: arm({ requests: 1, groups: 1, working: 1 }) }) }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-arms-verdict')
    expect(v).toHaveTextContent('late 600 requests in 1 group,')
    expect(v).toHaveTextContent('the holdout 1 in 1 group.')
  })

  it('says there is nothing to compare when the whole run is on the Legacy setting', async () => {
    serve(view({ arms: arms({ legacy: arm({ requests: 4_200, working: 3_300, turns: 900, groups: 1, sharePct: 21.4 }) }) }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-arms-verdict')
    expect(v).toHaveTextContent('Legacy setting')
    expect(v).toHaveTextContent('nothing to compare')
    expect(v.getAttribute('data-verdict')).toBe('not-enough-data')
  })

  it('says late is cheaper, by how much and with what margin', async () => {
    serve(view({ arms: arms({ late, holdout, verdict: 'late-cheaper', costDeltaPct: -13.5, costMarginPct: 6.2, turnVerdict: 'fewer', shareDeltaPts: -19.4, shareMarginPts: 7.1 }) }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-arms-verdict')
    expect(v.getAttribute('data-verdict')).toBe('late-cheaper')
    expect(v).toHaveTextContent('Late is cheaper')
    expect(v).toHaveTextContent('13.5% fewer billed units per unit of work')
    expect(v).toHaveTextContent('give or take 6.2 points')
  })

  it('says plainly, and in red, that late is costing more when it is', async () => {
    serve(view({ arms: arms({ late, holdout, verdict: 'late-costlier', costDeltaPct: 9.8, costMarginPct: 4.1 }) }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-arms-verdict')
    expect(v.getAttribute('data-verdict')).toBe('late-costlier')
    expect(v).toHaveTextContent('Late is costing more')
    expect(v).toHaveTextContent('9.8% more billed units per unit of work')
    expect(v).toHaveTextContent('give or take 4.1 points')
    expect(v).toHaveTextContent('Legacy')
    expect(v.getAttribute('style')).toContain('rgb(248, 113, 113)')
  })

  it('does not claim a difference inside the margin: it says the gap could be chance', async () => {
    serve(view({ arms: arms({ late, holdout, verdict: 'no-clear-difference', costDeltaPct: -3.1, costMarginPct: 9.4 }) }))
    render(<ElisionHealthCard />)
    const v = await screen.findByTestId('hr-arms-verdict')
    expect(v.getAttribute('data-verdict')).toBe('no-clear-difference')
    expect(v).toHaveTextContent('No clear difference yet')
    expect(v).toHaveTextContent('3.1% cheaper than the holdout')
    expect(v).toHaveTextContent('give or take 9.4 points')
    expect(v).toHaveTextContent('could be chance')
  })

  it('says "level with" for a gap of exactly nothing', async () => {
    serve(view({ arms: arms({ late, holdout, verdict: 'no-clear-difference', costDeltaPct: 0, costMarginPct: 0 }) }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-arms-verdict')).toHaveTextContent('running level with the holdout')
  })

  it('says a gap the other way is dearer', async () => {
    serve(view({ arms: arms({ late, holdout, verdict: 'no-clear-difference', costDeltaPct: 2.4, costMarginPct: 8 }) }))
    render(<ElisionHealthCard />)
    expect(await screen.findByTestId('hr-arms-verdict')).toHaveTextContent('2.4% dearer than the holdout')
  })

  describe('retrieval turns', () => {
    const turns = async (a: Partial<ArmComparisonView>): Promise<HTMLElement> => {
      serve(view({ arms: arms({ late, holdout, ...a }) }))
      render(<ElisionHealthCard />)
      return screen.findByTestId('hr-arms-turns')
    }

    it('says late needed fewer round trips, with both shares', async () => {
      const t = await turns({ turnVerdict: 'fewer', shareDeltaPts: -19.4, shareMarginPts: 7.1 })
      expect(t).toHaveTextContent('5.6% of late')
      expect(t).toHaveTextContent('25% of the holdout')
      expect(t).toHaveTextContent('clearly fewer round trips')
      expect(t.getAttribute('data-verdict')).toBe('fewer')
    })

    it('says, in red, when late needed MORE, because that is the opposite of what it is for', async () => {
      const t = await turns({ turnVerdict: 'more', shareDeltaPts: 12, shareMarginPts: 3 })
      expect(t).toHaveTextContent('MORE round trips under late')
      expect(t).toHaveTextContent('opposite of what it is for')
      expect(t.getAttribute('style')).toContain('rgb(248, 113, 113)')
    })

    it('says there is no clear difference', async () => {
      expect(await turns({ turnVerdict: 'no-clear-difference', shareDeltaPts: -1, shareMarginPts: 5 })).toHaveTextContent('no clear difference yet')
    })

    it('says the data is not there yet when there is no verdict', async () => {
      expect(await turns({ turnVerdict: null })).toHaveTextContent('not enough data yet')
    })
  })

  describe('the table', () => {
    it('gives each arm its requests, its retrieval turns and its cost per request and per working request', async () => {
      serve(view({ arms: arms({ late, holdout, verdict: 'late-cheaper', costDeltaPct: -13.5, costMarginPct: 6.2 }) }))
      render(<ElisionHealthCard />)
      const l = await screen.findByTestId('hr-arm-late')
      expect(l).toHaveTextContent('1,800')
      expect(l).toHaveTextContent('100 (5.6%)')
      expect(within(l).getByTestId('hr-arm-per-request')).toHaveTextContent('31,000')
      expect(within(l).getByTestId('hr-arm-per-working')).toHaveTextContent('32,800')
      const h = screen.getByTestId('hr-arm-holdout')
      expect(h).toHaveTextContent('600')
      expect(h).toHaveTextContent('150 (25%)')
      expect(within(h).getByTestId('hr-arm-per-request')).toHaveTextContent('28,400')
      expect(within(h).getByTestId('hr-arm-per-working')).toHaveTextContent('37,900')
    })

    it('shows a dash where an arm has nothing yet', async () => {
      serve(view({ arms: arms({ late: arm({ requests: 3, working: 3, groups: 1 }) }) }))
      render(<ElisionHealthCard />)
      const h = await screen.findByTestId('hr-arm-holdout')
      expect(within(h).getByTestId('hr-arm-per-request')).toHaveTextContent('—')
      expect(within(h).getByTestId('hr-arm-per-working')).toHaveTextContent('—')
    })

    it('lists the Legacy setting only when a run on it has produced requests, and says it is not compared', async () => {
      serve(view({ arms: arms({ late, holdout }) }))
      const { unmount } = render(<ElisionHealthCard />)
      await screen.findByTestId('hr-arm-late')
      expect(screen.queryByTestId('hr-arm-legacy')).toBeNull()
      unmount()
      serve(view({ arms: arms({ late, holdout, legacy: arm({ requests: 77, working: 70, turns: 7, groups: 1, sharePct: 9.1, unitsPerRequest: 20_000, unitsPerWorking: 22_000 }) }) }))
      render(<ElisionHealthCard />)
      const g = await screen.findByTestId('hr-arm-legacy')
      expect(g).toHaveTextContent('Legacy setting')
      expect(g).toHaveTextContent('not compared')
      expect(g).toHaveTextContent('77')
    })
  })

  it('explains the measure: working requests, why cost per request misleads, groups, and what it cannot see', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    const n = await screen.findByTestId('hr-arms-note')
    expect(n).toHaveTextContent('working request')
    expect(n).toHaveTextContent('only on fetching elided text')
    expect(n).toHaveTextContent('look dearer')
    expect(n).toHaveTextContent('between groups of conversations')
    expect(n).toHaveTextContent('500 requests')
    expect(n).toHaveTextContent('quality of an answer')
  })

  it('says how the holdout is chosen and that it runs the old behaviour whichever setting is on', async () => {
    serve(view())
    render(<ElisionHealthCard />)
    const n = await screen.findByTestId('hr-arms-holdout-note')
    expect(n).toHaveTextContent('about one conversation in ten')
    expect(n).toHaveTextContent('first message')
    expect(n).toHaveTextContent('old behaviour')
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
