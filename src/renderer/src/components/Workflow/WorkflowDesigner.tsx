import { useState } from 'react'
import type {
  Workflow,
  WorkflowInput,
  WorkflowScope,
  WorkflowStep,
  WorkflowStepType,
  WorkflowTriggerType,
} from '../../types'
import { StepEditor } from './stepEditors'

// Where the YAML lives. Global workflows are offered in every project; project
// workflows travel with the repo under .termpolis/workflows.
const SCOPE_CHOICES: { scope: WorkflowScope; label: string; icon: string; title: string }[] = [
  { scope: 'project', label: 'This project', icon: 'fa-solid fa-diagram-project', title: 'Saved in this repo under .termpolis/workflows — travels with the code' },
  { scope: 'global', label: 'Global', icon: 'fa-solid fa-earth-americas', title: 'Saved once and offered in every project you open' },
]

/** Input names become `${inputs.NAME}` refs, so they follow identifier rules. */
export const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A fresh, valid-but-empty input row. Named `input1`, `input2`, … so a row
 *  added with one click already has a usable (unique) reference name. */
export function nextInput(existing: WorkflowInput[]): WorkflowInput {
  const taken = new Set(existing.map(i => i.name))
  let n = existing.length + 1
  while (taken.has(`input${n}`)) n++
  return { name: `input${n}`, label: '', default: '', required: false }
}

// The trigger palette. Every type here is live: picking one arms the workflow
// in the main-process supervisor the next time it's saved.
const TRIGGER_CHOICES: { type: WorkflowTriggerType; label: string; icon: string; title: string }[] = [
  { type: 'manual', label: 'Manual', icon: 'fa-solid fa-hand-pointer', title: 'Run it yourself' },
  { type: 'schedule', label: 'Schedule', icon: 'fa-solid fa-clock', title: 'On a cron schedule' },
  { type: 'gitCommit', label: 'Git commit', icon: 'fa-solid fa-code-commit', title: 'After a commit lands (post-commit)' },
  { type: 'gitPush', label: 'Git push', icon: 'fa-brands fa-git-alt', title: 'After a successful push' },
  { type: 'fileWatch', label: 'File change', icon: 'fa-solid fa-file-pen', title: 'When files in the project change' },
]

// Sensible starting config per type, so switching trigger types never leaves an
// empty form the user has to guess at.
const DEFAULT_TRIGGER_CONFIG: Record<WorkflowTriggerType, Record<string, string>> = {
  manual: {},
  schedule: { cron: '0 9 * * 1-5', catchUp: '1' },
  gitCommit: { branch: '' },
  gitPush: { remote: 'origin', branch: '' },
  fileWatch: { paths: '', debounceMs: '2000' },
}

/** Shape-only check for the inline warning. The authoritative parse lives in
 *  main (`workflow/cron.ts`); the renderer must not import main-process code,
 *  so this just catches the obvious "that isn't a cron expression" case. */
export function looksLikeCron(expr: string): boolean {
  const t = (expr ?? '').trim().toLowerCase()
  if (!t) return false
  if (/^@(hourly|daily|midnight|weekly|monthly|yearly|annually)$/.test(t)) return true
  return t.split(/\s+/).length === 5
}

function TriggerField({
  label, hint, value, placeholder, onChange,
}: { label: string; hint: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-[#9ca3af] mb-1">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE]"
      />
      <span className="block text-[11px] text-[#6b7280] mt-1">{hint}</span>
    </label>
  )
}

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
  /** Receives the workflow exactly as persisted, so the caller can follow a
   *  scope change (the file has moved stores by the time this fires). */
  onSaved: (saved: Workflow) => void
}) {
  const [wf, setWf] = useState<Workflow>(workflow)
  // Where the file was loaded from. Save sends this as `fromScope` so flipping
  // the scope MOVES the workflow instead of leaving a copy in the old store.
  const [fromScope] = useState<WorkflowScope>(workflow.scope ?? 'project')
  const [pickerGap, setPickerGap] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const steps = wf.steps

  // Switching type swaps in that type's defaults; re-picking the current type is
  // a no-op so a stray click can't wipe config the user already filled in.
  const setTriggerType = (type: WorkflowTriggerType): void =>
    setWf(w => (w.trigger.type === type ? w : { ...w, trigger: { type, config: { ...DEFAULT_TRIGGER_CONFIG[type] } } }))

  const setTriggerCfg = (key: string, value: string): void =>
    setWf(w => ({ ...w, trigger: { ...w.trigger, config: { ...(w.trigger.config ?? {}), [key]: value } } }))

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

  const inputs = wf.inputs ?? []

  const updateInput = (index: number, patch: Partial<WorkflowInput>): void =>
    setWf(w => ({
      ...w,
      inputs: (w.inputs ?? []).map((inp, i) => (i === index ? { ...inp, ...patch } : inp)),
    }))

  const removeInput = (index: number): void =>
    setWf(w => ({ ...w, inputs: (w.inputs ?? []).filter((_, i) => i !== index) }))

  const addInput = (): void =>
    setWf(w => ({ ...w, inputs: [...(w.inputs ?? []), nextInput(w.inputs ?? [])] }))

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const res = await window.termpolis.saveWorkflow(cwd, wf, fromScope)
    setSaving(false)
    if (res.success) onSaved(wf)
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

      {/* Where it lives + how it files in the sidebar. Scope decides which store
          the YAML is written to; category is only a sidebar folder label. */}
      <div className="mb-3 rounded border border-[#3c3c3c] bg-[#252526] p-3">
        <span className="block text-[10px] uppercase tracking-wider text-[#9ca3af] mb-2">Availability</span>
        <div className="flex flex-wrap gap-2 mb-3">
          {SCOPE_CHOICES.map(s => (
            <button
              key={s.scope}
              type="button"
              title={s.title}
              aria-pressed={(wf.scope ?? 'project') === s.scope}
              onClick={() => setWf(w => ({ ...w, scope: s.scope }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border ${
                (wf.scope ?? 'project') === s.scope
                  ? 'border-[#22D3EE] text-[#22D3EE] bg-[#22d3ee1a]'
                  : 'border-[#3c3c3c] text-[#9ca3af] hover:text-[#d4d4d4]'
              }`}
            >
              <i className={s.icon}></i>
              {s.label}
            </button>
          ))}
        </div>
        <span className="block text-[10px] uppercase tracking-wider text-[#9ca3af] mb-1">Category</span>
        <input
          aria-label="Category"
          placeholder="Optional — groups this workflow into a sidebar folder"
          className="w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1.5 text-sm text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE]"
          value={wf.category ?? ''}
          onChange={e => setWf(w => ({ ...w, category: e.target.value }))}
        />
      </div>

      {/* Inputs make one workflow reusable: each becomes a `${inputs.NAME}`
          reference usable in any step field, prompted for at run time. */}
      <div className="mb-3 rounded border border-[#3c3c3c] bg-[#252526] p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wider text-[#9ca3af]">Inputs</span>
          <button
            type="button"
            onClick={addInput}
            title="Add an input"
            className="text-[#22D3EE] text-xs hover:underline"
          >
            <i className="fa-solid fa-plus mr-1"></i>Add input
          </button>
        </div>
        {inputs.length === 0 ? (
          <p className="text-xs text-[#6b7280]">
            No inputs. Add one to reuse this workflow with different values — reference it as{' '}
            <code className="text-[#9ca3af]">{'${inputs.name}'}</code> in any step, alongside{' '}
            <code className="text-[#9ca3af]">{'${project.cwd}'}</code>,{' '}
            <code className="text-[#9ca3af]">{'${project.name}'}</code> and{' '}
            <code className="text-[#9ca3af]">{'${project.branch}'}</code>.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {inputs.map((inp, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`Input ${i + 1} name`}
                  placeholder="name"
                  className={`w-28 bg-[#2d2d2d] border rounded px-2 py-1 text-xs text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE] ${
                    INPUT_NAME_RE.test(inp.name) ? 'border-[#3c3c3c]' : 'border-[#ef4444]'
                  }`}
                  value={inp.name}
                  onChange={e => updateInput(i, { name: e.target.value })}
                />
                <input
                  aria-label={`Input ${i + 1} label`}
                  placeholder="Prompt shown at run time"
                  className="flex-1 min-w-[8rem] bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE]"
                  value={inp.label ?? ''}
                  onChange={e => updateInput(i, { label: e.target.value })}
                />
                <input
                  aria-label={`Input ${i + 1} default`}
                  placeholder="default"
                  className="w-28 bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE]"
                  value={inp.default ?? ''}
                  onChange={e => updateInput(i, { default: e.target.value })}
                />
                <label className="flex items-center gap-1 text-xs text-[#9ca3af]">
                  <input
                    type="checkbox"
                    aria-label={`Input ${i + 1} required`}
                    checked={!!inp.required}
                    onChange={e => updateInput(i, { required: e.target.checked })}
                  />
                  Required
                </label>
                <button
                  type="button"
                  aria-label={`Remove input ${i + 1}`}
                  title="Remove input"
                  onClick={() => removeInput(i)}
                  className="text-[#9ca3af] hover:text-[#ef4444] text-xs px-1"
                >
                  <i className="fa-solid fa-trash"></i>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Trigger card — picking anything but Manual reveals that trigger's
          config fields; the main-process supervisor arms it on save. */}
      <div className="rounded border border-[#3c3c3c] bg-[#252526] p-3">
        <span className="block text-[10px] uppercase tracking-wider text-[#9ca3af] mb-2">Trigger</span>
        <div className="flex flex-wrap gap-2">
          {TRIGGER_CHOICES.map(t => (
            <button
              key={t.type}
              type="button"
              title={t.title}
              aria-pressed={wf.trigger.type === t.type}
              onClick={() => setTriggerType(t.type)}
              className={
                wf.trigger.type === t.type
                  ? 'px-2.5 py-1 rounded text-xs bg-[#22D3EE]/10 text-[#22D3EE] border border-[#22D3EE]/40'
                  : 'px-2.5 py-1 rounded text-xs text-[#9ca3af] border border-[#3c3c3c] hover:text-[#d4d4d4] hover:border-[#6b7280]'
              }
            ><i className={`${t.icon} mr-1.5`}></i>{t.label}</button>
          ))}
        </div>
        {wf.trigger.type !== 'manual' && (
          <div className="mt-3 pt-3 border-t border-[#3c3c3c] space-y-2">
            {wf.trigger.type === 'schedule' && (
              <>
                <TriggerField
                  label="Cron"
                  hint="min hour day month weekday — or @daily / @hourly / @weekly"
                  value={wf.trigger.config?.cron ?? ''}
                  placeholder="0 9 * * 1-5"
                  onChange={v => setTriggerCfg('cron', v)}
                />
                {!looksLikeCron(wf.trigger.config?.cron ?? '') && (
                  <p className="text-[11px] text-[#f59e0b]">
                    Needs 5 fields (or an @alias). An invalid expression never fires.
                  </p>
                )}
                <label className="flex items-center gap-2 text-xs text-[#9ca3af]">
                  <input
                    type="checkbox"
                    checked={(wf.trigger.config?.catchUp ?? '1') !== '0'}
                    onChange={e => setTriggerCfg('catchUp', e.target.checked ? '1' : '0')}
                  />
                  Run at launch if it was due while Termpolis was closed
                </label>
              </>
            )}
            {wf.trigger.type === 'gitCommit' && (
              <>
                <TriggerField
                  label="Branch"
                  hint="blank = whichever branch is checked out"
                  value={wf.trigger.config?.branch ?? ''}
                  placeholder="main"
                  onChange={v => setTriggerCfg('branch', v)}
                />
                <p className="text-[11px] text-[#6b7280]">
                  Fires after a commit lands (post-commit) — it cannot block or reject a commit.
                </p>
              </>
            )}
            {wf.trigger.type === 'gitPush' && (
              <>
                <TriggerField
                  label="Remote"
                  hint="defaults to origin"
                  value={wf.trigger.config?.remote ?? ''}
                  placeholder="origin"
                  onChange={v => setTriggerCfg('remote', v)}
                />
                <TriggerField
                  label="Branch"
                  hint="blank = whichever branch is checked out"
                  value={wf.trigger.config?.branch ?? ''}
                  placeholder="main"
                  onChange={v => setTriggerCfg('branch', v)}
                />
              </>
            )}
            {wf.trigger.type === 'fileWatch' && (
              <>
                <TriggerField
                  label="Paths"
                  hint="comma-separated prefixes, blank = whole project"
                  value={wf.trigger.config?.paths ?? ''}
                  placeholder="src/, docs/"
                  onChange={v => setTriggerCfg('paths', v)}
                />
                <TriggerField
                  label="Debounce (ms)"
                  hint="quiet period after the last change before running"
                  value={wf.trigger.config?.debounceMs ?? ''}
                  placeholder="2000"
                  onChange={v => setTriggerCfg('debounceMs', v)}
                />
              </>
            )}
            <p className="text-[11px] text-[#6b7280]">
              Automatic runs only happen in a trusted workspace, and never while a previous run of
              this workflow is still going.
            </p>
          </div>
        )}
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
