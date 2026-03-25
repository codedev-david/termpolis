import React from 'react'
import { v4 as uuid } from 'uuid'
import { useTerminalStore } from '../../store/terminalStore'
import { getHomedir } from '../../lib/homedir'
import { TERMINAL_DEFAULTS } from '../../lib/terminalDefaults'
import type { PaneNode, ShellType } from '../../types'

interface TemplateTerminal {
  name: string
  command: string
  shell: string
  color: string
}

interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  terminals: TemplateTerminal[]
  layout: 'vertical' | 'quad'
}

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
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

function buildLayoutTree(terminalIds: string[], layout: 'vertical' | 'quad'): PaneNode | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return { type: 'terminal', terminalId: terminalIds[0] }

  if (layout === 'vertical' || terminalIds.length === 2) {
    // Vertical split: left | right
    const mid = Math.ceil(terminalIds.length / 2)
    const left = buildLayoutTree(terminalIds.slice(0, mid), 'vertical')
    const right = buildLayoutTree(terminalIds.slice(mid), 'vertical')
    if (!left) return right
    if (!right) return left
    return {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [left, right],
    }
  }

  if (layout === 'quad' && terminalIds.length === 4) {
    // 2x2 grid: top row | bottom row
    const topLeft: PaneNode = { type: 'terminal', terminalId: terminalIds[0] }
    const topRight: PaneNode = { type: 'terminal', terminalId: terminalIds[1] }
    const bottomLeft: PaneNode = { type: 'terminal', terminalId: terminalIds[2] }
    const bottomRight: PaneNode = { type: 'terminal', terminalId: terminalIds[3] }
    return {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { type: 'split', direction: 'horizontal', ratio: 0.5, children: [topLeft, topRight] },
        { type: 'split', direction: 'horizontal', ratio: 0.5, children: [bottomLeft, bottomRight] },
      ],
    }
  }

  // Fallback: balanced binary tree with horizontal splits
  const mid = Math.ceil(terminalIds.length / 2)
  const left = buildLayoutTree(terminalIds.slice(0, mid), 'vertical')
  const right = buildLayoutTree(terminalIds.slice(mid), 'vertical')
  if (!left) return right
  if (!right) return left
  return {
    type: 'split',
    direction: 'horizontal',
    ratio: 0.5,
    children: [left, right],
  }
}

interface Props {
  onClose: () => void
}

export function WorkflowTemplates({ onClose }: Props) {
  const { terminals, removeTerminal, addTerminal, setPaneTree, setActiveTerminal } = useTerminalStore()
  const toggleViewMode = useTerminalStore(s => s.toggleViewMode)
  const viewMode = useTerminalStore(s => s.viewMode)

  const handleLaunch = async (template: WorkflowTemplate) => {
    // 1. Kill all existing terminals
    for (const t of terminals) {
      window.termpolis.killTerminal(t.id)
      removeTerminal(t.id)
    }

    const cwd = await getHomedir()
    const newIds: string[] = []

    // 2. Create new terminals
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
        fontSize: TERMINAL_DEFAULTS.fontSize,
        theme: TERMINAL_DEFAULTS.theme,
        fontFamily: TERMINAL_DEFAULTS.fontFamily,
      })
    }

    // 3. Switch to split view if not already
    if (viewMode !== 'split') {
      toggleViewMode()
    }

    // 4. Build and set the pane tree
    const tree = buildLayoutTree(newIds, template.layout)
    setPaneTree(tree)

    // 5. Set active terminal to first
    if (newIds.length > 0) {
      setActiveTerminal(newIds[0])
    }

    // 6. Send startup commands after a short delay
    setTimeout(() => {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fadeIn" onClick={onClose}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-xl w-[480px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <h2 className="text-sm font-semibold text-[#d4d4d4]">
            <i className="fa-solid fa-cubes mr-2 text-[#D97706]"></i>
            Workflow Templates
          </h2>
          <button
            className="text-[#999] hover:text-white text-sm cursor-pointer"
            onClick={onClose}
          >
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {WORKFLOW_TEMPLATES.map(template => (
            <div
              key={template.id}
              className="bg-[#2a2d2e] border border-[#3c3c3c] rounded-lg p-4 hover:border-[#555] transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-[#37373d] flex items-center justify-center shrink-0">
                  <i className={`${template.icon} text-lg text-[#D97706]`}></i>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#d4d4d4]">{template.name}</div>
                  <div className="text-xs text-[#888] mt-0.5">{template.description}</div>
                  <div className="flex items-center gap-1.5 mt-2">
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
                <button
                  className="shrink-0 px-3 py-1.5 bg-[#D97706] hover:bg-[#b45309] text-white text-xs font-medium rounded cursor-pointer transition-colors"
                  onClick={() => handleLaunch(template)}
                >
                  Launch
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-[#3c3c3c] text-[10px] text-[#999]">
          Launching a workflow will close all current terminals.
        </div>
      </div>
    </div>
  )
}
