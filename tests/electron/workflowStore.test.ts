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

describe('store edge cases', () => {
  const inlineFs = () => {
    const files = new Map<string, string>()
    return {
      files,
      fs: {
        existsSync: (p: string) => files.has(p) || p.endsWith('workflows'),
        mkdirSync: () => {},
        readdirSync: () => [...files.keys()].map(k => k.split(/[\\/]/).pop()!),
        readFileSync: (p: string) => files.get(p)!,
        writeFileSync: (p: string, d: string) => { files.set(p, d) },
        appendFileSync: () => {},
        rmSync: (p: string) => { files.delete(p) },
      } as any,
    }
  }
  it('flags a step that is missing its name (valid id + type, no name)', () => {
    const r = validateWorkflow({ ...WF, steps: [{ id: 'a', type: 'command', source: 'inline', command: 'x' }] })
    expect(r.ok).toBe(false)
    expect(r.errors).toContain('step a missing name')
  })
  it('listWorkflows ignores non-.yml files and unsafe/hostile file names', () => {
    const { fs, files } = inlineFs()
    const dir = workflowsDir('/repo')
    writeWorkflow(dir, WF, fs)                        // demo.yml — the only real workflow
    files.set(`${dir}/notes.txt`, 'not a workflow')  // wrong extension -> skipped (endsWith .yml)
    files.set(`${dir}/..evil.yml`, 'id: hax')         // unsafe id -> skipped, fileFor never throws
    expect(listWorkflows(dir, fs)).toEqual([{ id: 'demo', name: 'Demo' }])
  })
  it('readWorkflow returns not-found for a safe id with no file on disk', () => {
    const { fs } = inlineFs()
    const r = readWorkflow(workflowsDir('/repo'), 'ghostwf', fs)
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/not found/)
  })
  it('rejects a non-object workflow input (null / string)', () => {
    expect(validateWorkflow(null).ok).toBe(false)
    expect(validateWorkflow(null).errors).toContain('not an object')
    expect(validateWorkflow('nope').ok).toBe(false)
  })
  it('flags a step with a missing/non-string id and tolerates a null step entry', () => {
    const noId = validateWorkflow({ ...WF, steps: [{ type: 'command', name: 'a', source: 'inline', command: 'x' }] })
    expect(noId.ok).toBe(false)
    expect(noId.errors).toContain('step missing id')
    expect(validateWorkflow({ ...WF, steps: [null] }).ok).toBe(false) // !s guard, no throw
  })
  it('writeWorkflow creates the workflows dir when it does not yet exist', () => {
    const files = new Map<string, string>()
    let madeDir = ''
    const fs = {
      existsSync: (p: string) => files.has(p),           // dir absent -> triggers mkdir
      mkdirSync: (p: string) => { madeDir = p },
      writeFileSync: (p: string, d: string) => { files.set(p, d) },
      readdirSync: () => [], readFileSync: () => '', appendFileSync: () => {}, rmSync: () => {},
    } as any
    const dir = workflowsDir('/repo')
    writeWorkflow(dir, WF, fs)
    expect(madeDir).toBe(dir)
    expect([...files.keys()][0]).toContain('demo.yml')
  })
  it('listWorkflows returns [] when the workflows dir is absent', () => {
    const fs = { existsSync: () => false } as any
    expect(listWorkflows(workflowsDir('/repo'), fs)).toEqual([])
  })
  it('listWorkflows skips a .yml that fails to parse (never throws)', () => {
    const { fs, files } = inlineFs()
    const dir = workflowsDir('/repo')
    files.set(`${dir}/broken.yml`, 'id: : : nope\n  - broken') // safe id, unparseable body
    expect(listWorkflows(dir, fs)).toEqual([])                 // corrupt file skipped, not fatal
  })
})
