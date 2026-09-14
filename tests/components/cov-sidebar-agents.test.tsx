import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// A second Sidebar suite, deliberately separate from tests/components/Sidebar.test.tsx.
//
// The arms exercised here are only reachable through DIFFERENT module mocks than
// that file installs: its TerminalTab stub never calls onUpdate, its
// AddTerminalModal stub always calls onCreate with the appearance fields
// OMITTED, and it renders the real WorkflowOverlayBody, which never fires
// onSaved. vi.mock factories are hoisted per test file, so those stubs cannot be
// varied from inside that suite — hence this file.

const mockAddTerminal = vi.fn()
const mockUpdateTerminal = vi.fn()
const mockRemoveTerminal = vi.fn()
const mockSetActiveTerminal = vi.fn()
const mockToggleViewMode = vi.fn()
const mockSetShowSettings = vi.fn()
const mockSetSidebarCollapsed = vi.fn()
const mockSetWorkflows = vi.fn()

let mockState: Record<string, any> = {}

function baseState() {
  return {
    terminals: [],
    activeTerminalId: null,
    viewMode: 'tabs' as const,
    showSettings: false,
    defaultShell: 'bash',
    sidebarCollapsed: false,
    swarmActive: false,
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

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => (selector ? selector(mockState) : mockState),
    { getState: vi.fn(() => mockState), setState: vi.fn() },
  ),
}))

vi.mock('../../src/renderer/src/components/Sidebar/WorkspaceList', () => ({
  WorkspaceList: () => <div data-testid="workspace-list" />,
}))
vi.mock('../../src/renderer/src/components/Sidebar/AIProfiles', () => ({
  AIProfiles: ({ availableShells }: any) => (
    <div data-testid="ai-profiles" data-shell-count={availableShells.length} />
  ),
}))
// Unlike the sibling suite's stub, this one exposes onUpdate so the tab -> store
// write-back path is actually exercised.
vi.mock('../../src/renderer/src/components/Sidebar/TerminalTab', () => ({
  TerminalTab: ({ terminal, onUpdate }: any) => (
    <div data-testid={`tab-${terminal.id}`}>
      <button data-testid={`rename-${terminal.id}`} onClick={() => onUpdate({ name: 'Renamed' })}>
        rename
      </button>
    </div>
  ),
}))
// This stub passes the appearance fields the sibling suite's stub omits, so the
// left-hand side of handleCreate's `??` fallbacks is reached.
vi.mock('../../src/renderer/src/components/Sidebar/AddTerminalModal', () => ({
  AddTerminalModal: ({ shells, nextIndex, defaultShell, defaultCwd, onCreate }: any) => (
    <div
      data-testid="add-modal"
      data-shell-count={shells.length}
      data-next-index={nextIndex}
      data-default-shell={defaultShell}
      data-default-cwd={defaultCwd ?? ''}
    >
      <button
        data-testid="create-full"
        onClick={() =>
          onCreate({
            name: 'Full',
            shellType: 'zsh',
            color: '#abcabc',
            fontSize: 22,
            theme: 'nord',
            fontFamily: 'Fira Code, monospace',
          })
        }
      >
        create
      </button>
    </div>
  ),
}))
vi.mock('../../src/renderer/src/components/SwarmDashboard/SwarmDashboard', () => ({
  SwarmDashboard: () => <div data-testid="swarm-dashboard" />,
}))
vi.mock('../../src/renderer/src/components/GitPanel/GitPanel', () => ({
  GitPanel: () => <div data-testid="git-panel" />,
}))
vi.mock('../../src/renderer/src/components/Workflow/WorkflowSidebarSection', () => ({
  WorkflowSidebarSection: ({ onCreate }: any) => (
    <button data-testid="new-workflow" onClick={onCreate}>new workflow</button>
  ),
}))
// The real body never calls onSaved in a unit test; this stub does, which is the
// only way to reach the workflowNonce bump.
vi.mock('../../src/renderer/src/components/Workflow/WorkflowOverlayBody', () => ({
  WorkflowOverlayBody: ({ onSaved, cwd }: any) => (
    <button data-testid="save-workflow" data-cwd={cwd ?? ''} onClick={onSaved}>save</button>
  ),
}))
vi.mock('../../src/renderer/src/lib/homedir', () => ({ getHomedir: vi.fn() }))
vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  getTerminalDefaults: () => ({ fontSize: 14, theme: 'dark', fontFamily: 'monospace' }),
}))

import { Sidebar } from '../../src/renderer/src/components/Sidebar/Sidebar'
import { getHomedir } from '../../src/renderer/src/lib/homedir'

const listWorkflows = () => (window as any).termpolis.listWorkflows

beforeEach(() => {
  vi.clearAllMocks()
  mockState = baseState()
  ;(getHomedir as any).mockResolvedValue('/home/user')
  ;(window as any).termpolis = {
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [] }),
    listWorkflows: vi.fn().mockResolvedValue({ success: true, data: [] }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/tmp/test' }),
    readWorkflow: vi.fn().mockResolvedValue({ success: false, error: 'not found' }),
  }
})

// A terminal with a settled cwd pins workflowCwd, so the load effect runs exactly
// once on mount instead of re-running when the homedir promise resolves.
const withProject = () => ({
  ...baseState(),
  terminals: [{ id: 't1', name: 'T1', cwd: '/proj', color: '#fff', shellType: 'bash' }],
  activeTerminalId: 't1',
})

describe('Sidebar — tab write-back, appearance overrides and cwd fallbacks', () => {
  it('writes a tab rename back to that terminal in the store', () => {
    mockState = withProject()
    render(<Sidebar />)

    fireEvent.click(screen.getByTestId('rename-t1'))

    expect(mockUpdateTerminal).toHaveBeenCalledWith('t1', { name: 'Renamed' })
  })

  it('honours the modal appearance overrides instead of the saved defaults', async () => {
    mockState = withProject()
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))

    fireEvent.click(screen.getByTestId('create-full'))

    await waitFor(() => expect(mockAddTerminal).toHaveBeenCalled())
    // fontSize/theme/fontFamily came from the modal, NOT from getTerminalDefaults
    // (14 / 'dark' / 'monospace') — the `??` fallbacks must not clobber them.
    expect(mockAddTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Full',
        shellType: 'zsh',
        color: '#abcabc',
        fontSize: 22,
        theme: 'nord',
        fontFamily: 'Fira Code, monospace',
        // Inherited from the active terminal (/proj), NOT the home directory. Pinning
        // every new terminal to home is what left its git dot blank for good.
        cwd: '/proj',
      }),
    )
    // A successful create dismisses the modal.
    expect(screen.queryByTestId('add-modal')).not.toBeInTheDocument()
  })

  // The regression that made the git dot invisible: handleCreate called getHomedir()
  // unconditionally, so every terminal it made launched in the home directory — never a
  // repo — and the dot, which can only ever read the LAUNCH directory (Windows cannot
  // follow a `cd`), rendered nothing for the life of that terminal.
  it('launches a new terminal where the active one is, not in the home directory', async () => {
    mockState = withProject()
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))

    fireEvent.click(screen.getByTestId('create-full'))

    await waitFor(() => expect(mockAddTerminal).toHaveBeenCalled())
    expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/proj' }))
    // The pty must be spawned there too, or the dot would describe a repo the shell
    // is not actually sitting in.
    expect((window as any).termpolis.createTerminal).toHaveBeenCalledWith(
      expect.any(String), 'zsh', '/proj',
    )
  })

  it('falls back to the home directory when there is no active terminal to inherit from', async () => {
    mockState = baseState()
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))

    fireEvent.click(screen.getByTestId('create-full'))

    await waitFor(() => expect(mockAddTerminal).toHaveBeenCalled())
    expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/user' }))
  })

  it('offers the active terminal directory as the modal default folder', () => {
    mockState = withProject()
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Add Terminal'))

    expect(screen.getByTestId('add-modal').dataset.defaultCwd).toBe('/proj')
  })

  it('saving in the workflow overlay re-reads the project workflow list', async () => {
    mockState = withProject()
    render(<Sidebar />)
    await waitFor(() => expect(listWorkflows()).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('new-workflow'))
    expect(screen.getByTestId('save-workflow').dataset.cwd).toBe('/proj')
    fireEvent.click(screen.getByTestId('save-workflow'))

    // The save bumps workflowNonce, which re-runs the load effect against the
    // same project — otherwise a just-saved workflow never appears in the list.
    await waitFor(() => expect(listWorkflows()).toHaveBeenCalledTimes(2))
    expect(listWorkflows()).toHaveBeenLastCalledWith('/proj')
  })

  it('falls back to ~ when the home directory cannot be resolved', async () => {
    ;(getHomedir as any).mockRejectedValue(new Error('no home'))
    mockState = baseState() // no terminals -> the cwd can only come from homedir

    render(<Sidebar />)

    await waitFor(() => expect(listWorkflows()).toHaveBeenCalledWith('~'))
  })

  it('still lists global workflows before any cwd has resolved', async () => {
    let resolveHome: (v: string) => void = () => {}
    ;(getHomedir as any).mockReturnValue(new Promise<string>(r => { resolveHome = r }))
    mockState = baseState()

    render(<Sidebar />)

    // No terminal and no homedir yet: the list still runs, against ''.
    await waitFor(() => expect(listWorkflows()).toHaveBeenCalledWith(''))
    resolveHome('/home/user')
  })

  it('keeps the shell list empty when the shell probe fails', async () => {
    ;(window as any).termpolis.getAvailableShells = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'probe failed' })
    mockState = withProject()

    render(<Sidebar />)

    await waitFor(() => expect((window as any).termpolis.getAvailableShells).toHaveBeenCalled())
    expect(screen.getByTestId('ai-profiles').dataset.shellCount).toBe('0')
    fireEvent.click(screen.getByText('+ Add Terminal'))
    expect(screen.getByTestId('add-modal').dataset.shellCount).toBe('0')
  })

  it('hands the detected shells to the agent list and the new-terminal modal', async () => {
    ;(window as any).termpolis.getAvailableShells = vi.fn().mockResolvedValue({
      success: true,
      data: [
        { type: 'bash', label: 'Bash', executable: '/bin/bash' },
        { type: 'zsh', label: 'Zsh', executable: '/bin/zsh' },
      ],
    })
    mockState = withProject()

    render(<Sidebar />)

    await waitFor(() => expect(screen.getByTestId('ai-profiles').dataset.shellCount).toBe('2'))
    fireEvent.click(screen.getByText('+ Add Terminal'))
    const modal = screen.getByTestId('add-modal')
    expect(modal.dataset.shellCount).toBe('2')
    // nextIndex names the new terminal after the existing one.
    expect(modal.dataset.nextIndex).toBe('2')
    expect(modal.dataset.defaultShell).toBe('bash')
  })

  it('survives a preload whose watchWorkflowProject returns nothing to catch on', async () => {
    // Older preloads returned undefined rather than a promise; the optional call
    // chain must short-circuit instead of throwing and killing the list load.
    const watch = vi.fn(() => undefined)
    ;(window as any).termpolis.watchWorkflowProject = watch
    mockState = withProject()

    render(<Sidebar />)

    await waitFor(() => expect(watch).toHaveBeenCalledWith('/proj'))
    await waitFor(() => expect(listWorkflows()).toHaveBeenCalledWith('/proj'))
    delete (window as any).termpolis.watchWorkflowProject
  })

  it('does not push an empty workflow payload into the store', async () => {
    ;(window as any).termpolis.listWorkflows = vi
      .fn()
      .mockResolvedValue({ success: true, data: null })
    mockState = withProject()

    render(<Sidebar />)

    await waitFor(() => expect(listWorkflows()).toHaveBeenCalledWith('/proj'))
    expect(mockSetWorkflows).not.toHaveBeenCalled()
  })

  it('offers the return trip to tab view once split view is on', () => {
    mockState = { ...withProject(), viewMode: 'split' }
    render(<Sidebar />)

    // In split mode the toggle advertises where it goes, not where it is.
    const toggle = screen.getByTitle('Tab View')
    expect(screen.queryByTitle('Split View')).not.toBeInTheDocument()
    expect(toggle.querySelector('.fa-bars')).not.toBeNull()
    expect(toggle.querySelector('.fa-columns')).toBeNull()

    fireEvent.click(toggle)
    expect(mockToggleViewMode).toHaveBeenCalled()
  })
})
