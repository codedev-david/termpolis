import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorldCard } from '../../../src/renderer/src/components/World/WorldCard'
import { WorldEmptyState } from '../../../src/renderer/src/components/World/WorldEmptyState'

describe('WorldCard', () => {
  it('opens the part a data-node or data-edge link names, and ignores other clicks', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    render(<WorldCard html={'<h3>T</h3><a data-node="b1">B</a><a data-edge="e1">E</a>'} onOpen={onOpen} onClose={onClose} />)
    fireEvent.click(screen.getByText('T'))
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('B'))
    expect(onOpen).toHaveBeenLastCalledWith('b1')
    fireEvent.click(screen.getByText('E'))
    expect(onOpen).toHaveBeenLastCalledWith('e1')
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('WorldEmptyState', () => {
  it('an error without a retry handler shows no retry button', () => {
    render(<WorldEmptyState mode="error" error="nope" />)
    expect(screen.getByTestId('world-error')).toHaveTextContent('nope')
    expect(screen.queryByTestId('world-retry')).toBeNull()
  })

  it('mapping without a progress prop starts at zero', () => {
    render(<WorldEmptyState mode="mapping" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('Mapping your project…')).toBeInTheDocument()
  })
})
