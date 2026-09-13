import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CompletionDropdown } from '../../src/renderer/src/components/CompletionDropdown/CompletionDropdown'

const suggestions = [
  { text: 'commit', description: 'Record changes', source: 'spec' as const },
  { text: 'config', description: 'Get and set options', source: 'spec' as const },
]

describe('CompletionDropdown', () => {
  it('renders suggestions', () => {
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={0} position={{ x: 100, y: 200 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText('commit')).toBeInTheDocument()
    expect(screen.getByText('config')).toBeInTheDocument()
  })

  it('shows descriptions', () => {
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={0} position={{ x: 100, y: 200 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText('Record changes')).toBeInTheDocument()
  })

  it('renders keyboard hints footer', () => {
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={0} position={{ x: 100, y: 200 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/Tab accept/)).toBeInTheDocument()
  })

  it('renders nothing when suggestions is empty', () => {
    const { container } = render(<CompletionDropdown suggestions={[]} selectedIndex={0} position={{ x: 100, y: 200 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  // A mouse pick must insert the row the pointer is on. Handing back the
  // keyboard-highlighted entry instead is the classic completion-menu bug: the
  // user clicks 'config' and 'commit' lands in the shell.
  it('accepts the clicked suggestion, not the keyboard-highlighted one', () => {
    const onAccept = vi.fn()
    const onDismiss = vi.fn()
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={0} position={{ x: 100, y: 200 }} onAccept={onAccept} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByText('config'))

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept).toHaveBeenCalledWith(suggestions[1])
    // Dismissal is the parent's job — accepting must not also self-dismiss.
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('accepts the highlighted row when that is the row clicked', () => {
    const onAccept = vi.fn()
    render(<CompletionDropdown suggestions={suggestions} selectedIndex={1} position={{ x: 0, y: 0 }} onAccept={onAccept} onDismiss={vi.fn()} />)

    fireEvent.click(screen.getByText('commit'))

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept).toHaveBeenCalledWith(suggestions[0])
  })

  it('marks exactly one row as selected and styles it apart from the others', () => {
    const { container } = render(<CompletionDropdown suggestions={suggestions} selectedIndex={1} position={{ x: 0, y: 0 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)

    const marked = container.querySelectorAll('[data-selected]')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain('config')
    expect(marked[0].className).toContain('bg-[#04395e]')

    const unselected = screen.getByText('commit').parentElement!
    expect(unselected.hasAttribute('data-selected')).toBe(false)
    expect(unselected.className).toContain('hover:bg-[#2a2d2e]')
  })

  it('pins itself at the supplied caret coordinates', () => {
    const { container } = render(<CompletionDropdown suggestions={suggestions} selectedIndex={0} position={{ x: 120, y: 240 }} onAccept={vi.fn()} onDismiss={vi.fn()} />)

    const root = container.firstChild as HTMLElement
    expect(root.style.position).toBe('fixed')
    expect(root.style.left).toBe('120px')
    expect(root.style.top).toBe('240px')
  })

  it('renders one clickable row per suggestion, in order', () => {
    const three = [
      ...suggestions,
      { text: 'checkout', description: 'Switch branches', source: 'spec' as const },
    ]
    const onAccept = vi.fn()
    const { container } = render(<CompletionDropdown suggestions={three} selectedIndex={0} position={{ x: 0, y: 0 }} onAccept={onAccept} onDismiss={vi.fn()} />)

    const rows = container.querySelectorAll('[class*="cursor-pointer"]')
    expect(rows).toHaveLength(3)
    expect(Array.from(rows).map(r => r.querySelector('span')!.textContent)).toEqual(['commit', 'config', 'checkout'])

    fireEvent.click(screen.getByText('checkout'))
    expect(onAccept).toHaveBeenCalledWith(three[2])
  })
})
