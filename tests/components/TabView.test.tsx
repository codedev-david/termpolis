import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const mockTerminals: any[] = []
let mockActiveId: string | null = null

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector?: any) => {
    const state = {
      terminals: mockTerminals,
      activeTerminalId: mockActiveId,
    }
    return selector ? selector(state) : state
  },
}))

// Mock TerminalPane since it depends on xterm
vi.mock('../../src/renderer/src/components/TerminalPane/TerminalPane', () => ({
  TerminalPane: (props: any) => (
    <div data-testid={`terminal-pane-${props.terminalId}`}>{props.terminalName}</div>
  ),
}))

import { TabView } from '../../src/renderer/src/components/TabView/TabView'

describe('TabView', () => {
  it('shows empty state when no terminals exist', () => {
    mockTerminals.length = 0
    mockActiveId = null
    render(<TabView />)
    expect(screen.getByText(/No terminals open/)).toBeInTheDocument()
    expect(screen.getByText('+ Add Terminal')).toBeInTheDocument()
  })

  it('renders terminal panes when terminals exist', () => {
    mockTerminals.length = 0
    mockTerminals.push(
      { id: 't1', name: 'Terminal 1', shellType: 'bash', cwd: '/home', fontSize: 14, theme: 'dark', fontFamily: 'monospace', color: '#fff' },
      { id: 't2', name: 'Terminal 2', shellType: 'bash', cwd: '/home', fontSize: 14, theme: 'dark', fontFamily: 'monospace', color: '#fff' },
    )
    mockActiveId = 't1'
    render(<TabView />)
    expect(screen.getByTestId('terminal-pane-t1')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-pane-t2')).toBeInTheDocument()
  })
})
