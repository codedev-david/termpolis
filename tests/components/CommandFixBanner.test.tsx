import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CommandFixBanner } from '../../src/renderer/src/components/CommandFix/CommandFixBanner'

describe('CommandFixBanner', () => {
  it('renders suggestion text', () => {
    render(<CommandFixBanner suggestion="git stash" onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText('git stash')).toBeInTheDocument()
  })

  it('shows Enter to apply and Esc to ignore hint', () => {
    render(<CommandFixBanner suggestion="npm install" onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/Enter to run/)).toBeInTheDocument()
    expect(screen.getByText(/Esc to ignore/)).toBeInTheDocument()
  })

  it('calls onAccept when Enter pressed and onDismiss when Escape pressed', () => {
    const onAccept = vi.fn()
    const onDismiss = vi.fn()
    render(<CommandFixBanner suggestion="ls -la" onAccept={onAccept} onDismiss={onDismiss} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onAccept).toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalled()
  })
})
