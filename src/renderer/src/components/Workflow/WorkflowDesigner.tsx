import { useState } from 'react'
import type { Workflow, WorkflowStep, WorkflowStepType } from '../../types'
import { StepEditor } from './stepEditors'

// ---------------------------------------------------------------------------
// The Workflow Designer — an Azure-Logic-Apps-style vertical canvas: a trigger
// card at the top, then an alternating sequence of inline "+" gaps and step
// action cards. Clicking a gap "+" opens a type picker *at that gap*; picking a
// type splices a freshly-id'd default step in at that position. Each card hosts
// the per-type field editor from stepEditors.tsx. Save persists the whole
// workflow via the main process (workflow:save IPC).
// ---------------------------------------------------------------------------

/** A minimal, valid default step of the given type. `waitMs` (not `ms`) is the
 *  config key the control executor reads, so a default Wait actually waits. */
export function defaultStep(type: WorkflowStepType): WorkflowStep {
  const id = crypto.randomUUID()
  switch (type) {
    case 'command':
      return { id, type, name: 'Run command', source: 'inline', command: '', shell: 'bash', visible: false }
    case 'agent':
      return { id, type, name: 'Ask agent', agent: 'claude', prompt: '' }
    case 'skill':
      return { id, type, name: 'Run skill', tool: '', args: {} }
    case 'control':
      return { id, type, name: 'Wait', action: 'wait', config: { waitMs: 1000 } }
  }
}

/** Return a new steps array with a fresh default step of `type` spliced in at
 *  `index`. Never mutates the input. */
export function insertStep(steps: WorkflowStep[], index: number, type: WorkflowStepType): WorkflowStep[] {
  const next = steps.slice()
  next.splice(index, 0, defaultStep(type))
  return next
}

const STEP_TYPES: { type: WorkflowStepType; label: string; icon: string }[] = [
  { type: 'command', label: 'Command', icon: 'fa-terminal' },
  { type: 'agent', label: 'Agent', icon: 'fa-robot' },
  { type: 'skill', label: 'Skill', icon: 'fa-wand-magic-sparkles' },
  { type: 'control', label: 'Control', icon: 'fa-code-branch' },
]

const iconFor = (type: WorkflowStepType): string =>
  STEP_TYPES.find(t => t.type === type)?.icon ?? 'fa-cube'

export function WorkflowDesigner({
  workflow,
  cwd,
  onSaved,
}: {
  workflow: Workflow
  cwd: string
  onSaved: () => void
}) {
  const [wf, setWf] = useState<Workflow>(workflow)
  const [pickerGap, setPickerGap] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const steps = wf.steps

  const updateStep = (index: number, patch: Partial<WorkflowStep>): void =>
    setWf(w => ({
      ...w,
      steps: w.steps.map((s, i) => (i === index ? ({ ...s, ...patch } as WorkflowStep) : s)),
    }))

  const removeStep = (index: number): void =>
    setWf(w => ({ ...w, steps: w.steps.filter((_, i) => i !== index) }))

  const addAtGap = (gap: number, type: WorkflowStepType): void => {
    setWf(w => ({ ...w, steps: insertStep(w.steps, gap, type) }))
    setPickerGap(null)
  }

  const toggleGap = (gap: number): void => setPickerGap(g => (g === gap ? null : gap))

  const toggleCollapse = (id: string): void => setCollapsed(c => ({ ...c, [id]: !c[id] }))

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const res = await window.termpolis.saveWorkflow(cwd, wf)
    setSaving(false)
    if (res.success) onSaved()
    else setError(res.error ?? 'Failed to save workflow')
  }

  const gapPlus = (gap: number) => (
    <div className="flex flex-col items-center">
      <div className="w-px h-3 bg-[#3c3c3c]"></div>
      <div className="relative">
        <button
          title="Insert a step"
          onClick={() => toggleGap(gap)}
          className="w-6 h-6 rounded-full border border-[#3c3c3c] bg-[#252526] text-[#22D3EE] text-xs hover:border-[#22D3EE] flex items-center justify-center"
        >
          <i className="fa-solid fa-plus"></i>
        </button>
        {pickerGap === gap && (
          <div className="absolute left-1/2 -translate-x-1/2 mt-1 z-10 flex flex-col bg-[#252526] border border-[#3c3c3c] rounded shadow-lg overflow-hidden">
            {STEP_TYPES.map(t => (
              <button
                key={t.type}
                onClick={() => addAtGap(gap, t.type)}
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#37373d] text-left whitespace-nowrap"
              >
                <i className={`fa-solid ${t.icon} text-[#22D3EE] w-4`}></i>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="w-px h-3 bg-[#3c3c3c]"></div>
    </div>
  )

  return (
    <div className="flex flex-col gap-0 p-4 max-w-xl mx-auto w-full">
      <div className="mb-3">
        <span className="block text-[10px] uppercase tracking-wider text-[#9ca3af] mb-1">Workflow name</span>
        <input
          aria-label="Workflow name"
          className="w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1.5 text-sm text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE]"
          value={wf.name}
          onChange={e => setWf(w => ({ ...w, name: e.target.value }))}
        />
      </div>

      {/* Trigger card — Manual is active; the rest are roadmap. */}
      <div className="rounded border border-[#3c3c3c] bg-[#252526] p-3">
        <span className="block text-[10px] uppercase tracking-wider text-[#9ca3af] mb-2">Trigger</span>
        <div className="flex flex-wrap gap-2">
          <span className="px-2.5 py-1 rounded text-xs bg-[#22D3EE]/10 text-[#22D3EE] border border-[#22D3EE]/40">
            <i className="fa-solid fa-hand-pointer mr-1.5"></i>Manual
          </span>
          <button
            disabled
            title="Schedule (coming soon)"
            className="px-2.5 py-1 rounded text-xs text-[#6b7280] border border-[#3c3c3c] cursor-not-allowed"
          ><i className="fa-solid fa-clock mr-1.5"></i>Schedule</button>
          <button
            disabled
            title="On git push (coming soon)"
            className="px-2.5 py-1 rounded text-xs text-[#6b7280] border border-[#3c3c3c] cursor-not-allowed"
          ><i className="fa-brands fa-git-alt mr-1.5"></i>Git push</button>
          <button
            disabled
            title="On file change (coming soon)"
            className="px-2.5 py-1 rounded text-xs text-[#6b7280] border border-[#3c3c3c] cursor-not-allowed"
          ><i className="fa-solid fa-file-pen mr-1.5"></i>File change</button>
        </div>
      </div>

      {gapPlus(0)}

      {steps.map((step, i) => (
        <div key={step.id} className="flex flex-col">
          <div data-testid="step-card" className="rounded border border-[#3c3c3c] bg-[#252526]">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#3c3c3c]">
              <i className={`fa-solid ${iconFor(step.type)} text-[#22D3EE]`}></i>
              <input
                aria-label="Step name"
                className="flex-1 bg-transparent text-sm text-[#d4d4d4] focus:outline-none"
                value={step.name}
                onChange={e => updateStep(i, { name: e.target.value })}
              />
              <button
                title={collapsed[step.id] ? 'Expand step' : 'Collapse step'}
                onClick={() => toggleCollapse(step.id)}
                className="px-1.5 py-0.5 rounded text-[#999] hover:text-white hover:bg-[#37373d]"
              >
                <i className={`fa-solid ${collapsed[step.id] ? 'fa-chevron-down' : 'fa-chevron-up'} text-xs`}></i>
              </button>
              <button
                title="Remove step"
                onClick={() => removeStep(i)}
                className="px-1.5 py-0.5 rounded text-[#999] hover:text-[#f87171] hover:bg-[#37373d]"
              >
                <i className="fa-solid fa-trash text-xs"></i>
              </button>
            </div>
            {!collapsed[step.id] && (
              <div className="p-3">
                <StepEditor step={step} onChange={patch => updateStep(i, patch)} />
              </div>
            )}
          </div>
          {gapPlus(i + 1)}
        </div>
      ))}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-1.5 rounded text-sm bg-[#22D3EE] text-[#0b0b0b] font-medium hover:bg-[#67e8f9] disabled:opacity-50"
        >Save</button>
        {error && <span className="text-xs text-[#f87171]">{error}</span>}
      </div>
    </div>
  )
}
