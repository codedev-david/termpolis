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
})
