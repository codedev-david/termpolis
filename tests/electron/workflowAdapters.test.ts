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
})
