import { describe, it, expect, vi } from 'vitest'
import { registerWorkflowIpc } from '../../src/main/workflow/ipc'

function harness({ trusted = true, engine: engineOver }: { trusted?: boolean; engine?: any } = {}) {
  const handlers = new Map<string, Function>()
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn) }
  const sent: any[] = []
  const win = { webContents: { send: (ch: string, e: any) => sent.push({ ch, e }) } }
  const files = new Map<string, string>()
  const fs = {
    existsSync: (p: string) => files.has(p) || p.endsWith('workflows') || p.endsWith('runs'),
    mkdirSync: () => {}, readdirSync: () => [...files.keys()].map(k => k.split(/[\\/]/).pop()!),
    readFileSync: (p: string) => files.get(p)!, writeFileSync: (p: string, d: string) => files.set(p, d),
    appendFileSync: (p: string, d: string) => files.set(p, (files.get(p) || '') + d),
    rmSync: (p: string) => files.delete(p),
  }
  const engine = engineOver ?? { runWorkflow: vi.fn(async (wf: any, deps: any) => { deps.emit({ type: 'run:finished', runId: 'r', status: 'succeeded', at: 1 }); return { runId: 'r', status: 'succeeded', workflowId: wf.id, steps: [], startedAt: 0 } }), cancelRun: vi.fn() }
  registerWorkflowIpc(ipcMain as any, () => win as any, {
    fs: fs as any, engine,
    isTrusted: () => trusted,
    newRunId: () => 'r',
    makeDeps: (emit) => ({ emit }) as any,
  })
  return { call: (ch: string, arg: any) => handlers.get(ch)!(null, arg), sent, files }
}

describe('workflow IPC', () => {
  it('save then list then read', async () => {
    const h = harness()
    const wf = { id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [] }
    expect((await h.call('workflow:save', { cwd: '/r', workflow: wf })).success).toBe(true)
    expect((await h.call('workflow:list', { cwd: '/r' })).data).toEqual([{ id: 'x', name: 'X' }])
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
