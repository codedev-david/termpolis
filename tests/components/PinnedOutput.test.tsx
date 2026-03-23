import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PinnedOutput } from '../../src/renderer/src/components/PinnedOutput/PinnedOutput'
import type { PinnedItem } from '../../src/renderer/src/components/PinnedOutput/PinnedOutput'

const pins: PinnedItem[] = [
  { id: 'pin-1', text: 'Error: module not found', timestamp: Date.now(), terminalName: 'Dev' },
  { id: 'pin-2', text: 'BUILD SUCCESS', timestamp: Date.now(), terminalName: 'Build' },
]

describe('PinnedOutput', () => {
  it('renders pinned items with text after expanding', () => {
    render(<PinnedOutput pins={pins} onUnpin={vi.fn()} />)
    // Header shows count
    expect(screen.getByText('2 pinned')).toBeInTheDocument()
    // Expand to see pinned content
    fireEvent.click(screen.getByText('2 pinned'))
    expect(screen.getByText('Error: module not found')).toBeInTheDocument()
    expect(screen.getByText('BUILD SUCCESS')).toBeInTheDocument()
  })

  it('calls onUnpin when X clicked on a pin', () => {
    const onUnpin = vi.fn()
    render(<PinnedOutput pins={pins} onUnpin={onUnpin} />)
    // Expand first
    fireEvent.click(screen.getByText('2 pinned'))
    // Click unpin on the first pin (the xmark buttons)
    const unpinButtons = screen.getAllByTitle('Unpin')
    fireEvent.click(unpinButtons[0])
    expect(onUnpin).toHaveBeenCalledWith('pin-1')
  })
})
