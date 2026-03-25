import React, { useState, useEffect } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { v4 as uuid } from 'uuid'
import type { PromptTemplate } from '../../types'

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  { id: 'fix-tests', name: 'Fix Tests', text: 'Fix the failing tests and explain what was wrong', icon: 'fa-solid fa-bug' },
  { id: 'review', name: 'Code Review', text: 'Review this code for bugs, security issues, and improvements', icon: 'fa-solid fa-magnifying-glass' },
  { id: 'explain', name: 'Explain Code', text: 'Explain what this code does step by step', icon: 'fa-solid fa-book' },
  { id: 'refactor', name: 'Refactor', text: 'Refactor this code to be cleaner and more maintainable', icon: 'fa-solid fa-wand-magic-sparkles' },
  { id: 'test', name: 'Write Tests', text: 'Write comprehensive tests for this code', icon: 'fa-solid fa-flask' },
  { id: 'docs', name: 'Add Docs', text: 'Add documentation and comments to this code', icon: 'fa-solid fa-file-lines' },
]

interface AddTemplateFormProps {
  onSave: (template: PromptTemplate) => void
  onCancel: () => void
}

function AddTemplateForm({ onSave, onCancel }: AddTemplateFormProps) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !text.trim()) return
    onSave({
      id: uuid(),
      name: name.trim(),
      text: text.trim(),
      icon: 'fa-solid fa-message',
      isCustom: true,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 p-3 border-t border-[#3c3c3c]">
      <input
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#22D3EE]"
        placeholder="Template name"
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />
      <textarea
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#22D3EE] resize-none"
        placeholder="Prompt text..."
        rows={3}
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1 text-xs rounded hover:bg-[#37373d] text-[#9ca3af]">Cancel</button>
        <button type="submit" className="px-3 py-1 text-xs rounded bg-[#22D3EE] text-[#1e1e1e] font-medium hover:bg-[#06b6d4]">Save</button>
      </div>
    </form>
  )
}

interface PromptTemplatesProps {
  onClose: () => void
}

export function PromptTemplates({ onClose }: PromptTemplatesProps) {
  const { activeTerminalId, promptTemplates, addPromptTemplate, removePromptTemplate } = useTerminalStore()
  const [showAdd, setShowAdd] = useState(false)

  const allTemplates = [...DEFAULT_TEMPLATES, ...promptTemplates]

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleInsert = (template: PromptTemplate) => {
    if (!activeTerminalId) {
      alert('No active terminal. Open a terminal first.')
      return
    }
    window.termpolis.writeToTerminal(activeTerminalId, template.text)
    onClose()
  }

  const handleAddTemplate = (template: PromptTemplate) => {
    addPromptTemplate(template)
    setShowAdd(false)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fadeIn" onClick={onClose}>
      <div
        className="bg-[#2d2d2d] rounded-lg w-[420px] max-h-[70vh] flex flex-col border border-[#3c3c3c] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-2">
            <i className="fa-solid fa-message text-[#22D3EE] text-sm"></i>
            <h2 className="text-sm font-semibold text-[#d4d4d4]">Prompt Templates</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="text-[#9ca3af] hover:text-[#22D3EE] text-xs px-2 py-1 rounded hover:bg-[#37373d]"
              onClick={() => setShowAdd(!showAdd)}
            >
              <i className="fa-solid fa-plus mr-1"></i>Add
            </button>
            <button className="text-[#9ca3af] hover:text-white px-2 py-1" onClick={onClose}>
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 gap-2">
          {allTemplates.map(template => {
            const isCustom = template.isCustom || promptTemplates.some(t => t.id === template.id)
            return (
              <div
                key={template.id}
                className="group relative bg-[#1e1e1e] rounded-lg p-3 hover:bg-[#37373d] cursor-pointer border border-[#3c3c3c] hover:border-[#22D3EE]/40 transition-colors"
                onClick={() => handleInsert(template)}
                title={template.text}
              >
                <div className="flex items-center gap-2 mb-1">
                  <i className={`${template.icon} text-[#22D3EE] text-xs`}></i>
                  <span className="text-xs font-medium text-[#d4d4d4]">{template.name}</span>
                </div>
                <p className="text-[10px] text-[#9ca3af] leading-tight line-clamp-2">{template.text}</p>
                {isCustom && (
                  <button
                    className="absolute top-1.5 right-1.5 text-[#9ca3af] hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100"
                    onClick={e => { e.stopPropagation(); removePromptTemplate(template.id) }}
                    title="Remove template"
                  >
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {showAdd && <AddTemplateForm onSave={handleAddTemplate} onCancel={() => setShowAdd(false)} />}

        <div className="px-4 py-2 border-t border-[#3c3c3c]">
          <p className="text-[10px] text-[#9ca3af]">Click a template to insert into the active terminal. <kbd className="bg-[#1e1e1e] px-1 rounded text-[9px]">Ctrl+Shift+P</kbd></p>
        </div>
      </div>
    </div>
  )
}
