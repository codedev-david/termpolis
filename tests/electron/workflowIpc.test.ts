import { describe, it, expect, vi } from 'vitest'
import { registerWorkflowIpc, resolveInputs } from '../../src/main/workflow/ipc'

const USER_DATA = '/userdata'

function harness({ trusted = true, engine: engineOver }: { trusted?: boolean; engine?: any } = {}) {
  const handlers = new Map<string, Function>()
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn) }
  const sent: any[] = []
  const win = { webContents: { send: (ch: string, e: any) => sent.push({ ch, e }) } }
  const files = new Map<string, string>()
  // Dir-AWARE fake fs. A `readdirSync` that ignores its argument would make the
  // project and global stores indistinguishable and silently double every list.
  const dirs = new Set<string>()
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const under = (p: string) => norm(p) + '/'
  const fs = {
    existsSync: (p: string) => files.has(p) || dirs.has(norm(p)) || [...files.keys()].some(k => norm(k).startsWith(under(p))),
    mkdirSync: (p: string) => { dirs.add(norm(p)) },
    readdirSync: (d: string) => [...files.keys()]
      .filter(k => norm(k).startsWith(under(d)) && !norm(k).slice(under(d).length).includes('/'))
      .map(k => norm(k).split('/').pop()!),
    readFileSync: (p: string) => files.get(p)!, writeFileSync: (p: string, d: string) => files.set(p, d),
    appendFileSync: (p: string, d: string) => files.set(p, (files.get(p) || '') + d),
    rmSync: (p: string) => files.delete(p),
  }
  const engine = engineOver ?? { runWorkflow: vi.fn(async (wf: any, deps: any) => { deps.emit({ type: 'run:finished', runId: 'r', status: 'succeeded', at: 1 }); return { runId: 'r', status: 'succeeded', workflowId: wf.id, steps: [], startedAt: 0 } }), cancelRun: vi.fn() }
  const changed: string[] = []
  const changedScopes: string[] = []
  const watched: string[] = []
  const api = registerWorkflowIpc(ipcMain as any, () => win as any, {
    fs: fs as any, engine,
    isTrusted: () => trusted,
    newRunId: () => 'r',
    userDataDir: USER_DATA,
    makeDeps: (emit) => ({ emit }) as any,
    onWorkflowsChanged: (cwd: string, scope: string) => { changed.push(cwd); changedScopes.push(scope) },
    onWatchProject: (cwd: string) => watched.push(cwd),
  })
  return { call: (ch: string, arg: any) => handlers.get(ch)!(null, arg), sent, files, changed, changedScopes, watched, handlers, api, engine }
}

describe('workflow IPC', () => {
  it('save then list then read', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    expect((await h.call('workflow:save', { cwd: '/r', workflow: wf })).success).toBe(true)
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([{ id: 'x', name: 'X', scope: 'project' }])
    expect((await h.call('workflow:read', { cwd: '/r', id: 'x' })).data.id).toBe('x')
  })
  it('run returns the runId and forwards emitted events to the window', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    const res = await h.call('workflow:run', { cwd: '/r', id: 'x' })
    expect(res.data.runId).toBe('r')
    expect(h.sent.some(m => m.ch === 'workflow:run-event' && m.e.type === 'run:finished')).toBe(true)
  })
  it('run on an untrusted workspace is refused', async () => {
    const h = harness({ trusted: false })
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    const res = await h.call('workflow:run', { cwd: '/r', id: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/trust/i)
  })
  it('a finished run is appended to history', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    await h.call('workflow:run', { cwd: '/r', id: 'x' })
    await new Promise((r) => setTimeout(r, 0)) // let the engine promise + history append settle
    expect([...h.files.keys()].some((k) => k.endsWith('x.jsonl'))).toBe(true)
  })
  it('delete removes a saved workflow', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    expect((await h.call('workflow:delete', { cwd: '/r', id: 'x' })).success).toBe(true)
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([])
  })
  it('cancel forwards to the engine while a run is still in flight', async () => {
    // Park the engine on a gate so the run stays registered in depsByRun; cancel
    // must then look it up and delegate to engine.cancelRun (the `if (d)` branch).
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const engine = {
      runWorkflow: vi.fn(async () => { await gate; return { runId: 'r', status: 'cancelled', workflowId: 'x', steps: [], startedAt: 0 } }),
      cancelRun: vi.fn(),
    }
    const h = harness({ engine })
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    await h.call('workflow:run', { cwd: '/r', id: 'x' }) // fire-and-forget; engine parks on the gate
    const res = await h.call('workflow:cancel', { runId: 'r' })
    expect(res.success).toBe(true)
    expect(engine.cancelRun).toHaveBeenCalledWith('r', expect.anything())
    release()
  })
  it('cancel of an unknown runId is a harmless success (no engine call)', async () => {
    const h = harness()
    const res = await h.call('workflow:cancel', { runId: 'nope' })
    expect(res.success).toBe(true)
  })
  it('read of a missing id returns an error envelope (never throws)', async () => {
    const h = harness()
    const res = await h.call('workflow:read', { cwd: '/r', id: 'ghost' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/)
  })
  it('run of a missing id (trusted) is refused before the engine starts', async () => {
    const engine = { runWorkflow: vi.fn(), cancelRun: vi.fn() }
    const h = harness({ engine })
    const res = await h.call('workflow:run', { cwd: '/r', id: 'ghost' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/)
    expect(engine.runWorkflow).not.toHaveBeenCalled()
  })
  it('a rejected engine run is swallowed by the handler (no unhandled rejection)', async () => {
    // The run handler returns the runId synchronously and attaches a .catch so an
    // engine that throws cannot surface an unhandled rejection or crash the main process.
    const engine = {
      runWorkflow: vi.fn(async () => { throw new Error('engine blew up') }),
      cancelRun: vi.fn(),
    }
    const h = harness({ engine })
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    await h.call('workflow:save', { cwd: '/r', workflow: wf })
    const res = await h.call('workflow:run', { cwd: '/r', id: 'x' })
    expect(res.success).toBe(true)
    await new Promise((r) => setTimeout(r, 0)) // let the rejected promise settle through .catch/.finally
    expect(engine.runWorkflow).toHaveBeenCalled()
  })
})

describe('workflow IPC — trigger wiring', () => {
  const wf = (id = 'x') => ({ id, name: 'X', version: 1, trigger: { type: 'schedule', config: { cron: '@daily' } }, steps: [] })

  it('save and delete tell the supervisor to re-arm that project', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: wf() })
    expect(h.changed).toEqual(['/r'])
    await h.call('workflow:delete', { cwd: '/r', id: 'x' })
    expect(h.changed).toEqual(['/r', '/r'])
  })

  it('a failed save does not re-arm', async () => {
    const h = harness()
    const res = await h.call('workflow:save', { cwd: '/r', workflow: { id: 'bad!', name: 'B', version: 1, trigger: { type: 'manual' }, steps: [] } })
    expect(res.success).toBe(false)
    expect(h.changed).toEqual([])
  })

  it('watch-project forwards the cwd the renderer is showing', async () => {
    const h = harness()
    expect((await h.call('workflow:watch-project', { cwd: '/r' })).success).toBe(true)
    expect(h.watched).toEqual(['/r'])
  })

  it('watch-project with no cwd is a harmless no-op', async () => {
    const h = harness()
    expect((await h.call('workflow:watch-project', { cwd: '' })).success).toBe(true)
    expect(h.watched).toEqual([])
  })

  it('watch-project reports a throwing supervisor instead of crashing the handler', async () => {
    const handlers = new Map<string, Function>()
    const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn) }
    registerWorkflowIpc(ipcMain as any, () => null as any, {
      fs: { existsSync: () => false, mkdirSync: () => {}, readdirSync: () => [], readFileSync: () => '', writeFileSync: () => {}, appendFileSync: () => {}, rmSync: () => {} } as any,
      engine: { runWorkflow: vi.fn(), cancelRun: vi.fn() },
      isTrusted: () => true,
      newRunId: () => 'r',
      userDataDir: USER_DATA,
      makeDeps: (emit) => ({ emit }) as any,
      onWatchProject: () => { throw new Error('supervisor exploded') },
    })
    const res = await handlers.get('workflow:watch-project')!(null, { cwd: '/r' })
    expect(res).toEqual({ success: false, error: 'supervisor exploded' })
  })

  it('the IPC layer wires the ipc channels the preload calls', () => {
    const h = harness()
    for (const ch of ['workflow:list', 'workflow:read', 'workflow:save', 'workflow:delete', 'workflow:run', 'workflow:cancel', 'workflow:watch-project']) {
      expect(h.handlers.has(ch)).toBe(true)
    }
  })

  it('exposes startRun so an automatic trigger takes exactly the manual path', async () => {
    const h = harness()
    await h.call('workflow:save', { cwd: '/r', workflow: wf() })
    const r = h.api.startRun('/r', 'x')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.runId).toBe('r')
    await r.done
    expect(h.engine.runWorkflow).toHaveBeenCalled()
    // Same run-history side effect as a manual run.
    expect([...h.files.keys()].some((k) => k.endsWith('x.jsonl'))).toBe(true)
    // Same run events reach the window.
    expect(h.sent.some((s) => s.ch === 'workflow:run-event')).toBe(true)
  })

  it('startRun refuses an untrusted workspace', () => {
    const h = harness({ trusted: false })
    const r = h.api.startRun('/r', 'x')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error).toMatch(/trust/i)
  })

  it('startRun reports a missing workflow rather than throwing', () => {
    const h = harness()
    const r = h.api.startRun('/r', 'nope')
    expect(r.ok).toBe(false)
  })

  it('startRun resolves `done` even when the engine rejects', async () => {
    const engine = { runWorkflow: vi.fn().mockRejectedValue(new Error('engine blew up')), cancelRun: vi.fn() }
    const h = harness({ engine })
    await h.call('workflow:save', { cwd: '/r', workflow: wf() })
    const r = h.api.startRun('/r', 'x')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    await expect(r.done).resolves.toBeUndefined()
  })
})
