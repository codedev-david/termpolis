// Opening a terminal looks things up (the folder, the shell integration script, the bundled tools). A workflow's command
// step, its agent step and an agent's run_and_wait each open one, so they ask for those lookups on the thread pool
// (`prepare`) BEFORE the spawn and hand the answer to it, instead of the spawn doing them synchronously on the thread that
// echoes every keystroke. Counters only: how many times prepare and spawn ran, and in what order.
import { describe, it, expect, vi } from 'vitest'
import { makeTerminalRunner, makeAgentRunner } from '../../src/main/workflow/adapters'

const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}
const PREP = { cwd: '/prepared', integrationScript: null }

const cmdSpec = { stepId: 'c', command: 'echo hi', shell: 'bash', cwd: '/x', timeoutMs: 100000, visible: false }
const agentSpec = { stepId: 'a', agent: 'claude' as const, prompt: 'hi', cwd: '/x', idleMs: 1000, timeoutMs: 100000 }

describe('workflow command step: lookups before the spawn', () => {
  it('prepare is asked once, the spawn waits for it and receives what it found', async () => {
    const order: string[] = []
    const gate = deferred<typeof PREP>()
    const prepare = vi.fn((exe: string, cwd: string) => { order.push(`prepare ${exe} ${cwd}`); return gate.promise })
    const spawn = vi.fn((_id, _exe, _cwd, _d, _p, _e, onExit, _prep) => { order.push('spawn'); setTimeout(() => onExit(0), 0) })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare })
    const run = runner.run(cmdSpec)
    await Promise.resolve()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled() // the lookups are still on the thread pool: no terminal yet
    gate.resolve(PREP)
    const res = await run
    expect(res.exitCode).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][7]).toBe(PREP) // the 8th argument: what prepare found
    expect(order).toEqual(['prepare bash /x', 'spawn'])
  })

  it('without prepare it spawns synchronously inside run(), as before', () => {
    const spawn = vi.fn()
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() })
    void runner.run(cmdSpec)
    expect(spawn).toHaveBeenCalledTimes(1) // no await ran before it
    expect(spawn.mock.calls[0][7]).toBeUndefined()
  })

  it('cancelled while the lookups run: no terminal is ever started', async () => {
    const gate = deferred<typeof PREP>()
    const spawn = vi.fn()
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare: () => gate.promise })
    const run = runner.run(cmdSpec)
    runner.cancel('c')
    gate.resolve(PREP)
    const res = await run
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(res.exitCode).toBe(130)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('timed out while the lookups run: no terminal is started after the step is over', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<typeof PREP>()
      const spawn = vi.fn()
      const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare: () => gate.promise })
      const run = runner.run({ ...cmdSpec, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1500)
      const res = await run
      expect(res.timedOut).toBe(true)
      gate.resolve(PREP)
      await vi.advanceTimersByTimeAsync(10)
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lookups that fail do not stop the step: the spawn looks things up itself', async () => {
    const spawn = vi.fn((_id, _exe, _cwd, _d, _p, _e, onExit) => { setTimeout(() => onExit(0), 0) })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare: () => Promise.reject(new Error('disk')) })
    const res = await runner.run(cmdSpec)
    expect(res.exitCode).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][7]).toBeUndefined()
  })

  it('falling back to the default shell prepares for that shell too', async () => {
    const prepare = vi.fn(async (exe: string) => ({ ...PREP, cwd: '/for-' + exe }))
    const spawn = vi.fn((_id, exe, _cwd, _d, _p, _e, onExit) => {
      if (exe === 'weird') throw new Error('cannot spawn')
      setTimeout(() => onExit(0), 0)
    })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare, defaultShell: 'bash' })
    const res = await runner.run({ ...cmdSpec, shell: 'weird' })
    expect(res.exitCode).toBe(0)
    expect(prepare.mock.calls.map((c) => c[0])).toEqual(['weird', 'bash'])
    expect(spawn.mock.calls.map((c) => [c[1], c[7]?.cwd])).toEqual([['weird', '/for-weird'], ['bash', '/for-bash']])
  })
})

describe('workflow agent step: lookups before the spawn', () => {
  it('prepare is asked for the agent, the spawn waits for it, the idle poll starts with the agent', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<typeof PREP>()
      const prepare = vi.fn(() => gate.promise)
      const spawn = vi.fn()
      const detect = vi.fn(() => ({ status: 'idle', summary: '' }))
      const runner = makeAgentRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare }, detect, () => 'claude')
      const run = runner.run(agentSpec)
      await vi.advanceTimersByTimeAsync(2000)
      expect(prepare).toHaveBeenCalledWith('claude', '/x')
      expect(spawn).not.toHaveBeenCalled()
      expect(detect).not.toHaveBeenCalled() // nothing to poll yet
      gate.resolve(PREP)
      await vi.advanceTimersByTimeAsync(2500)
      expect((await run).ok).toBe(true)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn.mock.calls[0][7]).toBe(PREP)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelled or timed out while the lookups run: nothing is started and nothing polls', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<typeof PREP>()
      const spawn = vi.fn()
      const detect = vi.fn(() => ({ status: 'idle', summary: '' }))
      const runner = makeAgentRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare: () => gate.promise }, detect, () => 'claude')
      const cancelled = runner.run(agentSpec)
      runner.cancel('a')
      expect((await cancelled).error).toMatch(/cancel/)
      const timedOut = runner.run({ ...agentSpec, stepId: 'b', timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1500)
      expect((await timedOut).error).toMatch(/timed out/)
      gate.resolve(PREP)
      await vi.advanceTimersByTimeAsync(2000)
      expect(spawn).not.toHaveBeenCalled()
      expect(detect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spawn that throws rejects the run, with or without prepare', async () => {
    const boom = vi.fn(() => { throw new Error('no pty') })
    const idle = () => ({ status: 'idle', summary: '' })
    const plain = makeAgentRunner({ spawnTerminal: boom as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() }, idle, () => 'claude')
    await expect(plain.run({ ...agentSpec, timeoutMs: 50 })).rejects.toThrow('no pty')
    const prepared = makeAgentRunner({ spawnTerminal: boom as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), prepare: async () => PREP }, idle, () => 'claude')
    await expect(prepared.run({ ...agentSpec, timeoutMs: 50 })).rejects.toThrow('no pty')
  })
})
