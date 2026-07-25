import { basename } from 'path'
import type { Workflow, WorkflowScope } from '../../renderer/src/types'
import type { EngineDeps, WorkflowRunEvent, ExprScope } from './contracts'
import type { FsLike, WorkflowSummary } from './workflowStore'
import {
  listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow,
  workflowsDir, dirForScope, runsDirForScope, appendRunHistory,
} from './workflowStore'
import { gitDirOf, headRef } from './triggers'

type Engine = { runWorkflow: (wf: Workflow, d: EngineDeps) => Promise<any>; cancelRun: (id: string, d: EngineDeps) => void }
type Wiring = {
  fs: FsLike
  engine: Engine
  isTrusted: (cwd: string) => boolean
  newRunId: () => string
  makeDeps: (emit: (e: WorkflowRunEvent) => void, runId: string) => EngineDeps
  /** Root of the global (cross-project) store — `app.getPath('userData')`. */
  userDataDir: string
  /** Called after a workflow is saved or deleted so the trigger supervisor can
   *  re-arm. `scope` is 'global' when the change affects every watched project.
   *  Optional so tests can wire the IPC without it. */
  onWorkflowsChanged?: (cwd: string, scope: WorkflowScope) => void
  /** Called when the renderer reports which project directory it's showing. */
  onWatchProject?: (cwd: string) => void
}
const ok = (data?: any) => ({ success: true, data })
const err = (e: string) => ({ success: false, error: e })

const asScope = (s: unknown): WorkflowScope => (s === 'global' ? 'global' : 'project')

/** The branch the project is on, for `${project.branch}`. Read straight from
 *  git plumbing (same reader the triggers use) — no child process, and a
 *  non-repo directory simply has no branch. */
function branchOf(cwd: string, fs: FsLike): string | undefined {
  try {
    const gitDir = gitDirOf(cwd, fs)
    if (!gitDir) return undefined
    const ref = headRef(gitDir, fs)
    return ref ? ref.replace(/^refs\/heads\//, '') : undefined
  } catch {
    return undefined
  }
}

/**
 * Merge declared defaults with the values supplied for this run.
 * A required input with neither a supplied value nor a default is reported so
 * the caller can refuse the run — an automatic (trigger) run has nobody to ask,
 * so it is skipped with that reason logged rather than run half-configured.
 */
export function resolveInputs(
  wf: Workflow, supplied?: Record<string, string>,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const def of wf.inputs || []) {
    const given = supplied?.[def.name]
    const v = given !== undefined && given !== '' ? given : def.default
    // `required` means "the user actually typed something", so an all-whitespace
    // value is as missing as an empty one — otherwise a stray space would smuggle
    // a blank into a command line. The value itself is kept verbatim (a leading
    // space can be meaningful inside a larger interpolated string).
    if (v === undefined || String(v).trim() === '') {
      if (def.required) missing.push(def.name)
      values[def.name] = v === undefined ? '' : String(v)
      continue
    }
    values[def.name] = String(v)
  }
  return { values, missing }
}

export type StartRunResult = { ok: true; runId: string; done: Promise<void> } | { ok: false; error: string }
export type StartRunOpts = { scope?: WorkflowScope; inputs?: Record<string, string> }

export function registerWorkflowIpc(ipcMain: { handle: (ch: string, fn: (ev: any, arg: any) => any) => void }, getWindow: () => any, w: Wiring) {
  const depsByRun = new Map<string, EngineDeps>()

  // The single entry point into the engine. Both the renderer's Run button and
  // the trigger supervisor go through here, so an automatic run is identical to
  // a manual one — same trust gate, same events, same run history.
  //
  // `scope` picks the store the DEFINITION comes from; the run itself always
  // happens in `cwd`. That is what makes a global workflow reusable.
  const startRun = (cwd: string, id: string, opts: StartRunOpts = {}): StartRunResult => {
    if (!w.isTrusted(cwd)) return { ok: false, error: 'workspace not trusted — trust it before running workflows' }
    const scope = asScope(opts.scope)
    const r = readWorkflow(dirForScope(scope, cwd, w.userDataDir), id, w.fs, scope)
    if (!r.ok || !r.workflow) return { ok: false, error: r.errors.join('; ') }
    const { values: inputs, missing } = resolveInputs(r.workflow, opts.inputs)
    if (missing.length) return { ok: false, error: `missing required input(s): ${missing.join(', ')}` }
    const runId = w.newRunId()
    const emit = (ev: WorkflowRunEvent) => getWindow()?.webContents.send('workflow:run-event', ev)
    const exprScope: ExprScope = {
      inputs,
      project: { cwd, name: basename(cwd) || cwd, branch: branchOf(cwd, w.fs) },
    }
    const deps: EngineDeps = { ...w.makeDeps(emit, runId), scope: exprScope }
    depsByRun.set(runId, deps)
    const done = Promise.resolve(w.engine.runWorkflow(r.workflow, deps))
      .then((run) => {
        try { appendRunHistory(runsDirForScope(scope, cwd, w.userDataDir), { ...run, cwd, inputs }, w.fs) } catch { /* history is best-effort */ }
      })
      .catch(() => { /* engine already emitted a terminal event */ })
      .finally(() => { depsByRun.delete(runId) })
    return { ok: true, runId, done }
  }

  // The sidebar asks once and gets BOTH stores, each entry tagged with the store
  // it came from, so global workflows are offered in every project without the
  // renderer having to know where they live.
  const listAll = (cwd: string): WorkflowSummary[] => {
    const global = listWorkflows(dirForScope('global', cwd, w.userDataDir), w.fs, 'global')
    const project = cwd ? listWorkflows(workflowsDir(cwd), w.fs, 'project') : []
    return [...global, ...project]
  }

  ipcMain.handle('workflow:list', async (_e, { cwd }) => { try { return ok(listAll(cwd)) } catch (e: any) { return err(e.message) } })
  ipcMain.handle('workflow:read', async (_e, { cwd, id, scope }) => {
    const s = asScope(scope)
    const r = readWorkflow(dirForScope(s, cwd, w.userDataDir), id, w.fs, s)
    return r.ok ? ok(r.workflow) : err(r.errors.join('; '))
  })
  ipcMain.handle('workflow:save', async (_e, { cwd, workflow, fromScope }) => {
    try {
      const s = asScope((workflow as Workflow)?.scope)
      writeWorkflow(dirForScope(s, cwd, w.userDataDir), workflow, w.fs)
      // Changing a workflow's scope MOVES it: without this the old copy would
      // linger in the other store and show up twice in the sidebar.
      const from = fromScope === undefined ? undefined : asScope(fromScope)
      const moved = Boolean(from && from !== s)
      if (from && moved) deleteWorkflow(dirForScope(from, cwd, w.userDataDir), (workflow as Workflow).id, w.fs)
      // A move touches both stores, so it re-arms as widely as a global change.
      w.onWorkflowsChanged?.(cwd, moved || s === 'global' ? 'global' : 'project')
      return ok()
    } catch (e: any) { return err(e.message) }
  })
  ipcMain.handle('workflow:delete', async (_e, { cwd, id, scope }) => {
    try {
      const s = asScope(scope)
      deleteWorkflow(dirForScope(s, cwd, w.userDataDir), id, w.fs)
      w.onWorkflowsChanged?.(cwd, s)
      return ok()
    } catch (e: any) { return err(e.message) }
  })
  ipcMain.handle('workflow:run', async (_e, { cwd, id, scope, inputs }) => {
    const r = startRun(cwd, id, { scope: asScope(scope), inputs })
    return r.ok ? ok({ runId: r.runId }) : err(r.error)
  })
  ipcMain.handle('workflow:cancel', async (_e, { runId }) => { const d = depsByRun.get(runId); if (d) w.engine.cancelRun(runId, d); return ok() })
  // The renderer owns "which project am I looking at" (active terminal cwd, else
  // first terminal, else home) — it tells us so triggers arm for that project.
  ipcMain.handle('workflow:watch-project', async (_e, { cwd }) => { try { if (cwd) w.onWatchProject?.(cwd); return ok() } catch (e: any) { return err(e.message) } })

  return { startRun }
}
