import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  launchAgents,
  agentTargets,
  SHELL_SETTLE_MS,
  COMMAND_DELAY_MS,
  AUTO_TRUST_MS,
  DISMISS_MS,
  SLOW_DISMISS_MS,
} from '../../src/renderer/src/lib/agentLaunch'

describe('agentLaunch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('agentTargets', () => {
    it('keeps only terminals carrying an agent command', () => {
      const kept = agentTargets([
        { id: 'a', agentCommand: 'claude' },
        { id: 'b' },
        { id: 'c', agentCommand: '' },
        { id: 'd', agentCommand: 'codex' },
      ])
      expect(kept.map(t => t.id)).toEqual(['a', 'd'])
    })
  })

  describe('launchAgents', () => {
    it('flushes the shell, then types the command', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'claude' }], { write })

      // Nothing is typed while the shell is still initialising.
      vi.advanceTimersByTime(SHELL_SETTLE_MS - 1)
      expect(write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(write).toHaveBeenCalledExactlyOnceWith('t1', '\r')

      vi.advanceTimersByTime(COMMAND_DELAY_MS)
      expect(write).toHaveBeenLastCalledWith('t1', 'claude\r')
    })

    it('answers the Claude trust prompt with a bare Enter', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'claude' }], { write })

      vi.advanceTimersByTime(AUTO_TRUST_MS)
      expect(write).toHaveBeenLastCalledWith('t1', '\r')
    })

    it('answers the Codex approval prompt with option 1', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'codex' }], { write })

      vi.advanceTimersByTime(AUTO_TRUST_MS)
      expect(write).toHaveBeenLastCalledWith('t1', '1\r')
    })

    it('sends no trust reply for an agent that does not prompt', () => {
      const write = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'gemini' }], { write })

      vi.advanceTimersByTime(SLOW_DISMISS_MS)
      // Only the flush newline and the command itself — no trust answer.
      expect(write.mock.calls).toEqual([['t1', '\r'], ['t1', 'gemini\r']])
    })

    it('launches every agent terminal and skips the plain shells', () => {
      const write = vi.fn()
      launchAgents(
        [
          { id: 'shell', agentCommand: undefined },
          { id: 'a1', agentCommand: 'claude' },
          { id: 'a2', agentCommand: 'codex' },
        ],
        { write },
      )

      vi.advanceTimersByTime(SHELL_SETTLE_MS + COMMAND_DELAY_MS)
      expect(write).toHaveBeenCalledWith('a1', 'claude\r')
      expect(write).toHaveBeenCalledWith('a2', 'codex\r')
      expect(write).not.toHaveBeenCalledWith('shell', expect.anything())
    })

    it('settles after the normal dismiss delay', () => {
      const onSettled = vi.fn()
      launchAgents([{ id: 't1', agentCommand: 'claude' }], { write: vi.fn(), onSettled })

      vi.advanceTimersByTime(DISMISS_MS - 1)
      expect(onSettled).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onSettled).toHaveBeenCalledOnce()
    })

    it('waits longer to settle when a slow agent is in the batch', () => {
      const onSettled = vi.fn()
      launchAgents(
        [{ id: 't1', agentCommand: 'claude' }, { id: 't2', agentCommand: 'gemini' }],
        { write: vi.fn(), onSettled },
      )

      vi.advanceTimersByTime(DISMISS_MS)
      expect(onSettled).not.toHaveBeenCalled()

      vi.advanceTimersByTime(SLOW_DISMISS_MS - DISMISS_MS)
      expect(onSettled).toHaveBeenCalledOnce()
    })

    it('settles immediately and writes nothing when no target has an agent', () => {
      const write = vi.fn()
      const onSettled = vi.fn()
      launchAgents([{ id: 't1' }, { id: 't2' }], { write, onSettled })

      expect(onSettled).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(SLOW_DISMISS_MS)
      expect(write).not.toHaveBeenCalled()
    })

    it('tolerates an empty target list', () => {
      expect(() => launchAgents([], {})).not.toThrow()
    })

    it('falls back to the preload bridge when no writer is injected', () => {
      const writeToTerminal = vi.fn()
      ;(window as any).termpolis = { writeToTerminal }

      launchAgents([{ id: 't1', agentCommand: 'claude' }])
      vi.advanceTimersByTime(SHELL_SETTLE_MS + COMMAND_DELAY_MS)

      expect(writeToTerminal).toHaveBeenCalledWith('t1', 'claude\r')
    })
  })
})
