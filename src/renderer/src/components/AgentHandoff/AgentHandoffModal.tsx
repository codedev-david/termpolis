import React, { useState, useEffect } from 'react'
import type { HandoffContext } from '../../lib/contextCapture'
import { formatHandoffPrompt } from '../../lib/contextCapture'

interface Props {
  context: HandoffContext
  onConfirm: (agent: string, prompt: string, keepOldTerminal: boolean) => void
  onCancel: () => void
}

const AGENT_OPTIONS = [
  { name: 'Claude Code', command: 'claude', icon: 'fa-solid fa-robot', color: '#D97706' },
  { name: 'Codex', command: 'codex', icon: 'fa-solid fa-microchip', color: '#10B981' },
  { name: 'Gemini', command: 'gemini', icon: 'fa-brands fa-google', color: '#4285F4' },
  { name: 'Aider', command: 'aider', icon: 'fa-solid fa-code', color: '#8B5CF6' },
]

export function AgentHandoffModal({ context, onConfirm, onCancel }: Props) {
  const [selectedAgent, setSelectedAgent] = useState('')
  const [prompt, setPrompt] = useState('')
  const [keepOldTerminal, setKeepOldTerminal] = useState(true)

  // Filter out the previous agent and pre-select first available
  const availableAgents = AGENT_OPTIONS.filter(
    a => a.name.toLowerCase() !== context.previousAgent.toLowerCase()
  )

  useEffect(() => {
    setPrompt(formatHandoffPrompt(context))
    if (availableAgents.length > 0 && !selectedAgent) {
      setSelectedAgent(availableAgents[0].command)
    }
  }, [context])

  // Escape to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col"
        style={{ backgroundColor: '#1e1e1e', border: '1px solid #454545' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-3 rounded-t-lg"
          style={{ backgroundColor: '#78350f', borderBottom: '1px solid #a16207' }}
        >
          <i className="fa-solid fa-right-left" style={{ color: '#fbbf24' }}></i>
          <span className="text-sm font-medium" style={{ color: '#fde68a' }}>
            Switch AI Agent
          </span>
          <span className="text-xs ml-auto" style={{ color: '#d97706' }}>
            {context.previousAgent} ran out of context
          </span>
        </div>

        {/* Agent selection */}
        <div className="px-4 py-3" style={{ borderBottom: '1px solid #333' }}>
          <label className="text-xs mb-2 block" style={{ color: '#999' }}>Switch to:</label>
          <div className="flex gap-2">
            {availableAgents.map(agent => (
              <button
                key={agent.command}
                className="px-3 py-1.5 rounded text-xs cursor-pointer flex items-center gap-1.5"
                style={{
                  backgroundColor: selectedAgent === agent.command ? agent.color + '33' : '#2d2d2d',
                  border: `1px solid ${selectedAgent === agent.command ? agent.color : '#454545'}`,
                  color: selectedAgent === agent.command ? agent.color : '#999',
                }}
                onClick={() => setSelectedAgent(agent.command)}
              >
                <i className={agent.icon}></i>
                {agent.name}
              </button>
            ))}
          </div>
        </div>

        {/* Context preview */}
        <div className="px-4 py-3 flex-1 min-h-0 overflow-hidden flex flex-col">
          <label className="text-xs mb-2 block" style={{ color: '#999' }}>
            Handoff prompt (editable):
          </label>
          <textarea
            className="flex-1 w-full rounded p-2 text-xs font-mono resize-none min-h-[200px]"
            style={{
              backgroundColor: '#0d1117',
              color: '#c9d1d9',
              border: '1px solid #333',
              outline: 'none',
            }}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            spellCheck={false}
          />
        </div>

        {/* Options */}
        <div className="px-4 py-2" style={{ borderTop: '1px solid #333' }}>
          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: '#999' }}>
            <input
              type="checkbox"
              checked={keepOldTerminal}
              onChange={e => setKeepOldTerminal(e.target.checked)}
              className="accent-amber-600"
            />
            Keep old terminal open for reference
          </label>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 rounded-b-lg" style={{ borderTop: '1px solid #333' }}>
          <button
            className="px-3 py-1.5 rounded text-xs cursor-pointer"
            style={{ backgroundColor: '#2d2d2d', color: '#999', border: '1px solid #454545' }}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 rounded text-xs cursor-pointer font-medium"
            style={{ backgroundColor: '#d97706', color: '#fff', border: 'none' }}
            onMouseEnter={e => { (e.target as HTMLElement).style.backgroundColor = '#b45309' }}
            onMouseLeave={e => { (e.target as HTMLElement).style.backgroundColor = '#d97706' }}
            onClick={() => {
              if (selectedAgent) onConfirm(selectedAgent, prompt, keepOldTerminal)
            }}
            disabled={!selectedAgent}
          >
            <i className="fa-solid fa-right-left mr-1"></i>
            Switch Agent
          </button>
        </div>
      </div>
    </div>
  )
}
