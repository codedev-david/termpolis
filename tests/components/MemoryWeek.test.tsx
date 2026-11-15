import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { Memory } from '../../src/renderer/src/components/Memory/Memory'
import { WeekActivity, ago } from '../../src/renderer/src/components/Memory/WeekActivity'
import type { MemoryActivity } from '../../src/renderer/src/types'

vi.mock('../../src/renderer/src/components/Memory/CodeGraphPanel', () => ({ CodeGraphPanel: () => null }))

type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api

const NOW = Date.now()
const EMPTY: MemoryActivity = { sinceMs: 0, counts: { lessons: 0, decisions: 0, facts: 0, notes: 0, replaced: 0 }, learned: [], replaced: [], more: false }
const mem = (id: string, over: Partial<MemoryActivity['learned'][number]> = {}) => ({ id, ts: NOW - 5 * 60000, kind: 'fact' as const, lesson: false, agent: 'claude', content: `content ${id}`, ...over })
const FULL: MemoryActivity = {
  sinceMs: 0,
  counts: { lessons: 1, decisions: 1, facts: 1, notes: 1, replaced: 1 },
  learned: [
    mem('l1', { lesson: true, agent: 'mneme', content: 'Run the linter first', project: 'termpolis' }),
    mem('d1', { kind: 'decision', content: 'Ship behind a flag' }),
    mem('f1', { content: 'API on 8080' }),
    mem('n1', { kind: 'note', content: 'Rotate logs' }),
  ],
  replaced: [{ ts: NOW - 3 * 3600000, reason: 'contradicts', newer: mem('new1', { content: 'Never deploy on Fridays' }), older: mem('old1', { content: 'Deploy on Fridays' }) }],
  more: true,
}

beforeEach(() => {
  api = {
    memoryStats: vi.fn().mockResolvedValue({ success: true, data: { count: 42, capacity: 50000 } }),
    memorySyncStatus: vi.fn().mockResolvedValue({ success: true, data: { syncing: false } }),
    memoryActivity: vi.fn().mockResolvedValue({ success: true, data: FULL }),
    memoryReleaseSupersedes: vi.fn().mockResolvedValue({ success: true, data: 1 }),
  }
  ;(window as unknown as { termpolis: Api }).termpolis = api
})

describe('ago', () => {
  it('reads like a person would say it', () => {
    expect(ago(NOW, NOW)).toBe('just now')
    expect(ago(NOW + 5000, NOW)).toBe('just now')
    expect(ago(NOW - 5 * 60000, NOW)).toBe('5 min ago')
    expect(ago(NOW - 3 * 3600000, NOW)).toBe('3 h ago')
    expect(ago(NOW - 2 * 86400000, NOW)).toBe('2 d ago')
  })
})

describe('Memory panel tabs', () => {
  it('opens on Overview, loads nothing for This week until the tab is picked, and switches back', async () => {
    render(<Memory onClose={vi.fn()} activeTerminalId={null} activeCwd="" />)
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(api.memoryActivity).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'This week' }))
    expect(await screen.findByTestId('memory-week')).toBeInTheDocument()
    expect(api.memoryActivity).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(screen.queryByTestId('memory-week')).toBeNull()
    expect(screen.getByLabelText('Memory query')).toBeInTheDocument()
  })

  it('opens straight on This week when asked, and again when asked later', async () => {
    const { rerender } = render(<Memory onClose={vi.fn()} activeTerminalId={null} activeCwd="" weekRequest={1} />)
    expect(await screen.findByTestId('memory-week')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    rerender(<Memory onClose={vi.fn()} activeTerminalId={null} activeCwd="" weekRequest={2} />)
    expect(await screen.findByTestId('memory-week')).toBeInTheDocument()
  })
})

describe('WeekActivity', () => {
  it('shows counts, what was learned with agent and project, and what was replaced', async () => {
    render(<WeekActivity />)
    const counts = await screen.findByTestId('memory-week-counts')
    expect(counts.textContent).toMatch(/Learned 1 lesson, 1 decision, 1 fact and 1 note\. Replaced 1 memory\./)
    expect(screen.getByText('Lesson')).toBeInTheDocument()
    expect(screen.getByText('Decision')).toBeInTheDocument()
    expect(screen.getByText('Fact')).toBeInTheDocument()
    expect(screen.getByText('Note')).toBeInTheDocument()
    expect(screen.getByText('mneme · termpolis · 5 min ago')).toBeInTheDocument()
    expect(screen.getByText('The newer one says the opposite · 3 h ago')).toBeInTheDocument()
    expect(screen.getByText('Never deploy on Fridays')).toBeInTheDocument()
    expect(screen.getByText('Deploy on Fridays')).toHaveClass('line-through')
    expect(screen.getByText('Showing the newest. There is more.')).toBeInTheDocument()
  })

  it('uses plural counts and each reason has its own words', async () => {
    const reasons = ['restated', 'explicit', 'linked'] as const
    api.memoryActivity.mockResolvedValueOnce({
      success: true,
      data: {
        ...EMPTY,
        counts: { lessons: 2, decisions: 0, facts: 0, notes: 0, replaced: 3 },
        replaced: reasons.map((reason, i) => ({ ts: NOW, reason, newer: mem(`n${i}`), older: mem(`o${i}`) })),
      },
    })
    render(<WeekActivity />)
    const counts = await screen.findByTestId('memory-week-counts')
    expect(counts.textContent).toMatch(/2 lessons, 0 decisions, 0 facts and 0 notes\. Replaced 3 memories\./)
    expect(screen.getByText('Said again in newer words · just now')).toBeInTheDocument()
    expect(screen.getByText('The newer one says it replaces this · just now')).toBeInTheDocument()
    expect(screen.getByText('An agent linked them · just now')).toBeInTheDocument()
    expect(screen.queryByText('Learned', { selector: 'div.uppercase' })).toBeNull()
    expect(screen.queryByText(/There is more/)).toBeNull()
  })

  it('shows a plain empty state when nothing happened', async () => {
    api.memoryActivity.mockResolvedValueOnce({ success: true, data: EMPTY })
    render(<WeekActivity />)
    expect(await screen.findByTestId('memory-week-empty')).toHaveTextContent(/Nothing new this week/)
  })

  it('says so when the activity cannot be loaded, from an error reply or a throw', async () => {
    api.memoryActivity.mockResolvedValueOnce({ success: false, error: 'Memory is locked' })
    const { unmount } = render(<WeekActivity />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Memory is locked')
    unmount()
    api.memoryActivity.mockResolvedValueOnce({ success: false })
    const second = render(<WeekActivity />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this week's activity.")
    second.unmount()
    api.memoryActivity.mockRejectedValueOnce(new Error('ipc down'))
    render(<WeekActivity />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this week's activity.")
  })

  it('Undo releases by the newer memory, says what came back, and reloads', async () => {
    render(<WeekActivity />)
    const row = (await screen.findByText('Never deploy on Fridays')).closest('li') as HTMLElement
    api.memoryActivity.mockResolvedValueOnce({ success: true, data: EMPTY })
    fireEvent.click(within(row).getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Brought back 1 memory. Search returns it again.')).toBeInTheDocument()
    expect(api.memoryReleaseSupersedes).toHaveBeenCalledWith('new1')
    await waitFor(() => expect(api.memoryActivity).toHaveBeenCalledTimes(2))
  })

  it('Undo reports several, none, or a failure', async () => {
    render(<WeekActivity />)
    await screen.findByText('Never deploy on Fridays')
    api.memoryReleaseSupersedes.mockResolvedValueOnce({ success: true, data: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Brought back 3 memories. Search returns them again.')).toBeInTheDocument()

    await screen.findByText('Never deploy on Fridays')
    api.memoryReleaseSupersedes.mockResolvedValueOnce({ success: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Nothing to undo; it was already back.')).toBeInTheDocument()

    api.memoryReleaseSupersedes.mockResolvedValueOnce({ success: false, error: 'Memory is locked' })
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Memory is locked')).toBeInTheDocument()

    api.memoryReleaseSupersedes.mockRejectedValueOnce(new Error('ipc gone'))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText("Couldn't undo that.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).not.toBeDisabled() // a thrown call still ends the undo

    api.memoryReleaseSupersedes.mockResolvedValueOnce({ success: false })
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText("Couldn't undo that.")).toBeInTheDocument()
  })

  it('Refresh loads again', async () => {
    render(<WeekActivity />)
    await screen.findByTestId('memory-week')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh this week' }))
    await waitFor(() => expect(api.memoryActivity).toHaveBeenCalledTimes(2))
  })
})
