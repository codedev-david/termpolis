import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GridView } from '../../src/renderer/src/components/GridView/GridView'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

let capturedOnTerminalReady: ((term: any) => void) | null = null
vi.mock('../../src/renderer/src/components/TerminalPane/TerminalPane', () => ({
  TerminalPane: ({ terminalId, onTerminalReady }: any) => {
    // Capture the onTerminalReady callback so tests can invoke it
    capturedOnTerminalReady = onTerminalReady || null
    return <div data-testid={`pane-${terminalId}`} />
  },
}))

vi.mock('../../src/renderer/src/lib/exportTerminal', () => ({
  extractBuffer: vi.fn(() => 'buffer'),
  generateFilename: vi.fn(() => 'export.txt'),
}))

vi.mock('../../src/renderer/src/store/terminalStore')

// Mock IntersectionObserver globally before any component renders
class MockIntersectionObserver {
  private cb: any
  constructor(cb: any) {
    this.cb = cb
  }
  observe() { this.cb([{ isIntersecting: true }]) }
  disconnect() {}
  unobserve() {}
}
;(window as any).IntersectionObserver = MockIntersectionObserver

beforeEach(() => {
  capturedOnTerminalReady = null
  ;(window as any).termpolis = {
    killTerminal: vi.fn(),
    exportTerminal: vi.fn(),
  }
})

const fullTerminal = (id: string, name: string) => ({
  id,
  name,
  color: '#4FC3F7',
  shellType: 'bash' as const,
  cwd: '/',
  fontSize: 14,
  theme: 'dark',
  fontFamily: 'monospace',
})

describe('GridView', () => {
  it('shows empty state when no terminals', () => {
    vi.mocked(useTerminalStore).mockReturnValue({ terminals: [], removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByText(/No terminals/i)).toBeInTheDocument()
  })

  it('shows "Add Terminal" hint in empty state', () => {
    vi.mocked(useTerminalStore).mockReturnValue({ terminals: [], removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByText('+ Add Terminal')).toBeInTheDocument()
  })

  it('renders a pane for each terminal', () => {
    const terminals = [fullTerminal('t1', 'T1'), fullTerminal('t2', 'T2')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByTestId('pane-t1')).toBeInTheDocument()
    expect(screen.getByTestId('pane-t2')).toBeInTheDocument()
  })

  it('renders terminal names in card headers', () => {
    const terminals = [fullTerminal('t1', 'Dev Shell'), fullTerminal('t2', 'Build')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByText('Dev Shell')).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
  })

  it('renders close button for each terminal card', () => {
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByLabelText('Close T1')).toBeInTheDocument()
  })

  it('calls killTerminal and removeTerminal when close is clicked', () => {
    const removeTerminal = vi.fn()
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal } as any)
    render(<GridView />)
    fireEvent.click(screen.getByLabelText('Close T1'))
    expect((window as any).termpolis.killTerminal).toHaveBeenCalledWith('t1')
    expect(removeTerminal).toHaveBeenCalledWith('t1')
  })

  it('renders export button for each terminal card', () => {
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(screen.getByLabelText('Export T1')).toBeInTheDocument()
  })

  it('renders color border on card header', () => {
    const terminals = [{ ...fullTerminal('t1', 'T1'), color: '#FF0000' }]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    const { container } = render(<GridView />)
    const header = container.querySelector('.bg-\\[\\#2d2d2d\\]') as HTMLElement
    expect(header.style.borderLeft).toContain('solid')
  })

  it('renders single terminal in 1fr grid', () => {
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    const { container } = render(<GridView />)
    const grid = container.firstChild as HTMLElement
    expect(grid.style.gridTemplateColumns).toBe('1fr')
  })

  it('renders two terminals in 2-column grid', () => {
    const terminals = [fullTerminal('t1', 'T1'), fullTerminal('t2', 'T2')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    const { container } = render(<GridView />)
    const grid = container.firstChild as HTMLElement
    expect(grid.style.gridTemplateColumns).toBe('1fr 1fr')
  })

  it('renders three terminals with last spanning full width', () => {
    const terminals = [fullTerminal('t1', 'T1'), fullTerminal('t2', 'T2'), fullTerminal('t3', 'T3')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    const { container } = render(<GridView />)
    // The last card (index 2, total 3) should have gridColumn: 1 / -1
    const cards = container.querySelectorAll('.flex.flex-col.bg-\\[\\#1e1e1e\\]')
    const lastCard = cards[cards.length - 1] as HTMLElement
    expect(lastCard.style.gridColumn).toBe('1 / -1')
  })

  it('even count terminals do not span full width', () => {
    const terminals = [fullTerminal('t1', 'T1'), fullTerminal('t2', 'T2'), fullTerminal('t3', 'T3'), fullTerminal('t4', 'T4')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    const { container } = render(<GridView />)
    const cards = container.querySelectorAll('.flex.flex-col.bg-\\[\\#1e1e1e\\]')
    const lastCard = cards[cards.length - 1] as HTMLElement
    expect(lastCard.style.gridColumn).toBe('')
  })

  it('export button is a no-op when terminal instance is not ready', () => {
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    fireEvent.click(screen.getByLabelText('Export T1'))
    // exportTerminal should not be called since termInstanceRef.current is null
    expect((window as any).termpolis.exportTerminal).not.toHaveBeenCalled()
  })

  it('IntersectionObserver tracks viewport visibility', () => {
    // The mock IntersectionObserver fires immediately with isIntersecting: true
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    // Terminal pane should be rendered (visible)
    expect(screen.getByTestId('pane-t1')).toBeInTheDocument()
  })

  it('export works when terminal instance is ready via onTerminalReady', () => {
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)

    // Simulate terminal becoming ready
    if (capturedOnTerminalReady) {
      capturedOnTerminalReady({ buffer: { active: { length: 0 } } })
    }

    fireEvent.click(screen.getByLabelText('Export T1'))
    expect((window as any).termpolis.exportTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'buffer', defaultFilename: 'export.txt' })
    )
  })

  it('handleTerminalReady captures terminal instance', () => {
    const terminals = [fullTerminal('t1', 'T1')]
    vi.mocked(useTerminalStore).mockReturnValue({ terminals, removeTerminal: vi.fn() } as any)
    render(<GridView />)
    expect(capturedOnTerminalReady).toBeInstanceOf(Function)
    // Calling it should not throw
    capturedOnTerminalReady!({ cols: 80, rows: 24 })
  })
})
