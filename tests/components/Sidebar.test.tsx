import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const mockSetActiveTerminal = vi.fn()
const mockSetShowSettings = vi.fn()
const mockToggleViewMode = vi.fn()
const mockSetSidebarCollapsed = vi.fn()
const mockAddTerminal = vi.fn()
const mockRemoveTerminal = vi.fn()
const mockUpdateTerminal = vi.fn()

let mockState: Record<string, any> = {}

function getDefaultState() {
  return {
    terminals: [],
    activeTerminalId: null,
    viewMode: 'tabs' as const,
    showSettings: false,
    defaultShell: 'bash',
    sidebarCollapsed: false,
    swarmActive: false,
    swarmAgents: [],
    workspaces: [],
    aiProfiles: [],
    addTerminal: mockAddTerminal,
    removeTerminal: mockRemoveTerminal,
    updateTerminal: mockUpdateTerminal,
    setActiveTerminal: mockSetActiveTerminal,
    toggleViewMode: mockToggleViewMode,
    setShowSettings: mockSetShowSettings,
    setSidebarCollapsed: mockSetSidebarCollapsed,
  }
}

beforeAll(() => {
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({ success: true, data: {} }),
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getOllamaPath: vi.fn().mockResolvedValue({ success: true, data: null }),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/tmp/test' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    loadSession: vi.fn().mockResolvedValue({ success: true, data: { terminals: [], workspaces: [] } }),
    saveSession: vi.fn(),
  }
  ;(window as any).swarmAPI = {
    getMessages: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    createTask: vi.fn().mockResolvedValue({ success: true }),
    clear: vi.fn().mockResolvedValue({ success: true }),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockState = getDefaultState()
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = mockState
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => mockState),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/components/Sidebar/WorkspaceList', () => ({
  WorkspaceList: () => <div data-testid="workspace-list">Workspaces</div>,
}))
vi.mock('../../src/renderer/src/components/Sidebar/AIProfiles', () => ({
  AIProfiles: () => <div data-testid="ai-profiles">AI Agents</div>,
}))
vi.mock('../../src/renderer/src/components/Sidebar/TerminalTab', () => ({
  TerminalTab: ({ terminal, isActive, onClick, onClose }: any) => (
    <div data-testid={`terminal-tab-${terminal.id}`} data-active={isActive} onClick={onClick}>
      <span>{terminal.name}</span>
      <button data-testid={`close-${terminal.id}`} onClick={(e: any) => { e.stopPropagation(); onClose() }}>X</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/Sidebar/AddTerminalModal', () => ({
  AddTerminalModal: ({ onCreate, onCancel }: any) => (
    <div data-testid="add-terminal-modal">
      <button data-testid="modal-create" onClick={() => onCreate({ name: 'New', shellType: 'bash', color: '#fff' })}>Create</button>
      <button data-testid="modal-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/PromptTemplates/PromptTemplates', () => ({
  PromptTemplates: ({ onClose }: any) => <div data-testid="prompt-templates"><button onClick={onClose}>Close Prompts</button></div>,
}))
vi.mock('../../src/renderer/src/components/WorkflowTemplates/WorkflowTemplates', () => ({
  WorkflowTemplates: ({ onClose }: any) => <div data-testid="workflow-templates"><button onClick={onClose}>Close Workflows</button></div>,
}))
vi.mock('../../src/renderer/src/components/SwarmDashboard/SwarmDashboard', () => ({
  SwarmDashboard: ({ onClose, initialCwd }: any) => (
    <div data-testid="swarm-dashboard" data-cwd={initialCwd}>
      <button onClick={onClose}>Close Swarm</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/user'),
}))
vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  TERMINAL_DEFAULTS: { fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
}))

import { Sidebar } from '../../src/renderer/src/components/Sidebar/Sidebar'

describe('Sidebar', () => {
  it('renders sidebar with icon bar buttons', () => {
    render(<Sidebar />)
    expect(screen.getByTitle('Settings')).toBeInTheDocument()
    expect(screen.getByTitle('Prompts')).toBeInTheDocument()
    expect(screen.getByTitle('Workflows')).toBeInTheDocument()
    expect(screen.getByTitle('Swarm Dashboard (Ctrl+Shift+S)')).toBeInTheDocument()
  })

  it('shows AI Agents, Workspaces, and Terminals sections', () => {
    render(<Sidebar />)
    expect(screen.getByTestId('ai-profiles')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-list')).toBeInTheDocument()
    expect(screen.getByText('Terminals')).toBeInTheDocument()
  })

  it('has a collapse sidebar button', () => {
    render(<Sidebar />)
    expect(screen.getByTitle('Collapse sidebar')).toBeInTheDocument()
  })

  it('renders terminal list from store', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'Terminal 1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
        { id: 't2', name: 'Terminal 2', color: '#0ff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
    }
    render(<Sidebar />)
    expect(screen.getByTestId('terminal-tab-t1')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-tab-t2')).toBeInTheDocument()
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    expect(screen.getByText('Terminal 2')).toBeInTheDocument()
  })

  it('does not render hidden terminals in the list', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'Visible', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
        { id: 't2', name: 'Hidden', color: '#0ff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace', hidden: true },
      ],
    }
    render(<Sidebar />)
    expect(screen.getByText('Visible')).toBeInTheDocument()
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
  })

  it('shows terminal count excluding hidden', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
        { id: 't2', name: 'T2', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace', hidden: true },
        { id: 't3', name: 'T3', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
    }
    render(<Sidebar />)
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('clicking a terminal tab calls setActiveTerminal', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'Terminal 1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
    }
    render(<Sidebar />)
    fireEvent.click(screen.getByTestId('terminal-tab-t1'))
    expect(mockSetActiveTerminal).toHaveBeenCalledWith('t1')
  })

  it('marks the active terminal tab', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
        { id: 't2', name: 'T2', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
      activeTerminalId: 't2',
    }
    render(<Sidebar />)
    expect(screen.getByTestId('terminal-tab-t1').dataset.active).toBe('false')
    expect(screen.getByTestId('terminal-tab-t2').dataset.active).toBe('true')
  })

  it('settings button toggles settings', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Settings'))
    expect(mockSetShowSettings).toHaveBeenCalledWith(true)
  })

  it('settings button toggles off when already active', () => {
    mockState = { ...getDefaultState(), showSettings: true }
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Settings'))
    expect(mockSetShowSettings).toHaveBeenCalledWith(false)
  })

  it('collapse button calls setSidebarCollapsed', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Collapse sidebar'))
    expect(mockSetSidebarCollapsed).toHaveBeenCalledWith(true)
  })

  it('renders collapsed state with expand button', () => {
    mockState = { ...getDefaultState(), sidebarCollapsed: true }
    render(<Sidebar />)
    expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument()
    expect(screen.queryByTitle('Settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ai-profiles')).not.toBeInTheDocument()
  })

  it('expand button calls setSidebarCollapsed(false)', () => {
    mockState = { ...getDefaultState(), sidebarCollapsed: true }
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Expand sidebar'))
    expect(mockSetSidebarCollapsed).toHaveBeenCalledWith(false)
  })

  it('swarm button picks directory when swarm is not active', async () => {
    const mockPickDirectory = vi.fn().mockResolvedValue({ success: true, data: '/my/project' })
    ;(window as any).termpolis.pickDirectory = mockPickDirectory

    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Swarm Dashboard (Ctrl+Shift+S)'))

    await waitFor(() => {
      expect(mockPickDirectory).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('swarm-dashboard')).toBeInTheDocument()
    })
    expect(screen.getByTestId('swarm-dashboard').dataset.cwd).toBe('/my/project')
  })

  it('swarm button opens dashboard directly when swarm is active', async () => {
    mockState = { ...getDefaultState(), swarmActive: true }
    // The swarm button reads getState().swarmActive internally
    const { useTerminalStore } = await import('../../src/renderer/src/store/terminalStore')
    ;(useTerminalStore.getState as any).mockReturnValue({ ...mockState, swarmActive: true })

    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Swarm Dashboard (Ctrl+Shift+S)'))

    await waitFor(() => {
      expect(screen.getByTestId('swarm-dashboard')).toBeInTheDocument()
    })
    // Should NOT have called pickDirectory
    expect((window as any).termpolis.pickDirectory).not.toHaveBeenCalled()
  })

  it('does not open swarm dashboard when directory picker is cancelled', async () => {
    mockState = { ...getDefaultState(), swarmActive: false }
    const { useTerminalStore } = await import('../../src/renderer/src/store/terminalStore')
    ;(useTerminalStore.getState as any).mockReturnValue({ ...mockState, swarmActive: false })
    ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: true, data: null })

    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Swarm Dashboard (Ctrl+Shift+S)'))

    await waitFor(() => {
      expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('swarm-dashboard')).not.toBeInTheDocument()
  })

  it('view mode button toggles view mode', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Split View'))
    expect(mockToggleViewMode).toHaveBeenCalled()
    expect(mockSetShowSettings).toHaveBeenCalledWith(false)
  })

  it('prompts button opens PromptTemplates', async () => {
    render(<Sidebar />)
    expect(screen.queryByTestId('prompt-templates')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Prompts'))
    expect(screen.getByTestId('prompt-templates')).toBeInTheDocument()
  })

  it('workflows button opens WorkflowTemplates', async () => {
    render(<Sidebar />)
    expect(screen.queryByTestId('workflow-templates')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Workflows'))
    expect(screen.getByTestId('workflow-templates')).toBeInTheDocument()
  })

  it('shows Add Terminal button that opens modal', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))
    expect(screen.getByTestId('add-terminal-modal')).toBeInTheDocument()
  })

  it('closing a terminal calls killTerminal and removeTerminal', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
    }
    render(<Sidebar />)
    fireEvent.click(screen.getByTestId('close-t1'))
    expect((window as any).termpolis.killTerminal).toHaveBeenCalledWith('t1')
    expect(mockRemoveTerminal).toHaveBeenCalledWith('t1')
  })

  it('terminals section can be collapsed', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'Terminal 1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
    }
    render(<Sidebar />)
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    // Click the "Terminals" heading to collapse
    fireEvent.click(screen.getByText('Terminals'))
    expect(screen.queryByText('Terminal 1')).not.toBeInTheDocument()
  })

  it('active terminal is not marked active when showSettings is true', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
      activeTerminalId: 't1',
      showSettings: true,
    }
    render(<Sidebar />)
    expect(screen.getByTestId('terminal-tab-t1').dataset.active).toBe('false')
  })
})
