import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock conductorManager before importing the component
vi.mock('../../src/renderer/src/lib/conductorManager', () => ({
  checkClaudeInstalled: vi.fn(),
  startConductor: vi.fn(),
  waitForAuth: vi.fn(),
  sendTask: vi.fn(),
  stopConductor: vi.fn(),
}))

import { checkClaudeInstalled, startConductor, waitForAuth, sendTask } from '../../src/renderer/src/lib/conductorManager'

beforeEach(() => {
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({ success: true, data: { claude: true } }),
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [{ type: 'bash', label: 'Bash' }] }),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    readTerminalBuffer: vi.fn().mockResolvedValue({ success: true, data: { output: '' } }),
  }
  ;(window as any).swarmAPI = {
    getMessages: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    createTask: vi.fn().mockResolvedValue({ success: true }),
    clear: vi.fn().mockResolvedValue({ success: true }),
  }

  vi.mocked(checkClaudeInstalled).mockResolvedValue(true)
  vi.mocked(startConductor).mockResolvedValue({ success: true, needsAuth: false })
  vi.mocked(waitForAuth).mockResolvedValue(true)
  vi.mocked(sendTask).mockResolvedValue(undefined)
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: [],
        addTerminal: vi.fn(),
        setPaneTree: vi.fn(),
        setSwarmActive: vi.fn(),
        setSwarmAgents: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: [],
        viewMode: 'tabs',
        addTerminal: vi.fn(),
        setSwarmActive: vi.fn(),
        setSwarmNotification: vi.fn(),
        removeTerminal: vi.fn(),
      })),
      setState: vi.fn(),
    },
  ),
  buildPaneTree: vi.fn(),
}))

import { StartSwarmModal } from '../../src/renderer/src/components/SwarmDashboard/StartSwarmModal'

describe('StartSwarmModal', () => {
  it('shows preparing step with spinner on mount', () => {
    vi.mocked(checkClaudeInstalled).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    expect(screen.getByText('Preparing Conductor')).toBeInTheDocument()
    expect(screen.getByText('Checking Claude Code...')).toBeInTheDocument()
  })

  it('shows Claude Code Required when not installed', async () => {
    vi.mocked(checkClaudeInstalled).mockResolvedValue(false)
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Claude Code Required')).toBeInTheDocument()
    })
  })

  it('closes modal when user cancels directory picker', async () => {
    ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: false })
    const onClose = vi.fn()
    render(<StartSwarmModal onClose={onClose} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('shows describe step after successful preparation', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('What do you want the swarm to work on?')).toBeInTheDocument()
    })
  })

  it('shows AI Conductor info box on describe step', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('AI Conductor')).toBeInTheDocument()
    })
  })

  it('has Launch Swarm button disabled when task is empty', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('What do you want the swarm to work on?')).toBeInTheDocument()
    })
    const launchButton = screen.getByText('Launch Swarm')
    expect(launchButton.closest('button')).toBeDisabled()
  })

  it('enables Launch Swarm button when task is entered', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('What do you want the swarm to work on?')).toBeInTheDocument()
    })
    const textarea = screen.getByPlaceholderText(/tic-tac-toe/)
    fireEvent.change(textarea, { target: { value: 'Build a React app' } })
    const launchButton = screen.getByText('Launch Swarm')
    expect(launchButton.closest('button')).not.toBeDisabled()
  })

  it('calls sendTask and onLaunched when Launch Swarm is clicked', async () => {
    const onLaunched = vi.fn()
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={onLaunched} />)
    await waitFor(() => {
      expect(screen.getByText('What do you want the swarm to work on?')).toBeInTheDocument()
    })
    const textarea = screen.getByPlaceholderText(/tic-tac-toe/)
    fireEvent.change(textarea, { target: { value: 'Build a React app' } })
    fireEvent.click(screen.getByText('Launch Swarm'))
    await waitFor(() => {
      expect(sendTask).toHaveBeenCalledWith('Build a React app', '/test/project')
      expect(onLaunched).toHaveBeenCalled()
    })
  })

  it('shows auth message when conductor needs authentication', async () => {
    vi.mocked(startConductor).mockResolvedValue({ success: true, needsAuth: true })
    vi.mocked(waitForAuth).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText(/Complete sign-in in your browser/)).toBeInTheDocument()
    })
  })

  it('shows error when conductor fails to start', async () => {
    vi.mocked(startConductor).mockResolvedValue({ success: false, error: 'Terminal creation failed' })
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Terminal creation failed')).toBeInTheDocument()
    })
  })

  it('has 3 step dots in the header', () => {
    vi.mocked(checkClaudeInstalled).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    expect(screen.getByText('Start Swarm')).toBeInTheDocument()
    const dots = document.querySelectorAll('.rounded-full.w-2.h-2')
    expect(dots.length).toBe(3)
  })

  it('shows swarm description during preparation', () => {
    vi.mocked(checkClaudeInstalled).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    expect(screen.getByText(/multiple AI agents work together/)).toBeInTheDocument()
  })
})
