import type { Workflow } from '../../renderer/src/types'
import type { EngineDeps, WorkflowRunEvent } from './contracts'
import type { FsLike } from './workflowStore'
import { listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, workflowsDir, runsDir, appendRunHistory } from './workflowStore'

type Engine = { runWorkflow: (wf: Workflow, d: EngineDeps) => Promise<any>; cancelRun: (id: string, d: EngineDeps) => void }
type Wiring = {
  fs: FsLike
  engine: Engine
  isTrusted: (cwd: string) => boolean
  newRunId: () => string
  makeDeps: (emit: (e: WorkflowRunEvent) => void, runId: string) => EngineDeps
  /** Called after a workflow is saved or deleted so the trigger supervisor can
   *  re-arm that project. Optional so tests can wire the IPC without it. */
  onWorkflowsChanged?: (cwd: string) => void
  /** Called when the renderer reports which project directory it's showing. */
  onWatchProject?: (cwd: string) => void
}
const ok = (data?: any) => ({ success: true, data })
const err = (e: string) => ({ success: false, error: e })

export type StartRunResult = { ok: true; runId: string; done: Promise<void> } | { ok: false; error: string }

export function registerWorkflowIpc(ipcMain: { handle: (ch: string, fn: (ev: any, arg: any) => any) => void }, getWindow: () => any, w: Wiring) {
  const depsByRun = new Map<string, EngineDeps>()

  // The single entry point into the engine. Both the renderer's Run button and
  // the trigger supervisor go through here, so an automatic run is identical to
  // a manual one — same trust gate, same events, same run history.
  const startRun = (cwd: string, id: string): StartRunResult => {
    if (!w.isTrusted(cwd)) return { ok: false, error: 'workspace not trusted — trust it before running workflows' }
    const r = readWorkflow(workflowsDir(cwd), id, w.fs)
    if (!r.ok || !r.workflow) return { ok: false, error: r.errors.join('; ') }
    const runId = w.newRunId()
    const emit = (ev: WorkflowRunEvent) => getWindow()?.webContents.send('workflow:run-event', ev)
    const deps = w.makeDeps(emit, runId)
    depsByRun.set(runId, deps)
    const done = Promise.resolve(w.engine.runWorkflow(r.workflow, deps))
      .then((run) => { try { appendRunHistory(runsDir(cwd), run, w.fs) } catch { /* history is best-effort */ } })
      .catch(() => { /* engine already emitted a terminal event */ })
      .finally(() => depsByRun.delete(runId))
    return { ok: true, runId, done }
  }

  ipcMain.handle('workflow:list', async (_e, { cwd }) => { try { return ok(listWorkflows(workflowsDir(cwd), w.fs)) } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:read', async (_e, { cwd, id }) => { const r = readWorkflow(workflowsDir(cwd), id, w.fs); return r.ok ? ok(r.workflow) : err(r.errors.join('; ')) })
  ipcMain.handle('workflow:save', async (_e, { cwd, workflow }) => {
    try { writeWorkflow(workflowsDir(cwd), workflow, w.fs); w.onWorkflowsChanged?.(cwd); return ok() } catch (e: any) { return err(e.message) }
  })
  ipcMain.handle('workflow:delete', async (_e, { cwd, id }) => {
    try { deleteWorkflow(workflowsDir(cwd), id, w.fs); w.onWorkflowsChanged?.(cwd); return ok() } catch (e: any) { return err(e.message) }
  })
  ipcMain.handle('workflow:run', async (_e, { cwd, id }) => {
    const r = startRun(cwd, id)
    return r.ok ? ok({ runId: r.runId }) : err(r.error)
  })
  ipcMain.handle('workflow:cancel', async (_e, { runId }) => { const d = depsByRun.get(runId); if (d) w.engine.cancelRun(runId, d); return ok() })
  // The renderer owns "which project am I looking at" (active terminal cwd, else
  // first terminal, else home) — it tells us so triggers arm for that project.
  ipcMain.handle('workflow:watch-project', async (_e, { cwd }) => { try { if (cwd) w.onWatchProject?.(cwd); return ok() } catch (e: any) { return err(e.message) } })

  return { startRun }
}
