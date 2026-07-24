import { describe, it, expect } from 'vitest'
import {
  validateWorkflow, serializeWorkflow, parseWorkflow,
  listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, workflowsDir,
  runsDir, appendRunHistory,
} from '../../src/main/workflow/workflowStore'
import type { Workflow } from '../../src/renderer/src/types'

const WF: Workflow = {
  id: 'demo', name: 'Demo', version: 1, trigger: { type: 'manual' },
  steps: [
    { id: 'a', type: 'command', name: 'echo', source: 'inline', command: 'echo hi' },
    { id: 'b', type: 'control', name: 'note', action: 'notify', config: { message: 'done' }, when: 'steps.a.ok' },
  ],
}

describe('validateWorkflow', () => {
  it('accepts a well-formed workflow', () => {
    expect(validateWorkflow(WF).ok).toBe(true)
  })
  it('rejects missing id/steps and unknown step type', () => {
    expect(validateWorkflow({ name: 'x' }).ok).toBe(false)
    expect(validateWorkflow({ ...WF, steps: [{ id: 'z', type: 'nope', name: 'z' }] }).ok).toBe(false)
  })
  it('rejects duplicate step ids', () => {
    const dup = { ...WF, steps: [WF.steps[0], { ...WF.steps[0] }] }
    expect(validateWorkflow(dup).ok).toBe(false)
  })
  it('rejects a workflow id with path-traversal / separators', () => {
    for (const bad of ['../evil', 'a/b', '..\\evil', '.hidden', 'a.b', 'has space']) {
      expect(validateWorkflow({ ...WF, id: bad }).ok).toBe(false)
    }
    expect(validateWorkflow({ ...WF, id: 'good-id_1' }).ok).toBe(true)
  })
  it('rejects invalid per-type enums (command.source / agent.agent / control.action)', () => {
    expect(validateWorkflow({ ...WF, steps: [{ id: 'a', type: 'command', name: 'a', source: 'weird' }] }).ok).toBe(false)
    expect(validateWorkflow({ ...WF, steps: [{ id: 'a', type: 'agent', name: 'a', agent: 'qwen', prompt: 'x' }] }).ok).toBe(false)
    expect(validateWorkflow({ ...WF, steps: [{ id: 'a', type: 'control', name: 'a', action: 'explode', config: {} }] }).ok).toBe(false)
  })
})

describe('serialize/parse round-trip', () => {
  it('parse(serialize(wf)) deep-equals wf', () => {
    const round = parseWorkflow(serializeWorkflow(WF))
    expect(round.ok).toBe(true)
    expect(round.workflow).toEqual(WF)
  })
  it('malformed YAML -> ok:false, no throw', () => {
    const r = parseWorkflow('id: : : nope\n  - broken')
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

describe('fs CRUD (injected fake fs)', () => {
  function makeFs() {
    const files = new Map<string, string>()
    return {
      files,
      fs: {
        existsSync: (p: string) => files.has(p) || p.endsWith('workflows'),
        mkdirSync: () => {},
        readdirSync: (_d: string) => [...files.keys()].map(k => k.split(/[\\/]/).pop()!),
        readFileSync: (p: string) => files.get(p)!,
        writeFileSync: (p: string, d: string) => { files.set(p, d) },
        appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) || '') + d) },
        rmSync: (p: string) => { files.delete(p) },
      } as any,
    }
  }
  it('write then list then read then delete', () => {
    const { fs, files } = makeFs()
    const dir = workflowsDir('/repo')
    writeWorkflow(dir, WF, fs)
    expect([...files.keys()][0]).toContain('demo.yml')
    expect(listWorkflows(dir, fs)).toEqual([{ id: 'demo', name: 'Demo' }])
    expect(readWorkflow(dir, 'demo', fs).workflow).toEqual(WF)
    deleteWorkflow(dir, 'demo', fs)
    expect(files.size).toBe(0)
  })
  it('writeWorkflow refuses to persist an invalid workflow (main never trusts the renderer)', () => {
    const { fs, files } = makeFs()
    expect(() => writeWorkflow(workflowsDir('/repo'), { id: 'x' } as any, fs)).toThrow(/invalid workflow/)
    expect(files.size).toBe(0)
  })
  it('read/delete refuse a path-traversal id (no escape from the workflows dir)', () => {
    const { fs, files } = makeFs()
    const dir = workflowsDir('/repo')
    files.set('/repo/secret.yml', 'id: secret') // a file OUTSIDE the workflows dir
    expect(readWorkflow(dir, '../../secret', fs).ok).toBe(false)
    expect(() => deleteWorkflow(dir, '../../secret', fs)).toThrow(/unsafe/)
    expect(files.has('/repo/secret.yml')).toBe(true) // untouched
  })
  it('appendRunHistory appends one JSONL line per run', () => {
    const { fs, files } = makeFs()
    const dir = runsDir('/repo')
    const run = { runId: 'r1', workflowId: 'demo', status: 'succeeded', steps: [], startedAt: 1, endedAt: 2 } as any
    appendRunHistory(dir, run, fs)
    appendRunHistory(dir, run, fs)
    const key = [...files.keys()].find(k => k.endsWith('demo.jsonl'))!
    expect(files.get(key)!.trim().split('\n').length).toBe(2)
  })
})
