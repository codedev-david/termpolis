import { useEffect, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import type { Workflow, WorkflowInput, StepStatus, StepResult } from '../../types'

/** Seed the run form from each input's default so Run works in one click when
 *  every input has one. Mirrors main's `resolveInputs` fallback exactly. */
export function initialInputValues(inputs: WorkflowInput[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of inputs ?? []) out[i.name] = i.default ?? ''
  return out
}

/** Required inputs left blank. Run is disabled while this is non-empty so the
 *  user fixes it here rather than getting main's rejection after the fact. */
export function missingRequired(
  inputs: WorkflowInput[] | undefined,
  values: Record<string, string>
): string[] {
  return (inputs ?? []).filter(i => i.required && !(values[i.name] ?? '').trim()).map(i => i.name)
}

// ---------------------------------------------------------------------------
// The live Run view: a vertical progress timeline (one node per workflow step)
// driven entirely by the store's activeRuns[runId] — the engine streams
// run/step events over the workflow:run-event IPC into applyRunEvent, so this
// view just reads the reduced state. Each node's colour encodes the step's
// StepStatus; exit code + duration + streamed output show as they arrive. The
// output pane IS the live pane: the engine emits step:output chunks that the
// store accumulates onto StepResult.output, so this reflects a visible step's
// terminal in real time without mounting a separate PTY view.
// ---------------------------------------------------------------------------

const STATUS_CLASS: Record<StepStatus, string> = {
  pending: 'step-status-pending border-[#3c3c3c] text-[#9ca3af]',
  running: 'step-status-running border-[#22D3EE] text-[#22D3EE]',
  succeeded: 'step-status-succeeded border-[#22c55e] text-[#22c55e]',
  failed: 'step-status-failed border-[#f87171] text-[#f87171]',
  skipped: 'step-status-skipped border-[#6b7280] text-[#6b7280]',
  cancelled: 'step-status-cancelled border-[#eab308] text-[#eab308]',
}

const STATUS_ICON: Record<StepStatus, string> = {
  pending: 'fa-circle',
  running: 'fa-spinner fa-spin',
  succeeded: 'fa-circle-check',
  failed: 'fa-circle-xmark',
  skipped: 'fa-circle-minus',
  cancelled: 'fa-ban',
}

export function WorkflowRunner({
  workflow,
  runId,
  cwd,
}: {
  workflow: Workflow
  runId: string | null
  cwd: string
}) {
  const applyRunEvent = useTerminalStore(s => s.applyRunEvent)
  const run = useTerminalStore(s => (runId ? s.activeRuns[runId] : undefined))
  const [values, setValues] = useState<Record<string, string>>(() => initialInputValues(workflow.inputs))

  // Subscribe once to the main-process run-event stream; the store reducer
  // turns each event into timeline state. Unsubscribe on unmount.
  useEffect(() => {
    const unsub = window.termpolis?.onWorkflowRunEvent?.(e => applyRunEvent(e))
    return () => {
      unsub?.()
    }
  }, [applyRunEvent])

  const resultFor = (id: string): StepResult | undefined => run?.steps.find(s => s.stepId === id)
  const running = run?.status === 'running'

  const inputs = workflow.inputs ?? []
  const missing = missingRequired(inputs, values)

  const onRun = (): void => {
    void window.termpolis?.runWorkflow?.(cwd, workflow.id, workflow.scope ?? 'project', values)
  }
  const onCancel = (): void => {
    if (runId) void window.termpolis?.cancelWorkflow?.(runId)
  }

  return (
    <div className="flex flex-col gap-3 p-4 max-w-xl mx-auto w-full">
      {/* Inputs make the same workflow reusable across projects: values are
          collected here and interpolated as `${inputs.NAME}` by the engine. */}
      {inputs.length > 0 && (
        <div className="rounded border border-[#3c3c3c] bg-[#252526] p-3 flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[#9ca3af]">Inputs</span>
          {inputs.map(inp => (
            <label key={inp.name} className="flex flex-col gap-1">
              <span className="text-xs text-[#9ca3af]">
                {inp.label?.trim() || inp.name}
                {inp.required && <span className="text-[#f87171]"> *</span>}
              </span>
              <input
                aria-label={inp.label?.trim() || inp.name}
                disabled={running}
                placeholder={inp.description ?? ''}
                className="w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1 text-sm text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE] disabled:opacity-50"
                value={values[inp.name] ?? ''}
                onChange={e => setValues(v => ({ ...v, [inp.name]: e.target.value }))}
              />
            </label>
          ))}
          {missing.length > 0 && (
            <span className="text-xs text-[#f87171]" data-testid="workflow-missing-inputs">
              Required: {missing.join(', ')}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          onClick={onRun}
          title={missing.length ? `Fill in required input(s): ${missing.join(', ')}` : 'Run this workflow'}
          disabled={running || missing.length > 0}
          className="px-4 py-1.5 rounded text-sm bg-[#22c55e] text-[#0b0b0b] font-medium hover:bg-[#4ade80] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <i className="fa-solid fa-play mr-1.5"></i>Run
        </button>
        {running && (
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded text-sm bg-[#f87171] text-[#0b0b0b] font-medium hover:bg-[#fca5a5]"
          >
            <i className="fa-solid fa-stop mr-1.5"></i>Cancel
          </button>
        )}
        {run && (
          <span className={`text-xs uppercase tracking-wider ${STATUS_CLASS[run.status as StepStatus] ?? ''}`}>
            {run.status}
          </span>
        )}
      </div>

      <ol className="flex flex-col gap-2">
        {workflow.steps.map(step => {
          const r = resultFor(step.id)
          const status: StepStatus = r?.status ?? 'pending'
          const dur = r?.startedAt != null && r?.endedAt != null ? r.endedAt - r.startedAt : null
          return (
            <li
              key={step.id}
              data-testid={`step-node-${step.id}`}
              className={`rounded border p-2 ${STATUS_CLASS[status]}`}
            >
              <div className="flex items-center gap-2">
                <i className={`fa-solid ${STATUS_ICON[status]}`}></i>
                <span className="text-sm text-[#d4d4d4] flex-1">{step.name}</span>
                {r?.exitCode != null && <span className="text-[10px] font-mono">exit {r.exitCode}</span>}
                {dur != null && <span className="text-[10px] font-mono">{dur}ms</span>}
              </div>
              {r?.output ? (
                <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-[#1a1a1a] p-2 text-[11px] font-mono text-[#9ca3af] whitespace-pre-wrap">
                  {r.output}
                </pre>
              ) : null}
              {r?.error && <div className="mt-1 text-[11px] text-[#f87171]">{r.error}</div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
