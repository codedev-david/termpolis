import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ===========================================================================
// SwarmCoverage.test.tsx
//
// Branch/function coverage for the two swarm modals. This file deliberately
// targets the paths the original suites never reach: abort/unmount races in
// the conductor prep flow, every arm of the launch poll loop (task/message/
// agent-terminal progress, API failure fallbacks, conductor error, 60s
// timeout), and the dashboard's review/refine + handoff-animation wiring.
//
// StartSwarmModal is mocked for the SwarmDashboard tests (so we can observe
// exactly which props the dashboard hands it) and pulled in via importActual
// for its own tests, so both files get exercised for real in one run.
// ===========================================================================

// ---------------------------------------------------------------------------
// Mutable mock state (hoisted so the vi.mock factories can close over it)
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  terminals: [] as any[],
  swarmActive: false,
  swarmSummary: null as any,
  conductorState: { terminalId: null as string | null, status: 'idle', error: null as string | null },
  setSwarmActive: vi.fn(),
  setSwarmAgents: vi.fn(),
  removeTerminal: vi.fn(),
  pollCb: null as null | (() => unknown),
  startSwarmProps: null as any,
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../../src/renderer/src/store/terminalStore', () => {
  const getState = () => ({
    terminals: H.terminals,
    swarmActive: H.swarmActive,
    swarmCompletionSummary: H.swarmSummary,
    setSwarmActive: H.setSwarmActive,
    setSwarmAgents: H.setSwarmAgents,
    removeTerminal: H.removeTerminal,
  })
  const useTerminalStore: any = (selector?: any) => (selector ? selector(getState()) : getState())
  useTerminalStore.getState = getState
  useTerminalStore.setState = vi.fn()
  return { useTerminalStore }
})

vi.mock('../../src/renderer/src/lib/conductorManager', () => ({
  checkClaudeInstalled: vi.fn(),
  startConductor: vi.fn(),
  waitForAuth: vi.fn(),
  sendTask: vi.fn(),
  stopConductor: vi.fn(),
  revealConductor: vi.fn(),
  getConductorState: vi.fn(() => ({ ...H.conductorState })),
}))

vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn((_id: string, cb: () => unknown) => {
    H.pollCb = cb
  }),
  unsubscribe: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/swarmBridgeManager', () => ({
  stopAllBridges: vi.fn(),
}))

vi.mock('../../src/renderer/src/components/ConductorTrace/ConductorTrace', () => ({
  ConductorTrace: (props: any) => (
    <div data-testid="conductor-trace">trace:{String(props.conductorTerminalId)}</div>
  ),
}))

vi.mock('../../src/renderer/src/components/HandoffAnimation/HandoffAnimation', () => ({
  HandoffAnimation: (props: any) => (
    <div data-testid="handoff">
      <span data-testid="handoff-from">{props.fromAgent ?? '(none)'}</span>
      <span data-testid="handoff-to">{props.toAgent}</span>
      <button onClick={props.onComplete}>handoff-done</button>
    </div>
  ),
}))

vi.mock('../../src/renderer/src/components/SwarmReview/SwarmReviewPanel', () => ({
  SwarmReviewPanel: (props: any) => (
    <div data-testid="review-panel">
      <span data-testid="review-sha">{props.preSwarmSha}</span>
      <span data-testid="review-cwd">{props.cwd}</span>
      <span data-testid="review-desc">{props.taskDescription ?? '(none)'}</span>
      <button onClick={props.onClose}>review-close</button>
      <button onClick={() => props.onRefineWithSwarm('  make it prettier  ')}>review-refine</button>
    </div>
  ),
}))

vi.mock('../../src/renderer/src/components/SwarmDashboard/StartSwarmModal', () => ({
  StartSwarmModal: (props: any) => {
    H.startSwarmProps = props
    // The real modal puts every control inside a panel that stops propagation
    // (it is a DOM child of the dashboard's own click-to-close backdrop), so
    // the stub has to do the same or its clicks would close the dashboard too.
    return (
      <div data-testid="start-swarm-modal">
        <div onClick={(e) => e.stopPropagation()}>
          <span data-testid="ssm-cwd">{props.projectCwd}</span>
          <button onClick={props.onClose}>ssm-close</button>
          <button onClick={props.onLaunched}>ssm-launched</button>
        </div>
      </div>
    )
  },
}))

import {
  checkClaudeInstalled,
  startConductor,
  waitForAuth,
  sendTask,
  stopConductor,
  revealConductor,
  getConductorState,
} from '../../src/renderer/src/lib/conductorManager'
import { stopAllBridges } from '../../src/renderer/src/lib/swarmBridgeManager'
import { SwarmDashboard } from '../../src/renderer/src/components/SwarmDashboard/SwarmDashboard'

// The real StartSwarmModal (its deps — conductorManager / terminalStore — stay mocked).
const realModalModule = await vi.importActual<
  typeof import('../../src/renderer/src/components/SwarmDashboard/StartSwarmModal')
>('../../src/renderer/src/components/SwarmDashboard/StartSwarmModal')
const StartSwarmModal = realModalModule.StartSwarmModal

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let taskSeq = 0
function makeTask(overrides: Record<string, any> = {}) {
  taskSeq += 1
  return {
    id: `task-${taskSeq}`,
    title: 'A Task',
    description: '',
    assignedTo: '',
    status: 'pending',
    createdBy: 'conductor',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

let msgSeq = 0
function makeMessage(overrides: Record<string, any> = {}) {
  msgSeq += 1
  return {
    id: `msg-${msgSeq}`,
    from: 'conductor',
    to: 'all',
    type: 'info',
    content: 'hello',
    timestamp: 1_700_000_000_000,
    read: false,
    ...overrides,
  }
}

/** A visible swarm agent terminal (isSwarm && !isConductor && !hidden). */
function agentTerminal(id: string) {
  return { id, name: `Agent ${id}`, isSwarm: true, isConductor: false, hidden: false }
}

function swarmApi() {
  return window.swarmAPI as unknown as Record<string, ReturnType<typeof vi.fn>>
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  // vi.restoreAllMocks() only restores vi.spyOn spies in Vitest 4 — module
  // mocks keep their call history unless explicitly cleared.
  vi.clearAllMocks()

  H.terminals = []
  H.swarmActive = false
  H.swarmSummary = null
  H.conductorState = { terminalId: null, status: 'idle', error: null }
  H.setSwarmActive = vi.fn()
  H.setSwarmAgents = vi.fn()
  H.removeTerminal = vi.fn()
  H.pollCb = null
  H.startSwarmProps = null

  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({ success: true, data: { claude: true } }),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/picked/dir' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
  }
  ;(window as any).swarmAPI = {
    getMessages: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    clear: vi.fn().mockResolvedValue({ success: true }),
    updateTask: vi.fn().mockResolvedValue({ success: true }),
  }

  vi.mocked(checkClaudeInstalled).mockResolvedValue(true)
  vi.mocked(startConductor).mockResolvedValue({ success: true, needsAuth: false })
  vi.mocked(waitForAuth).mockResolvedValue(true)
  vi.mocked(sendTask).mockResolvedValue(undefined)
  vi.mocked(stopConductor).mockReturnValue(undefined)
  vi.mocked(revealConductor).mockReturnValue(undefined)
  vi.mocked(getConductorState).mockImplementation(() => ({ ...H.conductorState }) as any)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ===========================================================================
// StartSwarmModal
// ===========================================================================
describe('StartSwarmModal — preparation flow', () => {
  it('falls back to a generic error when startConductor fails without a message', async () => {
    vi.mocked(startConductor).mockResolvedValue({ success: false })
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/p" />)

    await waitFor(() => {
      expect(screen.getByText('Failed to start conductor')).toBeInTheDocument()
    })
    // Error on the preparing step reveals the footer Close button.
    expect(screen.getByText('Close')).toBeInTheDocument()
    expect(screen.queryByText('Describe what you want built')).not.toBeInTheDocument()
  })

  it('closes from the error footer via handleCancel', async () => {
    const onClose = vi.fn()
    vi.mocked(startConductor).mockResolvedValue({ success: false, error: 'boom' })
    render(<StartSwarmModal onClose={onClose} onLaunched={vi.fn()} projectCwd="/p" />)

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Close'))

    expect(stopConductor).toHaveBeenCalled()
    expect(H.setSwarmActive).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('waits for auth, then advances to the describe step once authenticated', async () => {
    let resolveAuth: (v: boolean) => void = () => {}
    vi.mocked(startConductor).mockResolvedValue({ success: true, needsAuth: true })
    vi.mocked(waitForAuth).mockReturnValue(new Promise<boolean>((r) => { resolveAuth = r }))

    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/p" />)

    await waitFor(() => {
      expect(screen.getByText(/Complete sign-in in your browser/)).toBeInTheDocument()
    })
    expect(screen.getByText('Waiting for authentication...')).toBeInTheDocument()

    await act(async () => {
      resolveAuth(true)
    })

    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    })
    // Auth banner is torn down once we're through.
    expect(screen.queryByText(/Complete sign-in in your browser/)).not.toBeInTheDocument()
  })

  it('surfaces an auth timeout and stays on the preparing step', async () => {
    vi.mocked(startConductor).mockResolvedValue({ success: true, needsAuth: true })
    vi.mocked(waitForAuth).mockResolvedValue(false)

    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/p" />)

    await waitFor(() => {
      expect(screen.getByText('Authentication timed out. Please try again.')).toBeInTheDocument()
    })
    expect(screen.queryByText(/Complete sign-in in your browser/)).not.toBeInTheDocument()
    expect(screen.queryByText('Describe what you want built')).not.toBeInTheDocument()
  })

  it('does not start a conductor when unmounted mid Claude-check', async () => {
    let resolveInstalled: (v: boolean) => void = () => {}
    vi.mocked(checkClaudeInstalled).mockReturnValue(new Promise<boolean>((r) => { resolveInstalled = r }))

    const { unmount } = render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/p" />)
    unmount()

    await act(async () => {
      resolveInstalled(true)
    })

    expect(startConductor).not.toHaveBeenCalled()
  })

  it('aborts the prep flow when cancelled while the conductor is starting', async () => {
    const onClose = vi.fn()
    let resolveStart: (v: any) => void = () => {}
    vi.mocked(startConductor).mockReturnValue(new Promise((r) => { resolveStart = r }))

    render(<StartSwarmModal onClose={onClose} onLaunched={vi.fn()} projectCwd="/p" />)
    await waitFor(() => expect(startConductor).toHaveBeenCalledWith('/p'))

    fireEvent.click(document.querySelector('.fa-xmark')!.closest('button')!)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(stopConductor).toHaveBeenCalled()

    await act(async () => {
      resolveStart({ success: true, needsAuth: false })
    })

    // Aborted: it must not walk on into the describe step behind the user's back.
    expect(screen.queryByText('Describe what you want built')).not.toBeInTheDocument()
  })

  it('aborts the prep flow when cancelled while waiting for auth', async () => {
    let resolveAuth: (v: boolean) => void = () => {}
    vi.mocked(startConductor).mockResolvedValue({ success: true, needsAuth: true })
    vi.mocked(waitForAuth).mockReturnValue(new Promise<boolean>((r) => { resolveAuth = r }))

    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/p" />)
    await waitFor(() => {
      expect(screen.getByText(/Complete sign-in in your browser/)).toBeInTheDocument()
    })

    fireEvent.click(document.querySelector('.fa-xmark')!.closest('button')!)
    await act(async () => {
      resolveAuth(true)
    })

    expect(screen.queryByText('Describe what you want built')).not.toBeInTheDocument()
  })

  it('opens the Claude Code docs in a new window and suppresses navigation', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    vi.mocked(checkClaudeInstalled).mockResolvedValue(false)

    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} projectCwd="/p" />)
    await waitFor(() => expect(screen.getByText('Claude Code Required')).toBeInTheDocument())

    // fireEvent.click returns false when the handler called preventDefault().
    const defaultNotPrevented = fireEvent.click(screen.getByText('Claude Code Documentation'))

    expect(defaultNotPrevented).toBe(false)
    expect(openSpy).toHaveBeenCalledWith('https://docs.anthropic.com/en/docs/claude-code', '_blank')
    expect(startConductor).not.toHaveBeenCalled()
  })
})

describe('StartSwarmModal — describe step', () => {
  async function toDescribeStep(projectCwd = '/test/project') {
    const onLaunched = vi.fn()
    const onClose = vi.fn()
    const utils = render(
      <StartSwarmModal onClose={onClose} onLaunched={onLaunched} projectCwd={projectCwd} />,
    )
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    })
    return { ...utils, onLaunched, onClose }
  }

  it('ignores non-Escape keys', async () => {
    const { onClose } = await toDescribeStep()
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cancels via the backdrop but not via a click inside the panel', async () => {
    const { container, onClose } = await toDescribeStep()

    fireEvent.click(screen.getByText('Describe what you want built'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(container.firstChild as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(stopConductor).toHaveBeenCalled()
    expect(H.setSwarmActive).toHaveBeenCalledWith(false)
  })

  it('cancels via the footer Cancel button', async () => {
    const { onClose } = await toDescribeStep()
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refuses to launch when the working directory is empty', async () => {
    const { onLaunched } = await toDescribeStep('')

    fireEvent.change(screen.getByPlaceholderText(/Add a contact form/), {
      target: { value: 'Do the thing' },
    })
    // Button is enabled (goal is non-empty) but handleLaunch bails on the empty cwd.
    expect(screen.getByText('Launch Swarm').closest('button')).not.toBeDisabled()
    fireEvent.click(screen.getByText('Launch Swarm'))

    expect(sendTask).not.toHaveBeenCalled()
    expect(onLaunched).not.toHaveBeenCalled()
    expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
  })

  it('omits blank optional sections from the prompt contract', async () => {
    await toDescribeStep()
    fireEvent.change(screen.getByPlaceholderText(/Add a contact form/), {
      target: { value: '  Ship the parser  ' },
    })
    // Whitespace-only optionals must not create empty headings.
    fireEvent.change(screen.getByPlaceholderText(/Needs to work on Windows/), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByText('Launch Swarm'))

    await waitFor(() => expect(sendTask).toHaveBeenCalled())
    const [prompt, cwd] = vi.mocked(sendTask).mock.calls[0]
    expect(prompt).toBe('## Goal\nShip the parser')
    expect(prompt).not.toContain('## Constraints')
    expect(cwd).toBe('/test/project')
  })
})

// ---------------------------------------------------------------------------
// The launch poll loop
// ---------------------------------------------------------------------------
describe('StartSwarmModal — launch polling', () => {
  async function launch(goal = 'Build a thing') {
    const onLaunched = vi.fn()
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={onLaunched} projectCwd="/test/project" />)
    await waitFor(() => {
      expect(screen.getByText('Describe what you want built')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByPlaceholderText(/Add a contact form/), { target: { value: goal } })
    fireEvent.click(screen.getByText('Launch Swarm'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    return onLaunched
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  it('hands off as soon as a single task appears (singular wording)', async () => {
    swarmApi().getTasks.mockResolvedValue({ success: true, data: [makeTask()] })
    const onLaunched = await launch()

    expect(screen.getByText(/^1 task created/)).toBeInTheDocument()
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('pluralises the task count', async () => {
    swarmApi().getTasks.mockResolvedValue({ success: true, data: [makeTask(), makeTask()] })
    const onLaunched = await launch()

    expect(screen.getByText(/^2 tasks created/)).toBeInTheDocument()
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('counts only visible non-conductor swarm terminals as agents', async () => {
    H.terminals = [
      agentTerminal('a'),
      agentTerminal('b'),
      { id: 'c', isSwarm: true, isConductor: true, hidden: true }, // the conductor itself
      { id: 'd', isSwarm: true, isConductor: false, hidden: true }, // hidden helper
      { id: 'e', isSwarm: false, isConductor: false, hidden: false }, // the user's own shell
    ]
    // Tasks also exist — agent terminals must win the progress message.
    swarmApi().getTasks.mockResolvedValue({ success: true, data: [makeTask()] })

    const onLaunched = await launch()

    expect(screen.getByText(/^2 agent terminals opened/)).toBeInTheDocument()
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('uses singular wording for a lone agent terminal', async () => {
    H.terminals = [agentTerminal('a')]
    const onLaunched = await launch()

    expect(screen.getByText(/^1 agent terminal opened/)).toBeInTheDocument()
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('hands off on conductor chatter alone, ignoring non-conductor senders', async () => {
    swarmApi().getMessages.mockResolvedValue({
      success: true,
      data: [
        makeMessage({ from: 'conductor', content: 'planning' }),
        makeMessage({ from: 'mcp-client', content: 'tool call' }),
        makeMessage({ from: 'system', content: 'ignored' }),
      ],
    })
    const onLaunched = await launch()

    expect(screen.getByText(/Conductor is planning/)).toBeInTheDocument()
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('does not hand off on a single conductor message', async () => {
    swarmApi().getMessages.mockResolvedValue({
      success: true,
      data: [
        makeMessage({ from: 'conductor', content: 'ack' }),
        makeMessage({ from: 'system', content: 'ignored' }),
        makeMessage({ from: 'agent-1', content: 'ignored' }),
      ],
    })
    const onLaunched = await launch()

    expect(screen.getByText('Conductor is analyzing your task...')).toBeInTheDocument()
    expect(onLaunched).not.toHaveBeenCalled()
  })

  it('keeps polling when the swarm API reports failure, then hands off once a task lands', async () => {
    swarmApi().getTasks
      .mockResolvedValueOnce({ success: false, error: 'not ready' })
      .mockResolvedValue({ success: true, data: [makeTask()] })
    swarmApi().getMessages
      .mockResolvedValueOnce({ success: false, error: 'not ready' })
      .mockResolvedValue({ success: true, data: [] })

    const onLaunched = await launch()

    // First poll: both calls failed -> treated as zero progress, no handoff.
    expect(screen.getByText('Conductor is analyzing your task...')).toBeInTheDocument()
    expect(onLaunched).not.toHaveBeenCalled()

    // Second poll, one second later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(screen.getByText(/^1 task created/)).toBeInTheDocument()
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('shows the conductor error and hands off after the 3s grace period', async () => {
    H.conductorState = { terminalId: 't', status: 'error', error: 'Conductor refused the task' }
    const onLaunched = await launch()

    expect(screen.getByText('Conductor refused the task')).toBeInTheDocument()
    expect(onLaunched).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('falls back to a generic message when the conductor errors without detail', async () => {
    H.conductorState = { terminalId: 't', status: 'error', error: null }
    const onLaunched = await launch()

    expect(screen.getByText('Conductor encountered an error.')).toBeInTheDocument()
    expect(onLaunched).not.toHaveBeenCalled()
  })

  it('gives up and hands off to the dashboard after the 60s ceiling', async () => {
    H.conductorState = { terminalId: 't', status: 'running', error: null }
    const onLaunched = await launch()

    expect(onLaunched).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })

    expect(onLaunched).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Conductor is analyzing your task...')).toBeInTheDocument()
  })

  it('survives a swarm API that throws outright', async () => {
    swarmApi().getTasks.mockRejectedValue(new Error('IPC channel closed'))
    const onLaunched = await launch()

    expect(screen.getByText('Conductor is analyzing your task...')).toBeInTheDocument()
    expect(onLaunched).not.toHaveBeenCalled()

    // The poll loop keeps ticking rather than dying on the rejection.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(swarmApi().getTasks.mock.calls.length).toBeGreaterThan(1)
  })

  it('shows the working directory and hides the close affordances while launching', async () => {
    H.terminals = [agentTerminal('a')]
    await launch()

    expect(screen.getByText('/test/project')).toBeInTheDocument()
    expect(screen.getByText('Launching Swarm')).toBeInTheDocument()
    // No X, no Cancel, and Escape is inert during launch.
    expect(document.querySelector('.fa-xmark')).toBeNull()
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// SwarmDashboard
// ===========================================================================
describe('SwarmDashboard — start swarm wizard wiring', () => {
  it('auto-opens the wizard with the pre-picked directory', () => {
    render(<SwarmDashboard onClose={vi.fn()} initialCwd="/auto/dir" />)

    expect(screen.getByTestId('start-swarm-modal')).toBeInTheDocument()
    expect(screen.getByTestId('ssm-cwd')).toHaveTextContent('/auto/dir')
    expect(H.startSwarmProps.initialGoal).toBeUndefined()
  })

  it('does not auto-open the wizard when a swarm is already running', () => {
    H.swarmActive = true
    render(<SwarmDashboard onClose={vi.fn()} initialCwd="/auto/dir" />)

    expect(screen.queryByTestId('start-swarm-modal')).not.toBeInTheDocument()
  })

  it('bubbles the close up when the user backs out without launching', () => {
    const onClose = vi.fn()
    render(<SwarmDashboard onClose={onClose} initialCwd="/auto/dir" />)

    fireEvent.click(screen.getByText('ssm-close'))

    expect(screen.queryByTestId('start-swarm-modal')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the dashboard open when the wizard closes while a swarm is running', () => {
    const onClose = vi.fn()
    render(<SwarmDashboard onClose={onClose} initialCwd="/auto/dir" />)
    expect(screen.getByTestId('start-swarm-modal')).toBeInTheDocument()

    // The swarm went live while the wizard was up.
    H.swarmActive = true
    fireEvent.click(screen.getByText('Messages')) // force a re-read of the store

    fireEvent.click(screen.getByText('ssm-close'))

    expect(screen.queryByTestId('start-swarm-modal')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays on the dashboard after a successful launch', () => {
    const onClose = vi.fn()
    render(<SwarmDashboard onClose={onClose} initialCwd="/auto/dir" />)

    fireEvent.click(screen.getByText('ssm-launched'))

    expect(screen.queryByTestId('start-swarm-modal')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not open the wizard when the directory picker is cancelled', async () => {
    ;(window.termpolis.pickDirectory as any).mockResolvedValue({ success: false })
    render(<SwarmDashboard onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Start Swarm'))

    await waitFor(() => expect(window.termpolis.pickDirectory).toHaveBeenCalled())
    expect(screen.queryByTestId('start-swarm-modal')).not.toBeInTheDocument()
  })

  it('opens the wizard with the directory the user picked', async () => {
    ;(window.termpolis.pickDirectory as any).mockResolvedValue({ success: true, data: '/chosen' })
    render(<SwarmDashboard onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Start Swarm'))

    await waitFor(() => expect(screen.getByTestId('start-swarm-modal')).toBeInTheDocument())
    expect(screen.getByTestId('ssm-cwd')).toHaveTextContent('/chosen')
  })
})

describe('SwarmDashboard — refresh resilience', () => {
  it('keeps the last good tasks and messages when a poll fails', async () => {
    swarmApi().getTasks.mockResolvedValue({ success: true, data: [makeTask({ title: 'Keep Me' })] })
    swarmApi().getMessages.mockResolvedValue({
      success: true,
      data: [makeMessage({ content: 'Keep This Message' })],
    })

    render(<SwarmDashboard onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Keep Me')).toBeInTheDocument())

    // The IPC bridge hiccups on the next poll.
    swarmApi().getTasks.mockResolvedValue({ success: false, error: 'gone' })
    swarmApi().getMessages.mockResolvedValue({ success: false, error: 'gone' })
    await act(async () => {
      await H.pollCb!()
    })

    expect(screen.getByText('Keep Me')).toBeInTheDocument()
    expect(screen.getByText(/1 task/)).toBeInTheDocument()
    expect(screen.getByText(/1 msg/)).toBeInTheDocument()
  })
})

describe('SwarmDashboard — handoff animation', () => {
  it('announces a brand-new in-progress task with no previous owner', async () => {
    swarmApi().getTasks
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValue({
        success: true,
        data: [makeTask({ status: 'in_progress', assignedTo: 'builder' })],
      })

    render(<SwarmDashboard onClose={vi.fn()} />)
    await waitFor(() => expect(swarmApi().getTasks).toHaveBeenCalled())

    await act(async () => {
      await H.pollCb!()
    })

    expect(screen.getByTestId('handoff-to')).toHaveTextContent('builder')
    expect(screen.getByTestId('handoff-from')).toHaveTextContent('(none)')

    // onComplete tears the animation back down.
    fireEvent.click(screen.getByText('handoff-done'))
    expect(screen.queryByTestId('handoff')).not.toBeInTheDocument()
  })

  it('announces a reassignment when a pending task starts', async () => {
    const pending = makeTask({ id: 'T1', status: 'pending', assignedTo: 'planner' })
    swarmApi().getTasks
      .mockResolvedValueOnce({ success: true, data: [pending] })
      .mockResolvedValue({
        success: true,
        data: [{ ...pending, status: 'in_progress', assignedTo: 'builder' }],
      })

    render(<SwarmDashboard onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('A Task')).toBeInTheDocument())
    expect(screen.queryByTestId('handoff')).not.toBeInTheDocument()

    await act(async () => {
      await H.pollCb!()
    })

    expect(screen.getByTestId('handoff-from')).toHaveTextContent('planner')
    expect(screen.getByTestId('handoff-to')).toHaveTextContent('builder')
  })

  it('does not animate when an unassigned task starts', async () => {
    const pending = makeTask({ id: 'T2', status: 'pending', assignedTo: '' })
    swarmApi().getTasks
      .mockResolvedValueOnce({ success: true, data: [pending] })
      .mockResolvedValue({ success: true, data: [{ ...pending, status: 'in_progress' }] })

    render(<SwarmDashboard onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('A Task')).toBeInTheDocument())

    await act(async () => {
      await H.pollCb!()
    })

    expect(screen.queryByTestId('handoff')).not.toBeInTheDocument()
  })
})

describe('SwarmDashboard — task rendering', () => {
  it('renders a failed task in the completed column with the failure palette', async () => {
    swarmApi().getTasks.mockResolvedValue({
      success: true,
      data: [makeTask({ title: 'Broke', status: 'failed' })],
    })
    render(<SwarmDashboard onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Broke')).toBeInTheDocument())
    const card = screen.getByText('Broke').closest('div.rounded-lg')!
    expect(card.className).toContain('text-red-400')
    expect(card.className).toContain('border-red-500/30')
    // Failed tasks land in the "Completed" bucket.
    expect(screen.getByText('(1)')).toBeInTheDocument()
  })

  it('shows the assignee arrow only when a task has an owner', async () => {
    swarmApi().getTasks.mockResolvedValue({
      success: true,
      data: [
        makeTask({ title: 'Owned', assignedTo: 'builder' }),
        makeTask({ title: 'Unowned', assignedTo: '' }),
      ],
    })
    render(<SwarmDashboard onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Owned')).toBeInTheDocument())
    expect(screen.getByText('-> builder', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getAllByText(/->/).length).toBe(1)
  })

  it('cancels a pending task', async () => {
    swarmApi().getTasks.mockResolvedValue({
      success: true,
      data: [makeTask({ id: 'p1', status: 'pending' })],
    })
    render(<SwarmDashboard onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Cancel')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Cancel'))

    expect(swarmApi().updateTask).toHaveBeenCalledWith('p1', 'failed')
    await waitFor(() => expect(swarmApi().getTasks.mock.calls.length).toBeGreaterThan(1))
  })

  it('completes and fails an in-progress task', async () => {
    swarmApi().getTasks.mockResolvedValue({
      success: true,
      data: [makeTask({ id: 'w1', status: 'in_progress', assignedTo: 'builder' })],
    })
    render(<SwarmDashboard onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Done'))
    expect(swarmApi().updateTask).toHaveBeenCalledWith('w1', 'completed')

    fireEvent.click(screen.getByText('Fail'))
    expect(swarmApi().updateTask).toHaveBeenCalledWith('w1', 'failed')
  })
})

describe('SwarmDashboard — messages', () => {
  it('falls back to the neutral palette for an unrecognised message type', async () => {
    swarmApi().getMessages.mockResolvedValue({
      success: true,
      data: [makeMessage({ type: 'diagnostic', content: 'odd one out' })],
    })
    render(<SwarmDashboard onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Messages'))
    await waitFor(() => expect(screen.getByText('odd one out')).toBeInTheDocument())
    expect(screen.getByText('diagnostic').className).toContain('text-gray-400')
  })
})

describe('SwarmDashboard — conductor status', () => {
  it('renders the neutral badge for an in-between conductor status', () => {
    H.swarmActive = true
    H.conductorState = { terminalId: 'c1', status: 'starting', error: null }
    render(<SwarmDashboard onClose={vi.fn()} />)

    const badge = screen.getByText('Conductor: starting')
    expect(badge.className).toContain('text-[#9ca3af]')
    expect(badge.className).not.toContain('text-green-400')
  })

  it('picks up a conductor status change on the next 3s poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    H.swarmActive = true
    H.conductorState = { terminalId: 'c1', status: 'starting', error: null }
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.getByText('Conductor: starting')).toBeInTheDocument()

    H.conductorState = { terminalId: 'c1', status: 'running', error: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(screen.getByText('Conductor: running')).toBeInTheDocument()
    expect(screen.queryByText('Conductor: starting')).not.toBeInTheDocument()
  })

  it('passes the conductor terminal id to the trace tab', () => {
    H.conductorState = { terminalId: 'cond-42', status: 'running', error: null }
    render(<SwarmDashboard onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Trace'))

    expect(screen.getByTestId('conductor-trace')).toHaveTextContent('trace:cond-42')
  })
})

describe('SwarmDashboard — review tab', () => {
  const summary = {
    message: 'SWARM COMPLETE: build the login page',
    tasks: [],
    projectCwd: '/repo',
    preSwarmSha: 'abc123',
  }

  it('hides the Review tab without a completion summary', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.queryByText('Review')).not.toBeInTheDocument()
  })

  it('hides the Review tab when the summary has a sha but no project directory', () => {
    H.swarmSummary = { ...summary, projectCwd: null }
    render(<SwarmDashboard onClose={vi.fn()} />)
    expect(screen.queryByText('Review')).not.toBeInTheDocument()
  })

  it('renders the review panel with the pre-swarm sha, cwd and task description', () => {
    H.swarmSummary = summary
    render(<SwarmDashboard onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Review'))

    expect(screen.getByTestId('review-sha')).toHaveTextContent('abc123')
    expect(screen.getByTestId('review-cwd')).toHaveTextContent('/repo')
    expect(screen.getByTestId('review-desc')).toHaveTextContent(
      'SWARM COMPLETE: build the login page',
    )
  })

  it('returns to the Tasks tab when the review panel closes', async () => {
    H.swarmSummary = summary
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Review'))

    fireEvent.click(screen.getByText('review-close'))

    expect(screen.queryByTestId('review-panel')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('In Progress')).toBeInTheDocument())
  })

  it('relaunches the wizard prefilled with the refinement and the prior goal', () => {
    H.swarmSummary = summary
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Review'))

    fireEvent.click(screen.getByText('review-refine'))

    expect(screen.getByTestId('start-swarm-modal')).toBeInTheDocument()
    expect(screen.getByTestId('ssm-cwd')).toHaveTextContent('/repo')
    // "SWARM COMPLETE:" is stripped; the refinement leads.
    expect(H.startSwarmProps.initialGoal).toBe(
      'make it prettier\n\nPrior swarm goal:\nbuild the login page',
    )
    expect(H.startSwarmProps.initialConstraints).toContain('Refine the previous swarm output')
    expect(H.startSwarmProps.initialExpectedOutput).toBe('')
    expect(H.startSwarmProps.initialFailureConditions).toBe('')
  })

  it('omits the prior-goal block when the summary carries no usable goal', () => {
    H.swarmSummary = { ...summary, message: 'SWARM COMPLETE:' }
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Review'))

    fireEvent.click(screen.getByText('review-refine'))

    expect(H.startSwarmProps.initialGoal).toBe('make it prettier')
  })

  it('omits the prior-goal block when the summary has no message at all', () => {
    H.swarmSummary = { ...summary, message: undefined }
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Review'))

    fireEvent.click(screen.getByText('review-refine'))

    expect(screen.getByTestId('review-desc')).toHaveTextContent('(none)')
    expect(H.startSwarmProps.initialGoal).toBe('make it prettier')
  })

  it('refuses to relaunch while a swarm is still running', () => {
    H.swarmActive = true
    H.swarmSummary = summary
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Review'))

    fireEvent.click(screen.getByText('review-refine'))

    expect(screen.queryByTestId('start-swarm-modal')).not.toBeInTheDocument()
  })
})

describe('SwarmDashboard — clear swarm', () => {
  it('dismisses the confirmation when its backdrop is clicked', () => {
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText(/All swarm work will be lost/)).toBeInTheDocument()

    const heading = screen.getAllByText('Clear Swarm').find((el) => el.tagName === 'H3')!
    fireEvent.click(heading.closest('.absolute')!)

    expect(screen.queryByText(/All swarm work will be lost/)).not.toBeInTheDocument()
    expect(swarmApi().clear).not.toHaveBeenCalled()
  })

  it('tears down bridges, conductor and every swarm terminal on confirm', async () => {
    H.swarmActive = true
    H.terminals = [
      { id: 'sw-1', isSwarm: true },
      { id: 'sw-2', isSwarm: true },
      { id: 'plain', isSwarm: false },
    ]
    render(<SwarmDashboard onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear'))

    fireEvent.click(screen.getAllByText(/Clear Swarm/).find((el) => el.tagName === 'BUTTON')!)

    await waitFor(() => expect(swarmApi().clear).toHaveBeenCalled())
    expect(stopAllBridges).toHaveBeenCalled()
    expect(stopConductor).toHaveBeenCalled()
    expect(window.termpolis.killTerminal).toHaveBeenCalledWith('sw-1')
    expect(window.termpolis.killTerminal).toHaveBeenCalledWith('sw-2')
    expect(window.termpolis.killTerminal).not.toHaveBeenCalledWith('plain')
    expect(H.removeTerminal).toHaveBeenCalledWith('sw-2')
    expect(H.setSwarmActive).toHaveBeenCalledWith(false)
    expect(H.setSwarmAgents).toHaveBeenCalledWith([])
  })

  it('reveals the conductor terminal from the debug button', () => {
    H.swarmActive = true
    render(<SwarmDashboard onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Debug'))

    expect(revealConductor).toHaveBeenCalledTimes(1)
  })
})
