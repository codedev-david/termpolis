import { useState, useEffect } from 'react'
import type { HistoryEntry } from '../../types'
import { copyText } from '../../lib/clipboard'

interface Props {
  onClose: () => void
}

export function HistorySearchModal({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HistoryEntry[]>([])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(async () => {
      const res = await window.termpolis.searchHistory(query)
      if (res.success && res.data) setResults(res.data)
    }, 150)
    return () => clearTimeout(timer)
  }, [query])

  const handleSelect = (entry: HistoryEntry) => {
    void copyText(entry.command)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center pt-24 z-50 animate-fadeIn">
      <div className="bg-[#252526] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden">
        <div className="p-3 border-b border-[#3c3c3c]">
          <input
            autoFocus
            placeholder="Search command history…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#0078d4]"
          />
        </div>
        <div className="overflow-y-auto max-h-80">
          {results.length === 0 && query && (
            <p className="text-center text-sm text-[#9ca3af] py-6">No results for "{query}"</p>
          )}
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => handleSelect(r)}
              className="w-full text-left flex items-center gap-3 px-4 py-2 hover:bg-[#37373d] border-b border-[#2d2d2d]"
            >
              <code className="flex-1 text-sm font-mono text-[#d4d4d4] truncate">{r.command}</code>
              <span className="text-xs text-[#9ca3af] shrink-0">{r.terminalName}</span>
              <span className="text-xs text-[#4b5563] shrink-0">{new Date(r.timestamp).toLocaleTimeString()}</span>
            </button>
          ))}
        </div>
        <div className="px-4 py-2 text-xs text-[#9ca3af] border-t border-[#3c3c3c]">
          Click a result to copy to clipboard • Esc to close
        </div>
      </div>
    </div>
  )
}
