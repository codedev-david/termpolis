import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { GridView } from '../../src/renderer/src/components/GridView/GridView'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

vi.mock('../../src/renderer/src/components/TerminalPane/TerminalPane', () => ({
  TerminalPane: ({ terminalId }: any) => <div data-testid={`pane-${terminalId}`} />,
}))

vi.mock('../../src/renderer/src/store/terminalStore')

describe('GridView', () => {
  it('shows empty state when no terminals', () => {
    vi.mocked(useTerminalStore).mockReturnValue({ terminals: [], removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByText(/No terminals/i)).toBeInTheDocument()
  })

  it('renders a pane for each terminal', () => {
    const terminals = [
      { id: 't1', name: 'T1', color: '#4FC3F7', shellType: 'bash' as const, cwd: '/' },
      { id: 't2', name: 'T2', color: '#A5D6A7', shellType: 'zsh' as const, cwd: '/' },
    ]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByTestId('pane-t1')).toBeInTheDocument()
    expect(screen.getByTestId('pane-t2')).toBeInTheDocument()
  })
})
