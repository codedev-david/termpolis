import React from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StallHistoryPanel } from '../../src/renderer/src/components/SettingsPane/StallHistoryPanel'

// David: "the whole app freezes up for 2-3 seconds and says not responding, then goes back."
//
// That is the main-thread event loop not being served. Termpolis pumps every PTY and serves all IPC
// on it, so when it stops, EVERY window dies at once and Windows paints "(Not Responding)".
//
// A percentile cannot show you this: one 2.5s stop-the-world pause barely moves a p99 over a 60s
// window. A dashboard of healthy-looking averages will sit there insisting nothing is wrong while
// the app freezes twice a minute. So freezes are recorded as discrete EVENTS, with a cause.

type Stall = {
  ts: number
  durationMs: number
  cause: 'gc' | 'sync-work'
  gcPauseMs: number
  heapUsedMB: number
  rssMB: number
  breadcrumb: string | null
}

const gcStall = (over: Partial<Stall> = {}): Stall => ({
  ts: 1_000,
  durationMs: 2_400,
  cause: 'gc',
  gcPauseMs: 2_350,
  heapUsedMB: 1_100,
  rssMB: 1_500,
  breadcrumb: null,
  ...over,
})

const mockStalls = (stalls: Stall[]) => {
  ;(window as any).termpolis = { memoryGetStalls: vi.fn(async () => ({ success: true, data: stalls })) }
}

beforeEach(() => mockStalls([]))
afterEach(() => { cleanup(); delete (window as any).termpolis; vi.useRealTimers() })

describe('StallHistoryPanel', () => {
  it('says plainly when there is nothing to chase', async () => {
    render(<StallHistoryPanel />)
    await waitFor(() => expect(screen.getByTestId('stall-none')).toBeInTheDocument())
    expect(screen.getByTestId('stall-none').textContent).toMatch(/no freezes recorded/i)
  })

  it('reports the count and the WORST freeze — the one that hurt', async () => {
    mockStalls([gcStall({ durationMs: 900 }), gcStall({ durationMs: 2_400 }), gcStall({ durationMs: 1_200 })])
    render(<StallHistoryPanel />)
    const s = await screen.findByTestId('stall-summary')
    expect(s.textContent).toMatch(/3 freezes/)
    expect(s.textContent).toMatch(/worst 2\.4s/)
  })

  // THE DIAGNOSIS. This is the sentence that turns "the app feels slow" into a bug you can fix.
  it('names garbage collection as the cause, and says it is a MEMORY problem not a CPU one', async () => {
    mockStalls([gcStall(), gcStall({ durationMs: 2_100 })])
    render(<StallHistoryPanel />)
    const s = await screen.findByTestId('stall-summary')
    expect(s.textContent).toMatch(/all of them were garbage collection/i)
    expect(s.textContent).toMatch(/the bigger the heap, the longer the app is gone/i)
    expect(s.textContent).toMatch(/memory-size problem, not a\s+cpu one/i)
    expect(s.textContent).toMatch(/not responding/i) // ties it to what the user actually sees
  })

  it('shows the HEAP at the time of each freeze — the number that explains it', async () => {
    mockStalls([gcStall({ heapUsedMB: 1_100, rssMB: 1_500 })])
    render(<StallHistoryPanel />)
    const row = await screen.findByTestId('stall-row')
    expect(row.textContent).toMatch(/2\.4s/)
    expect(row.textContent).toMatch(/heap 1100 MB/)
    expect(row.textContent).toMatch(/rss 1500 MB/)
  })

  it('a synchronous freeze is named by its breadcrumb, not left as a mystery', async () => {
    mockStalls([gcStall({ cause: 'sync-work', gcPauseMs: 0, breadcrumb: 'memory: persist HNSW index' })])
    render(<StallHistoryPanel />)
    const s = await screen.findByTestId('stall-summary')
    expect(s.textContent).toMatch(/none were garbage collection/i)
    expect(s.textContent).toMatch(/synchronously/i)
    expect((await screen.findByTestId('stall-row')).textContent).toMatch(/memory: persist HNSW index/)
  })

  it('a sync freeze with no breadcrumb still admits it happened', async () => {
    mockStalls([gcStall({ cause: 'sync-work', gcPauseMs: 0, breadcrumb: null })])
    render(<StallHistoryPanel />)
    expect((await screen.findByTestId('stall-row')).textContent).toMatch(/synchronous work/i)
  })

  it('a mixed session reports the split honestly rather than picking a story', async () => {
    mockStalls([
      gcStall(),
      gcStall({ cause: 'sync-work', gcPauseMs: 0, breadcrumb: 'memory: ingest conversations' }),
    ])
    render(<StallHistoryPanel />)
    const s = await screen.findByTestId('stall-summary')
    expect(s.textContent).toMatch(/1 of 2 were garbage collection/i)
  })

  it('shows the most RECENT freezes first, capped so the pane stays readable', async () => {
    const many = Array.from({ length: 20 }, (_, i) => gcStall({ ts: i, durationMs: 500 + i }))
    mockStalls(many)
    render(<StallHistoryPanel />)
    await screen.findByTestId('stall-summary')
    const rows = screen.getAllByTestId('stall-row')
    expect(rows).toHaveLength(8)
    expect(rows[0].textContent).toMatch(/519/) // newest (i=19) first, not oldest
  })

  it('polls, so a freeze that happens while you watch shows up', async () => {
    vi.useFakeTimers()
    const getStalls = vi.fn(async () => ({ success: true, data: [] as Stall[] }))
    ;(window as any).termpolis = { memoryGetStalls: getStalls }
    render(<StallHistoryPanel />)
    await vi.advanceTimersByTimeAsync(0)
    expect(getStalls).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getStalls).toHaveBeenCalledTimes(2)
  })

  it('stops polling on unmount', async () => {
    vi.useFakeTimers()
    const getStalls = vi.fn(async () => ({ success: true, data: [] as Stall[] }))
    ;(window as any).termpolis = { memoryGetStalls: getStalls }
    const { unmount } = render(<StallHistoryPanel />)
    await vi.advanceTimersByTimeAsync(0)
    unmount()
    const n = getStalls.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getStalls).toHaveBeenCalledTimes(n)
  })

  it('a broken bridge hides the panel rather than breaking Settings', async () => {
    delete (window as any).termpolis
    expect(() => render(<StallHistoryPanel />)).not.toThrow()
    expect(screen.queryByTestId('stall-history-panel')).toBeNull()
  })
})
