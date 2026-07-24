import { describe, it, expect, vi } from 'vitest'
import { runWorkflow, cancelRun } from '../../src/main/workflow/workflowEngine'
import type { Workflow } from '../../src/renderer/src/types'
import type { EngineDeps, WorkflowRunEvent } from '../../src/main/workflow/contracts'

function deps(over: Partial<EngineDeps> = {}): { d: EngineDeps; events: WorkflowRunEvent[] } {
  const events: WorkflowRunEvent[] = []
  let t = 1000
  const d: EngineDeps = {
    terminal: { run: vi.fn(async (s) => ({ exitCode: 0, output: `ran:${s.command}` })), cancel: vi.fn() },
    agent: { run: vi.fn(async () => ({ output: 'agent', ok: true })), cancel: vi.fn() },
    tools: { invoke: vi.fn(async () => ({ output: 'tool', ok: true })) },
    timer: { sleep: vi.fn(async () => {}) },
    now: () => t++, newRunId: () => 'run-1', emit: (e) => events.push(e),
    ...over,
  }
  return { d, events }
}
const wf = (steps: any[]): Workflow => ({ id: 'wf', name: 'wf', version: 1, trigger: { type: 'manual' }, steps })

describe('engine', () => {
  it('runs steps in order and finishes succeeded', async () => {
    const { d, events } = deps()
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'echo a' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b' },
    ]), d)
    expect(run.status).toBe('succeeded')
    expect(run.steps.map(s => s.status)).toEqual(['succeeded', 'succeeded'])
    expect(events[0].type).toBe('run:started')
    expect(events.at(-1)).toMatchObject({ type: 'run:finished', status: 'succeeded' })
  })

  it('gate when:false skips the step', async () => {
    const { d } = deps()
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'echo a' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b', when: 'steps.a.failed' },
    ]), d)
    expect(run.steps[1].status).toBe('skipped')
  })

  it('data flows from step a into step b command', async () => {
    const runSpy = vi.fn(async (s: any) => ({ exitCode: 0, output: s.command === 'echo a' ? 'A-OUT' : s.command }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'echo a' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'use ${steps.a.output}' },
    ]), d)
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ command: 'use A-OUT' }), expect.anything())
  })

  it('hard failure stops the run; later no-when steps are skipped', async () => {
    const runSpy = vi.fn(async (s: any) => ({ exitCode: s.command === 'boom' ? 1 : 0, output: '' }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'boom' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b' },
    ]), d)
    expect(run.status).toBe('failed')
    expect(run.steps[1].status).toBe('skipped')
  })

  it('continueOnError lets the run proceed', async () => {
    const runSpy = vi.fn(async (s: any) => ({ exitCode: s.command === 'boom' ? 1 : 0, output: '' }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const run = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'boom', continueOnError: true },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'echo b' },
    ]), d)
    expect(run.steps[0].status).toBe('failed')
    expect(run.steps[1].status).toBe('succeeded')
    expect(run.status).toBe('succeeded')
  })

  it('streams a command step\'s live output as step:output events', async () => {
    // The terminal substrate calls onChunk mid-run; the engine must relay each
    // chunk to the renderer as a step:output event tagged with the step id.
    const runSpy = vi.fn(async (_s: any, onChunk?: (c: string) => void) => { onChunk?.('line-1\n'); return { exitCode: 0, output: 'line-1\n' } })
    const { d, events } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([{ id: 'a', type: 'command', name: 'a', source: 'inline', command: 'echo hi' }]), d)
    expect(events).toContainEqual(expect.objectContaining({ type: 'step:output', stepId: 'a', chunk: 'line-1\n' }))
  })

  it('a notify control step emits its message as step:output', async () => {
    // notify is the one control action that emits; the engine\'s onEmit adapter
    // must forward the executor\'s chunk out as a step:output event.
    const { d, events } = deps()
    const run = await runWorkflow(wf([
      { id: 'n', type: 'control', name: 'n', action: 'notify', config: { message: 'ship it' } },
    ]), d)
    expect(run.steps[0].status).toBe('succeeded')
    expect(events).toContainEqual(expect.objectContaining({ type: 'step:output', stepId: 'n', chunk: 'ship it' }))
  })

  it('relays live output from a looped step on every iteration', async () => {
    // The looped step re-runs via runOne, which builds its own onChunk. Prove
    // that per-iteration output is streamed too, not just the first pass.
    let n = 0
    const runSpy = vi.fn(async (_s: any, onChunk?: (c: string) => void) => { n++; onChunk?.(`iter-${n}`); return { exitCode: 0, output: String(n) } })
    const { d, events } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'tick' },
      { id: 'l', type: 'control', name: 'l', action: 'loop', config: { maxIterations: 5, until: 'steps.a.output == 3' } },
    ]), d)
    const outputs = events.filter(e => e.type === 'step:output' && e.stepId === 'a').map(e => (e as any).chunk)
    expect(outputs).toContain('iter-1') // first pass (main loop onChunk)
    expect(outputs).toContain('iter-2') // re-run inside runLoop -> runOne onChunk
  })

  it('branch goto jumps forward to the target step', async () => {
    const order: string[] = []
    const runSpy = vi.fn(async (s: any) => { order.push(s.command); return { exitCode: 0, output: '' } })
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'A' },
      { id: 'j', type: 'control', name: 'j', action: 'branch', config: { condition: 'steps.a.ok', goto: 'c' } },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'B' },
      { id: 'c', type: 'command', name: 'c', source: 'inline', command: 'C' },
    ]), d)
    expect(order).toEqual(['A', 'C']) // B skipped by the jump
  })

  it('loop re-runs the preceding step until `until` holds (max cap)', async () => {
    let n = 0
    const runSpy = vi.fn(async () => ({ exitCode: 0, output: String(++n) }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'tick' },
      { id: 'l', type: 'control', name: 'l', action: 'loop', config: { maxIterations: 5, until: 'steps.a.output == 3' } },
    ]), d)
    expect(n).toBe(3) // ran once, then looped until output==3
  })

  it('re-runs a preceding control (notify) step through runOne, not just commands', async () => {
    // When the step before a loop is itself a control step, runLoop re-runs it via
    // runOne, whose control branch executes it with a no-op emit sink. Proves any
    // step type is a valid loop body; each re-run pushes a fresh step:finished.
    const { d, events } = deps()
    const run = await runWorkflow(wf([
      { id: 'n', type: 'control', name: 'n', action: 'notify', config: { message: 'ping' } },
      { id: 'l', type: 'control', name: 'l', action: 'loop', config: { maxIterations: 3 } },
    ]), d)
    expect(run.status).toBe('succeeded')
    const finished = events.filter(e => e.type === 'step:finished' && (e as any).stepId === 'n')
    expect(finished.length).toBeGreaterThanOrEqual(2) // 2 loop re-runs (n=1,2) via runOne
  })

  it('aborts a runaway backward branch goto at the execution cap (does not hang)', async () => {
    const runSpy = vi.fn(async () => ({ exitCode: 0, output: '' }))
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const r = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'A' },
      // condition is always true -> without a budget this jumps back to 'a' forever
      { id: 'j', type: 'control', name: 'j', action: 'branch', config: { condition: 'steps.a.ok', goto: 'a' } },
    ]), d)
    expect(r.status).toBe('failed')
    expect(runSpy.mock.calls.length).toBeLessThanOrEqual(1000)
    expect(r.steps.some(s => s.stepId === '__runaway__')).toBe(true)
  })

  it('a branch goto to an unknown step id falls through to the next step (no crash/hang)', async () => {
    const order: string[] = []
    const runSpy = vi.fn(async (s: any) => { order.push(s.command); return { exitCode: 0, output: '' } })
    const { d } = deps({ terminal: { run: runSpy, cancel: vi.fn() } })
    const r = await runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'A' },
      { id: 'j', type: 'control', name: 'j', action: 'branch', config: { condition: 'steps.a.ok', goto: 'ghost' } },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'B' },
    ]), d)
    expect(order).toEqual(['A', 'B']) // unknown goto ignored -> linear fall-through
    expect(r.status).toBe('succeeded')
  })

  it('cancel mid-run stops remaining steps and finishes cancelled', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const { d } = deps({ terminal: { run: vi.fn(async () => { await gate; return { exitCode: 0, output: '' } }), cancel: vi.fn() } })
    const p = runWorkflow(wf([
      { id: 'a', type: 'command', name: 'a', source: 'inline', command: 'slow' },
      { id: 'b', type: 'command', name: 'b', source: 'inline', command: 'next' },
    ]), d)
    cancelRun('run-1', d)   // deps.newRunId() returns 'run-1'; step 'a' is parked on the gate
    release()
    const run = await p
    expect(run.status).toBe('cancelled')
    expect(run.steps.find(s => s.stepId === 'b')!.status).toBe('cancelled')
  })
})
