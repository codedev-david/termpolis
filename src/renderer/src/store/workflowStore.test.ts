import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore, MAX_STEP_OUTPUT, MAX_FINISHED_RUNS } from './terminalStore'
import type { WorkflowRunEvent } from '../types'

const s = () => useTerminalStore.getState()
const apply = (e: WorkflowRunEvent) => s().applyRunEvent(e)

describe('workflow run reducer', () => {
  beforeEach(() => { useTerminalStore.setState({ activeRuns: {} }); s().setWorkflows([]) })

  it('creates a run on run:started, records a finished step, then closes on run:finished', () => {
    apply({ type: 'run:started', runId: 'r1', workflowId: 'wf', at: 100 })
    expect(s().activeRuns['r1'].status).toBe('running')
    expect(s().activeRuns['r1'].startedAt).toBe(100)

    apply({ type: 'step:finished', runId: 'r1', stepId: 'a', result: { stepId: 'a', status: 'succeeded', output: 'done', exitCode: 0 } })
    expect(s().activeRuns['r1'].steps).toHaveLength(1)
    expect(s().activeRuns['r1'].steps[0].status).toBe('succeeded')
    expect(s().activeRuns['r1'].steps[0].output).toBe('done')

    apply({ type: 'run:finished', runId: 'r1', status: 'succeeded', at: 200 })
    expect(s().activeRuns['r1'].status).toBe('succeeded')
    expect(s().activeRuns['r1'].endedAt).toBe(200)
  })

  it('marks a step running on step:started, accumulates output chunks, and the finished result overwrites in place', () => {
    apply({ type: 'run:started', runId: 'r2', workflowId: 'wf', at: 0 })
    apply({ type: 'step:started', runId: 'r2', stepId: 's', at: 5 })
    expect(s().activeRuns['r2'].steps[0].status).toBe('running')
    expect(s().activeRuns['r2'].steps[0].startedAt).toBe(5)

    apply({ type: 'step:status', runId: 'r2', stepId: 's', status: 'running' })
    apply({ type: 'step:output', runId: 'r2', stepId: 's', chunk: 'hel' })
    apply({ type: 'step:output', runId: 'r2', stepId: 's', chunk: 'lo' })
    expect(s().activeRuns['r2'].steps[0].output).toBe('hello')

    apply({ type: 'step:finished', runId: 'r2', stepId: 's', result: { stepId: 's', status: 'succeeded', output: 'hello', exitCode: 0, endedAt: 9 } })
    expect(s().activeRuns['r2'].steps).toHaveLength(1)
    expect(s().activeRuns['r2'].steps[0].status).toBe('succeeded')
    expect(s().activeRuns['r2'].steps[0].endedAt).toBe(9)
  })

  it('creates the step on a first step:output even with no prior step:started', () => {
    apply({ type: 'run:started', runId: 'r3', workflowId: 'wf', at: 0 })
    apply({ type: 'step:output', runId: 'r3', stepId: 'x', chunk: 'boot' })
    expect(s().activeRuns['r3'].steps).toHaveLength(1)
    expect(s().activeRuns['r3'].steps[0].status).toBe('running')
    expect(s().activeRuns['r3'].steps[0].output).toBe('boot')
  })

  it('ignores events for an unknown/finished run without creating it or crashing', () => {
    expect(() => apply({ type: 'step:output', runId: 'ghost', stepId: 'z', chunk: 'x' })).not.toThrow()
    expect(s().activeRuns['ghost']).toBeUndefined()
    expect(() => apply({ type: 'run:finished', runId: 'ghost', status: 'succeeded', at: 1 })).not.toThrow()
    expect(s().activeRuns['ghost']).toBeUndefined()
  })
})

describe('workflow run retention', () => {
  beforeEach(() => { useTerminalStore.setState({ activeRuns: {} }) })

  it('caps a step\'s retained output instead of concatenating chunks forever', () => {
    apply({ type: 'run:started', runId: 'big', workflowId: 'wf', at: 0 })
    // 40 x 8 KiB = 320 KiB streamed into one step, the shape of any `npm run build` tail.
    for (let i = 0; i < 40; i++) {
      apply({ type: 'step:output', runId: 'big', stepId: 's', chunk: 'x'.repeat(8192) })
    }
    const out = s().activeRuns['big'].steps[0].output
    expect(out.length).toBeLessThan(40 * 8192)
    expect(out.length).toBeLessThanOrEqual(MAX_STEP_OUTPUT)
  })

  it('keeps the head and the tail of a truncated step and says so, rather than silently dropping text', () => {
    apply({ type: 'run:started', runId: 'ht', workflowId: 'wf', at: 0 })
    apply({ type: 'step:output', runId: 'ht', stepId: 's', chunk: 'FIRST-LINE\n' })
    apply({ type: 'step:output', runId: 'ht', stepId: 's', chunk: 'y'.repeat(MAX_STEP_OUTPUT) })
    apply({ type: 'step:output', runId: 'ht', stepId: 's', chunk: '\nLAST-LINE' })

    const out = s().activeRuns['ht'].steps[0].output
    expect(out.startsWith('FIRST-LINE\n')).toBe(true)
    expect(out.endsWith('\nLAST-LINE')).toBe(true)
    expect(out).toContain('output truncated by Termpolis')
  })

  it('truncates a bulk step:finished result too, not just streamed chunks', () => {
    apply({ type: 'run:started', runId: 'bulk', workflowId: 'wf', at: 0 })
    apply({
      type: 'step:finished', runId: 'bulk', stepId: 's',
      result: { stepId: 's', status: 'succeeded', output: 'z'.repeat(MAX_STEP_OUTPUT * 2), exitCode: 0 },
    })
    expect(s().activeRuns['bulk'].steps[0].output.length).toBeLessThanOrEqual(MAX_STEP_OUTPUT)
  })

  it('leaves output below the cap byte-for-byte untouched', () => {
    apply({ type: 'run:started', runId: 'small', workflowId: 'wf', at: 0 })
    apply({ type: 'step:output', runId: 'small', stepId: 's', chunk: 'just a normal build log' })
    expect(s().activeRuns['small'].steps[0].output).toBe('just a normal build log')
  })

  it('evicts the oldest finished runs beyond the cap and keeps the newest', () => {
    const total = MAX_FINISHED_RUNS + 5
    for (let i = 0; i < total; i++) {
      apply({ type: 'run:started', runId: `r${i}`, workflowId: 'wf', at: i })
      apply({ type: 'run:finished', runId: `r${i}`, status: 'succeeded', at: i + 1 })
    }
    expect(Object.keys(s().activeRuns)).toHaveLength(MAX_FINISHED_RUNS)
    expect(s().activeRuns['r0']).toBeUndefined()
    expect(s().activeRuns['r4']).toBeUndefined()
    expect(s().activeRuns[`r${total - 1}`]).toBeDefined()
  })

  it('never evicts a still-running run, however many runs finish around it', () => {
    apply({ type: 'run:started', runId: 'live', workflowId: 'wf', at: 0 })
    for (let i = 0; i < MAX_FINISHED_RUNS + 10; i++) {
      apply({ type: 'run:started', runId: `done${i}`, workflowId: 'wf', at: i + 1 })
      apply({ type: 'run:finished', runId: `done${i}`, status: 'succeeded', at: i + 2 })
    }
    expect(s().activeRuns['live']).toBeDefined()
    expect(s().activeRuns['live'].status).toBe('running')
  })
})
