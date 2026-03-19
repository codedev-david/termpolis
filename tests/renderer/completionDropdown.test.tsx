import React from 'react'
import { render, screen } from '@testing-library/react'
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
})
