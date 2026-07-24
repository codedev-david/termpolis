import type { ControlStep, StepResult, StepStatus } from '../../renderer/src/types'
import type { Timer } from './contracts'
import { interpolate, evalCondition } from './workflowExpr'

type Emit = (e: { chunk: string }) => void
type Results = Record<string, StepResult>

// Hard ceiling on a single control-loop's iterations. A huge or absent
// `maxIterations` is clamped into [1, MAX_LOOP_ITERATIONS] so a loop can never hang the engine.
export const MAX_LOOP_ITERATIONS = 1000

export async function executeControlStep(
  step: ControlStep, results: Results, timer: Timer, emit: Emit,
): Promise<{ status: StepStatus; output: string; goto?: string; loop?: { maxIterations: number; until?: string } }> {
  const c = step.config
  switch (step.action) {
    case 'wait': {
      await timer.sleep(Number(c.waitMs) || 0)
      return { status: 'succeeded', output: '' }
    }
    case 'branch': {
      const hit = evalCondition(String(c.condition ?? ''), results)
      return { status: 'succeeded', output: hit ? 'branch taken' : 'branch skipped', goto: hit ? String(c.goto) : undefined }
    }
    case 'loop': {
      const requested = Number(c.maxIterations) || 1
      const maxIterations = Math.min(Math.max(1, requested), MAX_LOOP_ITERATIONS)
      return { status: 'succeeded', output: '', loop: { maxIterations, until: c.until ? String(c.until) : undefined } }
    }
    case 'notify': {
      const msg = interpolate(String(c.message ?? ''), results)
      emit({ chunk: msg })
      return { status: 'succeeded', output: msg }
    }
    default:
      return { status: 'failed', output: `unknown control action` }
  }
}
