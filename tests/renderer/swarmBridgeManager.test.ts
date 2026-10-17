import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockRecordSwarmError = vi.fn()
vi.mock('../../src/renderer/src/lib/sentry', () => ({
  recordSwarmError: (...args: any[]) => mockRecordSwarmError(...args),
  Sentry: { addBreadcrumb: vi.fn(), captureException: vi.fn() },
  initSentry: vi.fn(),
}))

import {
  startBridgeForAgent,
  stopBridgeForAgent,
  stopAllBridges,
} from '../../src/renderer/src/lib/swarmBridgeManager'

beforeEach(() => {
  vi.useFakeTimers()
  mockRecordSwarmError.mockReset()
  ;(window as any).termpolis = {
    readTerminalBuffer: vi.fn().mockResolvedValue({
      success: true,
      data: { output: '', length: 0, nextOffset: 0, missed: 0 },
    }),
  }
  ;(window as any).swarmAPI = {
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    updateTask: vi.fn().mockResolvedValue({ success: true }),
  }
})

afterEach(() => {
  stopAllBridges()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('startBridgeForAgent', () => {
  it('does not start a duplicate bridge if already running', async () => {
    startBridgeForAgent('t1', 'Agent')
    startBridgeForAgent('t1', 'Agent') // second call should be a no-op
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(1)
  })

  it('polls readTerminalBuffer on each interval tick', async () => {
    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledWith('t1', 0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(2)
  })

  it('tracks output offset across ticks', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, data: { output: 'hello', length: 5, nextOffset: 5, missed: 0 } })
      .mockResolvedValue({ success: true, data: { output: '', length: 0, nextOffset: 5, missed: 0 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenNthCalledWith(2, 't1', 5)
  })

  it('follows the offset the main process reports, not its own char count', async () => {
    // The buffer only retains the last 32 KB, so once it starts evicting, `offset + length`
    // no longer names a real position in it — the bridge must adopt `nextOffset` instead or
    // it walks off the end of the window and reads '' forever.
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: true,
        data: { output: 'tail', length: 4, nextOffset: 900_000, missed: 100 },
      })
      .mockResolvedValue({ success: true, data: { output: '', length: 0, nextOffset: 900_000, missed: 0 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenNthCalledWith(2, 't1', 900_000)
  })

  it('does NOT post a message when output has no meaningful signal', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: true, data: { output: 'just some random text abc', length: 25, nextOffset: 25, missed: 0 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).not.toHaveBeenCalled()
  })

  it('posts a screen that reads finished as an info hint for the conductor', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: 'Task is now complete and done.', length: 30, nextOffset: 30, missed: 0 },
      })

    startBridgeForAgent('t1', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith(
      'Gemini',
      'all',
      'info',
      '[Gemini] screen suggests it may be done; check with read_output\nTask is now complete and done.',
    )
  })

  // GitHub #36 item 3: a worker's screen said "done" ("=== ... DONE exit=0 ===" from a script, or
  // "the review is complete" halfway through), and the bridge marked its task completed.
  it('never completes a task, whatever the screen says: only swarm_update_task does', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: '=== build DONE exit=0 === the review is complete, all tests pass', length: 64, nextOffset: 64, missed: 0 },
      })
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'task-1', assignedTo: 't1', status: 'in_progress' }],
    })

    startBridgeForAgent('t1', 'Codex')
    await vi.advanceTimersByTimeAsync(15000)

    expect(window.swarmAPI.updateTask).not.toHaveBeenCalled()
    expect(window.swarmAPI.getTasks).not.toHaveBeenCalled()
    for (const call of (window.swarmAPI.sendMessage as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).not.toBe('result')
    }
  })

  it('posts other signals with their own type, and nothing for a read that failed', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: false, error: 'gone' })
      .mockResolvedValue({ success: true, data: { output: 'x'.repeat(30) + ' Build failed with 3 errors', length: 57, nextOffset: 57, missed: 0 } })

    startBridgeForAgent('t1', 'Codex')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith('Codex', 'all', 'error', expect.stringContaining('[Codex] '))
  })

  it('does not crash when readTerminalBuffer rejects with an unexpected error', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('IPC error'))

    startBridgeForAgent('t1', 'Claude')
    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow()
  })

  it('reports unexpected bridge errors to Sentry', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('IPC bus exploded'))

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockRecordSwarmError).toHaveBeenCalledWith(
      'swarmBridge.poll.failed',
      expect.objectContaining({ message: 'IPC bus exploded' }),
      expect.objectContaining({ terminalId: 't1', agentName: 'Claude' }),
    )
  })

  it('does NOT report expected "terminal closed" errors as bugs', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('terminal closed'))

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockRecordSwarmError).not.toHaveBeenCalled()
  })

  it('does NOT report "terminal not found" as a bug', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('terminal not found'))

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockRecordSwarmError).not.toHaveBeenCalled()
  })

  it('reports non-Error rejections too', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValue('plain string failure')

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockRecordSwarmError).toHaveBeenCalledWith(
      'swarmBridge.poll.failed',
      'plain string failure',
      expect.any(Object),
    )
  })
})

describe('stopBridgeForAgent', () => {
  it('stops polling after stop is called', async () => {
    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(1)

    stopBridgeForAgent('t1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledTimes(1)
  })

  it('is safe to call on a terminal that was never started', () => {
    expect(() => stopBridgeForAgent('never-started')).not.toThrow()
  })

  it('resets the output offset so a restarted bridge starts from 0', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: true, data: { output: 'abc', length: 3, nextOffset: 3, missed: 0 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    stopBridgeForAgent('t1')

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenLastCalledWith('t1', 0)
  })
})

describe('stopAllBridges', () => {
  it('stops all running bridges', async () => {
    startBridgeForAgent('t1', 'Claude')
    startBridgeForAgent('t2', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)

    stopAllBridges()
    vi.clearAllMocks()
    await vi.advanceTimersByTimeAsync(5000)

    expect(window.termpolis.readTerminalBuffer).not.toHaveBeenCalled()
  })

  it('is safe to call when no bridges are running', () => {
    expect(() => stopAllBridges()).not.toThrow()
  })
})
