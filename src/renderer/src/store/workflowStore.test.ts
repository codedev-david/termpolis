import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore } from './terminalStore'
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
