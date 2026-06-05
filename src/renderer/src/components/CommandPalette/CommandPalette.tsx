import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import type { PromptTemplate } from '../../types'

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  { id: 'fix-tests', name: 'Fix Tests', text: 'Fix the failing tests and explain what was wrong', icon: 'fa-solid fa-bug' },
  { id: 'review', name: 'Code Review', text: 'Review this code for bugs, security issues, and improvements', icon: 'fa-solid fa-magnifying-glass' },
  { id: 'explain', name: 'Explain Code', text: 'Explain what this code does step by step', icon: 'fa-solid fa-book' },
  { id: 'refactor', name: 'Refactor', text: 'Refactor this code to be cleaner and more maintainable', icon: 'fa-solid fa-wand-magic-sparkles' },
  { id: 'test', name: 'Write Tests', text: 'Write comprehensive tests for this code', icon: 'fa-solid fa-flask' },
  { id: 'docs', name: 'Add Docs', text: 'Add documentation and comments to this code', icon: 'fa-solid fa-file-lines' },
]

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
  { pattern: /show\s*swarm/i, action: 'show_swarm', label: 'Swarm Dashboard', description: 'Open the multi-agent swarm dashboard', icon: 'fa-solid fa-network-wired' },
  { pattern: /memory|remember|brain/i, action: 'show_memory', label: 'Memory', description: 'Open the persistent shared-memory panel', icon: 'fa-solid fa-brain' },
  { pattern: /launch\s*claude/i, action: 'launch_claude', label: 'Launch Claude', description: 'Launch Claude Code AI agent', icon: 'fa-solid fa-robot' },
  { pattern: /launch\s*codex/i, action: 'launch_codex', label: 'Launch Codex', description: 'Launch OpenAI Codex agent', icon: 'fa-solid fa-microchip' },
  { pattern: /launch\s*gemini/i, action: 'launch_gemini', label: 'Launch Gemini', description: 'Launch Gemini CLI agent', icon: 'fa-brands fa-google' },
  { pattern: /run\s+(.+)/i, action: 'run_command', capture: true, label: 'Run Command', description: 'Execute a command in active terminal', icon: 'fa-solid fa-terminal' },
]

interface Props {
  onAction: (action: string, captured?: string) => void
  onClose: () => void
}

export function CommandPalette({ onAction, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const storeTemplates = useTerminalStore(s => s.promptTemplates)
  const terminals = useTerminalStore(s => s.terminals).filter(t => !t.hidden)

  // Merge default + custom prompt templates
  const allTemplates = useMemo(() => {
    const customs = storeTemplates.filter(t => t.isCustom)
    return [...DEFAULT_TEMPLATES, ...customs]
  }, [storeTemplates])

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
    const lower = query.trim().toLowerCase()

    // Build command matches
    let commandResults: (CommandAction & { captured?: string })[] = []
    if (!lower) {
      commandResults = COMMAND_PATTERNS.map(cmd => ({ ...cmd, captured: undefined as string | undefined }))
    } else {
      for (const cmd of COMMAND_PATTERNS) {
        const m = cmd.pattern.exec(query)
        if (m) {
          commandResults.push({ ...cmd, captured: cmd.capture ? m[1] : undefined })
        }
      }
      if (commandResults.length === 0) {
        for (const cmd of COMMAND_PATTERNS) {
          if (cmd.label.toLowerCase().includes(lower) || cmd.description.toLowerCase().includes(lower)) {
            commandResults.push({ ...cmd, captured: undefined })
          }
        }
      }
    }

    // Build prompt template matches
    const templateResults = allTemplates
      .filter(t => !lower || t.name.toLowerCase().includes(lower) || t.text.toLowerCase().includes(lower))
      .map(t => ({
        pattern: /.*/ as RegExp,
        action: `insert_prompt:${t.id}`,
        label: t.name,
        description: t.text.slice(0, 60) + (t.text.length > 60 ? '...' : ''),
        icon: t.icon,
        captured: t.text,
      }))

    // Build terminal switch entries
    const terminalResults = terminals
      .filter(t => !lower || t.name.toLowerCase().includes(lower) || 'terminal'.includes(lower) || 'switch'.includes(lower))
      .map((t, i) => ({
        pattern: /.*/ as RegExp,
        action: `goto_terminal:${t.id}`,
        label: `${t.name}`,
        description: i < 9 ? `Alt+${i + 1}` : '',
        icon: 'fa-solid fa-terminal',
        captured: t.id,
      }))

    return [...commandResults, ...templateResults, ...terminalResults]
  }, [query, allTemplates, terminals])

  // Reset selection only when the query changes (not when matches recompute from store updates)
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  const executeMatch = (idx: number) => {
    const match = matches[idx]
    if (!match) return
    // Terminal switch — activate the selected terminal
    if (match.action.startsWith('goto_terminal:') && match.captured) {
      useTerminalStore.getState().setActiveTerminal(match.captured)
      onClose()
      return
    }
    // Prompt template insertion — type the text into the active terminal
    if (match.action.startsWith('insert_prompt:') && match.captured) {
      const terminalId = useTerminalStore.getState().activeTerminalId
      if (terminalId) {
        window.termpolis.writeToTerminal(terminalId, match.captured)
      }
      onClose()
      return
    }
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
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-20 z-50 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-[#252526] rounded-lg shadow-2xl flex flex-col overflow-hidden border border-[#3c3c3c]"
        style={{ width: 500 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#3c3c3c]">
          <i className="fa-solid fa-magnifying-glass text-[#9ca3af] text-sm"></i>
          <input
            ref={inputRef}
            autoFocus
            placeholder="Type a command..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-sm text-[#d4d4d4] outline-none placeholder-[#9ca3af]"
          />
          <kbd className="text-[10px] text-[#9ca3af] bg-[#1e1e1e] rounded px-1.5 py-0.5 border border-[#3c3c3c]">Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto max-h-72">
          {matches.length === 0 && query && (
            <p className="text-center text-sm text-[#9ca3af] py-6">No matching command</p>
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
              <i className={`${match.icon} text-[12px] w-4 text-center text-[#9ca3af]`}></i>
              <span className="text-sm text-[#d4d4d4] flex-1">{match.label}</span>
              <span className="text-xs text-[#9ca3af]">{match.description}</span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-1.5 text-[10px] text-[#9ca3af] border-t border-[#3c3c3c] flex gap-3">
          <span><kbd className="bg-[#1e1e1e] rounded px-1 py-0.5 border border-[#3c3c3c]">Up/Down</kbd> navigate</span>
          <span><kbd className="bg-[#1e1e1e] rounded px-1 py-0.5 border border-[#3c3c3c]">Enter</kbd> execute</span>
          <span><kbd className="bg-[#1e1e1e] rounded px-1 py-0.5 border border-[#3c3c3c]">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
