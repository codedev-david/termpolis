import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PaneNode } from '../../../src/renderer/src/types'

// Mock TerminalPane since it requires xterm
vi.mock('../../../src/renderer/src/components/TerminalPane/TerminalPane', () => ({
  TerminalPane: (props: any) => (
    <div data-testid={`terminal-pane-${props.terminalId}`} />
  ),
}))

// Mock exportTerminal
vi.mock('../../../src/renderer/src/lib/exportTerminal', () => ({
  extractBuffer: vi.fn(() => 'buffer content'),
  generateFilename: vi.fn(() => 'export.txt'),
}))

// Store mock state
let mockTerminals: any[] = []
let mockActiveTerminalId: string | null = null
const mockSetActiveTerminal = vi.fn()
const mockRemoveTerminal = vi.fn()
const mockSplitTerminal = vi.fn()

vi.mock('../../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector: (s: any) => any) => {
      const state = {
        terminals: mockTerminals,
        activeTerminalId: mockActiveTerminalId,
        setActiveTerminal: mockSetActiveTerminal,
        removeTerminal: mockRemoveTerminal,
        splitTerminal: mockSplitTerminal,
      }
      return selector(state)
    },
    {
      getState: vi.fn(() => ({
        terminals: mockTerminals,
        activeTerminalId: mockActiveTerminalId,
      })),
      setState: vi.fn(),
    },
  ),
}))

import { PaneRenderer } from '../../../src/renderer/src/components/SplitView/PaneRenderer'

beforeEach(() => {
  vi.clearAllMocks()
  mockTerminals = [
    {
      id: 't1',
      name: 'Terminal 1',
      color: '#22D3EE',
      shellType: 'bash',
      cwd: '/home/user',
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'monospace',
    },
    {
      id: 't2',
      name: 'Terminal 2',
      color: '#D97706',
      shellType: 'powershell',
      cwd: '/home/dev',
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'monospace',
    },
    {
      id: 't3',
      name: 'Terminal 3',
      color: '#10B981',
      shellType: 'bash',
      cwd: '/tmp',
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'monospace',
    },
  ]
  mockActiveTerminalId = 't1'
  ;(window as any).termpolis = {
    killTerminal: vi.fn(),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    exportTerminal: vi.fn(),
  }
})

describe('PaneRenderer', () => {
  // -- Single terminal pane --

  it('renders a single terminal pane for terminal node', () => {
    const node: PaneNode = { type: 'terminal', terminalId: 't1' }
    render(<PaneRenderer node={node} />)
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
  })

  it('renders terminal name in the pane header', () => {
    const node: PaneNode = { type: 'terminal', terminalId: 't2' }
    render(<PaneRenderer node={node} />)
    expect(screen.getByText('Terminal 2')).toBeInTheDocument()
  })

  it('renders the TerminalPane component with correct terminalId', () => {
    const node: PaneNode = { type: 'terminal', terminalId: 't1' }
    render(<PaneRenderer node={node} />)
    expect(screen.getByTestId('terminal-pane-t1')).toBeInTheDocument()
  })

  it('renders nothing when terminal is not found in store', () => {
    const node: PaneNode = { type: 'terminal', terminalId: 'nonexistent' }
    const { container } = render(<PaneRenderer node={node} />)
    // TerminalPaneWrapper returns null when terminal not found
    expect(container.innerHTML).toBe('')
  })

  it('shows close button with aria-label', () => {
    const node: PaneNode = { type: 'terminal', terminalId: 't1' }
    render(<PaneRenderer node={node} />)
    expect(screen.getByLabelText('Close Terminal 1')).toBeInTheDocument()
  })

  it('shows split right and split down buttons', () => {
    const node: PaneNode = { type: 'terminal', terminalId: 't1' }
    render(<PaneRenderer node={node} />)
    expect(screen.getByTitle('Split Right')).toBeInTheDocument()
    expect(screen.getByTitle('Split Down')).toBeInTheDocument()
  })

  it('shows export button', () => {
    const node: PaneNode = { type: 'terminal', terminalId: 't1' }
    render(<PaneRenderer node={node} />)
    expect(screen.getByTitle('Export terminal output')).toBeInTheDocument()
  })

  // -- Split layout with divider --

  it('renders split layout with two children and a divider', () => {
    const node: PaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 't1' },
        { type: 'terminal', terminalId: 't2' },
      ],
    }
    render(<PaneRenderer node={node} />)
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    expect(screen.getByText('Terminal 2')).toBeInTheDocument()
  })

  it('renders horizontal split with flex-col layout', () => {
    const node: PaneNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 't1' },
        { type: 'terminal', terminalId: 't2' },
      ],
    }
    const { container } = render(<PaneRenderer node={node} />)
    const splitContainer = container.firstChild as HTMLElement
    expect(splitContainer.classList.contains('flex-col')).toBe(true)
  })

  it('renders vertical split with flex-row layout', () => {
    const node: PaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 't1' },
        { type: 'terminal', terminalId: 't2' },
      ],
    }
    const { container } = render(<PaneRenderer node={node} />)
    const splitContainer = container.firstChild as HTMLElement
    expect(splitContainer.classList.contains('flex-row')).toBe(true)
  })

  it('renders divider element between split panes', () => {
    const node: PaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 't1' },
        { type: 'terminal', terminalId: 't2' },
      ],
    }
    const { container } = render(<PaneRenderer node={node} />)
    const divider = container.querySelector('.shrink-0')
    expect(divider).toBeInTheDocument()
  })

  // -- Nested splits --

  it('handles nested splits recursively', () => {
    const node: PaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.6,
          children: [
            { type: 'terminal', terminalId: 't1' },
            { type: 'terminal', terminalId: 't2' },
          ],
        },
        { type: 'terminal', terminalId: 't3' },
      ],
    }
    render(<PaneRenderer node={node} />)
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    expect(screen.getByText('Terminal 2')).toBeInTheDocument()
    expect(screen.getByText('Terminal 3')).toBeInTheDocument()
  })

  it('renders multiple dividers for nested splits', () => {
    const node: PaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          children: [
            { type: 'terminal', terminalId: 't1' },
            { type: 'terminal', terminalId: 't2' },
          ],
        },
        { type: 'terminal', terminalId: 't3' },
      ],
    }
    const { container } = render(<PaneRenderer node={node} />)
    const dividers = container.querySelectorAll('.shrink-0.bg-\\[\\#3c3c3c\\]')
    expect(dividers.length).toBe(2)
  })

  // -- Ratio applied via flex style --

  it('applies ratio to first child flex style', () => {
    const node: PaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.7,
      children: [
        { type: 'terminal', terminalId: 't1' },
        { type: 'terminal', terminalId: 't2' },
      ],
    }
    const { container } = render(<PaneRenderer node={node} />)
    const splitContainer = container.firstChild as HTMLElement
    const firstChild = splitContainer.children[0] as HTMLElement
    const lastChild = splitContainer.children[2] as HTMLElement
    expect(firstChild.style.flex).toContain('0.7')
    expect(lastChild.style.flex).toContain('0.3')
  })

  // -- onSplitRatioChange callback --

  it('passes onSplitRatioChange with correct path to children', () => {
    const onSplitRatioChange = vi.fn()
    const node: PaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 't1' },
        { type: 'terminal', terminalId: 't2' },
      ],
    }
    // Just verify it renders without error when callback is provided
    render(<PaneRenderer node={node} onSplitRatioChange={onSplitRatioChange} />)
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
  })
})
