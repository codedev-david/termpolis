import React, { useState, useEffect, useRef, useMemo } from 'react'

interface CommandAction {
  pattern: RegExp
  action: string
  capture?: boolean
  label: string
  description: string
  icon: string
}

const COMMAND_PATTERNS: CommandAction[] = [
  { pattern: /new\s*(terminal|term|shell)/i, action: 'create_terminal', label: 'New Terminal', description: 'Open the Add Terminal modal', icon: 'fa-solid fa-plus' },
  { pattern: /split\s*(right|horizontal)/i, action: 'split_right', label: 'Split Right', description: 'Split active terminal horizontally', icon: 'fa-solid fa-arrows-left-right' },
  { pattern: /split\s*(down|vertical)/i, action: 'split_down', label: 'Split Down', description: 'Split active terminal vertically', icon: 'fa-solid fa-arrows-up-down' },
  { pattern: /close\s*(terminal|term|this)/i, action: 'close_terminal', label: 'Close Terminal', description: 'Close the active terminal', icon: 'fa-solid fa-xmark' },
  { pattern: /toggle\s*(sidebar|side\s*bar)/i, action: 'toggle_sidebar', label: 'Toggle Sidebar', description: 'Show or hide the sidebar', icon: 'fa-solid fa-bars' },
  { pattern: /toggle\s*(split|grid)/i, action: 'toggle_split', label: 'Toggle Split View', description: 'Switch between tabs and split view', icon: 'fa-solid fa-columns' },
  { pattern: /open\s*settings/i, action: 'open_settings', label: 'Open Settings', description: 'Open the settings panel', icon: 'fa-solid fa-gear' },
  { pattern: /search\s*history/i, action: 'search_history', label: 'Search History', description: 'Search command history', icon: 'fa-solid fa-clock-rotate-left' },
  { pattern: /save\s*workspace/i, action: 'save_workspace', label: 'Save Workspace', description: 'Save current terminal layout', icon: 'fa-solid fa-floppy-disk' },
  { pattern: /export\s*(output|terminal)/i, action: 'export_output', label: 'Export Output', description: 'Export terminal output to file', icon: 'fa-solid fa-file-export' },
  { pattern: /record\s*(start|session)/i, action: 'start_recording', label: 'Start Recording', description: 'Start recording terminal session', icon: 'fa-solid fa-circle text-red-400' },
  { pattern: /show\s*(context|files|panel)/i, action: 'show_context', label: 'Show Context Panel', description: 'Toggle the context panel', icon: 'fa-solid fa-folder-open' },
  { pattern: /show\s*(prompts?|templates?)/i, action: 'show_prompts', label: 'Show Prompts', description: 'Open prompt templates', icon: 'fa-solid fa-message' },
  { pattern: /launch\s*claude/i, action: 'launch_claude', label: 'Launch Claude', description: 'Launch Claude Code AI agent', icon: 'fa-solid fa-robot' },
  { pattern: /launch\s*codex/i, action: 'launch_codex', label: 'Launch Codex', description: 'Launch OpenAI Codex agent', icon: 'fa-solid fa-microchip' },
  { pattern: /run\s+(.+)/i, action: 'run_command', capture: true, label: 'Run Command', description: 'Execute a command in active terminal', icon: 'fa-solid fa-terminal' },
  { pattern: /go\s*to\s*terminal\s*(\d)/i, action: 'goto_terminal', capture: true, label: 'Go to Terminal', description: 'Switch to terminal by number', icon: 'fa-solid fa-arrow-right' },
]

interface Props {
  onAction: (action: string, captured?: string) => void
  onClose: () => void
}

export function CommandPalette({ onAction, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const matches = useMemo(() => {
    if (!query.trim()) {
      // Show all commands when empty
      return COMMAND_PATTERNS.map(cmd => ({ ...cmd, captured: undefined as string | undefined }))
    }
    const results: (CommandAction & { captured?: string })[] = []
    for (const cmd of COMMAND_PATTERNS) {
      const m = cmd.pattern.exec(query)
      if (m) {
        results.push({ ...cmd, captured: cmd.capture ? m[1] : undefined })
      }
    }
    // Also do a fuzzy label match if no regex matched
    if (results.length === 0) {
      const lower = query.toLowerCase()
      for (const cmd of COMMAND_PATTERNS) {
        if (cmd.label.toLowerCase().includes(lower) || cmd.description.toLowerCase().includes(lower)) {
          results.push({ ...cmd, captured: undefined })
        }
      }
    }
    return results
  }, [query])

  // Reset selection when matches change
  useEffect(() => {
    setSelectedIndex(0)
  }, [matches])

  const executeMatch = (idx: number) => {
    const match = matches[idx]
    if (!match) return
    onAction(match.action, match.captured)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => (prev < matches.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : matches.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      executeMatch(selectedIndex)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-20 z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#252526] rounded-lg shadow-2xl flex flex-col overflow-hidden border border-[#3c3c3c]"
        style={{ width: 500 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#3c3c3c]">
          <i className="fa-solid fa-magnifying-glass text-[#6b7280] text-sm"></i>
          <input
            ref={inputRef}
            autoFocus
            placeholder="Type a command..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-sm text-[#d4d4d4] outline-none placeholder-[#6b7280]"
          />
          <kbd className="text-[10px] text-[#6b7280] bg-[#1e1e1e] rounded px-1.5 py-0.5 border border-[#3c3c3c]">Esc</kbd>
        </div>

        {/* Results */}
        <div className="overflow-y-auto max-h-72">
          {matches.length === 0 && query && (
            <p className="text-center text-sm text-[#6b7280] py-6">No matching command</p>
          )}
          {matches.map((match, i) => (
            <button
              key={match.action + i}
              className={`w-full text-left flex items-center gap-3 px-4 py-2 cursor-pointer ${
                i === selectedIndex ? 'bg-[#094771]' : 'hover:bg-[#37373d]'
              }`}
              onClick={() => executeMatch(i)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <i className={`${match.icon} text-[12px] w-4 text-center text-[#6b7280]`}></i>
              <span className="text-sm text-[#d4d4d4] flex-1">{match.label}</span>
              <span className="text-xs text-[#6b7280]">{match.description}</span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-1.5 text-[10px] text-[#6b7280] border-t border-[#3c3c3c] flex gap-3">
          <span><kbd className="bg-[#1e1e1e] rounded px-1 py-0.5 border border-[#3c3c3c]">Up/Down</kbd> navigate</span>
          <span><kbd className="bg-[#1e1e1e] rounded px-1 py-0.5 border border-[#3c3c3c]">Enter</kbd> execute</span>
          <span><kbd className="bg-[#1e1e1e] rounded px-1 py-0.5 border border-[#3c3c3c]">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
