import { describe, it, expect, vi } from 'vitest'
import { executeControlStep } from '../../src/main/workflow/executors'
import type { ControlStep, StepResult } from '../../src/renderer/src/types'

const timer = { sleep: vi.fn(async () => {}) }
const results: Record<string, StepResult> = {
  t: { stepId: 't', status: 'failed', exitCode: 1, output: 'boom' },
}

describe('control: wait', () => {
  it('sleeps for config.waitMs and succeeds', async () => {
    const step: ControlStep = { id: 'w', type: 'control', name: 'wait', action: 'wait', config: { waitMs: 500 } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(timer.sleep).toHaveBeenCalledWith(500)
    expect(r.status).toBe('succeeded')
  })
})

describe('control: branch', () => {
  it('returns goto when condition true', async () => {
    const step: ControlStep = { id: 'b', type: 'control', name: 'br', action: 'branch', config: { condition: 'steps.t.failed', goto: 'fix' } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.goto).toBe('fix')
  })
  it('no goto when condition false', async () => {
    const step: ControlStep = { id: 'b', type: 'control', name: 'br', action: 'branch', config: { condition: 'steps.t.ok', goto: 'fix' } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.goto).toBeUndefined()
  })
})

describe('control: loop + notify', () => {
  it('loop returns loop directive', async () => {
    const step: ControlStep = { id: 'l', type: 'control', name: 'lp', action: 'loop', config: { maxIterations: 3, until: 'steps.t.ok' } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.loop).toEqual({ maxIterations: 3, until: 'steps.t.ok' })
  })
  it('clamps a huge maxIterations to the hard ceiling (no runaway loop)', async () => {
    const step: ControlStep = { id: 'l', type: 'control', name: 'lp', action: 'loop', config: { maxIterations: 1_000_000_000 } }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.loop!.maxIterations).toBe(1000)
  })
  it('coerces a missing/zero maxIterations to a safe minimum of 1', async () => {
    const step: ControlStep = { id: 'l', type: 'control', name: 'lp', action: 'loop', config: {} }
    const r = await executeControlStep(step, results, timer, () => {})
    expect(r.loop!.maxIterations).toBe(1)
  })
  it('notify emits the interpolated message once', async () => {
    const emit = vi.fn()
    const step: ControlStep = { id: 'n', type: 'control', name: 'nt', action: 'notify', config: { message: 'code=${steps.t.exitCode}' } }
    const r = await executeControlStep(step, results, timer, emit)
    expect(r.status).toBe('succeeded')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ chunk: 'code=1' }))
  })
})
