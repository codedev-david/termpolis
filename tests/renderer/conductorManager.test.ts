import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'

// Mock uuid before importing the module under test
vi.mock('uuid', () => ({ v4: vi.fn(() => 'conductor-uuid-1') }))

// Mock the renderer Sentry module so we can assert recordSwarmError calls
const mockRecordSwarmError = vi.fn()
vi.mock('../../src/renderer/src/lib/sentry', () => ({
  recordSwarmError: (...args: any[]) => mockRecordSwarmError(...args),
  Sentry: { addBreadcrumb: vi.fn(), captureException: vi.fn() },
  initSentry: vi.fn(),
}))

beforeAll(() => {
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({
      success: true,
      data: { claude: true, codex: true, gemini: false },
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
    getMcpConfigPath: vi.fn().mockResolvedValue({ success: true, data: '/tmp/userData/claude-mcp-config.json' }),
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
  sendTask,
  getPreSwarmSha,
} from '../../src/renderer/src/lib/conductorManager'
import { startBridgeForAgent, stopAllBridges } from '../../src/renderer/src/lib/swarmBridgeManager'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

type Mock = ReturnType<typeof vi.fn>

describe('conductorManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // clearAllMocks keeps implementations, so one test's buffer or bus would leak into the next.
    ;(window.termpolis.readTerminalBuffer as Mock).mockResolvedValue({ success: true, data: { output: 'claude 1.0.0 ', length: 12 } })
    ;(window.swarmAPI.sendMessage as Mock).mockResolvedValue({ success: true })
    ;(window.swarmAPI.getTasks as Mock).mockResolvedValue({ success: true, data: [] })
    ;(window.swarmAPI.getMessages as Mock).mockResolvedValue({ success: true, data: [] })
    // Reset store state
    useTerminalStore.setState({ terminals: [], swarmActive: false, activeTerminalId: null, swarmNotification: null })
  })

  afterEach(() => {
    stopConductor()
    stopAllBridges()
    vi.useRealTimers()
  })

  /** An in-memory swarm bus behind the swarmAPI mocks, so a test sees what sendTask itself posts. */
  function fakeBus() {
    const messages: Array<{ id: string; from: string; to: string; type: string; content: string; timestamp: number; read: boolean }> = []
    const tasks: Array<{ id: string; status: string }> = []
    const post = (from: string, content: string, type = 'info') => {
      const m = { id: `m${messages.length + 1}`, from, to: 'all', type, content, timestamp: Date.now(), read: false }
      messages.push(m)
      return m
    }
    ;(window.swarmAPI.sendMessage as Mock).mockImplementation(async (from: string, _to: string, type: string, content: string) => ({ success: true, data: post(from, content, type) }))
    ;(window.swarmAPI.getMessages as Mock).mockImplementation(async () => ({ success: true, data: messages.map((m) => ({ ...m })) }))
    ;(window.swarmAPI.getTasks as Mock).mockImplementation(async () => ({ success: true, data: tasks.map((t) => ({ ...t })) }))
    return { messages, tasks, post }
  }

  /** Start the conductor and hand it a task, as the wizard does. */
  async function launchConductor(task = 'Build') {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise
    await sendTask(task, '/tmp/project')
  }

  it('checkClaudeInstalled returns true when claude is detected', async () => {
    const result = await checkClaudeInstalled()
    expect(result).toBe(true)
    expect(window.termpolis.detectAgents).toHaveBeenCalled()
  })

  it('checkClaudeInstalled returns false when claude is not detected', async () => {
    ;(window.termpolis.detectAgents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: { claude: false, codex: true, gemini: false },
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
      undefined,
      true, // conductor always launches Claude → Headroom proxy env requested
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

  it('keeps the conductor terminal hidden for the whole run', async () => {
    // Debug shows its output read-only inside the dashboard (ConductorOutput): mounted as a pane,
    // the memory primer would type into the conductor's console and its shell would run that.
    await launchConductor()
    await vi.advanceTimersByTimeAsync(15000)
    const conductor = useTerminalStore.getState().terminals.find(t => t.id === 'conductor-uuid-1')
    expect(conductor).toMatchObject({ hidden: true, isConductor: true })
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

  // ---- Monitoring loop: error reporting ----

  it('monitoring loop reports unexpected crashes to Sentry', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    mockRecordSwarmError.mockClear()
    await sendTask('Build something', '/tmp/project')
    // Simulate the monitoring loop hitting an exception inside the try block
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('IPC bus crashed mid-swarm'),
    )
    await vi.advanceTimersByTimeAsync(15000)

    expect(mockRecordSwarmError).toHaveBeenCalledWith(
      'conductor.monitor.failed',
      expect.objectContaining({ message: 'IPC bus crashed mid-swarm' }),
      expect.objectContaining({ status: expect.any(String) }),
    )
  })

  // ---- Monitoring loop: task-based completion ----

  it('monitoring loop marks swarm done when all tasks are completed', async () => {
    // Start and ready the conductor
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    await sendTask('Build a tic-tac-toe game', '/tmp/project')
    // Mock tasks: all completed
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
      ],
    })
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

    await sendTask('Build something', '/tmp/project')
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'failed' },
      ],
    })
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmActive).toBe(false)
    expect(getConductorState().status).toBe('done')
  })

  it('monitoring loop does NOT mark done when tasks are still in-progress', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    await sendTask('Build something', '/tmp/project')
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'in-progress' },
      ],
    })
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

    await sendTask('Build an app', '/tmp/project')
    // No tasks created — fallback to message detection
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [],
    })
    ;(window.swarmAPI.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [
        { from: 'conductor', type: 'info', content: 'Starting work...' },
        { from: 'conductor', type: 'result', content: 'SWARM COMPLETE: built the app' },
      ],
    })
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmActive).toBe(false)
    expect(getConductorState().status).toBe('done')
    expect(useTerminalStore.getState().swarmCompletionSummary?.message).toBe('SWARM COMPLETE: built the app')
  })

  // GitHub #36 item 3: the swarm ends when every task is completed or failed, or on the conductor's
  // STEP 8 message, and on nothing else.
  describe('what ends a swarm', () => {
    it('ends on STEP 8\'s message from the conductor', async () => {
      const bus = fakeBus()
      await launchConductor()
      bus.post('conductor', '  swarm complete: two features built', 'result')
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('done')
    })

    // R2-5: a conductor that wrote its own name another way was taken for a worker, and a run
    // that finished cleanly with no task ended as an error.
    it.each([['Conductor'], [' CONDUCTOR ']])("ends on STEP 8's message from %j: the conductor's name, however it is written", async (from) => {
      const bus = fakeBus()
      await launchConductor()
      bus.post(from, 'SWARM COMPLETE: built the page directly.', 'result')
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('done')
    })

    it.each([
      ['a message that only says the work is complete', 'mcp-client', 'info', 'All tasks are completed — swarm finished'],
      ['a Claude worker reporting its own task done', 'mcp-client', 'result', 'Implemented the login page; tests pass'],
      // MCP files a message under the name its caller gives, mcp-client when it gives none: a worker
      // whose own result started with STEP 8's words ended the swarm with a task still open.
      ['a worker\'s result through MCP in STEP 8\'s words', 'mcp-client', 'result', 'SWARM COMPLETE: my part (task t2, the docs) is done'],
      ['a worker naming itself', 'Claude (Docs)', 'result', 'SWARM COMPLETE: my part is done'],
      ['a worker\'s screen quoting the words', 'Codex', 'info', '[Codex] SWARM COMPLETE: echoed from its instructions'],
      ['a bridge or a stranger sending STEP 8\'s words', 'Codex', 'result', 'SWARM COMPLETE: not from the conductor'],
      ['Termpolis\'s own note', 'system', 'result', 'SWARM COMPLETE: system'],
      ['a result that starts some other way', 'conductor', 'result', 'Not yet. SWARM COMPLETE will follow'],
    ])('is not ended by %s', async (_name, from, type, content) => {
      const bus = fakeBus()
      await launchConductor()
      bus.post(from, content, type)
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('running')
      expect(useTerminalStore.getState().swarmActive).toBe(true)
    })

    it('is not ended by an open task, however its worker\'s screen reads, until the task is closed', async () => {
      const bus = fakeBus()
      await launchConductor()
      bus.tasks.push({ id: 't1', status: 'in_progress' })
      bus.post('Codex', '[Codex] screen suggests it may be done; check with read_output\n=== DONE exit=0 ===')
      await vi.advanceTimersByTimeAsync(30000)
      expect(getConductorState().status).toBe('running')

      bus.tasks[0].status = 'completed'
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('done')
    })
  })

  it('monitoring loop does NOT mark done when messages have no completion signal', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    await sendTask('Build an app', '/tmp/project')
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
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmActive).toBe(true)
    expect(getConductorState().status).toBe('running')
  })

  // ---- stall detection ----

  // GitHub #36: the warning required "no more than one message", but sendTask posts two of
  // its own before monitoring starts, so it could never fire. Only messages someone other
  // than the launcher posted after launch count now.
  describe('stall warning', () => {
    function stallCalls(spy: ReturnType<typeof vi.spyOn>) {
      return spy.mock.calls.filter(([arg]: any[]) => arg?.message?.includes('not created any tasks'))
    }

    it('fires a minute after launch although the launcher posted its own two messages', async () => {
      const bus = fakeBus()
      await launchConductor('Build an app')
      expect(bus.messages.map((m) => m.from)).toEqual(['conductor', 'system'])
      const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

      await vi.advanceTimersByTimeAsync(60000)
      expect(stallCalls(notifSpy)).toHaveLength(0) // not before the minute is up
      await vi.advanceTimersByTimeAsync(15000)

      expect(stallCalls(notifSpy)).toHaveLength(1)
      expect(stallCalls(notifSpy)[0][0]).toMatchObject({ type: 'error', message: expect.stringContaining('Click Debug') })
      expect(getConductorState().status).toBe('running')
    })

    it.each([['conductor'], ['Conductor'], [' conductor ']])('stays quiet once the conductor has said something, as %j', async (from) => {
      const bus = fakeBus()
      await launchConductor('Build an app')
      bus.post(from, 'Plan: two tasks')
      const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

      await vi.advanceTimersByTimeAsync(90000)
      expect(stallCalls(notifSpy)).toHaveLength(0)
    })

    it('stays quiet once the conductor has created a task', async () => {
      const bus = fakeBus()
      await launchConductor('Build an app')
      bus.tasks.push({ id: 't-new', status: 'pending' })
      const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

      await vi.advanceTimersByTimeAsync(90000)
      expect(stallCalls(notifSpy)).toHaveLength(0)
    })

    it('does not count a message an earlier swarm left on the bus', async () => {
      const bus = fakeBus()
      bus.post('conductor', 'Plan from the previous swarm')
      await launchConductor('Build an app')
      const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

      await vi.advanceTimersByTimeAsync(75000)
      expect(stallCalls(notifSpy)).toHaveLength(1)
    })

    it("counts only the conductor's own word: not a worker's screen, nor Termpolis's notes", async () => {
      // A worker the previous swarm left running still has its bridge, which posts what its
      // screen shows under its own name; that said nothing about this conductor.
      const bus = fakeBus()
      await launchConductor('Build an app')
      bus.post('Codex', '[Codex] Status: Working')
      bus.post('system', 'Codex (UI, terminal w7) is blocked: usage limit reached.')
      bus.post('mcp-client', 'A Claude worker the last swarm left running says its part is done')
      const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

      await vi.advanceTimersByTimeAsync(75000)
      expect(stallCalls(notifSpy)).toHaveLength(1)
    })
  })

  it("starts a new swarm with none of the last one's workers: their bridges stop, the dashboard drops them", async () => {
    // They would post to the new conductor as if they were its own, and their stops be reported to it.
    useTerminalStore.setState({ swarmAgents: [{ terminalId: 'old-w1', agentName: 'Codex', role: 'UI', status: 'idle', summary: '' }] })
    startBridgeForAgent('old-w1', 'Codex')
    await launchConductor('Build an app')
    expect(useTerminalStore.getState().swarmAgents).toEqual([])
    ;(window.termpolis.readTerminalBuffer as Mock).mockClear()

    await vi.advanceTimersByTimeAsync(10000)
    expect((window.termpolis.readTerminalBuffer as Mock).mock.calls.filter(([id]) => id === 'old-w1')).toEqual([])
  })

  // ---- conductor exit (GitHub #36) ----
  //
  // When claude exits, the conductor terminal's own shell lives on, so the "terminal still
  // exists" check never fired and an early exit (a cut-up prompt, an auth problem, a usage limit)
  // looked like a swarm running forever. The run script prints a sentinel line with claude's code.

  describe('conductor exit', () => {
    // What the terminal shows from launch on: the echoed launch line, then the script's first line.
    const launchEcho =
      "PS C:\\proj> $p='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; " +
      "& $p -ExecutionPolicy Bypass -File 'C:\\Users\\me\\.termpolis-conductor-run.ps1'\r\n" +
      '[termpolis-conductor-started]\r\n'
    function screen(output: string, nextOffset = 4321) {
      ;(window.termpolis.readTerminalBuffer as Mock).mockResolvedValue({ success: true, data: { output, length: output.length, nextOffset } })
    }
    const last = (bus: ReturnType<typeof fakeBus>) => bus.messages[bus.messages.length - 1]

    it("ends the swarm on a non-zero exit and posts the code with the conductor's last output", async () => {
      const bus = fakeBus()
      await launchConductor()
      screen(launchEcho + "error: unknown option '-NoProfile'\r\n[termpolis-conductor-exited] 1\r\nPS C:\\proj> ")

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState()).toMatchObject({ status: 'error', error: 'Conductor exited (code 1)' })
      expect(last(bus)).toMatchObject({ from: 'system', type: 'info', content: "Conductor exited (code 1): error: unknown option '-NoProfile'" })
      expect(useTerminalStore.getState().swarmNotification).toMatchObject({ type: 'error', message: expect.stringContaining('Conductor exited (code 1)') })
      expect(useTerminalStore.getState().swarmActive).toBe(false)
      // And it stops watching.
      ;(window.swarmAPI.getTasks as Mock).mockClear()
      await vi.advanceTimersByTimeAsync(30000)
      expect(window.swarmAPI.getTasks).not.toHaveBeenCalled()
    })

    it('treats a zero exit with no task created as a failure too', async () => {
      const bus = fakeBus()
      await launchConductor()
      screen('Done. The swarm tools were missing, so I stopped.\r\n[termpolis-conductor-exited] 0\r\n')

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState()).toMatchObject({ status: 'error', error: 'Conductor exited (code 0)' })
      expect(last(bus).content).toBe('Conductor exited (code 0): Done. The swarm tools were missing, so I stopped.')
      expect(useTerminalStore.getState().swarmActive).toBe(false)
    })

    it('says so when the conductor printed nothing before it exited', async () => {
      const bus = fakeBus()
      await launchConductor()
      screen(launchEcho + '[termpolis-conductor-exited] 3\r\n')

      await vi.advanceTimersByTimeAsync(15000)

      expect(last(bus).content).toBe('Conductor exited (code 3): (no output)')
    })

    it('keeps the end of a long last line rather than flood the dashboard', async () => {
      const bus = fakeBus()
      await launchConductor()
      screen(`${'x'.repeat(5000)}END\r\n[termpolis-conductor-exited] 1\r\n`)

      await vi.advanceTimersByTimeAsync(15000)

      const content = last(bus).content
      expect(content.length).toBeLessThan(2100)
      expect(content.startsWith('Conductor exited (code 1): …')).toBe(true)
      expect(content.endsWith('END')).toBe(true)
    })

    it('leaves a zero exit after tasks were created to the task-based completion', async () => {
      const bus = fakeBus()
      await launchConductor()
      bus.tasks.push({ id: 't1', status: 'in_progress' }, { id: 't2', status: 'completed' })
      screen('All work handed out.\r\n[termpolis-conductor-exited] 0\r\n')
      const handover = () => bus.messages.filter((m) => m.content.startsWith('Conductor exited (code 0) with'))

      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('running')
      expect(useTerminalStore.getState().swarmActive).toBe(true)
      expect(handover()).toHaveLength(1)
      expect(handover()[0]).toMatchObject({ from: 'system', content: expect.stringContaining('with 1 of 2 tasks still open') })

      await vi.advanceTimersByTimeAsync(15000) // said once, not every tick
      expect(handover()).toHaveLength(1)

      bus.tasks[0].status = 'completed'
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('done')
      expect(useTerminalStore.getState().swarmCompletionSummary?.tasks).toHaveLength(2)
    })

    it('reports a non-zero exit even after tasks were created', async () => {
      const bus = fakeBus()
      await launchConductor()
      bus.tasks.push({ id: 't1', status: 'in_progress' })
      screen('API Error: 529 Overloaded\r\n[termpolis-conductor-exited] 1\r\n')

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState().status).toBe('error')
      expect(last(bus).content).toBe('Conductor exited (code 1): API Error: 529 Overloaded')
    })

    it('lets finished tasks win over the exit that follows them', async () => {
      const bus = fakeBus()
      await launchConductor()
      bus.tasks.push({ id: 't1', status: 'completed' })
      screen('[termpolis-conductor-exited] 1\r\n')

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState().status).toBe('done')
      expect(useTerminalStore.getState().swarmNotification?.type).toBe('success')
    })

    it('ignores the sentinel quoted in the middle of a line', async () => {
      fakeBus()
      await launchConductor()
      screen('Claude: when I finish, the script prints [termpolis-conductor-exited] 1 for me\r\n')

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState().status).toBe('running')
      expect(useTerminalStore.getState().swarmActive).toBe(true)
    })

    it('catches a sentinel split across two reads once its line is complete', async () => {
      fakeBus()
      await launchConductor()
      screen('working\r\n[termpolis-conductor-exi')
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('running')

      screen('working\r\n[termpolis-conductor-exited] 1\r\n')
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState()).toMatchObject({ status: 'error', error: 'Conductor exited (code 1)' })
    })

    it('reads the conductor terminal only from where it stood at launch', async () => {
      fakeBus()
      screen('2.1.300 (Claude Code)\r\nPS C:\\proj> ', 777)
      await launchConductor()

      await vi.advanceTimersByTimeAsync(15000)

      expect(window.termpolis.readTerminalBuffer).toHaveBeenLastCalledWith('conductor-uuid-1', 777)
    })
  })

  // ---- the conductor's final answer (GitHub #36) ----
  //
  // `claude -p` prints only its final answer, as it exits, and the refusal and bypass guesses read
  // it before the tasks and the exit were looked at. A swarm whose tasks were all done ended as an
  // error over "I cannot verify the deployed site", and a failed run's exit report was lost to
  // "not able to reach". The guesses now decide only a run that created no task and didn't fail.

  describe("the conductor's final answer", () => {
    function exitsWith(answer: string, code = 0) {
      const output = `[termpolis-conductor-started]\r\n${answer}\r\n\r\n\r\n[termpolis-conductor-exited] ${code}\r\n`
      ;(window.termpolis.readTerminalBuffer as Mock).mockResolvedValue({ success: true, data: { output, length: output.length, nextOffset: 4321 } })
    }
    const answers = [
      "SWARM COMPLETE. Both tasks are done. I can't run the browser tests from this session, so check them by hand.",
      'Gemini was not able to finish the screenshots, so Codex took them over.',
      'I cannot verify the deployed site from here; the build and its tests pass.',
      "Codex's MCP tools weren't loaded at first, so I restarted it and it picked its task up.",
      'Both agents worked in parallel rather than sitting idle while the review ran.',
    ]

    it.each(answers)('does not undo a swarm whose tasks all finished: %s', async (answer) => {
      const bus = fakeBus()
      await launchConductor()
      bus.tasks.push({ id: 't1', status: 'completed' }, { id: 't2', status: 'completed' })
      bus.post('conductor', 'SWARM COMPLETE: both tasks done', 'result')
      exitsWith(answer)

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState().status).toBe('done')
      expect(useTerminalStore.getState().swarmNotification?.type).toBe('success')
      expect(useTerminalStore.getState().swarmCompletionSummary?.tasks).toHaveLength(2)
    })

    it.each(answers)('leaves a clean exit with tasks still open to those tasks: %s', async (answer) => {
      const bus = fakeBus()
      await launchConductor()
      bus.tasks.push({ id: 't1', status: 'in_progress' }, { id: 't2', status: 'in_progress' })
      exitsWith(answer)

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState().status).toBe('running')
      expect(useTerminalStore.getState().swarmActive).toBe(true)
      expect(bus.messages.filter((m) => m.content.includes('with 2 of 2 tasks still open'))).toHaveLength(1)
      expect(useTerminalStore.getState().swarmNotification).toBeNull()
    })

    it("reports a failed exit as the exit it is, whatever its last line's words", async () => {
      const bus = fakeBus()
      await launchConductor()
      exitsWith('Error: not able to reach api.anthropic.com (ECONNRESET)', 1)

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState()).toMatchObject({ status: 'error', error: 'Conductor exited (code 1)' })
      expect(bus.messages[bus.messages.length - 1].content).toBe('Conductor exited (code 1): Error: not able to reach api.anthropic.com (ECONNRESET)')
    })

    it('reads "I cannot" as the words they are: "Gemini cannot" is no refusal', async () => {
      fakeBus()
      await launchConductor()
      exitsWith('Gemini cannot take screenshots, and Gemini will not be needed for the rest.')

      await vi.advanceTimersByTimeAsync(15000)

      // No task and a clean exit: ended, as an exit, not as a task the conductor refused.
      expect(getConductorState()).toMatchObject({ status: 'error', error: 'Conductor exited (code 0)' })
    })

    it('still reads a refusal from a run that created no task', async () => {
      const bus = fakeBus()
      await launchConductor()
      exitsWith("I can't help with this task. It asks for something against the guidelines.")

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState()).toMatchObject({ status: 'error', error: 'Conductor refused the task' })
      // Termpolis's note, posted as its other notes after launch are: the conductor's name is its own.
      expect(bus.messages[bus.messages.length - 1]).toMatchObject({ from: 'system', content: "Task refused: I can't help with this task." })
    })
  })

  // ---- a second swarm in the same session ----
  //
  // The bus is emptied only by the dashboard's Clear, so "Start New Swarm" after a finished swarm
  // found its completed tasks and SWARM COMPLETE still there, and the new swarm was declared done
  // on its first monitoring tick.

  describe('a swarm started after another one', () => {
    it("is not ended by the previous swarm's finished tasks or SWARM COMPLETE", async () => {
      const bus = fakeBus()
      bus.tasks.push({ id: 'old-1', status: 'completed' })
      bus.post('conductor', 'SWARM COMPLETE: the previous swarm', 'result')
      await launchConductor()

      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('running')

      bus.tasks.push({ id: 'new-1', status: 'completed' })
      await vi.advanceTimersByTimeAsync(15000)
      expect(getConductorState().status).toBe('done')
      expect(useTerminalStore.getState().swarmCompletionSummary?.tasks.map((t) => t.id)).toEqual(['new-1'])
    })

    it('is not ended by its own goal, quoted in the launch message', async () => {
      fakeBus()
      await launchConductor('Make sure all tasks complete before the deploy')

      await vi.advanceTimersByTimeAsync(15000)

      expect(getConductorState().status).toBe('running')
    })
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

  it('MCP-unavailable detection fires on the v1.11.6 "orchestration MCP tools aren\'t registered" phrasing', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    // This is the exact phrasing observed in v1.11.6 debug terminals —
    // packaging was correct and the MCP server was healthy, but `claude -p`
    // didn't auto-load the user-scope MCP plugin. The conductor bypassed the
    // swarm and Claude described the bypass with a NEW phrasing that the
    // original regex didn't catch.
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        output:
          "Note: the orchestration MCP tools (`swarm_send_message`, " +
          "`swarm_create_task`, `create_terminal`, etc.) aren't registered in " +
          "this session, so I built the SPA directly rather than sitting idle.",
        length: 300,
      },
    })

    await sendTask('Build a sudoku SPA', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const bypassCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('WITHOUT swarm tools'),
    )
    expect(bypassCall).toBeDefined()
    expect(bypassCall?.[0].type).toBe('error')
    expect(useTerminalStore.getState().swarmActive).toBe(false)
  })

  it('MCP-unavailable detection fires on the "rather than sitting idle" phrasing alone', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        output: 'Went ahead and finished the work rather than sitting idle waiting for tools.',
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

  it('MCP-unavailable detection fires on "built the SPA directly" object-other-than-it/this', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        output: "Built the SPA directly rather than orchestrating agents.",
        length: 80,
      },
    })

    await sendTask('Build SPA', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    const bypassCall = notifSpy.mock.calls.find(([arg]) =>
      arg?.message?.includes('WITHOUT swarm tools'),
    )
    expect(bypassCall).toBeDefined()
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

  // claude -p prints only its final answer, as it exits, and a clean exit with tasks open keeps the
  // swarm going: a guess at a token limit read from that answer raised its error banner again on
  // every tick, however often it was dismissed. A real limit stops claude with an error, which its
  // exit report shows (GitHub #36).
  it.each([
    'I kept each worker prompt short to stay within the token budget. Both agents are working.',
    'I split the docs into two tasks so neither hits its context window.',
    'Started Codex on the rate limiter (token limits per user) and Claude on the tests.',
  ])('raises no token-limit banner over a final answer that mentions one: %s', async (answer) => {
    const bus = fakeBus()
    await launchConductor()
    bus.tasks.push({ id: 't1', status: 'in_progress' }, { id: 't2', status: 'in_progress' })
    const output = `[termpolis-conductor-started]\r\n${answer}\r\n\r\n\r\n[termpolis-conductor-exited] 0\r\n`
    ;(window.termpolis.readTerminalBuffer as Mock).mockResolvedValue({ success: true, data: { output, length: output.length, nextOffset: 4321 } })
    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')

    await vi.advanceTimersByTimeAsync(60000)

    expect(getConductorState().status).toBe('running')
    expect(notifSpy).not.toHaveBeenCalled()
  })

  // ---- markSwarmDone side-effects ----

  it('completing swarm sets swarmActive to false, enabling new swarm start', async () => {
    const startPromise = startConductor('/tmp/project')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    await startPromise

    // swarmActive should be true after conductor starts
    expect(useTerminalStore.getState().swarmActive).toBe(true)

    await sendTask('Build a game', '/tmp/project')
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [{ id: 't1', status: 'completed' }],
    })
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

    await sendTask('Build a game', '/tmp/project')
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: [{ id: 't1', status: 'completed' }],
    })
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

    // v1.11.7 — headless `claude -p` doesn't auto-load user-scope MCP plugins.
    // Without --mcp-config the conductor spins up with zero tools even when
    // packaging is correct, and the swarm silently bypasses orchestration.
    it('ps1 script passes --mcp-config pointing at the userData config', async () => {
      const { writeConfigCalls } = await launchAndGetWrites()
      const psCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.ps1'),
      )
      const psBody = (psCall?.[1] as string) ?? ''
      expect(psBody).toContain('--mcp-config')
      // Windows-backslash form of the mocked userData path, as a single-quoted literal
      expect(psBody).toMatch(/--mcp-config '[^']*\\userData\\claude-mcp-config\.json'/)
      // --mcp-config must precede --dangerously-skip-permissions so headless
      // Claude sees the MCP config (order matters less to the CLI, but we
      // want a deterministic shape so future edits don't silently drop it).
      expect(psBody.indexOf('--mcp-config')).toBeLessThan(
        psBody.indexOf('--dangerously-skip-permissions'),
      )
    })

    // GitHub #36 — 5.1 passes a native argument in quotes and escapes nothing, so with the
    // prompt in argv every `"` in it ended the argument and `--watch`-like words arrived as
    // options. claude rejected them and exited before it did anything.
    it('ps1 script pipes the task file into claude on stdin, never on its command line', async () => {
      const { writeConfigCalls } = await launchAndGetWrites()
      const psCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.ps1'),
      )
      const psBody = (psCall?.[1] as string) ?? ''
      expect(psBody).toMatch(
        /^Get-Content -Raw -Encoding UTF8 -LiteralPath '[^']*\\\.termpolis-conductor-task\.md' \| & \$claudeExe -p --mcp-config '[^']+' --dangerously-skip-permissions$/m,
      )
      expect(psBody).not.toContain('$task')
    })

    it('ps1 script sets $OutputEncoding and the console input encoding to UTF-8 without a BOM', async () => {
      const { writeConfigCalls } = await launchAndGetWrites()
      const psCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.ps1'),
      )
      const psBody = (psCall?.[1] as string) ?? ''
      expect(psBody).toContain('$enc = New-Object System.Text.UTF8Encoding $false')
      expect(psBody).toMatch(/^\s*\$OutputEncoding = \$enc$/m)
      expect(psBody).toMatch(/\[Console\]::InputEncoding = \$enc/)
    })

    // GitHub #36 — claude exiting changed nothing the monitor could see: the conductor
    // terminal's own shell lives on. The script reports the exit on a line of its own.
    it("ps1 script reports claude's exit code on a line of its own, then exits with it", async () => {
      const { writeConfigCalls } = await launchAndGetWrites()
      const psCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.ps1'),
      )
      const psBody = (psCall?.[1] as string) ?? ''
      expect(psBody).toMatch(
        / --dangerously-skip-permissions\n\$code = \$LASTEXITCODE\nif \(\$null -eq \$code\) \{ \$code = 1 \}\nWrite-Output ''\nWrite-Output ''\nWrite-Output "\[termpolis-conductor-exited\] \$code"\nexit \$code\n$/,
      )
      // Its first line, after the BOM that has 5.1 read the script as UTF-8, marks where the
      // script's own output starts, after the echoed launch line.
      expect(psBody.startsWith("\uFEFFWrite-Output '[termpolis-conductor-started]'\n")).toBe(true)
    })

    it('ps1 script fetches the MCP config path via the IPC bridge at launch', async () => {
      await launchAndGetWrites()
      expect(window.termpolis.getMcpConfigPath).toHaveBeenCalled()
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

    // v1.11.7 — same --mcp-config wiring as on Windows.
    it('sh script passes --mcp-config pointing at the userData config', async () => {
      const startPromise = startConductor('/tmp/project')
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(5000)
      await startPromise
      await sendTask('Build', '/tmp/project')

      const writeConfigCalls = (window.termpolis.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls
      const shCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.sh'),
      )
      const shBody = (shCall?.[1] as string) ?? ''
      expect(shBody).toContain('--mcp-config')
      expect(shBody).toMatch(/--mcp-config '[^']*claude-mcp-config\.json'/)
      expect(shBody.indexOf('--mcp-config')).toBeLessThan(
        shBody.indexOf('--dangerously-skip-permissions'),
      )
    })

    // `-p "$(cat file)"` quoted correctly, but one argument is capped at 128 KiB on Linux.
    it('sh script feeds the task file on stdin rather than as an argument', async () => {
      const startPromise = startConductor('/tmp/project')
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(5000)
      await startPromise
      await sendTask('Build', '/tmp/project')

      const writeConfigCalls = (window.termpolis.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls
      const shCall = writeConfigCalls.find(([path]) =>
        typeof path === 'string' && path.endsWith('.termpolis-conductor-run.sh'),
      )
      const shBody = (shCall?.[1] as string) ?? ''
      expect(shBody).toContain("TASK_FILE='/tmp/.termpolis-conductor-task.md'")
      expect(shBody).toMatch(/^"\$CLAUDE_EXE" -p --mcp-config '[^']+' --dangerously-skip-permissions < "\$TASK_FILE"$/m)
      expect(shBody).not.toContain('$(cat')
    })
  })
})
