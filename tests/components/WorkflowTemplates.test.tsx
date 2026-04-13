import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// Module-scope variables for dynamic mock state
let mockTerminals: any[] = []
let mockViewMode = 'tabs'
const mockRemoveTerminal = vi.fn()
const mockAddTerminal = vi.fn()
const mockSetPaneTree = vi.fn()
const mockSetActiveTerminal = vi.fn()
const mockToggleViewMode = vi.fn()

beforeAll(() => {
  ;(window as any).termpolis = {
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
  }
})

beforeEach(() => {
  mockTerminals = []
  mockViewMode = 'tabs'
  mockRemoveTerminal.mockClear()
  mockAddTerminal.mockClear()
  mockSetPaneTree.mockClear()
  mockSetActiveTerminal.mockClear()
  mockToggleViewMode.mockClear()
  vi.mocked((window as any).termpolis.killTerminal).mockClear()
  vi.mocked((window as any).termpolis.createTerminal).mockClear()
  vi.mocked((window as any).termpolis.writeToTerminal).mockClear()
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: mockTerminals,
        viewMode: mockViewMode,
        removeTerminal: mockRemoveTerminal,
        addTerminal: mockAddTerminal,
        setPaneTree: mockSetPaneTree,
        setActiveTerminal: mockSetActiveTerminal,
        toggleViewMode: mockToggleViewMode,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({ viewMode: mockViewMode })),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/test'),
}))

import { WorkflowTemplates } from '../../src/renderer/src/components/WorkflowTemplates/WorkflowTemplates'

describe('WorkflowTemplates', () => {
  it('renders workflow template list with heading', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Workflow Templates')).toBeInTheDocument()
  })

  it('shows all template names and descriptions', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Claude Code + Shell')).toBeInTheDocument()
    expect(screen.getByText('Claude Code on the left, shell on the right')).toBeInTheDocument()
    expect(screen.getByText('Full Stack Dev')).toBeInTheDocument()
    expect(screen.getByText('AI agent + frontend + backend + tests')).toBeInTheDocument()
    expect(screen.getByText('Code Review')).toBeInTheDocument()
    expect(screen.getByText('AI reviewer + git log + diff viewer')).toBeInTheDocument()
  })

  it('renders a Launch button for each workflow template', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    const launchButtons = screen.getAllByText('Launch')
    expect(launchButtons).toHaveLength(3)
  })

  it('shows terminal tags for each workflow', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    // Claude Code + Shell template terminals
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Shell')).toBeInTheDocument()
    // Full Stack Dev template terminals
    expect(screen.getByText('AI Agent')).toBeInTheDocument()
    expect(screen.getByText('Frontend')).toBeInTheDocument()
    expect(screen.getByText('Backend')).toBeInTheDocument()
    expect(screen.getByText('Tests')).toBeInTheDocument()
    // Code Review template terminals
    expect(screen.getByText('AI Review')).toBeInTheDocument()
    expect(screen.getByText('Git')).toBeInTheDocument()
  })

  it('shows warning footer about closing terminals', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Launching a workflow will close all current terminals.')).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)
    // The close button has an xmark icon
    const buttons = screen.getAllByRole('button')
    // First button is the close (x) button in the header
    const closeButton = buttons[0]
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop overlay is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<WorkflowTemplates onClose={onClose} />)
    // Click the outermost overlay div
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)
    // Click on the heading text inside the modal
    fireEvent.click(screen.getByText('Workflow Templates'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('launches workflow: kills existing terminals and creates new ones', async () => {
    mockTerminals = [
      { id: 'existing-1', name: 'Old Terminal' },
      { id: 'existing-2', name: 'Old Terminal 2' },
    ]
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    // Click the first Launch button (Claude Code + Shell - 2 terminals)
    const launchButtons = screen.getAllByText('Launch')
    fireEvent.click(launchButtons[0])

    await waitFor(() => {
      // Should have killed existing terminals
      expect((window as any).termpolis.killTerminal).toHaveBeenCalledWith('existing-1')
      expect((window as any).termpolis.killTerminal).toHaveBeenCalledWith('existing-2')
      expect(mockRemoveTerminal).toHaveBeenCalledWith('existing-1')
      expect(mockRemoveTerminal).toHaveBeenCalledWith('existing-2')
    })

    await waitFor(() => {
      // Should have created 2 new terminals (Claude Code + Shell)
      expect((window as any).termpolis.createTerminal).toHaveBeenCalledTimes(2)
      expect(mockAddTerminal).toHaveBeenCalledTimes(2)
    })

    await waitFor(() => {
      // Should set pane tree and active terminal
      expect(mockSetPaneTree).toHaveBeenCalledTimes(1)
      expect(mockSetActiveTerminal).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      // Should toggle view mode since default is 'tabs'
      expect(mockToggleViewMode).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('does not toggle view mode if already in split mode', async () => {
    mockViewMode = 'split'
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    const launchButtons = screen.getAllByText('Launch')
    fireEvent.click(launchButtons[0])

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })

    expect(mockToggleViewMode).not.toHaveBeenCalled()
  })

  it('launches Full Stack Dev workflow with 4 terminals', async () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    // Second Launch button = Full Stack Dev
    const launchButtons = screen.getAllByText('Launch')
    fireEvent.click(launchButtons[1])

    await waitFor(() => {
      expect((window as any).termpolis.createTerminal).toHaveBeenCalledTimes(4)
      expect(mockAddTerminal).toHaveBeenCalledTimes(4)
    })

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('sends startup commands after launch for templates with commands', async () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    // Launch Claude Code + Shell (first template has command: 'claude' on first terminal)
    const launchButtons = screen.getAllByText('Launch')
    fireEvent.click(launchButtons[0])

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })

    // Wait for the setTimeout(500ms) to fire and send commands
    await waitFor(() => {
      expect((window as any).termpolis.writeToTerminal).toHaveBeenCalled()
    }, { timeout: 2000 })
  })

  it('renders the x close icon button in header', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    // The header contains a close button
    const buttons = screen.getAllByRole('button')
    // First button should be the close button (before Launch buttons)
    expect(buttons.length).toBeGreaterThanOrEqual(4) // 1 close + 3 launch
  })
})
