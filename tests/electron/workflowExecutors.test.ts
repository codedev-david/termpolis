import { describe, it, expect, vi } from 'vitest'
import { executeControlStep, executeCommandStep, executeAgentStep, executeSkillStep } from '../../src/main/workflow/executors'
import type { ControlStep, CommandStep, AgentStep, SkillStep, StepResult } from '../../src/renderer/src/types'

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

function fakeTerminal(result: { exitCode: number; output: string; timedOut?: boolean }, spy?: (s: any) => void) {
  return { run: vi.fn(async (spec: any) => { spy?.(spec); return result }), cancel: vi.fn() }
}
const base: CommandStep = { id: 'c', type: 'command', name: 'run', source: 'inline', command: 'echo hi' }

describe('command executor', () => {
  it('exit 0 -> succeeded with output', async () => {
    const term = fakeTerminal({ exitCode: 0, output: 'hi' })
    const r = await executeCommandStep(base, {}, term as any)
    expect(r.status).toBe('succeeded'); expect(r.exitCode).toBe(0); expect(r.output).toBe('hi')
  })
  it('exit != 0 -> failed', async () => {
    const term = fakeTerminal({ exitCode: 2, output: 'err' })
    const r = await executeCommandStep(base, {}, term as any)
    expect(r.status).toBe('failed'); expect(r.exitCode).toBe(2)
  })
  it('timedOut -> failed with error', async () => {
    const term = fakeTerminal({ exitCode: 124, output: '', timedOut: true })
    const r = await executeCommandStep({ ...base, timeoutMs: 10 }, {}, term as any)
    expect(r.status).toBe('failed'); expect(r.error).toMatch(/timed out/i)
  })
  it('interpolates ${steps.*} into the command before running', async () => {
    let seen: any; const term = fakeTerminal({ exitCode: 0, output: '' }, s => (seen = s))
    await executeCommandStep({ ...base, command: 'deploy ${steps.build.output}' }, { build: { stepId: 'build', status: 'succeeded', output: 'v9', exitCode: 0 } }, term as any)
    expect(seen.command).toBe('deploy v9')
  })
  it('source:file runs the script via the shell (bash script.sh)', async () => {
    let seen: any; const term = fakeTerminal({ exitCode: 0, output: '' }, s => (seen = s))
    await executeCommandStep({ id: 'c', type: 'command', name: 'f', source: 'file', scriptPath: 'scripts/x.sh', shell: 'bash' }, {}, term as any)
    expect(seen.command).toContain('scripts/x.sh')
    expect(seen.shell).toBe('bash')
  })
  it('source:file infers python for .py', async () => {
    let seen: any; const term = fakeTerminal({ exitCode: 0, output: '' }, s => (seen = s))
    await executeCommandStep({ id: 'c', type: 'command', name: 'f', source: 'file', scriptPath: 'etl.py' }, {}, term as any)
    expect(seen.command).toBe('python etl.py')
  })
  it('caps captured output at 32KB (tail)', async () => {
    const big = 'x'.repeat(40_000)
    const term = fakeTerminal({ exitCode: 0, output: big })
    const r = await executeCommandStep(base, {}, term as any)
    expect(r.output.length).toBe(32_768)
  })
})

const A: AgentStep = { id: 'g', type: 'agent', name: 'ask', agent: 'claude', prompt: 'fix ${steps.test.output}' }

describe('agent executor', () => {
  it('ok:true -> succeeded, prompt interpolated', async () => {
    let seen: any
    const agent = { run: vi.fn(async (s: any) => { seen = s; return { output: 'patched', ok: true } }), cancel: vi.fn() }
    const r = await executeAgentStep(A, { test: { stepId: 'test', status: 'failed', exitCode: 1, output: 'boom' } }, agent as any)
    expect(seen.prompt).toBe('fix boom')
    expect(r.status).toBe('succeeded'); expect(r.output).toBe('patched')
  })
  it('ok:false -> failed with error', async () => {
    const agent = { run: vi.fn(async () => ({ output: '', ok: false, error: 'timeout after 900000ms' })), cancel: vi.fn() }
    const r = await executeAgentStep(A, {}, agent as any)
    expect(r.status).toBe('failed'); expect(r.error).toMatch(/timeout/)
  })
  it('passes idleMs/timeoutMs/doneMarker through to the runner', async () => {
    let seen: any
    const agent = { run: vi.fn(async (s: any) => { seen = s; return { output: '', ok: true } }), cancel: vi.fn() }
    await executeAgentStep({ ...A, idleMs: 3000, timeoutMs: 60000, doneMarker: '<<DONE>>' }, {}, agent as any)
    expect(seen).toMatchObject({ idleMs: 3000, timeoutMs: 60000, doneMarker: '<<DONE>>', agent: 'claude' })
  })
})

describe('skill executor', () => {
  it('invokes the tool with interpolated string args and captures output', async () => {
    let seen: any
    const tools = { invoke: vi.fn(async (tool: string, args: any) => { seen = { tool, args }; return { output: '3 hits', ok: true } }) }
    const step: SkillStep = { id: 's', type: 'skill', name: 'search', tool: 'memory_search', args: { query: 'about ${steps.a.output}', limit: 5 } }
    const r = await executeSkillStep(step, { a: { stepId: 'a', status: 'succeeded', output: 'X', exitCode: 0 } }, tools as any)
    expect(seen.tool).toBe('memory_search')
    expect(seen.args).toEqual({ query: 'about X', limit: 5 })
    expect(r.status).toBe('succeeded'); expect(r.output).toBe('3 hits')
  })
  it('tool error -> failed', async () => {
    const tools = { invoke: vi.fn(async () => ({ output: '', ok: false, error: 'no such tool' })) }
    const step: SkillStep = { id: 's', type: 'skill', name: 'x', tool: 'nope' }
    const r = await executeSkillStep(step, {}, tools as any)
    expect(r.status).toBe('failed'); expect(r.error).toBe('no such tool')
  })
})
