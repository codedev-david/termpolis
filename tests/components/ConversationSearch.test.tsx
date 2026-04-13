import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Module-scope variables for dynamic mock state
let mockConversations: any[] = []
const mockSetActiveTerminal = vi.fn()

beforeEach(() => {
  mockConversations = []
  mockSetActiveTerminal.mockClear()
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        conversations: mockConversations,
        setActiveTerminal: mockSetActiveTerminal,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        conversations: mockConversations,
      })),
      setState: vi.fn(),
    },
  ),
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

  it('shows conversation count summary when conversations exist and no query', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'Hello AI', timestamp: 1, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
          { role: 'assistant', content: 'Hi there!', timestamp: 2, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)
    expect(screen.getByText(/2 turns across 1 conversation/)).toBeInTheDocument()
  })

  it('shows plural conversations label when multiple conversations exist', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'Hello', timestamp: 1, terminalId: 'term-1', terminalName: 'T1', agentName: 'Claude' },
        ],
      },
      {
        terminalId: 'term-2',
        turns: [
          { role: 'user', content: 'World', timestamp: 2, terminalId: 'term-2', terminalName: 'T2', agentName: 'Claude' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)
    expect(screen.getByText(/2 turns across 2 conversations/)).toBeInTheDocument()
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    render(<ConversationSearch onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop overlay is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<ConversationSearch onClose={onClose} />)
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn()
    render(<ConversationSearch onClose={onClose} />)
    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.click(input)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('filters conversations by search query', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'How do I fix the bug in login?', timestamp: 1, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
          { role: 'assistant', content: 'Check the authentication middleware', timestamp: 2, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
          { role: 'user', content: 'How about the database schema?', timestamp: 3, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'bug' } })

    // Should find the turn with 'bug' in it
    expect(screen.getByText(/How do I fix the/)).toBeInTheDocument()
    // Should NOT show unmatched turns
    expect(screen.queryByText(/database schema/)).not.toBeInTheDocument()
  })

  it('shows "No matching conversations" when search has no results', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'Hello world', timestamp: 1, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'xyznonexistent' } })

    expect(screen.getByText('No matching conversations')).toBeInTheDocument()
  })

  it('shows role labels (You/AI) in search results', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'Fix the login bug please', timestamp: 1, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
          { role: 'assistant', content: 'I fixed the login issue', timestamp: 2, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'login' } })

    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
  })

  it('groups results by terminal and shows agent name', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'Search for this term', timestamp: 1, terminalId: 'term-1', terminalName: 'Terminal 1', agentName: 'Claude' },
        ],
      },
      {
        terminalId: 'term-2',
        turns: [
          { role: 'assistant', content: 'Search for this term too', timestamp: 2, terminalId: 'term-2', terminalName: 'Terminal 2', agentName: 'Codex' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'Search for this' } })

    // Should show both agent names as group headers
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('in Terminal 1')).toBeInTheDocument()
    expect(screen.getByText('in Terminal 2')).toBeInTheDocument()
  })

  it('selects terminal and closes when a result is clicked', () => {
    mockConversations = [
      {
        terminalId: 'term-42',
        turns: [
          { role: 'user', content: 'Clickable result text', timestamp: 1, terminalId: 'term-42', terminalName: 'Terminal 42', agentName: 'Claude' },
        ],
      },
    ]
    const onClose = vi.fn()
    render(<ConversationSearch onClose={onClose} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'Clickable' } })

    // Click the result button
    const resultButton = screen.getByRole('button', { name: /Clickable result text/ })
    fireEvent.click(resultButton)

    expect(mockSetActiveTerminal).toHaveBeenCalledWith('term-42')
    expect(onClose).toHaveBeenCalled()
  })

  it('performs case-insensitive search', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'UPPERCASE content here', timestamp: 1, terminalId: 'term-1', terminalName: 'T1', agentName: 'Claude' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'uppercase' } })

    // The highlight function splits text, so look for the mark element and surrounding text
    expect(screen.getByText('UPPERCASE')).toBeInTheDocument()
    expect(screen.getByText(/content here/)).toBeInTheDocument()
  })

  it('highlights matching text in results', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'Find the bug in production', timestamp: 1, terminalId: 'term-1', terminalName: 'T1', agentName: 'Claude' },
        ],
      },
    ]
    const { container } = render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'bug' } })

    // The matching text should be wrapped in a <mark> element
    const mark = container.querySelector('mark')
    expect(mark).toBeTruthy()
    expect(mark!.textContent).toBe('bug')
  })

  it('shows footer text with instructions', () => {
    render(<ConversationSearch onClose={vi.fn()} />)
    expect(screen.getByText(/Click a result to switch to that terminal/)).toBeInTheDocument()
  })

  it('limits results to 50 matches', () => {
    // Create conversation with 60 matching turns
    const turns = Array.from({ length: 60 }, (_, i) => ({
      role: 'user' as const,
      content: `Match item number ${i}`,
      timestamp: i,
      terminalId: 'term-1',
      terminalName: 'T1',
      agentName: 'Claude',
    }))
    mockConversations = [{ terminalId: 'term-1', turns }]

    render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: 'Match item' } })

    // Should only show 50 result buttons
    const resultButtons = screen.getAllByRole('button').filter(b => b.textContent?.includes('Match item'))
    expect(resultButtons.length).toBe(50)
  })

  it('shows Esc keyboard hint', () => {
    render(<ConversationSearch onClose={vi.fn()} />)
    expect(screen.getByText('Esc')).toBeInTheDocument()
  })

  it('returns empty results for whitespace-only query', () => {
    mockConversations = [
      {
        terminalId: 'term-1',
        turns: [
          { role: 'user', content: 'Some content', timestamp: 1, terminalId: 'term-1', terminalName: 'T1', agentName: 'Claude' },
        ],
      },
    ]
    render(<ConversationSearch onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('Search AI conversations...')
    fireEvent.change(input, { target: { value: '   ' } })

    // Whitespace query is truthy but trim() is empty, so results array is empty
    // The component checks `query && results.length === 0` which shows "No matching conversations"
    expect(screen.getByText('No matching conversations')).toBeInTheDocument()
  })
})
