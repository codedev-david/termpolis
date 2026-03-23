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
      data: { output: 'claude> ', length: 8 },
    }),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/tmp/test' }),
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

    // Advance past the shell init delay (testDelay(3000))
    await vi.advanceTimersByTimeAsync(3000)
    // Advance past the auto-trust delay (testDelay(9000))
    await vi.advanceTimersByTimeAsync(9000)
    // Advance past the auth check delay (testDelay(12000))
    await vi.advanceTimersByTimeAsync(12000)

    const result = await promise

    expect(window.termpolis.createTerminal).toHaveBeenCalledWith(
      'conductor-uuid-1',
      expect.any(String),
      '/tmp/project',
    )
    // Should have written the claude command
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

    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(9000)
    await vi.advanceTimersByTimeAsync(12000)

    await promise

    // After completion with 'claude> ' output (no auth prompt), state should be ready
    expect(getConductorState().status).toBe('ready')
  })

  it('stopConductor kills the terminal and resets state', async () => {
    // Start conductor first
    const promise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(9000)
    await vi.advanceTimersByTimeAsync(12000)
    await promise

    stopConductor()

    expect(window.termpolis.killTerminal).toHaveBeenCalledWith('conductor-uuid-1')
    const state = getConductorState()
    expect(state.status).toBe('idle')
    expect(state.terminalId).toBeNull()
  })

  it('revealConductor updates terminal hidden flag to false', async () => {
    const promise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(9000)
    await vi.advanceTimersByTimeAsync(12000)
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
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(9000)
    await vi.advanceTimersByTimeAsync(12000)
    await promise

    await sendTask('Build a REST API', '/tmp/project')

    expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith(
      'conductor',
      'all',
      'info',
      expect.stringContaining('Build a REST API'),
    )
    // Should have written the prompt to the terminal
    expect(window.termpolis.writeToTerminal).toHaveBeenCalledWith(
      'conductor-uuid-1',
      expect.stringContaining('Build a REST API'),
    )
  })
})
