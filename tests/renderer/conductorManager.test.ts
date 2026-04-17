import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// Mock uuid before importing the module under test
vi.mock('uuid', () => ({ v4: vi.fn(() => 'conductor-uuid-1') }))

beforeAll(() => {
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({
      success: true,
      data: { claude: true, codex: true, gemini: false, aider: false, 'aider-qwen': false },
    }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    readTerminalBuffer: vi.fn().mockResolvedValue({
      success: true,
      data: { output: 'claude 1.0.0 ', length: 12 },
    }),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/tmp/test' }),
    getHomedir: vi.fn().mockResolvedValue({ success: true, data: '/tmp' }),
    writeConfigFile: vi.fn().mockResolvedValue({ success: true }),
  }
  ;(window as any).swarmAPI = {
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getMessages: vi.fn().mockResolvedValue({ success: true, data: [] }),
    clear: vi.fn().mockResolvedValue({ success: true }),
  }
})

import {
  checkClaudeInstalled,
  getConductorState,
  startConductor,
  stopConductor,
  revealConductor,
  sendTask,
} from '../../src/renderer/src/lib/conductorManager'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

describe('conductorManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // Reset store state
    useTerminalStore.setState({ terminals: [], swarmActive: false, activeTerminalId: null })
  })

  afterEach(() => {
    stopConductor()
    vi.useRealTimers()
  })

  it('checkClaudeInstalled returns true when claude is detected', async () => {
    const result = await checkClaudeInstalled()
    expect(result).toBe(true)
    expect(window.termpolis.detectAgents).toHaveBeenCalled()
  })

  it('checkClaudeInstalled returns false when claude is not detected', async () => {
    ;(window.termpolis.detectAgents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: { claude: false, codex: true, gemini: false, aider: false, 'aider-qwen': false },
    })
    const result = await checkClaudeInstalled()
    expect(result).toBe(false)
  })

  it('getConductorState returns idle state initially', () => {
    const state = getConductorState()
    expect(state.status).toBe('idle')
    expect(state.terminalId).toBeNull()
    expect(state.error).toBeNull()
  })

  it('startConductor creates a terminal and writes claude command', async () => {
    const promise = startConductor('/tmp/project')

    // Advance past shell init (2s) + auth check wait (5s)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)

    const result = await promise

    expect(window.termpolis.createTerminal).toHaveBeenCalledWith(
      'conductor-uuid-1',
      expect.any(String),
      '/tmp/project',
    )
    // Should have written the claude --version command
    expect(window.termpolis.writeToTerminal).toHaveBeenCalledWith(
      'conductor-uuid-1',
      expect.stringContaining('claude'),
    )
    expect(result.success).toBe(true)
  })

  it('startConductor sets conductor state to starting then ready', async () => {
    const promise = startConductor('/tmp/project')

    // State should be starting right away
    expect(getConductorState().status).toBe('starting')

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)

    await promise

    // After completion with version output (no auth prompt), state should be ready
    expect(getConductorState().status).toBe('ready')
  })

  it('stopConductor kills the terminal and resets state', async () => {
    // Start conductor first
    const promise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await promise

    stopConductor()

    expect(window.termpolis.killTerminal).toHaveBeenCalledWith('conductor-uuid-1')
    const state = getConductorState()
    expect(state.status).toBe('idle')
    expect(state.terminalId).toBeNull()
  })

  it('revealConductor updates terminal hidden flag to false', async () => {
    const promise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await promise

    // The conductor terminal should exist in the store as hidden
    const termBefore = useTerminalStore.getState().terminals.find(t => t.id === 'conductor-uuid-1')
    expect(termBefore?.hidden).toBe(true)

    revealConductor()

    const termAfter = useTerminalStore.getState().terminals.find(t => t.id === 'conductor-uuid-1')
    expect(termAfter?.hidden).toBe(false)
    expect(useTerminalStore.getState().activeTerminalId).toBe('conductor-uuid-1')
  })

  it('sendTask calls swarmAPI.sendMessage with conductor info', async () => {
    // Start and ready the conductor
    const promise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await promise

    await sendTask('Build a REST API', '/tmp/project')

    expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith(
      'conductor',
      'all',
      'info',
      expect.stringContaining('Build a REST API'),
    )
    // Prompt should be written to temp file
    expect(window.termpolis.writeConfigFile).toHaveBeenCalledWith(
      expect.stringContaining('.termpolis-conductor-task.md'),
      expect.stringContaining('Build a REST API'),
    )
    // Terminal should receive the claude launch command
    expect(window.termpolis.writeToTerminal).toHaveBeenCalledWith(
      'conductor-uuid-1',
      expect.stringContaining('claude'),
    )
    // Script file should have been written for the launch
    expect(window.termpolis.writeConfigFile).toHaveBeenCalledWith(
      expect.stringContaining('.termpolis-conductor-run'),
      expect.stringContaining('claude'),
    )
  })

  // ---- Monitoring loop: task-based completion ----

  it('monitoring loop marks swarm done when all tasks are completed', async () => {
    // Start and ready the conductor
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    // Mock tasks: all completed
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
      ],
    })

    await sendTask('Build a tic-tac-toe game', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const store = useTerminalStore.getState()
    expect(store.swarmActive).toBe(false)
    expect(store.swarmNotification).toMatchObject({ type: 'success' })
    expect(getConductorState().status).toBe('done')
  })

  it('monitoring loop marks swarm done when a mix of completed and failed tasks', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'failed' },
      ],
    })

    await sendTask('Build something', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmActive).toBe(false)
    expect(getConductorState().status).toBe('done')
  })

  it('monitoring loop does NOT mark done when tasks are still in-progress', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'in-progress' },
      ],
    })

    await sendTask('Build something', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    // Still running — swarmActive should remain true
    expect(useTerminalStore.getState().swarmActive).toBe(true)
    expect(getConductorState().status).toBe('running')
  })

  // ---- Monitoring loop: message-based completion (fallback) ----

  it('monitoring loop marks done when message with type=result arrives', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    // No tasks created — fallback to message detection
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [],
    })
    ;(window.swarmAPI.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { type: 'info', content: 'Starting work...' },
        { type: 'result', content: 'SWARM COMPLETE: built the app' },
      ],
    })

    await sendTask('Build an app', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmActive).toBe(false)
    expect(getConductorState().status).toBe('done')
  })

  it('monitoring loop marks done when message content matches SWARM COMPLETE pattern', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [],
    })
    ;(window.swarmAPI.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { type: 'info', content: 'All tasks are completed — swarm finished' },
      ],
    })

    await sendTask('Build an app', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmActive).toBe(false)
    expect(getConductorState().status).toBe('done')
  })

  it('monitoring loop does NOT mark done when messages have no completion signal', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [],
    })
    ;(window.swarmAPI.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { type: 'info', content: 'Agent 1 is working on feature X...' },
        { type: 'info', content: 'Agent 2 started tests...' },
      ],
    })

    await sendTask('Build an app', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmActive).toBe(true)
    expect(getConductorState().status).toBe('running')
  })

  // ---- markSwarmDone side-effects ----

  it('completing swarm sets swarmActive to false, enabling new swarm start', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    // swarmActive should be true after conductor starts
    expect(useTerminalStore.getState().swarmActive).toBe(true)

    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [{ id: 't1', status: 'completed' }],
    })

    await sendTask('Build a game', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    // After completion, swarmActive is false — a new swarm can start
    expect(useTerminalStore.getState().swarmActive).toBe(false)
  })
})
