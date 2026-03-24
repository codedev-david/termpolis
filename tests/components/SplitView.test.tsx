import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PaneNode } from '../../src/renderer/src/types'

// Mock PaneRenderer — it requires live xterm instances
vi.mock('../../src/renderer/src/components/SplitView/PaneRenderer', () => ({
  PaneRenderer: ({ node, onSplitRatioChange }: { node: PaneNode; onSplitRatioChange: (path: number[], ratio: number) => void }) => (
    <div data-testid="pane-renderer" data-node-type={node.type}>
      <button onClick={() => onSplitRatioChange([0], 0.7)}>change-ratio</button>
    </div>
  ),
}))

// Mock the store
const mockSetPaneTree = vi.fn()
let mockPaneTree: PaneNode | null = null

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector: (s: any) => any) => {
      const state = { paneTree: mockPaneTree, setPaneTree: mockSetPaneTree }
      return selector(state)
    },
    {
      getState: vi.fn(() => ({
        paneTree: mockPaneTree,
        setPaneTree: mockSetPaneTree,
      })),
      setState: vi.fn(),
    },
  ),
}))

import { SplitView } from '../../src/renderer/src/components/SplitView/SplitView'

describe('SplitView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPaneTree = null
  })

  it('shows empty state message when paneTree is null', () => {
    render(<SplitView />)
    expect(screen.getByText(/No terminals open/)).toBeInTheDocument()
  })

  it('shows Add Terminal hint in empty state', () => {
    render(<SplitView />)
    expect(screen.getByText('+ Add Terminal')).toBeInTheDocument()
  })

  it('renders PaneRenderer when paneTree is set', () => {
    mockPaneTree = { type: 'terminal', terminalId: 'term-1' }
    render(<SplitView />)
    expect(screen.getByTestId('pane-renderer')).toBeInTheDocument()
  })

  it('passes the pane tree node type to PaneRenderer', () => {
    mockPaneTree = { type: 'terminal', terminalId: 'term-1' }
    render(<SplitView />)
    expect(screen.getByTestId('pane-renderer').dataset.nodeType).toBe('terminal')
  })

  it('calls setPaneTree with updated ratio when onSplitRatioChange fires', () => {
    mockPaneTree = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            { type: 'terminal', terminalId: 't1' },
            { type: 'terminal', terminalId: 't2' },
          ],
        },
        { type: 'terminal', terminalId: 't3' },
      ],
    }
    render(<SplitView />)
    screen.getByText('change-ratio').click()
    expect(mockSetPaneTree).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        children: expect.arrayContaining([
          expect.objectContaining({ ratio: 0.7 }),
        ]),
      })
    )
  })

  it('does not render PaneRenderer in the empty state', () => {
    render(<SplitView />)
    expect(screen.queryByTestId('pane-renderer')).not.toBeInTheDocument()
  })
})
