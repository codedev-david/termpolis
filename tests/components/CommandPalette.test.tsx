import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const mockTerminals = [
  { id: 't1', name: 'Terminal 1', hidden: false },
  { id: 't2', name: 'Dev Server', hidden: false },
]

const mockPromptTemplates = [
  { id: 'custom1', name: 'My Custom', text: 'Custom prompt text', icon: 'fa-solid fa-star', isCustom: true },
]

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: mockTerminals,
        activeTerminalId: 't1',
        promptTemplates: mockPromptTemplates,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: mockTerminals,
        activeTerminalId: 't1',
        setActiveTerminal: vi.fn(),
      })),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/types', () => ({}))

beforeAll(() => {
  ;(window as any).termpolis = {
    writeToTerminal: vi.fn(),
  }
})

import { CommandPalette } from '../../src/renderer/src/components/CommandPalette/CommandPalette'

describe('CommandPalette', () => {
  it('renders input field and command list', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByPlaceholderText('Type a command...')).toBeInTheDocument()
    // All commands are shown when input is empty
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    expect(screen.getByText('Split Right')).toBeInTheDocument()
  })

  it('filters commands when typing', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(input, { target: { value: 'new terminal' } })
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    // Other non-matching commands should not appear
    expect(screen.queryByText('Split Right')).not.toBeInTheDocument()
  })

  it('calls onAction with correct action when command clicked', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={onClose} />)
    fireEvent.click(screen.getByText('New Terminal'))
    expect(onAction).toHaveBeenCalledWith('create_terminal', undefined)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape pressed', () => {
    const onClose = vi.fn()
    render(<CommandPalette onAction={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('navigates with ArrowDown and ArrowUp keys', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    // Exercises keyboard navigation handler
  })

  it('executes command on Enter key', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={onClose} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('shows multiple built-in commands', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    // Some of the standard commands that should always be visible
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    expect(screen.getByText('Split Right')).toBeInTheDocument()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(<CommandPalette onAction={vi.fn()} onClose={onClose} />)
    const backdrop = container.firstChild as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls correct action for split_right command', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={onClose} />)
    fireEvent.click(screen.getByText('Split Right'))
    expect(onAction).toHaveBeenCalledWith('split_right', undefined)
  })

  it('shows prompt templates from store', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    // Custom prompt template should appear
    expect(screen.getByText('My Custom')).toBeInTheDocument()
  })

  it('filters to show prompt templates when typed', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(input, { target: { value: 'my custom' } })
    expect(screen.getByText('My Custom')).toBeInTheDocument()
  })
})
