import { describe, it, expect, vi } from 'vitest'
import { makeTerminalRunner, makeAgentRunner, makeToolInvoker, realTimer } from '../../src/main/workflow/adapters'

describe('terminal runner adapter', () => {
  it('spawns, feeds output to onChunk, resolves with the exit code', async () => {
    // fake spawnTerminal: capture callbacks, then drive them
    let onData: (s: string) => void = () => {}
    let onExit: (code: number) => void = () => {}
    const spawn = vi.fn((_id, _exe, _cwd, d, _p, _e, ex) => { onData = d; onExit = ex })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() })
    const chunks: string[] = []
    const p = runner.run({ stepId: 's', command: 'echo hi', shell: 'bash', cwd: '/x', timeoutMs: 1000, visible: false }, c => chunks.push(c))
    onData('hi\n'); onExit(0)
    const res = await p
    expect(res.exitCode).toBe(0)
    expect(chunks.join('')).toContain('hi')
  })
  it('resolves failed (never rejects/hangs) when spawnTerminal throws', async () => {
    // node-pty throws synchronously when it cannot spawn the shell (e.g. a
    // bad executable). The runner MUST catch it and resolve a failed result
    // so the engine reports the step failed — a rejected promise here would
    // hang the whole run with the step stuck "running" forever.
    const spawn = vi.fn(() => { throw new Error('File not found: bogus') })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() })
    const res = await runner.run({ stepId: 's', command: 'echo hi', shell: 'bogus', cwd: '/x', timeoutMs: 1000, visible: false })
    expect(res.exitCode).not.toBe(0)
    expect(res.output).toContain('File not found')
  })
  it('falls back to the OS default shell when the chosen shell cannot be spawned', async () => {
    // node-pty throws for the requested shell (e.g. a runner that cannot
    // posix_spawn /bin/bash) but the OS default (zsh) spawns fine — the step
    // must run on the fallback shell rather than hard-fail.
    let onExit: (code: number) => void = () => {}
    const spawn = vi.fn((_id: string, exe: string, _cwd: string, _d: any, _p: any, _e: any, ex: (c: number) => void) => {
      if (exe === 'bash') throw new Error('posix_spawnp failed')
      onExit = ex
    })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), defaultShell: 'zsh' })
    const p = runner.run({ stepId: 's', command: 'exit 0', shell: 'bash', cwd: '/x', timeoutMs: 1000, visible: false })
    onExit(0)
    const res = await p
    expect(res.exitCode).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0][1]).toBe('bash')   // first attempt: chosen shell
    expect(spawn.mock.calls[1][1]).toBe('zsh')    // retry: OS default
    expect(res.output).toContain('falling back to default shell "zsh"')
  })
  it('reports a failed step when neither the chosen shell nor the default can spawn', async () => {
    const spawn = vi.fn(() => { throw new Error('posix_spawnp failed') })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), defaultShell: 'zsh' })
    const res = await runner.run({ stepId: 's', command: 'exit 0', shell: 'bash', cwd: '/x', timeoutMs: 1000, visible: false })
    expect(res.exitCode).toBe(127)
    expect(spawn).toHaveBeenCalledTimes(2)        // tried bash, then the zsh fallback
    expect(res.output).toContain('posix_spawnp failed')
  })
  it('does not retry when the chosen shell already IS the OS default', async () => {
    const spawn = vi.fn(() => { throw new Error('boom') })
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: vi.fn(), defaultShell: 'bash' })
    const res = await runner.run({ stepId: 's', command: 'exit 0', shell: 'bash', cwd: '/x', timeoutMs: 1000, visible: false })
    expect(res.exitCode).toBe(127)
    expect(spawn).toHaveBeenCalledTimes(1)        // no pointless retry on the same shell
  })
  it('timeout kills the pty and resolves timedOut', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const spawn = vi.fn((_id, _exe, _cwd, _d, _p, _e, _ex) => {})
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: kill })
    const p = runner.run({ stepId: 's', command: 'sleep 999', shell: 'bash', cwd: '/x', timeoutMs: 50, visible: false })
    await vi.advanceTimersByTimeAsync(60)
    const res = await p
    expect(res.timedOut).toBe(true); expect(kill).toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('cancel(stepId) kills the live pty and resolves the run (exit 130)', async () => {
    // spawn never drives onExit — the run stays in-flight until cancel fires.
    const kill = vi.fn()
    const spawn = vi.fn((_id, _exe, _cwd, _d, _p, _e, _ex) => {})
    const runner = makeTerminalRunner({ spawnTerminal: spawn as any, writeToTerminal: vi.fn(), killTerminal: kill })
    const p = runner.run({ stepId: 's', command: 'sleep 999', shell: 'bash', cwd: '/x', timeoutMs: 100000, visible: false })
    runner.cancel('s')
    const res = await p
    expect(res.exitCode).toBe(130)
    expect(kill).toHaveBeenCalledWith('s')
  })
  it('cancel of an unknown stepId is a harmless no-op', () => {
    const runner = makeTerminalRunner({ spawnTerminal: vi.fn() as any, writeToTerminal: vi.fn(), killTerminal: vi.fn() })
    expect(() => runner.cancel('never-started')).not.toThrow()
  })
})

describe('tool invoker adapter', () => {
  it('delegates to executeTool and returns ok/output', async () => {
    const handlers: any = {}
    const runner = makeToolInvoker(handlers, async (name) => ({ output: `${name}!` }))
    const r = await runner.invoke('memory_search', { query: 'x' }, 1000)
    expect(r.ok).toBe(true); expect(r.output).toContain('memory_search!')
  })
  it('executeTool throwing -> ok:false', async () => {
    const runner = makeToolInvoker({} as any, async () => { throw new Error('bad tool') })
    const r = await runner.invoke('nope', {}, 1000)
    expect(r.ok).toBe(false); expect(r.error).toBe('bad tool')
  })
})

describe('realTimer', () => {
  it('sleeps ~ the requested ms', async () => {
    vi.useFakeTimers(); const p = realTimer.sleep(100); await vi.advanceTimersByTimeAsync(100); await p; vi.useRealTimers()
  })
})

describe('agent runner adapter', () => {
  const sp = (spawn: any, kill = vi.fn()) => ({ spawnTerminal: spawn, writeToTerminal: vi.fn(), killTerminal: kill })
  const spec = { stepId: 'g', agent: 'claude' as const, prompt: 'hi', cwd: '/x', idleMs: 1000, timeoutMs: 100000 }

  it('resolves ok once detect holds idle for idleMs', async () => {
    vi.useFakeTimers()
    const runner = makeAgentRunner(sp(vi.fn()) as any, () => ({ status: 'idle', summary: '' }), () => 'claude')
    const p = runner.run(spec)
    await vi.advanceTimersByTimeAsync(2000) // polls @500ms: idle latched, then held >= idleMs
    expect((await p).ok).toBe(true)
    vi.useRealTimers()
  })
  it('doneMarker in output short-circuits to ok', async () => {
    let onData: (s: string) => void = () => {}
    const spawn = vi.fn((_i: string, _e: string, _c: string, d: (s: string) => void) => { onData = d })
    const runner = makeAgentRunner(sp(spawn) as any, () => ({ status: 'working', summary: '' }), () => 'claude')
    const p = runner.run({ ...spec, idleMs: 9e9, doneMarker: '<<DONE>>' })
    onData('... <<DONE>> ...')
    expect((await p).ok).toBe(true)
  })
  it('errored status -> ok:false', async () => {
    vi.useFakeTimers()
    const runner = makeAgentRunner(sp(vi.fn()) as any, () => ({ status: 'errored', summary: '' }), () => 'claude')
    const p = runner.run(spec)
    await vi.advanceTimersByTimeAsync(600)
    const r = await p
    expect(r.ok).toBe(false); expect(r.error).toMatch(/errored/)
    vi.useRealTimers()
  })
  it('timeout kills the pane and fails', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const runner = makeAgentRunner(sp(vi.fn(), kill) as any, () => ({ status: 'working', summary: '' }), () => 'claude')
    const p = runner.run({ ...spec, timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(60)
    const r = await p
    expect(r.ok).toBe(false); expect(kill).toHaveBeenCalled(); expect(r.error).toMatch(/timed out/)
    vi.useRealTimers()
  })
  it('cancel -> ok:false', async () => {
    const runner = makeAgentRunner(sp(vi.fn()) as any, () => ({ status: 'working', summary: '' }), () => 'claude')
    const p = runner.run(spec)
    runner.cancel('g')
    const r = await p
    expect(r.ok).toBe(false); expect(r.error).toMatch(/cancel/)
  })
  it('resets the idle countdown when the agent resumes work after briefly going idle', async () => {
    // idle latches idleSince; a subsequent non-idle poll must clear it so the agent
    // is only declared done after a *sustained* idle, never a momentary pause.
    vi.useFakeTimers()
    const seq = ['idle', 'working', 'errored'] // poll @500ms: latch, reset (else branch), then end
    let i = 0
    const detect = () => ({ status: seq[Math.min(i++, seq.length - 1)] as any, summary: '' })
    const runner = makeAgentRunner(sp(vi.fn()) as any, detect, () => 'claude')
    const p = runner.run(spec) // idleMs 1000
    await vi.advanceTimersByTimeAsync(1500)
    const r = await p
    expect(r.ok).toBe(false)          // ended on 'errored', NOT a premature idle-complete
    expect(r.error).toMatch(/errored/)
    vi.useRealTimers()
  })
})
