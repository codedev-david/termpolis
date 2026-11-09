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

// perf155 P14: with the pty host up a spawn RETURNS a promise, and a shell the host could not start rejects it instead
// of throwing. The runners await it after their writes.
describe('workflow steps: a spawn that rejects (the pty host could not start it)', () => {
  it('a command step falls back to the default shell, and with none left fails with 127', async () => {
    const spawn = vi.fn((_id, exe: string) => (exe === 'pwsh' ? Promise.reject(new Error('File not found: pwsh')) : Promise.reject('still no')))
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), defaultShell: 'cmd.exe' })
    const res = await runner.run({ ...cmdSpec, shell: 'pwsh' })
    expect(spawn.mock.calls.map((c) => c[1])).toEqual(['pwsh', 'cmd.exe'])
    expect(res.exitCode).toBe(127)
    expect(res.output).toContain('File not found: pwsh')
    expect(res.output).toContain('falling back to default shell "cmd.exe"')
    expect(res.output).toContain('still no')
  })

  it('a command step cancelled while the host starts it neither retries nor reports the failure', async () => {
    let fail: (e: Error) => void = () => {}
    const spawn = vi.fn(() => new Promise<void>((_r, rej) => { fail = rej }))
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), defaultShell: 'cmd.exe' })
    const run = runner.run(cmdSpec)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    runner.cancel(cmdSpec.stepId)
    fail(new Error('late'))
    const res = await run
    expect(res.exitCode).toBe(130)
    await new Promise((r) => setTimeout(r, 0))
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('an agent step whose spawn rejects rejects the run', async () => {
    const spawn = vi.fn(() => Promise.reject(new Error('Failed to open terminal: gone')))
    const runner = makeAgentRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() }, () => ({ status: 'working', summary: '' }), () => 'claude')
    await expect(runner.run(agentSpec)).rejects.toThrow('Failed to open terminal: gone')
  })

  it('an agent step that finished while the host started it starts no poll', async () => {
    vi.useFakeTimers()
    try {
      let spawned: () => void = () => {}
      const detect = vi.fn(() => ({ status: 'working', summary: '' }))
      const spawn = vi.fn(() => new Promise<void>((r) => { spawned = r }))
      const runner = makeAgentRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() }, detect, () => 'claude')
      const run = runner.run(agentSpec)
      await vi.advanceTimersByTimeAsync(0)
      runner.cancel(agentSpec.stepId)
      expect((await run).error).toBe('cancelled')
      spawned()
      await vi.advanceTimersByTimeAsync(5000)
      expect(detect).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
