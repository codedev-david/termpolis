import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTerminalStore } from '../../store/terminalStore'
import type { Workflow } from '../../types'
import { WorkflowDesigner } from './WorkflowDesigner'
import { WorkflowRunner } from './WorkflowRunner'

// ---------------------------------------------------------------------------
// The body that fills the workflow overlay frame owned by the Sidebar. It hosts
// two tabs — Design (the authoring canvas) and Run (the live progress timeline)
// — over a single workflow. New mode seeds a blank manual-trigger workflow;
// edit mode loads one from disk by id via the workflow:read IPC. The Designer
// stays mounted across tab switches (so unsaved edits survive), while the Runner
// mounts only on the Run tab — it owns the sole run-event subscription, so there
// is never a second subscriber duplicating streamed output.
// ---------------------------------------------------------------------------

export type WorkflowOverlayView = { mode: 'new'; seed?: Workflow } | { mode: 'edit'; id: string }

/** A blank manual-trigger workflow for the "new" path. `crypto.randomUUID` is a
 *  renderer-only id mint — the deterministic engine never sees this call. */
function freshWorkflow(): Workflow {
  return { id: crypto.randomUUID(), name: 'New workflow', version: 1, trigger: { type: 'manual' }, steps: [] }
}

const tabCls = (active: boolean): string =>
  `px-3 py-1 text-xs rounded-t border-b-2 ${
    active
      ? 'border-[#22D3EE] text-[#22D3EE]'
      : 'border-transparent text-[#9ca3af] hover:text-[#d4d4d4]'
  }`

export function WorkflowOverlayBody({
  view,
  cwd,
  onSaved,
}: {
  view: WorkflowOverlayView
  cwd: string | null
  onSaved: () => void
}) {
  // New mode seeds a workflow: a starter template (re-id'd to a fresh instance so
  // saving never overwrites another) when one is supplied, otherwise a blank one.
  const [wf, setWf] = useState<Workflow | null>(() =>
    view.mode === 'new' ? (view.seed ? { ...view.seed, id: crypto.randomUUID() } : freshWorkflow()) : null,
  )
  const [tab, setTab] = useState<'design' | 'run'>('design')
  const [loadError, setLoadError] = useState<string | null>(null)
  const activeRuns = useTerminalStore(useShallow(s => s.activeRuns))

  // Edit mode: load the workflow from disk. New mode already has a fresh wf, so
  // this effect is a no-op there. Guarded on cwd so we never read without a
  // project directory. `alive` prevents a late resolve from a prior id landing.
  useEffect(() => {
    if (view.mode !== 'edit' || !cwd) return
    let alive = true
    setWf(null)
    setLoadError(null)
    void window.termpolis.readWorkflow(cwd, view.id).then(res => {
      if (!alive) return
      if (res.success && res.data) setWf(res.data)
      else setLoadError(res.error ?? 'Workflow not found')
    })
    return () => {
      alive = false
    }
  }, [view, cwd])

  // The most recent run for this workflow drives the Runner timeline. Runs are
  // keyed by runId; we match on workflowId and take the latest by start time.
  const runId =
    wf == null
      ? null
      : (Object.values(activeRuns)
          .filter(r => r.workflowId === wf.id)
          .sort((a, b) => b.startedAt - a.startedAt)[0]?.runId ?? null)

  if (!cwd) {
    return (
      <div className="p-6 text-sm text-[#f0ad4e]">
        Open a terminal to pick a project directory for this workflow.
      </div>
    )
  }
  if (loadError) {
    return <div className="p-6 text-sm text-[#f87171]">{loadError}</div>
  }
  if (!wf) {
    return <div className="p-6 text-sm text-[#9ca3af]">Loading workflow…</div>
  }

  // The Designer edits its own internal draft and persists it on Save. Re-read
  // the saved workflow from disk here so this component's `wf` — the single
  // source the Runner renders its timeline from — matches exactly what Run will
  // execute (workflow:run loads the saved YAML by id). Without this, a freshly
  // authored workflow's Run tab would show an empty timeline even though the
  // saved workflow ran, and later edits would drift from what actually runs.
  const handleSaved = (): void => {
    onSaved()
    void window.termpolis.readWorkflow(cwd, wf.id).then(res => {
      if (res.success && res.data) setWf(res.data)
    })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-4 pt-2 border-b border-[#3c3c3c]">
        <button aria-label="Design tab" onClick={() => setTab('design')} className={tabCls(tab === 'design')}>
          <i className="fa-solid fa-diagram-project mr-1.5"></i>Design
        </button>
        <button aria-label="Run tab" onClick={() => setTab('run')} className={tabCls(tab === 'run')}>
          <i className="fa-solid fa-play mr-1.5"></i>Run
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {/* Designer stays mounted (edits survive tab switches); just hidden off-tab. */}
        <div className={tab === 'design' ? 'h-full' : 'hidden'}>
          <WorkflowDesigner workflow={wf} cwd={cwd} onSaved={handleSaved} />
        </div>
        {tab === 'run' && <WorkflowRunner workflow={wf} runId={runId} cwd={cwd} />}
      </div>
    </div>
  )
}
