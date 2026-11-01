// @vitest-environment jsdom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'
import { billBreakdown } from '../../src/main/headroom/effectiveUnits'

/**
 * The all-time headline is "billed units avoided, net of the turns that fetched elided text". That is
 * only true of the history those turns were read for. A ledger from v1.54 has none of them, so on the
 * day of the upgrade the figure netted nothing and said it had netted everything. The pane must say how
 * much of the history behind the number was read, and say it in words a user would meet.
 */

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
    retrieveMisses: 0, turnRequests: 40, askedBackTokens: 0,
    sysTokensPerRequest: 0, toolsTokensPerRequest: 0, tpToolsTokensPerRequest: 0, toolCount: 0,
    steeredRequests: 0, unsteeredRequests: 0, steeredAvgOutput: 0, unsteeredAvgOutput: 0,
    ...over,
  }
  return { ...t, bill: billBreakdown(t, t.netSavedTokens) }
}

const api = (): Record<string, ReturnType<typeof vi.fn>> => (window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis

function serve(session: Record<string, number>, cumulative: Record<string, number>): void {
  api().tokenSavingsGetUnifiedReceipt = vi.fn().mockResolvedValue({ success: true, data: { session: unifiedTotals(session), cumulative: unifiedTotals(cumulative) } })
}

beforeEach(() => {
  ;(window as unknown as { termpolis: Record<string, ReturnType<typeof vi.fn>> }).termpolis = {
    tokenSavingsGetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, mode: 'balanced', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: false, firstSightElision: 'late' } }),
    tokenSavingsSetSettings: vi.fn().mockResolvedValue({ success: true, data: {} }),
    tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 12345, events: 3, byTool: {} }, cumulative: { netSaved: 99999, events: 40, byTool: {} } } }),
    tokenSavingsGetProxyReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: proxyTotals(), cumulative: proxyTotals() } }),
    tokenSavingsGetUnifiedReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: unifiedTotals({}), cumulative: unifiedTotals({}) } }),
  }
})

describe('the all-time headline says how much of its history was netted', () => {
  it('says nothing about it when every response behind the figure was read for retrieval turns', async () => {
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-bill-avoided')
    expect(screen.queryByTestId('hr-bill-coverage')).toBeNull()
  })

  it('says so when none of them were: a ledger from before v1.55, the day of the upgrade', async () => {
    serve({}, { requests: 477_099, turnRequests: 0 })
    render(<TokenSavingsSettings />)
    const note = await screen.findByTestId('hr-bill-coverage')
    expect(note).toHaveTextContent('Retrieval turns are counted from v1.55 on')
    expect(note).toHaveTextContent('read for 0 of the 477,099 responses behind this all-time figure')
    expect(note).toHaveTextContent('Earlier history was never netted')
    expect(note).toHaveTextContent('higher than your bill supports')
    expect(note).toHaveTextContent('This session’s figure is fully measured')
  })

  it('and says how far it has come once some were: 12,000 of 477,099', async () => {
    serve({}, { requests: 477_099, turnRequests: 12_000 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-bill-coverage')).toHaveTextContent('read for 12,000 of the 477,099 responses')
  })

  it('also marks the parts line, so "0 spent on 0 turns" is not read as "no turn ever cost anything"', async () => {
    serve({}, { requests: 477_099, turnRequests: 0, retrievalTurns: 0, retrievalTurnUnits: 0 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-bill-parts')).toHaveTextContent('counted from v1.55')
  })

  it('leaves the parts line alone when the history is fully read', async () => {
    serve({}, { retrievalTurns: 12, retrievalTurnUnits: 3000 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-bill-parts')).not.toHaveTextContent('counted from v1.55')
  })

  it('treats a nearly full history as full: 99% or more read needs no caveat', async () => {
    serve({}, { requests: 1000, turnRequests: 990 })
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-bill-avoided')
    expect(screen.queryByTestId('hr-bill-coverage')).toBeNull()
  })

  it('and 98.9% is not: the line is drawn at 99%', async () => {
    serve({}, { requests: 1000, turnRequests: 989 })
    render(<TokenSavingsSettings />)
    expect(await screen.findByTestId('hr-bill-coverage')).toBeTruthy()
  })

  it('has no caveat for an install with no responses at all', async () => {
    serve({}, { requests: 0, turnRequests: 0 })
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-bill-avoided')
    expect(screen.queryByTestId('hr-bill-coverage')).toBeNull()
  })

  it('has no caveat from a main process that sends no counts at all', async () => {
    const bare = { ...unifiedTotals({}), requests: undefined, turnRequests: undefined } as unknown as Record<string, number>
    api().tokenSavingsGetUnifiedReceipt = vi.fn().mockResolvedValue({ success: true, data: { session: bare, cumulative: bare } })
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-bill-avoided')
    expect(screen.queryByTestId('hr-bill-coverage')).toBeNull()
  })
})

describe('what the headline claims to be', () => {
  it('says the figure is net of the turns that fetched text and of text asked back, and that it is an estimate', async () => {
    render(<TokenSavingsSettings />)
    const card = (await screen.findByTestId('hr-bill-avoided')).closest('.hr-unified-receipt') as HTMLElement
    expect(card).toHaveTextContent('net of the turns that fetched elided text and of text asked back')
    const note = screen.getByTestId('hr-bill-note')
    expect(note).toHaveTextContent('a turn that first had to load the tool through ToolSearch is charged with it')
    expect(note).toHaveTextContent('no longer credited as saved')
    expect(note).toHaveTextContent('It is an estimate')
    expect(note).toHaveTextContent('short view that stays behind')
  })

  it('names the percentage for what it measures: a share of what your usage would have cost', async () => {
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-bill-pct')
    expect(screen.getByText('of what your usage would have cost')).toBeTruthy()
  })

  it('no longer calls three different quantities "the same saving"', async () => {
    render(<TokenSavingsSettings />)
    const d = await screen.findByTestId('hr-denominators')
    expect(d).not.toHaveTextContent('The same saving')
    expect(d).toHaveTextContent('The saving, measured three ways')
    expect(d).toHaveTextContent('the last also subtracts the turns that fetched elided text')
  })

  it('shows the credit withdrawn for text already asked back, in tokens, only when there is some', async () => {
    serve({}, { grossSavedTokens: 100_000, givebackTokens: 4_000, askedBackTokens: 9_000, netSavedTokens: 87_000, retrieves: 6 })
    render(<TokenSavingsSettings />)
    const line = await screen.findByTestId('hr-unified-tokens')
    expect(screen.getByTestId('hr-unified-asked-back')).toHaveTextContent('9,000')
    expect(line).toHaveTextContent('already asked back')
    expect(line).toHaveTextContent('87,000 net = 100,000 removed from the wire − 4,000 given back by 6 retrieve_full calls − 9,000 already asked back')
  })

  it('leaves that clause out when nothing was asked back', async () => {
    render(<TokenSavingsSettings />)
    await screen.findByTestId('hr-unified-tokens')
    expect(screen.queryByTestId('hr-unified-asked-back')).toBeNull()
  })

  it('writes a headline that rounds to zero as 0, not -0', async () => {
    // A tiny negative: gross 0.3 units kept off the bill against 0.6 spent on turns.
    serve({}, { netSavedTokens: 0, grossSavedTokens: 0, retrievalTurnUnits: 0.4, retrievalTurns: 1 })
    render(<TokenSavingsSettings />)
    const head = await screen.findByTestId('hr-bill-avoided')
    expect(head.textContent).toBe('0')
  })
})

describe('where the tool-output line sits', () => {
  it('belongs to the Termpolis tool-output compression block, not to the context window section below it', async () => {
    render(<TokenSavingsSettings />)
    const line = await screen.findByTestId('hr-tool-output-savings')
    expect(line).toHaveTextContent('Tool-output savings')
    expect(screen.getByTestId('hr-session-saved')).toHaveTextContent('12,345')
    expect(screen.getByTestId('hr-cumulative-saved')).toHaveTextContent('99,999')
    const cap = screen.getByTestId('hr-context-cap')
    // Document order: the line comes before the context window section, and is not inside it.
    expect(cap.contains(line)).toBe(false)
    expect(line.compareDocumentPosition(cap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const toggle = screen.getByTestId('hr-toggle-enabled')
    expect(toggle.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
