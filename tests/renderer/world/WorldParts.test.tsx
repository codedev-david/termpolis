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

  it('scrolls its body under a fixed title and ×, reachable by keyboard, within the cap it is given', () => {
    const html = `<h3>m12</h3>${'<h4>What it does</h4><p>Line</p>'.repeat(20)}`
    const { rerender } = render(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} />)
    const card = screen.getByTestId('world-card')
    const body = screen.getByTestId('world-card-body')
    // Uncapped (a wide pane): the stage less 110 px, as before.
    expect(card.style.maxHeight).toBe('calc(100% - 110px)')
    rerender(<WorldCard html={html} onOpen={vi.fn()} onClose={vi.fn()} maxHeight={132} />)
    expect(card.style.maxHeight).toBe('min(132px, calc(100% - 110px))')
    // The body is the scroller: a region with a name, in the tab order, so arrows and Page Down scroll it.
    expect(body).toHaveAttribute('role', 'region')
    expect(body).toHaveAccessibleName('Details')
    expect(body.tabIndex).toBe(0)
    body.focus()
    expect(document.activeElement).toBe(body)
    // The × sits outside the scroller, and the title row sticks at its top; a visible scrollbar.
    const button = screen.getByRole('button', { name: 'Close details' })
    expect(body.contains(button)).toBe(false)
    const css = card.querySelector('style')?.textContent ?? ''
    expect(css).toMatch(/\.world-card\{display:flex;flex-direction:column;overflow:hidden;/)
    expect(css).toMatch(/\.world-card-body\{flex:1 1 auto;min-height:0;overflow-y:auto;[^}]*scrollbar-color:/)
    expect(css).toMatch(/\.world-card-body > h3:first-child\{position:sticky;top:0;/)
    expect(css).toMatch(/\.world-card-close\{position:absolute;/)
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
