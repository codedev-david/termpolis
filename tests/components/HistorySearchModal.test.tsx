import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HistorySearchModal } from '../../src/renderer/src/components/HistorySearch/HistorySearchModal'

const mockResults = [
  { terminalId: 't1', terminalName: 'Terminal 1', command: 'git status', timestamp: Date.now() },
]

describe('HistorySearchModal', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'termpolis', {
      value: { searchHistory: vi.fn().mockResolvedValue({ success: true, data: mockResults }) },
      writable: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
    })
  })

  it('shows search results matching query', async () => {
    render(<HistorySearchModal onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'git' } })
    await waitFor(() => expect(screen.getByText('git status')).toBeInTheDocument(), { timeout: 500 })
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<HistorySearchModal onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('copies command to clipboard and closes when a result is clicked', async () => {
    const onClose = vi.fn()
    render(<HistorySearchModal onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'git' } })
    await waitFor(() => expect(screen.getByText('git status')).toBeInTheDocument(), { timeout: 500 })
    fireEvent.click(screen.getByText('git status'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('git status')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows no results message for unmatched query', async () => {
    ;(window as any).termpolis.searchHistory.mockResolvedValue({ success: true, data: [] })
    render(<HistorySearchModal onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'zzz_no_match' } })
    await waitFor(() => expect(screen.getByText(/No results/)).toBeInTheDocument(), { timeout: 500 })
  })
})
