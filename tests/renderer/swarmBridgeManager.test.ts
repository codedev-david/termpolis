import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startBridgeForAgent,
  stopBridgeForAgent,
  stopAllBridges,
} from '../../src/renderer/src/lib/swarmBridgeManager'

beforeEach(() => {
  vi.useFakeTimers()
  ;(window as any).termpolis = {
    readTerminalBuffer: vi.fn().mockResolvedValue({
      success: true,
      data: { output: '', length: 0 },
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
      .mockResolvedValueOnce({ success: true, data: { output: 'hello', length: 5 } })
      .mockResolvedValue({ success: true, data: { output: '', length: 0 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.termpolis.readTerminalBuffer).toHaveBeenNthCalledWith(2, 't1', 5)
  })

  it('does NOT post a message when output has no meaningful signal', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: true, data: { output: 'just some random text abc', length: 25 } })

    startBridgeForAgent('t1', 'Claude')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).not.toHaveBeenCalled()
  })

  it('posts a message when a completion signal is detected', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: 'Task is now complete and done.', length: 30 },
      })

    startBridgeForAgent('t1', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.sendMessage).toHaveBeenCalledWith(
      'Gemini',
      'all',
      expect.any(String),
      expect.stringContaining('Gemini'),
    )
  })

  it('auto-completes in-progress task when result signal detected', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: 'All done — work is finished successfully', length: 40 },
      })
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'task-1', assignedTo: 't1', status: 'in_progress' }],
    })

    startBridgeForAgent('t1', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)

    expect(window.swarmAPI.updateTask).toHaveBeenCalledWith(
      'task-1',
      'completed',
      expect.any(String),
    )
  })

  it('does not update tasks if there is no matching in-progress task', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        success: true,
        data: { output: 'All done — work is finished', length: 27 },
      })
    ;(window.swarmAPI.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [{ id: 'task-2', assignedTo: 'other-terminal', status: 'in_progress' }],
    })

    startBridgeForAgent('t1', 'Gemini')
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.swarmAPI.updateTask).not.toHaveBeenCalled()
  })

  it('swallows errors silently if readTerminalBuffer fails', async () => {
    ;(window.termpolis.readTerminalBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('IPC error'))

    startBridgeForAgent('t1', 'Claude')
    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow()
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
      .mockResolvedValue({ success: true, data: { output: 'abc', length: 3 } })

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
