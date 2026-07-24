import type { AgentStep, CommandStep, ControlStep, SkillStep, StepResult, StepStatus } from '../../renderer/src/types'
import type { AgentRunner, TerminalRunner, ToolInvoker, Timer } from './contracts'
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

const CAP = 32_768
const tail = (s: string) => (s.length > CAP ? s.slice(-CAP) : s)

function fileCommand(scriptPath: string, shell?: string): string {
  if (shell === 'python' || /\.py$/.test(scriptPath)) return `python ${scriptPath}`
  if (/\.(mjs|cjs|js)$/.test(scriptPath)) return `node ${scriptPath}`
  if (/\.ps1$/.test(scriptPath)) return `pwsh -File ${scriptPath}`
  return `${shell || 'bash'} ${scriptPath}`
}

export async function executeCommandStep(
  step: CommandStep, results: Results, terminal: TerminalRunner, onChunk?: (s: string) => void,
): Promise<StepResult> {
  const shell = step.shell || 'bash'
  const command = step.source === 'file'
    ? fileCommand(step.scriptPath || '', step.shell)
    : interpolate(step.command || '', results)
  const res = await terminal.run(
    { stepId: step.id, command, shell, cwd: step.cwd || '', timeoutMs: step.timeoutMs ?? 600_000, visible: step.visible ?? true },
    onChunk,
  )
  return {
    stepId: step.id,
    status: res.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: res.exitCode,
    output: tail(res.output),
    error: res.timedOut ? `command timed out after ${step.timeoutMs ?? 600_000}ms` : undefined,
  }
}

export async function executeAgentStep(
  step: AgentStep, results: Results, agent: AgentRunner, onChunk?: (s: string) => void,
): Promise<StepResult> {
  const res = await agent.run({
    stepId: step.id, agent: step.agent, prompt: interpolate(step.prompt, results),
    cwd: step.cwd || '', idleMs: step.idleMs ?? 8_000, timeoutMs: step.timeoutMs ?? 900_000,
    doneMarker: step.doneMarker,
  }, onChunk)
  return { stepId: step.id, status: res.ok ? 'succeeded' : 'failed', output: tail(res.output), error: res.error }
}

export async function executeSkillStep(step: SkillStep, results: Results, tools: ToolInvoker): Promise<StepResult> {
  const args: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(step.args || {})) {
    args[k] = typeof v === 'string' ? interpolate(v, results) : v
  }
  const res = await tools.invoke(step.tool, args, step.timeoutMs ?? 120_000)
  return { stepId: step.id, status: res.ok ? 'succeeded' : 'failed', output: tail(res.output), error: res.error }
}
