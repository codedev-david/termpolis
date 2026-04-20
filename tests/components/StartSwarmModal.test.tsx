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
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    expect(screen.getByText('Preparing Conductor')).toBeInTheDocument()
    expect(screen.getByText('Checking Claude Code...')).toBeInTheDocument()
  })

  it('shows Claude Code Required when not installed', async () => {
    vi.mocked(checkClaudeInstalled).mockResolvedValue(false)
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Claude Code Required')).toBeInTheDocument()
    })
  })

  it('receives projectCwd as prop', () => {
    vi.mocked(checkClaudeInstalled).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    expect(screen.getByText('Preparing Conductor')).toBeInTheDocument()
  })

  it('shows describe step after successful preparation', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    })
  })

  it('shows AI Conductor info box on describe step', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('AI Conductor')).toBeInTheDocument()
    })
  })

  it('has Launch Swarm button disabled when task is empty', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    })
    const launchButton = screen.getByText('Launch Swarm')
    expect(launchButton.closest('button')).toBeDisabled()
  })

  it('enables Launch Swarm button when task is entered', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    })
    const textarea = screen.getByPlaceholderText(/Add a contact form/)
    fireEvent.change(textarea, { target: { value: 'Build a React app' } })
    const launchButton = screen.getByText('Launch Swarm')
    expect(launchButton.closest('button')).not.toBeDisabled()
  })

  it('calls sendTask and onLaunched when Launch Swarm is clicked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onLaunched = vi.fn()

    // After launch, simulate an agent terminal appearing so the polling resolves
    const { useTerminalStore } = await import('../../src/renderer/src/store/terminalStore')
    const mockGetState = vi.mocked(useTerminalStore.getState)
    let agentTerminalVisible = false
    mockGetState.mockImplementation(() => ({
      terminals: agentTerminalVisible
        ? [{ id: 't1', name: 'Claude (Build)', isSwarm: true, isConductor: false, hidden: false } as any]
        : [],
      viewMode: 'tabs' as const,
      addTerminal: vi.fn(),
      setSwarmActive: vi.fn(),
      setSwarmNotification: vi.fn(),
      removeTerminal: vi.fn(),
    }))

    render(<StartSwarmModal onClose={vi.fn()} onLaunched={onLaunched} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    }, { timeout: 3000 })
    const textarea = screen.getByPlaceholderText(/Add a contact form/)
    fireEvent.change(textarea, { target: { value: 'Build a React app' } })
    fireEvent.click(screen.getByText('Launch Swarm'))

    // sendTask resolves immediately; simulate agent terminal appearing after min wait
    agentTerminalVisible = true
    await vi.advanceTimersByTimeAsync(15000)

    expect(sendTask).toHaveBeenCalledWith(expect.stringContaining('## Goal\nBuild a React app'), '/test/project')
    expect(onLaunched).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('shows auth message when conductor needs authentication', async () => {
    vi.mocked(startConductor).mockResolvedValue({ success: true, needsAuth: true })
    vi.mocked(waitForAuth).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText(/Complete sign-in in your browser/)).toBeInTheDocument()
    })
  })

  it('shows error when conductor fails to start', async () => {
    vi.mocked(startConductor).mockResolvedValue({ success: false, error: 'Terminal creation failed' })
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Terminal creation failed')).toBeInTheDocument()
    })
  })

  it('has 3 step dots in the header', () => {
    vi.mocked(checkClaudeInstalled).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    expect(screen.getByText('Start Swarm')).toBeInTheDocument()
    const dots = document.querySelectorAll('.rounded-full.w-2.h-2')
    expect(dots.length).toBe(3)
  })

  it('shows swarm description during preparation', () => {
    vi.mocked(checkClaudeInstalled).mockReturnValue(new Promise(() => {}))
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    expect(screen.getByText(/multiple AI agents work together/)).toBeInTheDocument()
  })

  it('shows live progress message during launch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    }, { timeout: 3000 })
    const textarea = screen.getByPlaceholderText(/Add a contact form/)
    fireEvent.change(textarea, { target: { value: 'Build something' } })
    fireEvent.click(screen.getByText('Launch Swarm'))
    // Should show conductor working message
    await waitFor(() => {
      expect(screen.getByText(/Conductor is analyzing|Sending task/)).toBeInTheDocument()
    })
    vi.useRealTimers()
  })

  it('shows conductor working message in launching step', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    }, { timeout: 3000 })
    const textarea = screen.getByPlaceholderText(/Add a contact form/)
    fireEvent.change(textarea, { target: { value: 'Test task' } })
    fireEvent.click(screen.getByText('Launch Swarm'))
    await waitFor(() => {
      expect(screen.getByText('The AI conductor is working')).toBeInTheDocument()
      expect(screen.getByText(/This screen will close as soon as/)).toBeInTheDocument()
    })
    vi.useRealTimers()
  })

  it('shows working directory notification in launching step', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/home/dev/my-special-app" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    }, { timeout: 3000 })
    const textarea = screen.getByPlaceholderText(/Add a contact form/)
    fireEvent.change(textarea, { target: { value: 'Build a thing' } })
    fireEvent.click(screen.getByText('Launch Swarm'))
    await waitFor(() => {
      expect(screen.getByText('Working directory')).toBeInTheDocument()
      expect(screen.getByText('/home/dev/my-special-app')).toBeInTheDocument()
      expect(screen.getByText(/The swarm will work in this folder/)).toBeInTheDocument()
    })
    vi.useRealTimers()
  })

  it('includes all optional fields in the contract when provided', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    }, { timeout: 3000 })

    fireEvent.change(screen.getByPlaceholderText(/Add a contact form/), { target: { value: 'My goal' } })
    fireEvent.change(screen.getByPlaceholderText(/Needs to work on Windows/), { target: { value: 'Constraint A' } })
    fireEvent.change(screen.getByPlaceholderText(/A working contact page/), { target: { value: 'Outcome B' } })
    fireEvent.change(screen.getByPlaceholderText(/Form submits without validating/), { target: { value: 'Fail case C' } })

    fireEvent.click(screen.getByText('Launch Swarm'))
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.mocked(sendTask)).toHaveBeenCalledWith(
      expect.stringMatching(/## Goal\nMy goal[\s\S]*## Constraints\nConstraint A[\s\S]*## Expected Output\nOutcome B[\s\S]*## Failure Conditions\nFail case C/),
      '/test/project',
    )
    vi.useRealTimers()
  }, 10000)

  it('closes via Escape key while on describe step (not launching)', async () => {
    const onClose = vi.fn()
    render(<StartSwarmModal onClose={onClose} onLaunched={vi.fn()} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

})
