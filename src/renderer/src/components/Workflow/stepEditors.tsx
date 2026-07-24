import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  WorkflowStep,
  CommandStep,
  AgentStep,
  SkillStep,
  ControlStep,
  ShellType,
} from '../../types'

// ---------------------------------------------------------------------------
// Per-type field editors for a single workflow step. Each editor is a pure
// controlled form: it reads the concrete step and emits a *patch* (a partial
// step) up to the Designer, which merges it into workflow state. The field
// keys map 1:1 onto the keys the main-process executors actually read
// (see src/main/workflow/executors.ts) so every editable field is wired to
// real behaviour — nothing here is decorative.
// ---------------------------------------------------------------------------

const inputCls =
  'w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1 text-xs text-[#d4d4d4] focus:outline-none focus:border-[#22D3EE]'
const labelCls = 'block text-[10px] uppercase tracking-wider text-[#9ca3af] mb-1'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  )
}

const SHELLS: ShellType[] = ['bash', 'zsh', 'cmd', 'powershell', 'gitbash']

/** Optional numeric input: emits the number, or `undefined` when blanked/zeroed. */
function numOrUndef(raw: string): number | undefined {
  return Number(raw) || undefined
}
/** Optional string input: emits the string, or `undefined` when blanked. */
function strOrUndef(raw: string): string | undefined {
  return raw || undefined
}

function CommandEditor({ step, onChange }: { step: CommandStep; onChange: (p: Partial<CommandStep>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <Field label="Command source">
        <select
          aria-label="Command source"
          className={inputCls}
          value={step.source}
          onChange={e => onChange({ source: e.target.value as CommandStep['source'] })}
        >
          <option value="inline">Inline command</option>
          <option value="file">Script file</option>
        </select>
      </Field>
      {step.source === 'inline' ? (
        <Field label="Inline command">
          <textarea
            aria-label="Inline command"
            className={`${inputCls} font-mono`}
            rows={2}
            value={step.command ?? ''}
            onChange={e => onChange({ command: e.target.value })}
          />
        </Field>
      ) : (
        <Field label="Script path">
          <input
            aria-label="Script path"
            className={`${inputCls} font-mono`}
            value={step.scriptPath ?? ''}
            onChange={e => onChange({ scriptPath: e.target.value })}
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Shell">
          <select
            aria-label="Shell"
            className={inputCls}
            value={step.shell ?? 'bash'}
            onChange={e => onChange({ shell: e.target.value as ShellType })}
          >
            {SHELLS.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Working directory">
          <input
            aria-label="Working directory"
            className={`${inputCls} font-mono`}
            placeholder="(workflow cwd)"
            value={step.cwd ?? ''}
            onChange={e => onChange({ cwd: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Timeout (ms)">
        <input
          aria-label="Timeout (ms)"
          type="number"
          className={inputCls}
          placeholder="(none)"
          value={step.timeoutMs ?? ''}
          onChange={e => onChange({ timeoutMs: numOrUndef(e.target.value) })}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-[#d4d4d4]">
        <input
          type="checkbox"
          aria-label="Run visibly"
          checked={step.visible ?? false}
          onChange={e => onChange({ visible: e.target.checked })}
        />
        Run visibly (show the terminal pane)
      </label>
      <label className="flex items-center gap-2 text-xs text-[#d4d4d4]">
        <input
          type="checkbox"
          aria-label="Continue on error"
          checked={step.continueOnError ?? false}
          onChange={e => onChange({ continueOnError: e.target.checked })}
        />
        Continue even if this step fails
      </label>
      <Field label="Run when (gate)">
        <input
          aria-label="Run when (gate)"
          className={`${inputCls} font-mono`}
          placeholder="always"
          value={step.when ?? ''}
          onChange={e => onChange({ when: strOrUndef(e.target.value) })}
        />
      </Field>
    </div>
  )
}

function AgentEditor({ step, onChange }: { step: AgentStep; onChange: (p: Partial<AgentStep>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Agent">
          <select
            aria-label="Agent"
            className={inputCls}
            value={step.agent}
            onChange={e => onChange({ agent: e.target.value as AgentStep['agent'] })}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">OpenAI Codex</option>
            <option value="gemini">Gemini CLI</option>
          </select>
        </Field>
        <Field label="Done marker">
          <input
            aria-label="Done marker"
            className={`${inputCls} font-mono`}
            placeholder="(idle detection)"
            value={step.doneMarker ?? ''}
            onChange={e => onChange({ doneMarker: strOrUndef(e.target.value) })}
          />
        </Field>
      </div>
      <Field label="Prompt">
        <textarea
          aria-label="Prompt"
          className={inputCls}
          rows={3}
          value={step.prompt}
          onChange={e => onChange({ prompt: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Idle (ms)">
          <input
            aria-label="Idle (ms)"
            type="number"
            className={inputCls}
            placeholder="(default)"
            value={step.idleMs ?? ''}
            onChange={e => onChange({ idleMs: numOrUndef(e.target.value) })}
          />
        </Field>
        <Field label="Timeout (ms)">
          <input
            aria-label="Timeout (ms)"
            type="number"
            className={inputCls}
            placeholder="(none)"
            value={step.timeoutMs ?? ''}
            onChange={e => onChange({ timeoutMs: numOrUndef(e.target.value) })}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs text-[#d4d4d4]">
        <input
          type="checkbox"
          aria-label="Continue on error"
          checked={step.continueOnError ?? false}
          onChange={e => onChange({ continueOnError: e.target.checked })}
        />
        Continue even if this step fails
      </label>
      <Field label="Run when (gate)">
        <input
          aria-label="Run when (gate)"
          className={`${inputCls} font-mono`}
          placeholder="always"
          value={step.when ?? ''}
          onChange={e => onChange({ when: strOrUndef(e.target.value) })}
        />
      </Field>
    </div>
  )
}

function SkillEditor({ step, onChange }: { step: SkillStep; onChange: (p: Partial<SkillStep>) => void }) {
  // The args JSON is edited as raw text so an in-progress/invalid edit stays
  // visible; we only emit an `args` patch when the text parses cleanly.
  const [argsText, setArgsText] = useState(() => JSON.stringify(step.args ?? {}, null, 2))
  const [argsError, setArgsError] = useState<string | null>(null)

  const onArgs = (raw: string): void => {
    setArgsText(raw)
    try {
      const parsed = JSON.parse(raw)
      setArgsError(null)
      onChange({ args: parsed })
    } catch {
      setArgsError('Invalid JSON')
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Field label="Tool">
        <input
          aria-label="Tool"
          className={`${inputCls} font-mono`}
          placeholder="e.g. code_search"
          value={step.tool}
          onChange={e => onChange({ tool: e.target.value })}
        />
      </Field>
      <Field label="Arguments (JSON)">
        <textarea
          aria-label="Arguments (JSON)"
          className={`${inputCls} font-mono`}
          rows={3}
          value={argsText}
          onChange={e => onArgs(e.target.value)}
        />
        {argsError && <span className="text-[10px] text-[#f87171]">{argsError}</span>}
      </Field>
      <Field label="Timeout (ms)">
        <input
          aria-label="Timeout (ms)"
          type="number"
          className={inputCls}
          placeholder="(none)"
          value={step.timeoutMs ?? ''}
          onChange={e => onChange({ timeoutMs: numOrUndef(e.target.value) })}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-[#d4d4d4]">
        <input
          type="checkbox"
          aria-label="Continue on error"
          checked={step.continueOnError ?? false}
          onChange={e => onChange({ continueOnError: e.target.checked })}
        />
        Continue even if this step fails
      </label>
      <Field label="Run when (gate)">
        <input
          aria-label="Run when (gate)"
          className={`${inputCls} font-mono`}
          placeholder="always"
          value={step.when ?? ''}
          onChange={e => onChange({ when: strOrUndef(e.target.value) })}
        />
      </Field>
    </div>
  )
}

function ControlEditor({ step, onChange }: { step: ControlStep; onChange: (p: Partial<ControlStep>) => void }) {
  const cfg = step.config ?? {}
  const patchCfg = (patch: Record<string, string | number>): void =>
    onChange({ config: { ...cfg, ...patch } })

  return (
    <div className="flex flex-col gap-2">
      <Field label="Control action">
        <select
          aria-label="Control action"
          className={inputCls}
          value={step.action}
          onChange={e => onChange({ action: e.target.value as ControlStep['action'] })}
        >
          <option value="wait">Wait / delay</option>
          <option value="branch">Branch (jump to a step)</option>
          <option value="loop">Loop (repeat earlier steps)</option>
          <option value="notify">Notify</option>
        </select>
      </Field>

      {step.action === 'wait' && (
        <Field label="Wait (ms)">
          <input
            aria-label="Wait (ms)"
            type="number"
            className={inputCls}
            value={cfg.waitMs ?? ''}
            onChange={e => patchCfg({ waitMs: Number(e.target.value) || 0 })}
          />
        </Field>
      )}

      {step.action === 'branch' && (
        <>
          <Field label="Branch condition">
            <input
              aria-label="Branch condition"
              className={`${inputCls} font-mono`}
              placeholder="steps.build.exitCode == 0"
              value={cfg.condition ?? ''}
              onChange={e => patchCfg({ condition: e.target.value })}
            />
          </Field>
          <Field label="Go to step (id)">
            <input
              aria-label="Go to step (id)"
              className={`${inputCls} font-mono`}
              value={cfg.goto ?? ''}
              onChange={e => patchCfg({ goto: e.target.value })}
            />
          </Field>
        </>
      )}

      {step.action === 'loop' && (
        <>
          <Field label="Max iterations">
            <input
              aria-label="Max iterations"
              type="number"
              className={inputCls}
              value={cfg.maxIterations ?? ''}
              onChange={e => patchCfg({ maxIterations: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label="Until (condition)">
            <input
              aria-label="Until (condition)"
              className={`${inputCls} font-mono`}
              placeholder="steps.test.exitCode == 0"
              value={cfg.until ?? ''}
              onChange={e => patchCfg({ until: e.target.value })}
            />
          </Field>
        </>
      )}

      {step.action === 'notify' && (
        <Field label="Notify message">
          <input
            aria-label="Notify message"
            className={inputCls}
            value={cfg.message ?? ''}
            onChange={e => patchCfg({ message: e.target.value })}
          />
        </Field>
      )}

      <Field label="Run when (gate)">
        <input
          aria-label="Run when (gate)"
          className={`${inputCls} font-mono`}
          placeholder="always"
          value={step.when ?? ''}
          onChange={e => onChange({ when: strOrUndef(e.target.value) })}
        />
      </Field>
    </div>
  )
}

export function StepEditor({
  step,
  onChange,
}: {
  step: WorkflowStep
  onChange: (patch: Partial<WorkflowStep>) => void
}) {
  switch (step.type) {
    case 'command':
      return <CommandEditor step={step} onChange={onChange} />
    case 'agent':
      return <AgentEditor step={step} onChange={onChange} />
    case 'skill':
      return <SkillEditor step={step} onChange={onChange} />
    case 'control':
      return <ControlEditor step={step} onChange={onChange} />
  }
}
