import type { Workflow, WorkflowStep, WorkflowRun, StepResult, RunStatus } from '../../renderer/src/types'
import type { EngineDeps } from './contracts'
import { evalCondition } from './workflowExpr'
import { executeCommandStep, executeAgentStep, executeSkillStep, executeControlStep } from './executors'

const cancelled = new Set<string>()
const runningStep = new Map<string, string>()   // runId -> in-flight stepId

export function cancelRun(runId: string, deps: EngineDeps): void {
  cancelled.add(runId)
  const stepId = runningStep.get(runId)
  if (stepId) { deps.terminal.cancel(stepId); deps.agent.cancel(stepId) }
}

export async function runWorkflow(wf: Workflow, deps: EngineDeps): Promise<WorkflowRun> {
  const runId = deps.newRunId()
  const results: Record<string, StepResult> = {}
  const run: WorkflowRun = { runId, workflowId: wf.id, status: 'running', steps: [], startedAt: deps.now() }
  deps.emit({ type: 'run:started', runId, workflowId: wf.id, at: run.startedAt })
  const idIndex = new Map(wf.steps.map((s, i) => [s.id, i]))
  // Run-wide execution budget. Bounds runaway backward `goto` loops in the main loop
  // AND (threaded into runLoop below) nested control loops, so no workflow can hang the engine.
  const MAX_STEP_EXECUTIONS = 1000
  let executed = 0
  const overBudget = () => ++executed > MAX_STEP_EXECUTIONS
  let hardFailed = false
  let i = 0

  const record = (r: StepResult) => { results[r.stepId] = r; run.steps.push(r); deps.emit({ type: 'step:finished', runId, stepId: r.stepId, result: r }) }

  while (i < wf.steps.length) {
    if (overBudget()) { record({ stepId: '__runaway__', status: 'failed', output: `aborted after ${MAX_STEP_EXECUTIONS} step executions (possible infinite loop)` }); hardFailed = true; break }
    if (cancelled.has(runId)) { record({ stepId: wf.steps[i].id, status: 'cancelled', output: '' }); i++; continue }
    const step = wf.steps[i]
    const gated = step.when !== undefined ? !evalCondition(step.when, results, deps.scope) : hardFailed
    if (gated) { record({ stepId: step.id, status: 'skipped', output: '' }); i++; continue }

    deps.emit({ type: 'step:started', runId, stepId: step.id, at: deps.now() })
    deps.emit({ type: 'step:status', runId, stepId: step.id, status: 'running' })
    runningStep.set(runId, step.id)
    const onChunk = (chunk: string) => deps.emit({ type: 'step:output', runId, stepId: step.id, chunk })

    let result: StepResult
    let jumpTo: string | undefined
    if (step.type === 'command') result = await executeCommandStep(step, results, deps.terminal, onChunk, deps.scope)
    else if (step.type === 'agent') result = await executeAgentStep(step, results, deps.agent, onChunk, deps.scope)
    else if (step.type === 'skill') result = await executeSkillStep(step, results, deps.tools, deps.scope)
    else {
      const c = await executeControlStep(step, results, deps.timer, (e) => deps.emit({ type: 'step:output', runId, stepId: step.id, chunk: e.chunk || '' }), deps.scope)
      result = { stepId: step.id, status: c.status, output: c.output }
      jumpTo = c.goto
      if (c.loop) { record(result); i = await runLoop(wf, i, c.loop, results, deps, runId, overBudget); continue }
    }
    result.startedAt = result.startedAt ?? run.startedAt
    result.endedAt = deps.now()
    record(result)

    if (result.status === 'failed' && !(step as any).continueOnError) { hardFailed = true }
    if (jumpTo && idIndex.has(jumpTo)) { i = idIndex.get(jumpTo)!; continue }
    i++
  }

  run.status = (cancelled.has(runId) ? 'cancelled' : hardFailed ? 'failed' : 'succeeded') as RunStatus
  run.endedAt = deps.now()
  cancelled.delete(runId); runningStep.delete(runId)
  deps.emit({ type: 'run:finished', runId, status: run.status, at: run.endedAt })
  return run
}

async function runLoop(
  wf: Workflow, loopIdx: number, loop: { maxIterations: number; until?: string },
  results: Record<string, StepResult>, deps: EngineDeps, runId: string, overBudget: () => boolean,
): Promise<number> {
  const prev = wf.steps[loopIdx - 1] as WorkflowStep | undefined
  if (!prev) return loopIdx + 1
  for (let n = 1; n < loop.maxIterations; n++) {
    if (loop.until && evalCondition(loop.until, results, deps.scope)) break
    if (overBudget()) break // share the run-wide budget so a nested loop can't hang either
    const r = await runOne(prev, results, deps, runId, n)
    results[prev.id] = r
    run_push(deps, runId, r)
    if (loop.until && evalCondition(loop.until, results, deps.scope)) break
  }
  return loopIdx + 1
}

function run_push(deps: EngineDeps, runId: string, r: StepResult) {
  deps.emit({ type: 'step:finished', runId, stepId: r.stepId, result: r })
}

async function runOne(step: WorkflowStep, results: Record<string, StepResult>, deps: EngineDeps, runId: string, iteration: number): Promise<StepResult> {
  const onChunk = (chunk: string) => deps.emit({ type: 'step:output', runId, stepId: step.id, chunk })
  let r: StepResult
  if (step.type === 'command') r = await executeCommandStep(step, results, deps.terminal, onChunk, deps.scope)
  else if (step.type === 'agent') r = await executeAgentStep(step, results, deps.agent, onChunk, deps.scope)
  else if (step.type === 'skill') r = await executeSkillStep(step, results, deps.tools, deps.scope)
  else { const c = await executeControlStep(step, results, deps.timer, () => {}, deps.scope); r = { stepId: step.id, status: c.status, output: c.output } }
  r.iteration = iteration
  return r
}
