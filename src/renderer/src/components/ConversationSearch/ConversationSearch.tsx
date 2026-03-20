import React, { useState, useEffect, useMemo } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import type { ConversationTurn } from '../../lib/conversationParser'

interface Props {
  onClose: () => void
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[#d97706] text-[#1e1e1e] rounded px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}

export function ConversationSearch({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const conversations = useTerminalStore(s => s.conversations)
  const setActiveTerminal = useTerminalStore(s => s.setActiveTerminal)

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

  // Search across all conversation turns
  const results = useMemo(() => {
    if (!query.trim()) return []
    const lower = query.toLowerCase()
    const matched: ConversationTurn[] = []
    for (const conv of conversations) {
      for (const turn of conv.turns) {
        if (turn.content.toLowerCase().includes(lower)) {
          matched.push(turn)
        }
      }
    }
    // Limit to 50 results
    return matched.slice(0, 50)
  }, [query, conversations])

  // Group results by terminal
  const grouped = useMemo(() => {
    const map = new Map<string, { terminalName: string; agentName: string; turns: ConversationTurn[] }>()
    for (const turn of results) {
      let group = map.get(turn.terminalId)
      if (!group) {
        group = { terminalName: turn.terminalName, agentName: turn.agentName, turns: [] }
        map.set(turn.terminalId, group)
      }
      group.turns.push(turn)
    }
    return Array.from(map.entries())
  }, [results])

  const handleSelect = (terminalId: string) => {
    setActiveTerminal(terminalId)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-20 z-50 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-[#252526] rounded-lg shadow-2xl flex flex-col overflow-hidden border border-[#3c3c3c]"
        style={{ width: 600 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#3c3c3c]">
          <i className="fa-solid fa-comments text-[#6b7280] text-sm"></i>
          <input
            autoFocus
            placeholder="Search AI conversations..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-[#d4d4d4] outline-none placeholder-[#6b7280]"
          />
          <kbd className="text-[10px] text-[#6b7280] bg-[#1e1e1e] rounded px-1.5 py-0.5 border border-[#3c3c3c]">Esc</kbd>
        </div>

        {/* Results */}
        <div className="overflow-y-auto max-h-96">
          {query && results.length === 0 && (
            <p className="text-center text-sm text-[#6b7280] py-6">No matching conversations</p>
          )}
          {!query && conversations.length === 0 && (
            <p className="text-center text-sm text-[#6b7280] py-6">No AI conversations indexed yet</p>
          )}
          {!query && conversations.length > 0 && (
            <p className="text-center text-sm text-[#6b7280] py-6">
              {conversations.reduce((sum, c) => sum + c.turns.length, 0)} turns across {conversations.length} conversation{conversations.length !== 1 ? 's' : ''} -- type to search
            </p>
          )}
          {grouped.map(([terminalId, group]) => (
            <div key={terminalId} className="border-b border-[#2d2d2d]">
              {/* Group header */}
              <div className="px-4 py-1.5 bg-[#1e1e1e] flex items-center gap-2">
                <i className="fa-solid fa-robot text-[10px] text-[#d97706]"></i>
                <span className="text-xs font-medium text-[#d4d4d4]">{group.agentName}</span>
                <span className="text-xs text-[#6b7280]">in {group.terminalName}</span>
              </div>
              {/* Matched turns */}
              {group.turns.map((turn, i) => (
                <button
                  key={i}
                  className="w-full text-left flex items-start gap-3 px-4 py-2 hover:bg-[#37373d] cursor-pointer"
                  onClick={() => handleSelect(terminalId)}
                >
                  <span className={`text-[10px] mt-0.5 shrink-0 rounded px-1 py-0.5 font-medium ${
                    turn.role === 'user'
                      ? 'bg-[#1e3a5f] text-[#82aaff]'
                      : 'bg-[#2d4a1e] text-[#a3d977]'
                  }`}>
                    {turn.role === 'user' ? 'You' : 'AI'}
                  </span>
                  <span className="text-xs text-[#d4d4d4] flex-1 leading-relaxed">
                    {highlightMatch(truncate(turn.content, 200), query)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-1.5 text-[10px] text-[#6b7280] border-t border-[#3c3c3c]">
          Click a result to switch to that terminal -- Esc to close
        </div>
      </div>
    </div>
  )
}
