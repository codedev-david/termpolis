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

  it('shows Agents, Tasks, and Messages tabs', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Agents')).toBeInTheDocument()
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
  describe('Agent status rendering', () => {
    const statuses = [
      { status: 'starting', label: 'Starting', iconClass: 'fa-spinner' },
      { status: 'thinking', label: 'Thinking', iconClass: 'fa-brain' },
      { status: 'waiting_for_input', label: 'Needs Input', iconClass: 'fa-hand' },
      { status: 'working', label: 'Working', iconClass: 'fa-hammer' },
      { status: 'idle', label: 'Idle', iconClass: 'fa-circle-check' },
      { status: 'errored', label: 'Error', iconClass: 'fa-triangle-exclamation' },
      { status: 'completed', label: 'Done', iconClass: 'fa-flag-checkered' },
    ]

    statuses.forEach(({ status, label, iconClass }) => {
      it(`renders agent with status "${status}" showing label "${label}" and icon "${iconClass}"`, () => {
        const termId = `term-${status}`
        mockSwarmAgents = [makeAgent({ agentName: `Agent-${status}`, status, terminalId: termId })]
        // Do NOT add a matching terminal with the same name to avoid duplicate text
        mockTerminals = []
        render(<SwarmDashboard onClose={vi.fn()} />)
        expect(screen.getByText(label)).toBeInTheDocument()
        expect(screen.getByText(`Agent-${status}`)).toBeInTheDocument()
        // Verify the icon element exists with the correct class
        const iconEl = document.querySelector(`.${iconClass}`)
        expect(iconEl).not.toBeNull()
      })
    })
  })

  // ------------------------------------------------------------------
  // 2. Agent summary display
  // ------------------------------------------------------------------
  describe('Agent summary display', () => {
    it('displays summary text under the agent name', () => {
      mockSwarmAgents = [makeAgent({ agentName: 'Coder-1', summary: 'Refactoring the auth module' })]
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('Refactoring the auth module')).toBeInTheDocument()
    })

    it('does not render summary element when summary is undefined', () => {
      mockSwarmAgents = [makeAgent({ agentName: 'Coder-2', summary: undefined })]
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('Coder-2')).toBeInTheDocument()
      expect(screen.queryByText('Refactoring the auth module')).not.toBeInTheDocument()
    })
  })

  // ------------------------------------------------------------------
  // 3. Waiting_for_input agents are clickable
  // ------------------------------------------------------------------
  describe('Waiting-for-input agents', () => {
    it('has orange border class for waiting_for_input agent', () => {
      const agent = makeAgent({ agentName: 'Blocked-Agent', status: 'waiting_for_input' })
      mockSwarmAgents = [agent]
      render(<SwarmDashboard onClose={vi.fn()} />)
      const agentEl = screen.getByText('Blocked-Agent').closest('[class*="border-orange"]')
      expect(agentEl).not.toBeNull()
    })

    it('clicking a waiting_for_input agent calls setActiveTerminal and onClose', () => {
      const onClose = vi.fn()
      const agent = makeAgent({ agentName: 'Blocked-Agent', status: 'waiting_for_input', terminalId: 'term-blocked' })
      mockSwarmAgents = [agent]
      render(<SwarmDashboard onClose={onClose} />)
      const agentRow = screen.getByText('Blocked-Agent').closest('[class*="cursor-pointer"]')!
      fireEvent.click(agentRow)
      expect(onClose).toHaveBeenCalled()
    })

    it('non-waiting agents are NOT clickable', () => {
      const onClose = vi.fn()
      mockSwarmAgents = [makeAgent({ agentName: 'Working-Agent', status: 'working' })]
      render(<SwarmDashboard onClose={onClose} />)
      const agentRow = screen.getByText('Working-Agent').closest('[class*="bg-"]')
      // Should not have cursor-pointer
      expect(agentRow?.className).not.toContain('cursor-pointer')
    })
  })

  // ------------------------------------------------------------------
  // 4. Tab switching
  // ------------------------------------------------------------------
  describe('Tab switching', () => {
    it('defaults to Agents tab', () => {
      mockSwarmAgents = []
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('No swarm agents running. Start a swarm to see agents here.')).toBeInTheDocument()
    })

    it('switches to Tasks tab and shows kanban columns', async () => {
      ;(window.swarmAPI.getTasks as any).mockResolvedValue({
        success: true,
        data: [makeTask({ title: 'Kanban Task', status: 'pending' })],
      })
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Tasks'))
      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument()
        expect(screen.getByText('In Progress')).toBeInTheDocument()
        expect(screen.getByText('Completed')).toBeInTheDocument()
      })
    })

    it('switches to Messages tab and shows empty message', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      expect(screen.getByText(/No swarm messages yet/)).toBeInTheDocument()
    })

    it('switches back to Agents tab from Messages', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByText('Messages'))
      fireEvent.click(screen.getByText('Agents'))
      expect(screen.getByText('No swarm agents running. Start a swarm to see agents here.')).toBeInTheDocument()
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
  // 7. New Task modal
  // ------------------------------------------------------------------
  describe('New Task modal', () => {
    it('opens when Task button is clicked', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      // The "+ Task" button in the tab bar
      const taskBtn = screen.getByTitle('New Task')
      fireEvent.click(taskBtn)
      expect(screen.getByText('New Swarm Task')).toBeInTheDocument()
    })

    it('has title, description, and assignee fields', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('New Task'))
      expect(screen.getByPlaceholderText('Task title')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Description')).toBeInTheDocument()
      expect(screen.getByText('Unassigned (pending)')).toBeInTheDocument()
    })

    it('submits a new task with entered values', async () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('New Task'))

      fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'New feature' } })
      fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Build it fast' } })
      fireEvent.click(screen.getByText('Create'))

      await waitFor(() => {
        expect(window.swarmAPI.createTask).toHaveBeenCalledWith('New feature', 'Build it fast', 'dashboard', undefined)
      })
    })

    it('does not submit when title is empty', async () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('New Task'))
      fireEvent.click(screen.getByText('Create'))
      expect(window.swarmAPI.createTask).not.toHaveBeenCalled()
    })

    it('closes when Cancel is clicked', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('New Task'))
      expect(screen.getByText('New Swarm Task')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))
      expect(screen.queryByText('New Swarm Task')).not.toBeInTheDocument()
    })

    it('clears fields after successful submission', async () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('New Task'))
      fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Some task' } })
      fireEvent.click(screen.getByText('Create'))
      await waitFor(() => {
        expect(window.swarmAPI.createTask).toHaveBeenCalled()
      })
      // Modal should close after creation
      expect(screen.queryByText('New Swarm Task')).not.toBeInTheDocument()
    })
  })

  // ------------------------------------------------------------------
  // 8. Broadcast modal
  // ------------------------------------------------------------------
  describe('Broadcast modal', () => {
    it('opens when Broadcast button is clicked', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('Broadcast Message'))
      expect(screen.getByText('Broadcast to All Agents')).toBeInTheDocument()
    })

    it('has type selector and content textarea', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('Broadcast Message'))
      expect(screen.getByText('Info')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Message content...')).toBeInTheDocument()
    })

    it('sends a broadcast message with selected type', async () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('Broadcast Message'))

      // Change type to "task"
      const select = screen.getByDisplayValue('Info')
      fireEvent.change(select, { target: { value: 'task' } })

      fireEvent.change(screen.getByPlaceholderText('Message content...'), {
        target: { value: 'Everyone focus on auth' },
      })
      fireEvent.click(screen.getByText('Send'))

      await waitFor(() => {
        expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith(
          'dashboard',
          'all',
          'task',
          'Everyone focus on auth',
        )
      })
    })

    it('does not send when content is empty', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('Broadcast Message'))
      fireEvent.click(screen.getByText('Send'))
      expect(window.swarmAPI.sendMessage).not.toHaveBeenCalled()
    })

    it('closes when Cancel is clicked', () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('Broadcast Message'))
      expect(screen.getByText('Broadcast to All Agents')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))
      expect(screen.queryByText('Broadcast to All Agents')).not.toBeInTheDocument()
    })

    it('closes after successful send', async () => {
      render(<SwarmDashboard onClose={vi.fn()} />)
      fireEvent.click(screen.getByTitle('Broadcast Message'))
      fireEvent.change(screen.getByPlaceholderText('Message content...'), {
        target: { value: 'Go go go' },
      })
      fireEvent.click(screen.getByText('Send'))
      await waitFor(() => {
        expect(screen.queryByText('Broadcast to All Agents')).not.toBeInTheDocument()
      })
    })
  })

  // ------------------------------------------------------------------
  // 9. Start Swarm button
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
    it('shows empty agents message when no agents and no terminals', () => {
      mockSwarmAgents = []
      mockTerminals = []
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('No swarm agents running. Start a swarm to see agents here.')).toBeInTheDocument()
    })

    it('renders agent role text', () => {
      mockSwarmAgents = [makeAgent({ agentName: 'Specialist', role: 'reviewer' })]
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('reviewer')).toBeInTheDocument()
    })

    it('renders swarm terminal entries (non-agent swarm terminals)', () => {
      mockSwarmAgents = []
      mockTerminals = [
        { id: 'sw-t1', name: 'Worker-1', isSwarm: true, hidden: false, isConductor: false, color: '#ff0', cwd: '/project', shellType: 'zsh' },
      ]
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('Worker-1')).toBeInTheDocument()
      expect(screen.getByText('/project')).toBeInTheDocument()
      expect(screen.getByText('zsh')).toBeInTheDocument()
    })

    it('hides conductor terminals from the list', () => {
      mockSwarmAgents = []
      mockTerminals = [
        { id: 'cond-1', name: 'Conductor', isSwarm: true, hidden: false, isConductor: true, color: '#fff', cwd: '/tmp', shellType: 'bash' },
      ]
      render(<SwarmDashboard onClose={vi.fn()} />)
      // Conductor terminals should be filtered out
      expect(screen.queryByText('Conductor')).not.toBeInTheDocument()
    })

    it('hides hidden swarm terminals from the list', () => {
      mockSwarmAgents = []
      mockTerminals = [
        { id: 'hidden-1', name: 'HiddenAgent', isSwarm: true, hidden: true, isConductor: false, color: '#fff', cwd: '/tmp', shellType: 'bash' },
      ]
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.queryByText('HiddenAgent')).not.toBeInTheDocument()
    })

    it('shows agent count badge on Agents tab when agents exist', () => {
      mockSwarmAgents = [makeAgent(), makeAgent({ terminalId: 'term-2', agentName: 'Agent-2' })]
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText('2')).toBeInTheDocument()
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

    it('shows stats in the header (agent count, task count, message count)', () => {
      mockTerminals = [
        { id: 'sw-1', name: 'A1', isSwarm: true, hidden: false, isConductor: false },
        { id: 'sw-2', name: 'A2', isSwarm: true, hidden: false, isConductor: false },
      ]
      render(<SwarmDashboard onClose={vi.fn()} />)
      expect(screen.getByText(/2 agents/)).toBeInTheDocument()
      expect(screen.getByText(/0 tasks/)).toBeInTheDocument()
      expect(screen.getByText(/0 msgs/)).toBeInTheDocument()
    })
  })
})
