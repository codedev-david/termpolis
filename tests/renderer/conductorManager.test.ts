import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'

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
    gitRevParseHead: vi.fn().mockResolvedValue({ success: true, data: 'pre123abc' }),
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
  getPreSwarmSha,
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

  // ---- stall detection ----

  it('monitoring loop emits a stall notification after 60s with no tasks or messages', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [],
    })
    ;(window.swarmAPI.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ type: 'info', content: 'Analyzing task...' }],
    })

    await sendTask('Build an app', '/tmp/project')
    // First tick (15s) — monitoringStartTime set
    await vi.advanceTimersByTimeAsync(15000)
    // Advance past the 60s stall threshold
    await vi.advanceTimersByTimeAsync(60000)

    const stallCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('not created any tasks'),
    )
    expect(stallCall).toBeDefined()
    expect(stallCall?.[0].type).toBe('error')
  })

  // ---- stopConductor orphan cleanup ----

  it('stopConductor kills orphaned conductor terminals in the store', async () => {
    // Seed the store with an orphan conductor terminal that was never tracked by conductorState
    useTerminalStore.setState({
      terminals: [
        { id: 'orphan-conductor', name: 'orphan', hidden: true, isConductor: true } as any,
      ],
      swarmActive: false,
      activeTerminalId: null,
    })
    const killSpy = window.termpolis.killTerminal as ReturnType<typeof vi.fn>

    stopConductor()

    expect(killSpy).toHaveBeenCalledWith('orphan-conductor')
    expect(useTerminalStore.getState().terminals.find(t => t.id === 'orphan-conductor')).toBeUndefined()
  })

  // ---- conductor refusal / MCP / token-limit detection ----

  it('monitoring loop detects conductor refusal and sets error notification', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    // Return refusal text on the monitoring interval's buffer read
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { output: "I can't help with this task. It violates my guidelines.", length: 100 },
    })

    await sendTask('Do something sketchy', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const refusalCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('refused the task'),
    )
    expect(refusalCall).toBeDefined()
    expect(refusalCall?.[0].type).toBe('error')
    expect(getConductorState().status).toBe('error')
  })

  it('monitoring loop warns on MCP connection error in conductor output', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { output: 'Error: ECONNREFUSED connecting to MCP server', length: 50 },
    })

    await sendTask('Build', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const mcpCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('MCP tools'),
    )
    expect(mcpCall).toBeDefined()
    expect(mcpCall?.[0].type).toBe('error')
  })

  // ---- MCP-unavailable detection (v1.11.6) ----
  //
  // When Claude Code can't load the Termpolis MCP server (e.g., stdio adapter
  // missing from the installer), the conductor silently answers the prompt
  // directly without orchestrating any swarm. Previously this left the UI
  // sitting in "running" forever with no completion screen — the user only
  // noticed by opening Debug. v1.11.6 detects the bypass from the conductor's
  // own output and raises a clear error notification + marks the swarm done.

  it('monitoring loop detects "MCP tools weren\'t available" bypass and marks swarm done with error', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        output:
          "Built the thing at C:\\Users\\me\\project. " +
          "Note: swarm MCP tools weren't available in this session, so I built it directly rather than orchestrating multiple agents.",
        length: 200,
      },
    })

    await sendTask('Build a small feature', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    // Notification explains the bypass clearly and includes remediation
    const bypassCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('WITHOUT swarm tools'),
    )
    expect(bypassCall).toBeDefined()
    expect(bypassCall?.[0].type).toBe('error')
    expect(bypassCall?.[0].message).toMatch(/Restart Termpolis/i)

    // Swarm is marked done (not stuck running)
    expect(useTerminalStore.getState().swarmActive).toBe(false)
    expect(getConductorState().status).toBe('error')
  })

  it('MCP-unavailable detection also fires on the "built it directly" pattern', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        output: 'Finished. I built this directly rather than orchestrating agents.',
        length: 100,
      },
    })

    await sendTask('Build', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const bypassCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('WITHOUT swarm tools'),
    )
    expect(bypassCall).toBeDefined()
  })

  it('MCP-unavailable detection does NOT fire when conductor actually calls swarm_create_task', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    // Output CONTAINS "weren't available" (e.g., in a comment) but ALSO contains
    // swarm_create_task — so the conductor did actually orchestrate. Should not
    // falsely trigger the bypass notification.
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        output:
          'swarm_create_task({ title: "Build" })  # some earlier runs had MCP tools weren\'t available, but here they work',
        length: 200,
      },
    })

    await sendTask('Build', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const bypassCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('WITHOUT swarm tools'),
    )
    expect(bypassCall).toBeUndefined()
  })

  it('monitoring loop warns when conductor hits token limit', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { output: 'context window exceeded — please start a new session', length: 50 },
    })

    await sendTask('Build', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const tokenCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('token limit'),
    )
    expect(tokenCall).toBeDefined()
    expect(tokenCall?.[0].type).toBe('error')
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

  // ---- preSwarmSha capture — all three branches in startConductor ----

  it('captures preSwarmSha from gitRevParseHead when repo has commits', async () => {
    ;(window.termpolis.gitRevParseHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true, data: 'happy1234'
    })
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    expect(getPreSwarmSha()).toBe('happy1234')
    expect(window.termpolis.gitRevParseHead).toHaveBeenCalledWith('/tmp/project')
  })

  it('leaves preSwarmSha null when gitRevParseHead succeeds without data (not a repo)', async () => {
    ;(window.termpolis.gitRevParseHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true, data: null
    })
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    expect(getPreSwarmSha()).toBeNull()
  })

  it('leaves preSwarmSha null when gitRevParseHead reports failure', async () => {
    ;(window.termpolis.gitRevParseHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false, error: 'not a repo'
    })
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    expect(getPreSwarmSha()).toBeNull()
  })

  it('swallows thrown errors from gitRevParseHead and leaves preSwarmSha null', async () => {
    ;(window.termpolis.gitRevParseHead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('IPC exploded')
    )
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    expect(getPreSwarmSha()).toBeNull()
  })

  it('propagates preSwarmSha through markSwarmDone into swarmCompletionSummary', async () => {
    ;(window.termpolis.gitRevParseHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true, data: 'preShaForSummary'
    })
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [{ id: 't1', status: 'completed' }],
    })

    await sendTask('Build a game', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const summary = useTerminalStore.getState().swarmCompletionSummary
    expect(summary).not.toBeNull()
    expect(summary?.preSwarmSha).toBe('preShaForSummary')
    expect(summary?.projectCwd).toBe('/tmp/project')
  })

  it('stopConductor clears preSwarmSha back to null', async () => {
    ;(window.termpolis.gitRevParseHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true, data: 'willBeCleared'
    })
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise
    expect(getPreSwarmSha()).toBe('willBeCleared')

    stopConductor()
    expect(getPreSwarmSha()).toBeNull()
  })

  it('createTerminal failure after SHA capture resets preSwarmSha to null', async () => {
    ;(window.termpolis.gitRevParseHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true, data: 'lostSha'
    })
    ;(window.termpolis.createTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false, error: 'spawn ENOENT'
    })
    const result = await startConductor('/tmp/project')
    expect(result.success).toBe(false)
    expect(getPreSwarmSha()).toBeNull()
  })

  // ---- launch-shell wiring: Windows inline PS launch ----
  //
  // v1.11.2 used bare `powershell` → broke on pwsh 7 (powershell not on PATH).
  // v1.11.3 used absolute PS 5.1 path. v1.11.4 added a .cmd belt-and-suspenders
  // wrapper → broke when System32 wasn't on PATH (cmd.exe not resolvable).
  // v1.11.5 drops the .cmd wrapper entirely: a pure PowerShell one-liner runs
  // inline in the already-running pwsh/PS 5.1 conductor terminal, using the
  // call operator `&` with an absolute PS 5.1 path + `(Get-Process -Id $PID).Path`
  // fallback. Zero PATH dependencies.

  describe('Windows launch command', () => {
    let originalPlatform: string

    beforeAll(() => {
      originalPlatform = window.navigator.platform
      Object.defineProperty(window.navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      })
    })

    afterAll(() => {
      Object.defineProperty(window.navigator, 'platform', {
        value: originalPlatform,
        configurable: true,
      })
    })

    async function launchAndGetWrites() {
      const startPromise = startConductor('/tmp/project')
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(5000)
      await startPromise
      await sendTask('Build a REST API', '/tmp/project')
      const writeConfigCalls = (window.termpolis.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls
      const writeTerminalCalls = (window.termpolis.writeToTerminal as ReturnType<typeof vi.fn>).mock.calls
      return { writeConfigCalls, writeTerminalCalls }
    }

    function getLaunchCmd(writeTerminalCalls: any[]): string {
      const launchCall = writeTerminalCalls.find(([, data]) =>
        typeof data === 'string' && data.includes('.termpolis-conductor-run.ps1'),
      )
      return (launchCall?.[1] as string) ?? ''
    }

    it('writes the .ps1 script to the user home', async () => {
      const { writeConfigCalls } = await launchAndGetWrites()
      const psCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.ps1'),
      )
      expect(psCall).toBeDefined()
      const psBody = psCall?.[1] as string
      expect(psBody).toContain('claude')
      expect(psBody).toContain('--dangerously-skip-permissions')
    })

    it('does NOT write a .cmd wrapper (regression guard for v1.11.4 breakage)', async () => {
      const { writeConfigCalls } = await launchAndGetWrites()
      const wrapperCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.cmd'),
      )
      expect(wrapperCall).toBeUndefined()
    })

    it('launch command uses PS call operator with absolute PS 5.1 path', async () => {
      const { writeTerminalCalls } = await launchAndGetWrites()
      const cmd = getLaunchCmd(writeTerminalCalls)
      expect(cmd).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(cmd).toContain('-ExecutionPolicy Bypass')
      expect(cmd).toMatch(/& \$p /)
    })

    it('launch command falls back to current PS interpreter if PS 5.1 is absent', async () => {
      const { writeTerminalCalls } = await launchAndGetWrites()
      const cmd = getLaunchCmd(writeTerminalCalls)
      expect(cmd).toMatch(/if \(-not \(Test-Path \$p\)\)/)
      expect(cmd).toContain('(Get-Process -Id $PID).Path')
    })

    it('launch command references the .ps1 script path with Windows backslashes', async () => {
      const { writeTerminalCalls } = await launchAndGetWrites()
      const cmd = getLaunchCmd(writeTerminalCalls)
      expect(cmd).toMatch(/-File '[^']*\\\.termpolis-conductor-run\.ps1'/)
    })

    it('launch command ends with carriage return so PS executes it', async () => {
      const { writeTerminalCalls } = await launchAndGetWrites()
      const cmd = getLaunchCmd(writeTerminalCalls)
      expect(cmd.endsWith('\r')).toBe(true)
    })

    it('launch command never starts with bare `powershell ` (v1.11.2 regression)', async () => {
      const { writeTerminalCalls } = await launchAndGetWrites()
      for (const [, data] of writeTerminalCalls) {
        if (typeof data !== 'string') continue
        expect(data.startsWith('powershell ')).toBe(false)
      }
    })

    it('launch command never starts with `cmd ` or uses `cmd /c` (v1.11.4 regression)', async () => {
      const { writeTerminalCalls } = await launchAndGetWrites()
      for (const [, data] of writeTerminalCalls) {
        if (typeof data !== 'string') continue
        expect(data.startsWith('cmd ')).toBe(false)
        expect(data.includes('cmd /c')).toBe(false)
      }
    })

    it('full launch command shape is a single inline PS statement (no multi-line, no semicolons in unsafe places)', async () => {
      const { writeTerminalCalls } = await launchAndGetWrites()
      const cmd = getLaunchCmd(writeTerminalCalls).trimEnd()
      // One line (no embedded \n or \r within body)
      expect(cmd.includes('\n')).toBe(false)
      // Has the three-part structure we expect: $p= ; if ; &
      expect(cmd).toMatch(/^\$p='[^']+'; if \(-not \(Test-Path \$p\)\) \{ \$p=\(Get-Process -Id \$PID\)\.Path \}; & \$p -ExecutionPolicy Bypass -File '[^']+\.ps1'$/)
    })
  })

  describe('Unix launch wrapper', () => {
    let originalPlatform: string

    beforeAll(() => {
      originalPlatform = window.navigator.platform
      Object.defineProperty(window.navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      })
    })

    afterAll(() => {
      Object.defineProperty(window.navigator, 'platform', {
        value: originalPlatform,
        configurable: true,
      })
    })

    it('writes a .sh script and invokes bash directly — no .cmd wrapper', async () => {
      const startPromise = startConductor('/tmp/project')
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(5000)
      await startPromise
      await sendTask('Build a REST API', '/tmp/project')

      const writeConfigCalls = (window.termpolis.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls
      const writeTerminalCalls = (window.termpolis.writeToTerminal as ReturnType<typeof vi.fn>).mock.calls

      const shCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.sh'),
      )
      expect(shCall).toBeDefined()

      const wrapperCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.cmd'),
      )
      expect(wrapperCall).toBeUndefined()

      const bashCall = writeTerminalCalls.find(([, data]) =>
        typeof data === 'string' && data.startsWith('bash '),
      )
      expect(bashCall).toBeDefined()
    })
  })
})
