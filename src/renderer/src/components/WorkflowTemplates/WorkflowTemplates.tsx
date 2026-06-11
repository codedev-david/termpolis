import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useTerminalStore } from '../../store/terminalStore'
import { getHomedir } from '../../lib/homedir'
import { getTerminalDefaults } from '../../lib/terminalDefaults'
import type { PaneNode, ShellType, WorkflowTemplate, WorkflowTerminal, WorkflowLayout } from '../../types'

const BUILT_IN_WORKFLOWS: WorkflowTemplate[] = [
  {
    id: 'claude-dev',
    name: 'Claude Code + Shell',
    description: 'Claude Code on the left, shell on the right',
    icon: 'fa-solid fa-robot',
    terminals: [
      { name: 'Claude Code', command: 'claude', shell: 'bash', color: '#D97706' },
      { name: 'Shell', command: '', shell: 'bash', color: '#22D3EE' },
    ],
    layout: 'vertical',
  },
  {
    id: 'full-stack',
    name: 'Full Stack Dev',
    description: 'AI agent + frontend + backend + tests',
    icon: 'fa-solid fa-layer-group',
    terminals: [
      { name: 'AI Agent', command: 'claude', shell: 'bash', color: '#D97706' },
      { name: 'Frontend', command: '', shell: 'bash', color: '#22D3EE' },
      { name: 'Backend', command: '', shell: 'bash', color: '#A5D6A7' },
      { name: 'Tests', command: '', shell: 'bash', color: '#CE93D8' },
    ],
    layout: 'quad',
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'AI reviewer + git log + diff viewer',
    icon: 'fa-solid fa-magnifying-glass',
    terminals: [
      { name: 'AI Review', command: '', shell: 'bash', color: '#8B5CF6' },
      { name: 'Git', command: '', shell: 'bash', color: '#EF9A9A' },
    ],
    layout: 'vertical',
  },
]

function resolveShell(shell: string): ShellType {
  // On Windows, prefer gitbash when template says bash
  if (shell === 'bash' && navigator.platform.startsWith('Win')) return 'gitbash'
  return shell as ShellType
}

function buildLayoutTree(terminalIds: string[], layout: WorkflowLayout): PaneNode | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return { type: 'terminal', terminalId: terminalIds[0] }

  if (layout === 'vertical' || terminalIds.length === 2) {
    const mid = Math.ceil(terminalIds.length / 2)
    const left = buildLayoutTree(terminalIds.slice(0, mid), 'vertical')
    const right = buildLayoutTree(terminalIds.slice(mid), 'vertical')
    if (!left) return right
    if (!right) return left
    return { type: 'split', direction: 'horizontal', ratio: 0.5, children: [left, right] }
  }

  if (layout === 'quad' && terminalIds.length === 4) {
    const tl: PaneNode = { type: 'terminal', terminalId: terminalIds[0] }
    const tr: PaneNode = { type: 'terminal', terminalId: terminalIds[1] }
    const bl: PaneNode = { type: 'terminal', terminalId: terminalIds[2] }
    const br: PaneNode = { type: 'terminal', terminalId: terminalIds[3] }
    return {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { type: 'split', direction: 'horizontal', ratio: 0.5, children: [tl, tr] },
        { type: 'split', direction: 'horizontal', ratio: 0.5, children: [bl, br] },
      ],
    }
  }

  const mid = Math.ceil(terminalIds.length / 2)
  const left = buildLayoutTree(terminalIds.slice(0, mid), 'vertical')
  const right = buildLayoutTree(terminalIds.slice(mid), 'vertical')
  if (!left) return right
  if (!right) return left
  return { type: 'split', direction: 'horizontal', ratio: 0.5, children: [left, right] }
}

const SHELL_OPTIONS: { value: string; label: string }[] = [
  { value: 'bash', label: 'Bash' },
  { value: 'zsh', label: 'Zsh' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'CMD' },
  { value: 'gitbash', label: 'Git Bash' },
]

const COLOR_SWATCHES = ['#D97706', '#22D3EE', '#A5D6A7', '#CE93D8', '#8B5CF6', '#EF9A9A', '#F59E0B', '#10B981']

const ICON_OPTIONS = [
  'fa-solid fa-robot',
  'fa-solid fa-layer-group',
  'fa-solid fa-magnifying-glass',
  'fa-solid fa-cubes',
  'fa-solid fa-bolt',
  'fa-solid fa-code',
  'fa-solid fa-terminal',
  'fa-solid fa-rocket',
]

interface EditorProps {
  initial?: WorkflowTemplate
  onSave: (workflow: WorkflowTemplate) => void
  onCancel: () => void
}

function WorkflowEditor({ initial, onSave, onCancel }: EditorProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? ICON_OPTIONS[0])
  const [layout, setLayout] = useState<WorkflowLayout>(initial?.layout ?? 'vertical')
  const [terminals, setTerminals] = useState<WorkflowTerminal[]>(
    initial?.terminals ?? [{ name: 'Terminal 1', command: '', shell: 'bash', color: COLOR_SWATCHES[0] }],
  )

  const canSave = name.trim().length > 0 && terminals.length > 0 && terminals.every(t => t.name.trim().length > 0)

  const addTerminal = () => {
    if (terminals.length >= 8) return
    setTerminals([
      ...terminals,
      {
        name: `Terminal ${terminals.length + 1}`,
        command: '',
        shell: 'bash',
        color: COLOR_SWATCHES[terminals.length % COLOR_SWATCHES.length],
      },
    ])
  }

  const updateTerminal = (idx: number, patch: Partial<WorkflowTerminal>) => {
    setTerminals(terminals.map((t, i) => i === idx ? { ...t, ...patch } : t))
  }

  const removeTerminal = (idx: number) => {
    if (terminals.length <= 1) return
    setTerminals(terminals.filter((_, i) => i !== idx))
  }

  const handleSave = () => {
    if (!canSave) return
    onSave({
      id: initial?.id ?? `user-${uuid()}`,
      name: name.trim(),
      description: description.trim(),
      icon,
      layout,
      terminals: terminals.map(t => ({ ...t, name: t.name.trim() })),
      isCustom: true,
    })
  }

  return (
    <div
      className="flex-1 overflow-y-auto p-4 flex flex-col gap-3"
      data-testid="workflow-editor"
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[#999]">Name</span>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="My Workflow"
          className="bg-[#2a2d2e] border border-[#3c3c3c] text-[#d4d4d4] text-xs rounded px-2 py-1.5 focus:border-[#D97706] outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[#999]">Description</span>
        <input
          type="text"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What this workflow sets up"
          className="bg-[#2a2d2e] border border-[#3c3c3c] text-[#d4d4d4] text-xs rounded px-2 py-1.5 focus:border-[#D97706] outline-none"
        />
      </label>
      <div className="flex gap-3">
        <label className="flex-1 flex flex-col gap-1">
          <span className="text-[11px] text-[#999]">Icon</span>
          <select
            value={icon}
            onChange={e => setIcon(e.target.value)}
            className="bg-[#2a2d2e] border border-[#3c3c3c] text-[#d4d4d4] text-xs rounded px-2 py-1.5 focus:border-[#D97706] outline-none"
          >
            {ICON_OPTIONS.map(i => <option key={i} value={i}>{i.replace('fa-solid fa-', '')}</option>)}
          </select>
        </label>
        <label className="flex-1 flex flex-col gap-1">
          <span className="text-[11px] text-[#999]">Layout</span>
          <select
            value={layout}
            onChange={e => setLayout(e.target.value as WorkflowLayout)}
            className="bg-[#2a2d2e] border border-[#3c3c3c] text-[#d4d4d4] text-xs rounded px-2 py-1.5 focus:border-[#D97706] outline-none"
          >
            <option value="vertical">Vertical splits</option>
            <option value="quad">2×2 grid (needs 4 terminals)</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] text-[#999]">Terminals ({terminals.length})</span>
        <button
          className="text-[10px] px-2 py-0.5 rounded bg-[#37373d] hover:bg-[#3c3c3c] text-[#d4d4d4] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={addTerminal}
          disabled={terminals.length >= 8}
        >
          + Add terminal
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {terminals.map((t, idx) => (
          <div key={idx} className="bg-[#2a2d2e] border border-[#3c3c3c] rounded p-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={t.name}
                onChange={e => updateTerminal(idx, { name: e.target.value })}
                placeholder="Terminal name"
                className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] text-[#d4d4d4] text-xs rounded px-2 py-1 focus:border-[#D97706] outline-none"
              />
              <select
                value={t.shell}
                onChange={e => updateTerminal(idx, { shell: e.target.value })}
                className="bg-[#1e1e1e] border border-[#3c3c3c] text-[#d4d4d4] text-xs rounded px-2 py-1 focus:border-[#D97706] outline-none"
              >
                {SHELL_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <button
                className="text-[#999] hover:text-[#ef9a9a] text-xs px-1 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => removeTerminal(idx)}
                disabled={terminals.length <= 1}
                aria-label={`Remove terminal ${idx + 1}`}
              >
                <i className="fa-solid fa-trash"></i>
              </button>
            </div>
            <input
              type="text"
              value={t.command}
              onChange={e => updateTerminal(idx, { command: e.target.value })}
              placeholder="Startup command (optional) — e.g. claude, npm run dev"
              className="bg-[#1e1e1e] border border-[#3c3c3c] text-[#d4d4d4] text-xs rounded px-2 py-1 focus:border-[#D97706] outline-none"
            />
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[#999] mr-1">Color</span>
              {COLOR_SWATCHES.map(c => (
                <button
                  key={c}
                  className={`w-4 h-4 rounded-full border-2 ${t.color === c ? 'border-white' : 'border-transparent'} cursor-pointer`}
                  style={{ backgroundColor: c }}
                  onClick={() => updateTerminal(idx, { color: c })}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 mt-2">
        <button
          className="px-3 py-1.5 text-xs text-[#d4d4d4] hover:bg-[#37373d] rounded cursor-pointer"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="px-3 py-1.5 bg-[#D97706] hover:bg-[#b45309] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded cursor-pointer transition-colors"
          onClick={handleSave}
          disabled={!canSave}
        >
          {initial ? 'Save changes' : 'Create workflow'}
        </button>
      </div>
    </div>
  )
}

interface Props {
  onClose: () => void
}

export function WorkflowTemplates({ onClose }: Props) {
  const { terminals, removeTerminal, addTerminal, setPaneTree, setActiveTerminal } = useTerminalStore()
  const toggleViewMode = useTerminalStore(s => s.toggleViewMode)
  const viewMode = useTerminalStore(s => s.viewMode)
  const userWorkflows = useTerminalStore(s => s.userWorkflows)
  const addUserWorkflow = useTerminalStore(s => s.addUserWorkflow)
  const updateUserWorkflow = useTerminalStore(s => s.updateUserWorkflow)
  const removeUserWorkflow = useTerminalStore(s => s.removeUserWorkflow)

  const [editing, setEditing] = useState<WorkflowTemplate | null>(null)
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list')

  const handleLaunch = async (template: WorkflowTemplate) => {
    for (const t of terminals) {
      window.termpolis.killTerminal(t.id)
      removeTerminal(t.id)
    }

    const cwd = await getHomedir()
    const newIds: string[] = []

    for (const tmpl of template.terminals) {
      const id = uuid()
      newIds.push(id)
      const shellType = resolveShell(tmpl.shell)
      const res = await window.termpolis.createTerminal(id, shellType, cwd)
      if (!res.success) continue
      addTerminal({
        id,
        name: tmpl.name,
        color: tmpl.color,
        shellType,
        cwd,
        ...getTerminalDefaults(),
      })
    }

    if (viewMode !== 'split') {
      toggleViewMode()
    }

    const tree = buildLayoutTree(newIds, template.layout)
    setPaneTree(tree)

    if (newIds.length > 0) {
      setActiveTerminal(newIds[0])
    }

    // Guard against jsdom teardown in tests: onClose() unmounts the component
    // and this timer fires ~500ms later, after vitest has torn down the window.
    setTimeout(() => {
      if (typeof window === 'undefined' || !window.termpolis?.writeToTerminal) return
      for (let i = 0; i < template.terminals.length; i++) {
        const tmpl = template.terminals[i]
        const id = newIds[i]
        if (tmpl.command && id) {
          window.termpolis.writeToTerminal(id, tmpl.command + '\r')
        }
      }
    }, 500)

    onClose()
  }

  const handleCreate = (workflow: WorkflowTemplate) => {
    addUserWorkflow(workflow)
    setMode('list')
    setEditing(null)
  }

  const handleSaveEdit = (workflow: WorkflowTemplate) => {
    updateUserWorkflow(workflow.id, workflow)
    setMode('list')
    setEditing(null)
  }

  const handleDuplicate = (template: WorkflowTemplate) => {
    setEditing({ ...template, id: '', name: `${template.name} (copy)` })
    setMode('create')
  }

  const handleDelete = (id: string) => {
    removeUserWorkflow(id)
  }

  const allWorkflows: WorkflowTemplate[] = [...BUILT_IN_WORKFLOWS, ...userWorkflows]

  const headerTitle =
    mode === 'create' ? 'New Workflow' :
    mode === 'edit' ? 'Edit Workflow' :
    'Workflow Templates'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fadeIn" onClick={onClose}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-xl w-[560px] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <h2 className="text-sm font-semibold text-[#d4d4d4] flex items-center gap-2">
            {mode !== 'list' && (
              <button
                className="text-[#999] hover:text-white cursor-pointer"
                onClick={() => { setMode('list'); setEditing(null) }}
                aria-label="Back to workflow list"
              >
                <i className="fa-solid fa-arrow-left"></i>
              </button>
            )}
            <i className="fa-solid fa-cubes text-[#D97706]"></i>
            {headerTitle}
          </h2>
          <button
            className="text-[#999] hover:text-white text-sm cursor-pointer"
            onClick={onClose}
            aria-label="Close workflows"
          >
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        {mode === 'list' && (
          <>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {allWorkflows.map(template => (
                <div
                  key={template.id}
                  className="bg-[#2a2d2e] border border-[#3c3c3c] rounded-lg p-4 hover:border-[#555] transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-[#37373d] flex items-center justify-center shrink-0">
                      <i className={`${template.icon} text-lg text-[#D97706]`}></i>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[#d4d4d4] flex items-center gap-2">
                        {template.name}
                        {template.isCustom && (
                          <span className="text-[9px] uppercase tracking-wide text-[#22D3EE] border border-[#22D3EE]/40 rounded px-1 py-px">
                            Custom
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[#888] mt-0.5">{template.description || 'No description'}</div>
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {template.terminals.map((t, i) => (
                          <span
                            key={i}
                            className="text-[10px] px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: t.color + '22', color: t.color, border: `1px solid ${t.color}44` }}
                          >
                            {t.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col gap-1">
                      <button
                        className="px-3 py-1.5 bg-[#D97706] hover:bg-[#b45309] text-white text-xs font-medium rounded cursor-pointer transition-colors"
                        onClick={() => handleLaunch(template)}
                      >
                        Launch
                      </button>
                      {template.isCustom ? (
                        <div className="flex gap-1">
                          <button
                            className="flex-1 px-2 py-1 text-[10px] text-[#d4d4d4] hover:bg-[#37373d] rounded cursor-pointer"
                            onClick={() => { setEditing(template); setMode('edit') }}
                            aria-label={`Edit ${template.name}`}
                          >
                            <i className="fa-solid fa-pen"></i>
                          </button>
                          <button
                            className="flex-1 px-2 py-1 text-[10px] text-[#ef9a9a] hover:bg-[#37373d] rounded cursor-pointer"
                            onClick={() => handleDelete(template.id)}
                            aria-label={`Delete ${template.name}`}
                          >
                            <i className="fa-solid fa-trash"></i>
                          </button>
                        </div>
                      ) : (
                        <button
                          className="px-2 py-1 text-[10px] text-[#999] hover:text-[#d4d4d4] hover:bg-[#37373d] rounded cursor-pointer"
                          onClick={() => handleDuplicate(template)}
                          title="Duplicate to customize"
                        >
                          <i className="fa-solid fa-copy"></i> Duplicate
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <button
                className="mt-1 bg-[#2a2d2e] border border-dashed border-[#555] text-[#d4d4d4] text-sm rounded-lg p-3 hover:border-[#D97706] hover:bg-[#37373d] cursor-pointer transition-colors"
                onClick={() => { setEditing(null); setMode('create') }}
              >
                <i className="fa-solid fa-plus mr-2"></i>
                New Workflow
              </button>
            </div>
            <div className="px-4 py-2 border-t border-[#3c3c3c] text-[10px] text-[#999]">
              Launching a workflow will close all current terminals. Custom workflows save to your session.
            </div>
          </>
        )}

        {mode === 'create' && (
          <WorkflowEditor
            initial={editing ?? undefined}
            onSave={handleCreate}
            onCancel={() => { setMode('list'); setEditing(null) }}
          />
        )}

        {mode === 'edit' && editing && (
          <WorkflowEditor
            initial={editing}
            onSave={handleSaveEdit}
            onCancel={() => { setMode('list'); setEditing(null) }}
          />
        )}
      </div>
    </div>
  )
}
