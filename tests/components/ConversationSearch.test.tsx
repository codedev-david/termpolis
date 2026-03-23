import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector?: any) => {
    const state = {
      conversations: [],
      setActiveTerminal: vi.fn(),
    }
    return selector ? selector(state) : state
  },
}))

import { ConversationSearch } from '../../src/renderer/src/components/ConversationSearch/ConversationSearch'

describe('ConversationSearch', () => {
  it('renders search overlay with input field', () => {
    render(<ConversationSearch onClose={vi.fn()} />)
    expect(screen.getByPlaceholderText('Search AI conversations...')).toBeInTheDocument()
  })

  it('shows empty state when no conversations exist', () => {
    render(<ConversationSearch onClose={vi.fn()} />)
    expect(screen.getByText('No AI conversations indexed yet')).toBeInTheDocument()
  })
})
