import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ---------- module-scope mutable state for mocks ----------
let mockTerminals: any[] = []
let mockSwarmActive = false
let mockSwarmAgents: any[] = []
let mockSetSwarmActive = vi.fn()
let mockSetSwarmAgents = vi.fn()
let mockSetActiveTerminal = vi.fn()
let mockRemoveTerminal = vi.fn()
let mockConductorStatus = 'idle'

// ---------- window mocks ----------
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

// ---------- module mocks ----------
vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: mockTerminals,
        swarmActive: mockSwarmActive,
        swarmAgents: mockSwarmAgents,
        setSwarmActive: mockSetSwarmActive,
        setSwarmAgents: mockSetSwarmAgents,
        setActiveTerminal: mockSetActiveTerminal,
        removeTerminal: mockRemoveTerminal,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: mockTerminals,
        swarmActive: mockSwarmActive,
        swarmAgents: mockSwarmAgents,
        setSwarmActive: mockSetSwarmActive,
        setSwarmAgents: mockSetSwarmAgents,
        setActiveTerminal: mockSetActiveTerminal,
        removeTerminal: mockRemoveTerminal,
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

vi.mock('../../src/renderer/src/lib/conductorManager', () => ({
  stopConductor: vi.fn(),
  getConductorState: vi.fn(() => ({ status: mockConductorStatus })),
  revealConductor: vi.fn(),
}))

vi.mock('../../src/renderer/src/components/SwarmDashboard/StartSwarmModal', () => ({
  StartSwarmModal: ({ onClose }: any) => (
    <div data-testid="start-swarm-modal">
      <button onClick={onClose}>Close Modal</button>
    </div>
  ),
}))

import { SwarmDashboard } from '../../src/renderer/src/components/SwarmDashboard/SwarmDashboard'

// ---------- helpers ----------
function makeAgent(overrides: Partial<{
  terminalId: string
  agentName: string
  role: string
  status: string
  summary: string
}> = {}) {
  return {
    terminalId: overrides.terminalId ?? `term-${Math.random().toString(36).slice(2, 8)}`,
    agentName: overrides.agentName ?? 'TestAgent',
    role: overrides.role ?? 'coder',
    status: overrides.status ?? 'idle',
    summary: overrides.summary,
  }
}

function makeTask(overrides: Partial<{
  id: string
  title: string
  description: string
  assignedTo: string
  status: string
  createdBy: string
  result: string
  createdAt: number
}> = {}) {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    title: overrides.title ?? 'Test Task',
    description: overrides.description ?? 'A test task',
    assignedTo: overrides.assignedTo ?? '',
    status: overrides.status ?? 'pending',
    createdBy: overrides.createdBy ?? 'dashboard',
    result: overrides.result,
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

function makeMessage(overrides: Partial<{
  id: string
  from: string
  to: string
  type: string
  content: string
  timestamp: number
  read: boolean
}> = {}) {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    from: overrides.from ?? 'agent-1',
    to: overrides.to ?? 'conductor',
    type: overrides.type ?? 'info',
    content: overrides.content ?? 'Hello world',
    timestamp: overrides.timestamp ?? Date.now(),
    read: overrides.read ?? false,
  }
}

// ---------- reset between tests ----------
beforeEach(() => {
  mockTerminals = []
  mockSwarmActive = false
  mockSwarmAgents = []
  mockSetSwarmActive = vi.fn()
  mockSetSwarmAgents = vi.fn()
  mockSetActiveTerminal = vi.fn()
  mockRemoveTerminal = vi.fn()
  mockConductorStatus = 'idle'
  vi.clearAllMocks()
  ;(window.swarmAPI.getMessages as any).mockResolvedValue({ success: true, data: [] })
  ;(window.swarmAPI.getTasks as any).mockResolvedValue({ success: true, data: [] })
})

// ==========================================================================
// TESTS
// ==========================================================================

describe('SwarmDashboard', () => {
  // ------------------------------------------------------------------
  // Basic rendering (existing)
  // ------------------------------------------------------------------
  it('renders the dashboard overlay with title', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Swarm Dashboard')).toBeInTheDocument()
  })

  it('shows Tasks and Messages tabs', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('Messages')).toBeInTheDocument()
  })

  it('shows Start Swarm button when swarm not active', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Start Swarm')).toBeInTheDocument()
  })

  it('shows Clear button', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Clear')).toBeInTheDocument()
  })

  // ------------------------------------------------------------------
  // Clear confirmation (existing)
  // ------------------------------------------------------------------
  describe('Clear confirmation', () => {
    it('shows confirmation modal when Clear is clicked', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Clear'))
      expect(screen.getByText(/All swarm work will be lost/)).toBeInTheDocument()
      const heading = screen.getAllByText('Clear Swarm').find((el) => el.tagName === 'H3')
      expect(heading).toBeInTheDocument()
    })

    it('confirmation modal has Cancel and confirm buttons', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Clear'))
      expect(screen.getByText('Cancel')).toBeInTheDocument()
      const confirmBtn = screen.getAllByText(/Clear Swarm/).find((el) => el.tagName === 'BUTTON')
      expect(confirmBtn).toBeInTheDocument()
    })

    it('dismisses confirmation modal when Cancel is clicked', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Clear'))
      expect(screen.getByText(/All swarm work will be lost/)).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))
      expect(screen.queryByText(/All swarm work will be lost/)).not.toBeInTheDocument()
    })

    it('calls clear APIs when confirm is clicked', async () => {
      mockSwarmActive = true
      mockTerminals = [{ id: 'sw-1', name: 'Agent 1', isSwarm: true, hidden: false, isConductor: false }]
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Clear'))
      const confirmBtn = screen.getAllByText(/Clear Swarm/).find((el) => el.tagName === 'BUTTON')!
      fireEvent.click(confirmBtn)
      await waitFor(() => {
        expect(window.swarmAPI.clear).toHaveBeenCalled()
      })
    })
  })

  // ------------------------------------------------------------------
  // 1. Agent status rendering
  // ------------------------------------------------------------------
  // Agent status/summary/waiting-for-input render tests were removed along with
  // the Agents tab. Conductor (claude --dangerously-skip-permissions) has
  // native write/edit/bash tools and typically does work itself instead of
  // delegating to per-agent terminals, so per-agent idle rows were misleading.
  // Agent-status detection logic is still covered by agentStatusDetector.test.ts.

  // ------------------------------------------------------------------
  // 4. Tab switching
  // ------------------------------------------------------------------
  describe('Tab switching', () => {
    it('defaults to Tasks tab', async () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument()
        expect(screen.getByText('In Progress')).toBeInTheDocument()
        expect(screen.getByText('Completed')).toBeInTheDocument()
      })
    })

    // Bumped per-call timeouts on 2026-05-12 — windows-latest CI runners
    // are slow enough that the default 1s waitFor / 5s test timeout flake on
    // the getTasks promise resolving + React re-rendering with the kanban data.
    // Local + macOS both run this in <500ms.
    it('Tasks tab shows kanban columns with data', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ title: 'Kanban Task', status: 'pending' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByText('Kanban Task')).toBeInTheDocument()
      }, { timeout: 8000 })
    }, 15000)

    it('switches to Messages tab and shows empty message', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      expect(screen.getByText(/No swarm messages yet/)).toBeInTheDocument()
    })

    it('switches back to Tasks tab from Messages', async () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument()
      })
    })
  })

  // ------------------------------------------------------------------
  // 5. Task columns (kanban layout)
  // ------------------------------------------------------------------
  describe('Task columns', () => {
    it('renders tasks in the correct columns', async () => {
      const pending = makeTask({ id: 't1', title: 'Pending Task', status: 'pending', createdBy: 'alice' })
      const inProgress = makeTask({ id: 't2', title: 'Active Task', status: 'in_progress', createdBy: 'bob' })
      const completed = makeTask({ id: 't3', title: 'Done Task', status: 'completed', createdBy: 'carol' })
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [pending, inProgress, completed],
      })

      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))

      await waitFor(() => {
        expect(screen.getByText('Pending Task')).toBeInTheDocument()
        expect(screen.getByText('Active Task')).toBeInTheDocument()
        expect(screen.getByText('Done Task')).toBeInTheDocument()
      })
    })

    it('shows task description text', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ title: 'My Task', description: 'Important description here' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        expect(screen.getByText('Important description here')).toBeInTheDocument()
      })
    })

    it('shows Start and Cancel buttons for pending tasks', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ title: 'Pending One', status: 'pending' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        expect(screen.getByText('Start')).toBeInTheDocument()
        // The "Cancel" button uses the text "Cancel" in task action buttons
        // Actually it's rendered as "Cancel" for pending tasks
        const cancelBtns = screen.getAllByText('Cancel')
        expect(cancelBtns.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('shows Done and Fail buttons for in_progress tasks', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ title: 'In Progress One', status: 'in_progress' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        expect(screen.getByText('Done')).toBeInTheDocument()
        expect(screen.getByText('Fail')).toBeInTheDocument()
      })
    })

    it('applies pulsing animation class to in_progress task cards', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ title: 'Actively Working', status: 'in_progress' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => screen.getByText('Actively Working'))
      // Card should have animate-pulse-border class
      const card = screen.getByText('Actively Working').closest('.animate-pulse-border')
      expect(card).toBeInTheDocument()
    })

    it('does NOT apply pulse animation to pending or completed tasks', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [
          makeTask({ title: 'Not Started', status: 'pending' }),
          makeTask({ title: 'All Done', status: 'completed' }),
        ],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => screen.getByText('Not Started'))
      expect(screen.getByText('Not Started').closest('.animate-pulse-border')).toBeNull()
      expect(screen.getByText('All Done').closest('.animate-pulse-border')).toBeNull()
    })

    it('calls updateTask when Start button is clicked', async () => {
      const task = makeTask({ id: 'task-x', title: 'Start Me', status: 'pending' })
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({ success: true, data: [task] })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => screen.getByText('Start'))
      fireEvent.click(screen.getByText('Start'))
      expect(window.swarmAPI.updateTask).toHaveBeenCalledWith('task-x', 'in_progress')
    })

    it('shows task result when present', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ title: 'Completed', status: 'completed', result: 'All tests passed' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        expect(screen.getByText('All tests passed')).toBeInTheDocument()
      })
    })

    it('shows "None" when a column has no tasks', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({ success: true, data: [] })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        const noneElements = screen.getAllByText('None')
        expect(noneElements.length).toBe(3)
      })
    })

    it('shows task count in column headers', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [
          makeTask({ status: 'pending' }),
          makeTask({ status: 'pending' }),
          makeTask({ status: 'in_progress' }),
        ],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        expect(screen.getByText('(2)')).toBeInTheDocument()
        expect(screen.getByText('(1)')).toBeInTheDocument()
        expect(screen.getByText('(0)')).toBeInTheDocument()
      })
    })
  })

  // ------------------------------------------------------------------
  // 6. Messages tab
  // ------------------------------------------------------------------
  describe('Messages tab', () => {
    it('renders messages with type, from, to, and content', async () => {
      ;(window.swarmAPI.getMessages as any).mockResolvedValue({
        success: true,
        data: [
          makeMessage({ from: 'agent-A', to: 'agent-B', type: 'task', content: 'Build the login page' }),
        ],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      await waitFor(() => {
        expect(screen.getByText('task')).toBeInTheDocument()
        expect(screen.getByText('agent-A')).toBeInTheDocument()
        expect(screen.getByText('agent-B')).toBeInTheDocument()
        expect(screen.getByText('Build the login page')).toBeInTheDocument()
      })
    })

    it('shows correct type color classes for each message type', async () => {
      const types = ['task', 'result', 'question', 'info', 'review'] as const
      const expectedColors: Record<string, string> = {
        task: 'text-yellow-400',
        result: 'text-green-400',
        question: 'text-blue-400',
        info: 'text-gray-400',
        review: 'text-purple-400',
      }
      ;(window.swarmAPI.getMessages as any).mockResolvedValue({
        success: true,
        data: types.map((type, i) =>
          makeMessage({ id: `msg-${i}`, type, content: `Content-${type}`, from: `from-${type}` }),
        ),
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      await waitFor(() => {
        types.forEach((type) => {
          const typeEl = screen.getByText(type)
          expect(typeEl.className).toContain(expectedColors[type])
        })
      })
    })

    it('shows (read) indicator for read messages', async () => {
      ;(window.swarmAPI.getMessages as any).mockResolvedValue({
        success: true,
        data: [makeMessage({ read: true, content: 'Read msg' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      await waitFor(() => {
        expect(screen.getByText('(read)')).toBeInTheDocument()
      })
    })

    it('shows empty state when no messages', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      expect(screen.getByText(/No swarm messages yet/)).toBeInTheDocument()
    })
  })

  // ------------------------------------------------------------------
  // 7. Start Swarm button
  // ------------------------------------------------------------------
  describe('Start Swarm button', () => {
    it('shows "Start Swarm" when swarm is not active', () => {
      mockSwarmActive = false
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('Start Swarm')).toBeInTheDocument()
    })

    it('hides "Start Swarm" and shows "Swarm Active" lock when swarm is active', () => {
      mockSwarmActive = true
      render(<SwarmDashboard onClose={vi.fn()} />)
      // Should not have a clickable Start Swarm button
      expect(screen.queryByRole('button', { name: /Start Swarm/i })).not.toBeInTheDocument()
      // The locked "Swarm Active" span should exist in the header actions area
      const activeSpans = screen.getAllByText('Swarm Active')
      // At least the lock span exists
      expect(activeSpans.length).toBeGreaterThanOrEqual(1)
    })

    it('shows "Start New Swarm" when conductor status is done and swarm not active', async () => {
      vi.useFakeTimers()
      mockSwarmActive = false
      mockConductorStatus = 'done'
      render(<SwarmDashboard onClose={vi.fn()} />)
      // Advance past the 3s conductor poll interval
      await vi.advanceTimersByTimeAsync(3100)
      expect(screen.getByText('Start New Swarm')).toBeInTheDocument()
      vi.useRealTimers()
    })

    it('calls pickDirectory when Start Swarm is clicked', async () => {
      mockSwarmActive = false
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Start Swarm'))
      await waitFor(() => {
        expect(window.termpolis.pickDirectory).toHaveBeenCalled()
      })
    })
  })

  // ------------------------------------------------------------------
  // 10. Debug button
  // ------------------------------------------------------------------
  describe('Debug button', () => {
    it('is visible when swarm is active', () => {
      mockSwarmActive = true
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('Debug')).toBeInTheDocument()
    })

    it('is not visible when swarm is not active', () => {
      mockSwarmActive = false
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.queryByText('Debug')).not.toBeInTheDocument()
    })

    it('calls revealConductor when clicked', async () => {
      mockSwarmActive = true
      const { revealConductor } = await import('../../src/renderer/src/lib/conductorManager')
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Debug'))
      expect(revealConductor).toHaveBeenCalled()
    })
  })

  // ------------------------------------------------------------------
  // 11. Conductor status badges
  // ------------------------------------------------------------------
  describe('Conductor status badges', () => {
    it('shows "Swarm Active" badge when swarm is active and conductor is not done', () => {
      mockSwarmActive = true
      mockConductorStatus = 'running'
      render(<SwarmDashboard onClose={vi.fn()} />)
      // The badge in the header
      const activeBadges = screen.getAllByText('Swarm Active')
      // Should have the header badge
      expect(activeBadges.length).toBeGreaterThanOrEqual(1)
    })

    it('shows "Swarm Complete" badge when conductor status is done', async () => {
      vi.useFakeTimers()
      mockSwarmActive = true
      mockConductorStatus = 'done'
      render(<SwarmDashboard onClose={vi.fn()} />)
      await vi.advanceTimersByTimeAsync(3100)
      expect(screen.getByText('Swarm Complete')).toBeInTheDocument()
      vi.useRealTimers()
    })

    it('shows conductor running badge when conductor is running', async () => {
      vi.useFakeTimers()
      mockSwarmActive = true
      mockConductorStatus = 'running'
      render(<SwarmDashboard onClose={vi.fn()} />)
      await vi.advanceTimersByTimeAsync(3100)
      expect(screen.getByText('Conductor: running')).toBeInTheDocument()
      vi.useRealTimers()
    })

    it('shows conductor error badge when conductor has errored', async () => {
      vi.useFakeTimers()
      mockSwarmActive = true
      mockConductorStatus = 'error'
      render(<SwarmDashboard onClose={vi.fn()} />)
      await vi.advanceTimersByTimeAsync(3100)
      expect(screen.getByText('Conductor: error')).toBeInTheDocument()
      vi.useRealTimers()
    })

    it('does not show any badge when swarm is not active and conductor is idle', () => {
      mockSwarmActive = false
      mockConductorStatus = 'idle'
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.queryByText('Swarm Active')).not.toBeInTheDocument()
      expect(screen.queryByText('Swarm Complete')).not.toBeInTheDocument()
    })
  })

  // ------------------------------------------------------------------
  // 12. Escape to close
  // ------------------------------------------------------------------
  describe('Escape to close', () => {
    it('calls onClose when Escape is pressed', () => {
      const onClose = vi.fn()
      render(<SwarmDashboard onClose={onClose} />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does NOT call onClose on Escape when StartSwarmModal is open', async () => {
      const onClose = vi.fn()
      mockSwarmActive = false
      render(<SwarmDashboard onClose={onClose} />)
      // Open the start swarm modal via the button
      fireEvent.click(screen.getByText('Start Swarm'))
      await waitFor(() => {
        expect(screen.getByTestId('start-swarm-modal')).toBeInTheDocument()
      })
      fireEvent.keyDown(window, { key: 'Escape' })
      // onClose should NOT have been called because the wizard is open
      expect(onClose).not.toHaveBeenCalled()
    })

    it('does not call onClose for other keys', () => {
      const onClose = vi.fn()
      render(<SwarmDashboard onClose={onClose} />)
      fireEvent.keyDown(window, { key: 'Enter' })
      fireEvent.keyDown(window, { key: 'a' })
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------------------------------
  // Additional edge cases
  // ------------------------------------------------------------------
  describe('Edge cases', () => {
    it('shows empty kanban columns by default when no tasks', async () => {
      mockSwarmAgents = []
      mockTerminals = []
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({ success: true, data: [] })
      render(<SwarmDashboard onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument()
        expect(screen.getByText('In Progress')).toBeInTheDocument()
        expect(screen.getByText('Completed')).toBeInTheDocument()
      })
    })

    it('shows task count badge on Tasks tab when tasks exist', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ id: 't1', status: 'pending' }), makeTask({ id: 't2', status: 'completed' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByText('2')).toBeInTheDocument()
      })
    })

    it('closes overlay when clicking the backdrop', () => {
      const onClose = vi.fn()
      render(<SwarmDashboard onClose={onClose} />)
      // Click the outer overlay div
      const overlay = screen.getByText('Swarm Dashboard').closest('.fixed')!
      fireEvent.click(overlay)
      expect(onClose).toHaveBeenCalled()
    })

    it('does not close overlay when clicking inside the modal', () => {
      const onClose = vi.fn()
      render(<SwarmDashboard onClose={onClose} />)
      // Click on the dashboard title (inside modal)
      fireEvent.click(screen.getByText('Swarm Dashboard'))
      expect(onClose).not.toHaveBeenCalled()
    })

    it('shows stats in the header (task count, message count)', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText(/0 tasks/)).toBeInTheDocument()
      expect(screen.getByText(/0 msgs/)).toBeInTheDocument()
    })
  })
})
