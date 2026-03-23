import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
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
})
