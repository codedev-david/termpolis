import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
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
    updateTask: vi.fn().mockResolvedValue({ success: true }),
  }
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: [],
        swarmActive: false,
        swarmAgents: [],
        setSwarmActive: vi.fn(),
        setSwarmAgents: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: [],
        swarmActive: false,
        swarmAgents: [],
        setSwarmActive: vi.fn(),
        setSwarmAgents: vi.fn(),
      })),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/swarmBridgeManager', () => ({
  stopAllBridges: vi.fn(),
}))

// Mock StartSwarmModal to avoid its complex dependencies
vi.mock('../../src/renderer/src/components/SwarmDashboard/StartSwarmModal', () => ({
  StartSwarmModal: ({ onClose }: any) => <div data-testid="start-swarm-modal"><button onClick={onClose}>Close Modal</button></div>,
}))

import { SwarmDashboard } from '../../src/renderer/src/components/SwarmDashboard/SwarmDashboard'

describe('SwarmDashboard', () => {
  it('renders the dashboard overlay with title', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Swarm Dashboard')).toBeInTheDocument()
  })

  it('shows Agents, Tasks, and Messages tabs', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('Messages')).toBeInTheDocument()
  })

  it('shows Start Swarm button', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Start Swarm')).toBeInTheDocument()
  })

  it('shows Clear button', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Clear')).toBeInTheDocument()
  })

  it('shows confirmation modal when Clear is clicked', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText(/All swarm work will be lost/)).toBeInTheDocument()
    // Modal heading
    const heading = screen.getAllByText('Clear Swarm').find(el => el.tagName === 'H3')
    expect(heading).toBeInTheDocument()
  })

  it('confirmation modal has Cancel and confirm buttons', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText('Cancel')).toBeInTheDocument()
    // The confirm button has the trash icon and destructive styling
    const confirmBtn = screen.getAllByText(/Clear Swarm/).find(el => el.tagName === 'BUTTON')
    expect(confirmBtn).toBeInTheDocument()
  })

  it('dismisses confirmation modal when Cancel is clicked', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText(/All swarm work will be lost/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText(/All swarm work will be lost/)).not.toBeInTheDocument()
  })
})
