import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import { registerWorkflowIpc, resolveInputs } from '../../src/main/workflow/ipc'

// ---------------------------------------------------------------------------
// v1.32.1 — global workflow scope, sidebar categories and reusable inputs.
//
// The IPC layer is the only place that decides WHICH store a workflow lives in
// (project `<cwd>/.termpolis/workflows` vs global `<userData>/workflows`), so
// every scope-routing rule is pinned here against a dir-aware fake fs. A
// `readdirSync` that ignored its argument would make the two stores
// indistinguishable and silently double every list, so the fake models
// directories properly.
// ---------------------------------------------------------------------------

const USER_DATA = '/userdata'

function harness({ trusted = true, engine: engineOver }: { trusted?: boolean; engine?: any } = {}) {
  const handlers = new Map<string, Function>()
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn) }
  const sent: any[] = []
  const win = { webContents: { send: (ch: string, e: any) => sent.push({ ch, e }) } }
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const under = (p: string) => norm(p) + '/'
  const fs = {
    existsSync: (p: string) =>
      files.has(p) || dirs.has(norm(p)) || [...files.keys()].some(k => norm(k).startsWith(under(p))),
    mkdirSync: (p: string) => {
      dirs.add(norm(p))
    },
    readdirSync: (d: string) =>
      [...files.keys()]
        .filter(k => norm(k).startsWith(under(d)) && !norm(k).slice(under(d).length).includes('/'))
        .map(k => norm(k).split('/').pop()!),
    readFileSync: (p: string) => files.get(p)!,
    writeFileSync: (p: string, d: string) => files.set(p, d),
    appendFileSync: (p: string, d: string) => files.set(p, (files.get(p) || '') + d),
    rmSync: (p: string) => files.delete(p),
  }
  const engine =
    engineOver ?? {
      runWorkflow: vi.fn(async (wf: any, deps: any) => {
        deps.emit({ type: 'run:finished', runId: 'r', status: 'succeeded', at: 1 })
        return { runId: 'r', status: 'succeeded', workflowId: wf.id, steps: [], startedAt: 0 }
      }),
      cancelRun: vi.fn(),
    }
  const changed: string[] = []
  const changedScopes: string[] = []
  const api = registerWorkflowIpc(ipcMain as any, () => win as any, {
    fs: fs as any,
    engine,
    isTrusted: () => trusted,
    newRunId: () => 'r',
    userDataDir: USER_DATA,
    makeDeps: emit => ({ emit }) as any,
    onWorkflowsChanged: (cwd: string, scope: string) => {
      changed.push(cwd)
      changedScopes.push(scope)
    },
  })
  return {
    call: (ch: string, arg: any) => handlers.get(ch)!(null, arg),
    sent,
    files,
    changed,
    changedScopes,
    api,
    engine,
  }
}

const keyOf = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.keys()].map(k => k.replace(/\\/g, '/')).find(k => k.endsWith(suffix))

const lineOf = (files: Map<string, string>, suffix: string): any =>
  JSON.parse([...files.entries()].find(([k]) => k.replace(/\\/g, '/').endsWith(suffix))![1].trim())

const gwf = (over: any = {}) => ({
  id: 'g',
  name: 'Global one',
  version: 1,
  trigger: { type: 'manual' },
  steps: [],
  scope: 'global',
  ...over,
})
const pwf = (over: any = {}) => ({
  id: 'p',
  name: 'Project one',
  version: 1,
  trigger: { type: 'manual' },
  steps: [],
  scope: 'project',
  ...over,
})

describe('resolveInputs', () => {
  const withInputs = (inputs: any) =>
    ({ id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [], inputs }) as any

  it('a workflow with no inputs resolves to nothing missing', () => {
    expect(
      resolveInputs({ id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] } as any),
    ).toEqual({ values: {}, missing: [] })
  })

  it('falls back to each input default when nothing is supplied', () => {
    expect(resolveInputs(withInputs([{ name: 'branch', default: 'main' }]))).toEqual({
      values: { branch: 'main' },
      missing: [],
    })
  })

  it('a supplied value wins over the default', () => {
    const r = resolveInputs(withInputs([{ name: 'branch', default: 'main' }]), { branch: 'release' })
    expect(r.values.branch).toBe('release')
  })

  it('an optional input with neither value nor default resolves to empty, not missing', () => {
    expect(resolveInputs(withInputs([{ name: 'note' }]))).toEqual({ values: { note: '' }, missing: [] })
  })

  it('a required input with no value is reported missing', () => {
    expect(resolveInputs(withInputs([{ name: 'target', required: true }])).missing).toEqual(['target'])
  })

  it('a required input satisfied by its default is not missing', () => {
    const r = resolveInputs(withInputs([{ name: 'target', required: true, default: 'prod' }]))
    expect(r.missing).toEqual([])
    expect(r.values.target).toBe('prod')
  })

  it('a required input supplied as whitespace only is still missing', () => {
    const r = resolveInputs(withInputs([{ name: 'target', required: true }]), { target: '   ' })
    expect(r.missing).toEqual(['target'])
  })

  it('ignores supplied keys the workflow never declared', () => {
    const r = resolveInputs(withInputs([{ name: 'a' }]), { a: '1', bogus: 'x' })
    expect(r.values).toEqual({ a: '1' })
  })

  it('reports every missing required input, not just the first', () => {
    const r = resolveInputs(withInputs([{ name: 'a', required: true }, { name: 'b', required: true }]))
    expect(r.missing).toEqual(['a', 'b'])
  })
})

describe('workflow IPC — global scope', () => {
  it('a global workflow is written to the user-data store, not the project', async () => {
    const h = harness()
    expect((await h.call('workflow:save', { cwd: '/r', workflow: gwf() })).success).toBe(true)
    const keys = [...h.files.keys()].map(k => k.replace(/\\/g, '/'))
    expect(keys.some(k => k.startsWith(USER_DATA + '/workflows/'))).toBe(true)
    expect(keys.some(k => k.startsWith('/r/.termpolis/'))).toBe(false)
  })

  it('scope is never persisted into the YAML — it is derived from the directory', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    expect([...h.files.values()][0]).not.toMatch(/scope:/)
  })

  it('list returns global rows first, then the project rows, each tagged with its scope', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    await h.call('workflow:save', { cwd: '/r', workflow: pwf() })
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([
      { id: 'g', name: 'Global one', scope: 'global' },
      { id: 'p', name: 'Project one', scope: 'project' },
    ])
  })

  it('a global workflow is offered from a completely different project', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/repo-a', workflow: gwf() })
    expect((await h.call('workflow:list', { cwd: '/repo-b' })).data).toEqual([
      { id: 'g', name: 'Global one', scope: 'global' },
    ])
  })

  it('global workflows list even with no project directory at all', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    expect((await h.call('workflow:list', { cwd: '' })).data).toEqual([
      { id: 'g', name: 'Global one', scope: 'global' },
    ])
  })

  it('a project workflow does not leak into another project', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/repo-a', workflow: pwf() })
    expect((await h.call('workflow:list', { cwd: '/repo-b' })).data).toEqual([])
  })

  it('read honours the scope so a shared id resolves to the right file', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf({ id: 'same', name: 'Global copy' }) })
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ id: 'same', name: 'Project copy' }) })
    expect((await h.call('workflow:read', { cwd: '/r', id: 'same', scope: 'global' })).data.name).toBe('Global copy')
    expect((await h.call('workflow:read', { cwd: '/r', id: 'same', scope: 'project' })).data.name).toBe('Project copy')
  })

  it('read tags the returned workflow with the scope it came from', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    expect((await h.call('workflow:read', { cwd: '/r', id: 'g', scope: 'global' })).data.scope).toBe('global')
  })

  it('an omitted scope defaults to project — old callers keep working', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf() })
    expect((await h.call('workflow:read', { cwd: '/r', id: 'p' })).data.scope).toBe('project')
  })

  it('a nonsense scope string is treated as project, never as global', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf() })
    expect((await h.call('workflow:read', { cwd: '/r', id: 'p', scope: 'GLOBAL!!' })).data.scope).toBe('project')
  })

  it('delete honours the scope — deleting the project copy leaves the global one', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf({ id: 'same' }) })
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ id: 'same' }) })
    expect((await h.call('workflow:delete', { cwd: '/r', id: 'same', scope: 'project' })).success).toBe(true)
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([
      { id: 'same', name: 'Global one', scope: 'global' },
    ])
  })

  it('flipping the scope MOVES the workflow instead of leaving a duplicate', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ id: 'm', name: 'Mover' }) })
    await h.call('workflow:save', { cwd: '/r', workflow: gwf({ id: 'm', name: 'Mover' }), fromScope: 'project' })
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([
      { id: 'm', name: 'Mover', scope: 'global' },
    ])
  })

  it('a save with a matching fromScope is a plain overwrite, not a move', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ name: 'v1' }) })
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ name: 'v2' }), fromScope: 'project' })
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([
      { id: 'p', name: 'v2', scope: 'project' },
    ])
  })

  it('saving a global workflow reports the global scope so every project re-arms', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    expect(h.changedScopes).toEqual(['global'])
  })

  it('saving a project workflow reports the project scope', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf() })
    expect(h.changedScopes).toEqual(['project'])
  })

  it('a scope MOVE reports global so the vacated store is re-armed too', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf({ id: 'm' }) })
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ id: 'm' }), fromScope: 'global' })
    expect(h.changedScopes).toEqual(['global', 'global'])
  })

  it('deleting a global workflow reports the global scope', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    await h.call('workflow:delete', { cwd: '/r', id: 'g', scope: 'global' })
    expect(h.changedScopes).toEqual(['global', 'global'])
  })

  it('running a global workflow reads it from the global store', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    expect((await h.call('workflow:run', { cwd: '/r', id: 'g', scope: 'global' })).success).toBe(true)
    expect(h.engine.runWorkflow).toHaveBeenCalled()
  })

  it('running a global workflow without its scope fails — it is not in the project store', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    expect((await h.call('workflow:run', { cwd: '/r', id: 'g' })).success).toBe(false)
  })

  it('a global run lands in the global run history, not the project one', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    await h.call('workflow:run', { cwd: '/r', id: 'g', scope: 'global' })
    await new Promise(r => setTimeout(r, 0))
    expect(keyOf(h.files, 'g.jsonl')).toBe(USER_DATA + '/workflows/runs/g.jsonl')
  })

  it('a global run records the cwd it actually ran in', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf() })
    await h.call('workflow:run', { cwd: '/some/repo', id: 'g', scope: 'global' })
    await new Promise(r => setTimeout(r, 0))
    expect(lineOf(h.files, 'g.jsonl').cwd).toBe('/some/repo')
  })

  it('a project run of the same id keeps its own separate history file', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: gwf({ id: 'same' }) })
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ id: 'same' }) })
    await h.call('workflow:run', { cwd: '/r', id: 'same', scope: 'global' })
    await h.call('workflow:run', { cwd: '/r', id: 'same', scope: 'project' })
    await new Promise(r => setTimeout(r, 0))
    const hist = [...h.files.keys()].map(k => k.replace(/\\/g, '/')).filter(k => k.endsWith('same.jsonl'))
    expect(hist.sort()).toEqual(['/r/.termpolis/workflows/runs/same.jsonl', USER_DATA + '/workflows/runs/same.jsonl'])
  })

  it('an untrusted workspace refuses a global run too — scope is not a trust bypass', async () => {
    const h = harness({ trusted: false })
    const trusting = harness()
    await trusting.call('workflow:save', { cwd: '/r', workflow: gwf() })
    for (const [k, v] of trusting.files) h.files.set(k, v)
    const res = await h.call('workflow:run', { cwd: '/r', id: 'g', scope: 'global' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/trust/i)
  })
})

describe('workflow IPC — reusable inputs and project context', () => {
  const inputWf = (over: any = {}) =>
    pwf({
      id: 'i',
      name: 'Reusable',
      inputs: [{ name: 'target', required: true }, { name: 'note', default: 'hi' }],
      ...over,
    })

  it('a run missing a required input is refused with the input named', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: inputWf() })
    const res = await h.call('workflow:run', { cwd: '/r', id: 'i' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/target/)
    expect(h.engine.runWorkflow).not.toHaveBeenCalled()
  })

  it('supplied inputs reach the engine as expression scope', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: inputWf() })
    expect((await h.call('workflow:run', { cwd: '/r', id: 'i', inputs: { target: 'prod' } })).success).toBe(true)
    expect(h.engine.runWorkflow.mock.calls[0][1].scope.inputs).toEqual({ target: 'prod', note: 'hi' })
  })

  it('the engine scope carries the project the run is standing in', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/repos/termpolis', workflow: pwf() })
    await h.call('workflow:run', { cwd: '/repos/termpolis', id: 'p' })
    const scope = h.engine.runWorkflow.mock.calls[0][1].scope
    expect(scope.project.cwd).toBe('/repos/termpolis')
    expect(scope.project.name).toBe('termpolis')
  })

  it('the same global workflow run in two projects sees two different contexts', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/a', workflow: gwf() })
    await h.call('workflow:run', { cwd: '/repos/alpha', id: 'g', scope: 'global' })
    await h.call('workflow:run', { cwd: '/repos/beta', id: 'g', scope: 'global' })
    expect(h.engine.runWorkflow.mock.calls[0][1].scope.project.name).toBe('alpha')
    expect(h.engine.runWorkflow.mock.calls[1][1].scope.project.name).toBe('beta')
  })

  it('the run record stores the inputs it ran with', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: inputWf() })
    await h.call('workflow:run', { cwd: '/r', id: 'i', inputs: { target: 'prod' } })
    await new Promise(r => setTimeout(r, 0))
    expect(lineOf(h.files, 'i.jsonl').inputs).toEqual({ target: 'prod', note: 'hi' })
  })

  it('a branch is undefined outside a git repo rather than throwing', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf() })
    await h.call('workflow:run', { cwd: '/r', id: 'p' })
    expect(h.engine.runWorkflow.mock.calls[0][1].scope.project.branch).toBeUndefined()
  })

  it('the branch is read from the repo HEAD when there is one', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf() })
    // Written through the platform join so the key matches what headRef builds.
    h.files.set(join('/r/.git', 'HEAD'), 'ref: refs/heads/feature/login\n')
    await h.call('workflow:run', { cwd: '/r', id: 'p' })
    expect(h.engine.runWorkflow.mock.calls[0][1].scope.project.branch).toBe('feature/login')
  })

  it('a category survives a save/list round trip', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: pwf({ category: 'Release' }) })
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([
      { id: 'p', name: 'Project one', category: 'Release', scope: 'project' },
    ])
  })

  it('a workflow with a malformed input name is rejected at save', async () => {
    const h = harness()
    const res = await h.call('workflow:save', { cwd: '/r', workflow: pwf({ inputs: [{ name: '2bad' }] }) })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/input/i)
  })

  it('duplicate input names are rejected at save', async () => {
    const h = harness()
    const res = await h.call('workflow:save', {
      cwd: '/r',
      workflow: pwf({ inputs: [{ name: 'a' }, { name: 'a' }] }),
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/duplicate/i)
  })

  it('a non-string category is rejected at save', async () => {
    const h = harness()
    const res = await h.call('workflow:save', { cwd: '/r', workflow: pwf({ category: 7 }) })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/category/i)
  })
})
