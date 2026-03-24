import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'

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

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: [],
        activeTerminalId: null,
        viewMode: 'tabs',
        showSettings: false,
        defaultShell: 'bash',
        sidebarCollapsed: false,
        swarmActive: false,
        swarmAgents: [],
        workspaces: [],
        aiProfiles: [],
        addTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        updateTerminal: vi.fn(),
        setActiveTerminal: vi.fn(),
        toggleViewMode: vi.fn(),
        setShowSettings: vi.fn(),
        setSidebarCollapsed: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: [],
        activeTerminalId: null,
        viewMode: 'tabs',
        showSettings: false,
        defaultShell: 'bash',
        sidebarCollapsed: false,
        swarmActive: false,
        swarmAgents: [],
        workspaces: [],
        aiProfiles: [],
      })),
      setState: vi.fn(),
    },
  ),
}))

// Mock child components that have complex dependencies
vi.mock('../../src/renderer/src/components/Sidebar/WorkspaceList', () => ({
  WorkspaceList: () => <div data-testid="workspace-list">Workspaces</div>,
}))
vi.mock('../../src/renderer/src/components/Sidebar/AIProfiles', () => ({
  AIProfiles: () => <div data-testid="ai-profiles">AI Agents</div>,
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
})
