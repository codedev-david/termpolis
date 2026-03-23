import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

// Mock createPortal to render in place
vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom')
  return {
    ...actual,
    createPortal: (node: any) => node,
  }
})

// Mock TabPopover
vi.mock('../../src/renderer/src/components/TabPopover/TabPopover', () => ({
  TabPopover: () => <div data-testid="tab-popover">Popover</div>,
}))

import { TerminalTab } from '../../src/renderer/src/components/Sidebar/TerminalTab'

const mockTerminal = {
  id: 'term-1',
  name: 'My Terminal',
  color: '#22D3EE',
  shellType: 'bash' as const,
  cwd: '/home/user',
  fontSize: 14,
  theme: 'dark',
  fontFamily: 'monospace',
}

describe('TerminalTab', () => {
  it('renders terminal name and close button', () => {
    render(
      <TerminalTab
        terminal={mockTerminal as any}
        index={0}
        isActive={false}
        onClick={vi.fn()}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText('My Terminal')).toBeInTheDocument()
    expect(screen.getByLabelText('Close My Terminal')).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <TerminalTab
        terminal={mockTerminal as any}
        index={0}
        isActive={false}
        onClick={vi.fn()}
        onClose={onClose}
        onUpdate={vi.fn()}
      />
    )
    fireEvent.click(screen.getByLabelText('Close My Terminal'))
    expect(onClose).toHaveBeenCalled()
  })
})
