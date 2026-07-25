import { describe, it, expect, vi } from 'vitest'
import {
  executeControlStep,
  executeCommandStep,
  executeAgentStep,
  executeSkillStep,
} from '../../src/main/workflow/executors'
import type { ExprScope } from '../../src/main/workflow/workflowExpr'
import type { ControlStep, CommandStep, AgentStep, SkillStep } from '../../src/renderer/src/types'

// ---------------------------------------------------------------------------
// v1.32.1 — every executor must see the run's ExprScope, and a step with no
// explicit cwd must fall back to the project the run is standing in. That
// fallback is what lets ONE global workflow definition operate on whichever
// repo the user is in; without it a global workflow would run against the
// process cwd and quietly touch the wrong tree.
// ---------------------------------------------------------------------------

const timer = { sleep: vi.fn(async () => {}) }

const scope: ExprScope = {
  inputs: { target: 'prod', script: 'deploy.sh' },
  project: { cwd: '/repos/alpha', name: 'alpha', branch: 'main' },
}

function fakeTerminal(result = { exitCode: 0, output: '' }, spy?: (s: any) => void) {
  return {
    run: vi.fn(async (spec: any) => {
      spy?.(spec)
      return result
    }),
    cancel: vi.fn(),
  }
}

describe('command executor — project cwd fallback', () => {
  const step: CommandStep = { id: 'c', type: 'command', name: 'run', source: 'inline', command: 'echo hi' }

  it('a step with no cwd runs in the project the run is standing in', async () => {
    let seen: any
    await executeCommandStep(step, {}, fakeTerminal(undefined, s => (seen = s)) as any, undefined, scope)
    expect(seen.cwd).toBe('/repos/alpha')
  })

  it('an explicit cwd wins over the project fallback', async () => {
    let seen: any
    await executeCommandStep({ ...step, cwd: '/elsewhere' }, {}, fakeTerminal(undefined, s => (seen = s)) as any, undefined, scope)
    expect(seen.cwd).toBe('/elsewhere')
  })

  it('an explicit cwd is itself interpolated', async () => {
    let seen: any
    await executeCommandStep({ ...step, cwd: '${project.cwd}/sub' }, {}, fakeTerminal(undefined, s => (seen = s)) as any, undefined, scope)
    expect(seen.cwd).toBe('/repos/alpha/sub')
  })

  it('a cwd that interpolates to nothing falls back to the project', async () => {
    let seen: any
    await executeCommandStep({ ...step, cwd: '${inputs.missing}' }, {}, fakeTerminal(undefined, s => (seen = s)) as any, undefined, scope)
    expect(seen.cwd).toBe('/repos/alpha')
  })

  it('a whitespace-only cwd falls back to the project rather than running in ""', async () => {
    let seen: any
    await executeCommandStep({ ...step, cwd: '   ' }, {}, fakeTerminal(undefined, s => (seen = s)) as any, undefined, scope)
    expect(seen.cwd).toBe('/repos/alpha')
  })

  it('with no scope at all the cwd stays empty — the old behaviour is unchanged', async () => {
    let seen: any
    await executeCommandStep(step, {}, fakeTerminal(undefined, s => (seen = s)) as any)
    expect(seen.cwd).toBe('')
  })

  it('the command line is interpolated from inputs', async () => {
    let seen: any
    const wf: CommandStep = { ...step, command: 'deploy ${inputs.target}' }
    await executeCommandStep(wf, {}, fakeTerminal(undefined, s => (seen = s)) as any, undefined, scope)
    expect(seen.command).toContain('deploy prod')
  })

  it('a script path is interpolated too, so one workflow can target per-project scripts', async () => {
    let seen: any
    const wf: CommandStep = { id: 'c', type: 'command', name: 'f', source: 'file', scriptPath: 'scripts/${inputs.script}', shell: 'bash' }
    await executeCommandStep(wf, {}, fakeTerminal(undefined, s => (seen = s)) as any, undefined, scope)
    expect(JSON.stringify(seen)).toContain('scripts/deploy.sh')
  })

  it('the same step run in two projects lands in two different directories', async () => {
    const seen: string[] = []
    const beta: ExprScope = { project: { cwd: '/repos/beta', name: 'beta' } }
    await executeCommandStep(step, {}, fakeTerminal(undefined, s => seen.push(s.cwd)) as any, undefined, scope)
    await executeCommandStep(step, {}, fakeTerminal(undefined, s => seen.push(s.cwd)) as any, undefined, beta)
    expect(seen).toEqual(['/repos/alpha', '/repos/beta'])
  })
})

describe('agent executor — scope', () => {
  const step: AgentStep = { id: 'a', type: 'agent', name: 'ask', agent: 'claude', prompt: 'review ${inputs.target}' }

  it('the prompt is interpolated from inputs', async () => {
    let seen: any
    const agent = { run: vi.fn(async (s: any) => { seen = s; return { exitCode: 0, output: '' } }), cancel: vi.fn() }
    await executeAgentStep(step, {}, agent as any, undefined, scope)
    expect(JSON.stringify(seen)).toContain('review prod')
  })

  it('an agent step with no cwd runs in the project the run is standing in', async () => {
    let seen: any
    const agent = { run: vi.fn(async (s: any) => { seen = s; return { exitCode: 0, output: '' } }), cancel: vi.fn() }
    await executeAgentStep(step, {}, agent as any, undefined, scope)
    expect(seen.cwd).toBe('/repos/alpha')
  })

  it('an explicit agent cwd still wins', async () => {
    let seen: any
    const agent = { run: vi.fn(async (s: any) => { seen = s; return { exitCode: 0, output: '' } }), cancel: vi.fn() }
    await executeAgentStep({ ...step, cwd: '/pinned' }, {}, agent as any, undefined, scope)
    expect(seen.cwd).toBe('/pinned')
  })
})

describe('skill executor — scope', () => {
  it('skill arguments are interpolated from inputs', async () => {
    let seen: any
    const step: SkillStep = { id: 's', type: 'skill', name: 'call', tool: 'code_search', args: { query: '${inputs.target}', limit: 5 } }
    const tools = { invoke: vi.fn(async (_n: string, a: any) => { seen = a; return { ok: true, output: '' } }) }
    await executeSkillStep(step, {}, tools as any, scope)
    expect(seen).toEqual({ query: 'prod', limit: 5 })
  })
})

describe('control executor — scope', () => {
  it('a branch condition can gate on an input', async () => {
    const step: ControlStep = { id: 'b', type: 'control', name: 'br', action: 'branch', config: { condition: 'inputs.target == prod', goto: 'ship' } }
    const r = await executeControlStep(step, {}, timer, () => {}, scope)
    expect(r.goto).toBe('ship')
  })

  it('the same branch does not fire for a different input value', async () => {
    const step: ControlStep = { id: 'b', type: 'control', name: 'br', action: 'branch', config: { condition: 'inputs.target == prod', goto: 'ship' } }
    const staging: ExprScope = { inputs: { target: 'staging' } }
    const r = await executeControlStep(step, {}, timer, () => {}, staging)
    expect(r.goto).toBeUndefined()
  })

  it('a branch can gate on the project branch, so one workflow behaves per repo', async () => {
    const step: ControlStep = { id: 'b', type: 'control', name: 'br', action: 'branch', config: { condition: 'project.branch == main', goto: 'release' } }
    expect((await executeControlStep(step, {}, timer, () => {}, scope)).goto).toBe('release')
    const featureScope: ExprScope = { project: { cwd: '/x', name: 'x', branch: 'feature/login' } }
    expect((await executeControlStep(step, {}, timer, () => {}, featureScope)).goto).toBeUndefined()
  })

  it('a notify message is interpolated from the project context', async () => {
    const emit = vi.fn()
    const step: ControlStep = { id: 'n', type: 'control', name: 'note', action: 'notify', config: { message: 'done in ${project.name}' } }
    await executeControlStep(step, {}, timer, emit, scope)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ chunk: 'done in alpha' }))
  })
})
