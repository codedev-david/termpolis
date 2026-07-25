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
const mockSetWorkflows = vi.fn()

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
    workflows: [],
    activeRuns: {},
    addTerminal: mockAddTerminal,
    removeTerminal: mockRemoveTerminal,
    updateTerminal: mockUpdateTerminal,
    setActiveTerminal: mockSetActiveTerminal,
    toggleViewMode: mockToggleViewMode,
    setShowSettings: mockSetShowSettings,
    setSidebarCollapsed: mockSetSidebarCollapsed,
    setWorkflows: mockSetWorkflows,
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
    listWorkflows: vi.fn().mockResolvedValue({ success: true, data: [] }),
    readWorkflow: vi.fn().mockResolvedValue({ success: false, error: 'not found' }),
    onWorkflowRunEvent: vi.fn(() => vi.fn()),
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
vi.mock('../../src/renderer/src/components/SwarmDashboard/SwarmDashboard', () => ({
  SwarmDashboard: ({ onClose, initialCwd }: any) => (
    <div data-testid="swarm-dashboard" data-cwd={initialCwd}>
      <button onClick={onClose}>Close Swarm</button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/GitPanel/GitPanel', () => ({
  GitPanel: ({ onClose }: any) => <div data-testid="git-panel"><button onClick={onClose}>Close Git</button></div>,
}))
vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/user'),
}))
vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  getTerminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'monospace' }),
}))

import { Sidebar } from '../../src/renderer/src/components/Sidebar/Sidebar'

describe('Sidebar', () => {
  it('renders sidebar with icon bar buttons', () => {
    render(<Sidebar />)
    expect(screen.getByTitle('Settings')).toBeInTheDocument()
    expect(screen.getByTitle('Git Panel')).toBeInTheDocument()
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

  // -- Git Panel --

  it('git button opens GitPanel', async () => {
    render(<Sidebar />)
    expect(screen.queryByText('Close Git')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Git Panel'))
    expect(screen.getByTestId('git-panel')).toBeInTheDocument()
  })

  it('closing GitPanel hides it', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Git Panel'))
    expect(screen.getByTestId('git-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Close Git'))
    expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument()
  })

  // -- View mode toggle sets first terminal active when none active --

  it('view mode toggle sets first terminal as active when none is active', () => {
    mockState = {
      ...getDefaultState(),
      terminals: [
        { id: 't1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
      ],
      activeTerminalId: null,
    }
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Split View'))
    expect(mockSetActiveTerminal).toHaveBeenCalledWith('t1')
  })

  // -- Add Terminal modal create flow --

  it('creating a terminal through modal calls handleCreate', async () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))
    expect(screen.getByTestId('add-terminal-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('modal-create'))
    await waitFor(() => {
      expect(mockAddTerminal).toHaveBeenCalled()
    })
  })

  it('cancelling add terminal modal hides it', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))
    expect(screen.getByTestId('add-terminal-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('modal-cancel'))
    expect(screen.queryByTestId('add-terminal-modal')).not.toBeInTheDocument()
  })

  it('handleCreate shows alert when createTerminal fails', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    ;(window as any).termpolis.createTerminal = vi.fn().mockResolvedValue({ success: false, error: 'Shell not found' })

    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))
    fireEvent.click(screen.getByTestId('modal-create'))

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Shell not found'))
    })
    alertSpy.mockRestore()
  })

  it('closing SwarmDashboard hides it and clears cwd', async () => {
    const mockPickDirectory = vi.fn().mockResolvedValue({ success: true, data: '/my/project' })
    ;(window as any).termpolis.pickDirectory = mockPickDirectory

    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Swarm Dashboard (Ctrl+Shift+S)'))

    await waitFor(() => {
      expect(screen.getByTestId('swarm-dashboard')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Close Swarm'))
    expect(screen.queryByTestId('swarm-dashboard')).not.toBeInTheDocument()
  })

  // -- Swarm button indicator --

  it('shows pulsing indicator when swarm is active', () => {
    mockState = { ...getDefaultState(), swarmActive: true }
    const { container } = render(<Sidebar />)
    const indicator = container.querySelector('.animate-pulse')
    expect(indicator).toBeInTheDocument()
  })

  // -- Workflow orchestrator section + overlay --

  it('the legacy fa-cubes workflow toolbar button is gone', () => {
    render(<Sidebar />)
    expect(document.querySelector('.fa-cubes')).toBeNull()
  })

  it('renders the Workflows sidebar section header', () => {
    render(<Sidebar />)
    expect(screen.getByText('Workflows')).toBeInTheDocument()
  })

  it('Start Workflow opens the workflow overlay in one click, and Close dismisses it', () => {
    render(<Sidebar />)
    expect(screen.queryByRole('dialog', { name: 'Workflow' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Start Workflow'))
    const dialog = screen.getByRole('dialog', { name: 'Workflow' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('New Workflow')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Close workflow'))
    expect(screen.queryByRole('dialog', { name: 'Workflow' })).not.toBeInTheDocument()
  })

  it('clicking a saved workflow row opens the edit overlay', () => {
    mockState = { ...getDefaultState(), workflows: [{ id: 'wf1', name: 'Deploy' }] }
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Deploy'))
    expect(screen.getByRole('dialog', { name: 'Workflow' })).toBeInTheDocument()
    expect(screen.getByText('Edit Workflow')).toBeInTheDocument()
  })

  it("loads the active project's saved workflows on mount", async () => {
    const wfs = [{ id: 'w1', name: 'Deploy' }]
    ;(window as any).termpolis.listWorkflows = vi.fn().mockResolvedValue({ success: true, data: wfs })
    mockState = { ...getDefaultState(), terminals: [{ id: 't1', cwd: '/proj' }], activeTerminalId: 't1' }
    render(<Sidebar />)
    await waitFor(() => expect((window as any).termpolis.listWorkflows).toHaveBeenCalledWith('/proj'))
    await waitFor(() => expect(mockSetWorkflows).toHaveBeenCalledWith(wfs))
  })

  it('falls back to the home directory to load workflows when no terminal is open', async () => {
    mockState = getDefaultState()
    render(<Sidebar />)
    await waitFor(() => expect((window as any).termpolis.listWorkflows).toHaveBeenCalledWith('/home/user'))
  })

  it('the workflow overlay hosts the Designer body over the active project', () => {
    mockState = { ...getDefaultState(), terminals: [{ id: 't1', cwd: '/proj' }], activeTerminalId: 't1' }
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Start Workflow'))
    expect(screen.getByLabelText('Workflow name')).toBeInTheDocument()
  })

  it('opens a global row against the global store, and a project row against the project one', async () => {
    mockState = {
      ...getDefaultState(),
      terminals: [{ id: 't1', cwd: '/proj' }],
      activeTerminalId: 't1',
      workflows: [
        { id: 'g1', name: 'Everywhere', scope: 'global' },
        { id: 'p1', name: 'Just here', scope: 'project' },
      ],
    }
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Everywhere'))
    await waitFor(() =>
      expect((window as any).termpolis.readWorkflow).toHaveBeenCalledWith('/proj', 'g1', 'global'),
    )
    fireEvent.click(screen.getByTitle('Close workflow'))
    fireEvent.click(screen.getByText('Just here'))
    await waitFor(() =>
      expect((window as any).termpolis.readWorkflow).toHaveBeenCalledWith('/proj', 'p1', 'project'),
    )
  })
})
