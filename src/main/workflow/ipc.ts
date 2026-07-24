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
}
const ok = (data?: any) => ({ success: true, data })
const err = (e: string) => ({ success: false, error: e })

export function registerWorkflowIpc(ipcMain: { handle: (ch: string, fn: (ev: any, arg: any) => any) => void }, getWindow: () => any, w: Wiring) {
  const depsByRun = new Map<string, EngineDeps>()
  ipcMain.handle('workflow:list', async (_e, { cwd }) => { try { return ok(listWorkflows(workflowsDir(cwd), w.fs)) } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:read', async (_e, { cwd, id }) => { const r = readWorkflow(workflowsDir(cwd), id, w.fs); return r.ok ? ok(r.workflow) : err(r.errors.join('; ')) })
  ipcMain.handle('workflow:save', async (_e, { cwd, workflow }) => { try { writeWorkflow(workflowsDir(cwd), workflow, w.fs); return ok() } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:delete', async (_e, { cwd, id }) => { try { deleteWorkflow(workflowsDir(cwd), id, w.fs); return ok() } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:run', async (_e, { cwd, id }) => {
    if (!w.isTrusted(cwd)) return err('workspace not trusted — trust it before running workflows')
    const r = readWorkflow(workflowsDir(cwd), id, w.fs); if (!r.ok || !r.workflow) return err(r.errors.join('; '))
    const runId = w.newRunId()
    const emit = (ev: WorkflowRunEvent) => getWindow()?.webContents.send('workflow:run-event', ev)
    const deps = w.makeDeps(emit, runId)
    depsByRun.set(runId, deps)
    Promise.resolve(w.engine.runWorkflow(r.workflow, deps))
      .then((run) => { try { appendRunHistory(runsDir(cwd), run, w.fs) } catch { /* history is best-effort */ } })
      .catch(() => { /* engine already emitted a terminal event */ })
      .finally(() => depsByRun.delete(runId))
    return ok({ runId })
  })
  ipcMain.handle('workflow:cancel', async (_e, { runId }) => { const d = depsByRun.get(runId); if (d) w.engine.cancelRun(runId, d); return ok() })
}
