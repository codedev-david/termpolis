// The edges of finishing a workflow command step and agent step: a second finish is ignored, and a spawn that throws
// something that is not an Error is still reported. Counters (calls, results), no clock assertions.
import { describe, it, expect, vi } from 'vitest'
import { makeTerminalRunner, makeAgentRunner } from '../../src/main/workflow/adapters'

const cmdSpec = { stepId: 'c', command: 'echo hi', shell: 'bash', cwd: '/x', timeoutMs: 100000, visible: false }
const agentSpec = { stepId: 'a', agent: 'claude' as const, prompt: 'hi', cwd: '/x', idleMs: 1000, timeoutMs: 100000 }

describe('workflow command step: finishing', () => {
  it('an exit that arrives after the timeout is ignored: the step stays timed out', async () => {
    vi.useFakeTimers()
    try {
      let onExit: (code: number) => void = () => {}
      const spawn = vi.fn((_id, _exe, _cwd, _d, _p, _e, ex) => { onExit = ex })
      const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() })
      const run = runner.run({ ...cmdSpec, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1500)
      expect((await run).timedOut).toBe(true)
      expect(() => onExit(0)).not.toThrow() // the killed pty reports its exit afterwards
      expect((await run).exitCode).toBe(124)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spawn that throws something that is not an Error is reported by its text', async () => {
    const spawn = vi.fn(() => { throw 'no such shell' })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() })
    const res = await runner.run(cmdSpec)
    expect(res.exitCode).toBe(127)
    expect(res.output).toContain('no such shell')
  })
})

describe('workflow agent step: finishing', () => {
  it('a done marker that has not arrived yet does not finish the step; once it has, a later chunk and the timeout change nothing', async () => {
    vi.useFakeTimers()
    try {
      let onData: (s: string) => void = () => {}
      const spawn = vi.fn((_id, _exe, _cwd, d) => { onData = d })
      const kill = vi.fn()
      const runner = makeAgentRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: kill }, () => ({ status: 'working', summary: '' }), () => 'claude')
      const run = runner.run({ ...agentSpec, doneMarker: 'ALL DONE', timeoutMs: 5000 })
      let settled = false
      void run.then(() => { settled = true })
      onData('still working ')
      await Promise.resolve()
      expect(settled).toBe(false) // the marker is set but is not in the output yet
      onData('... ALL DONE')
      const res = await run
      expect(res.ok).toBe(true)
      onData('ALL DONE again') // a late chunk after the step finished: ignored
      await vi.advanceTimersByTimeAsync(6000) // the hard timeout was cleared with the step: nothing is killed
      expect(kill).not.toHaveBeenCalled()
      expect((await run).ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
