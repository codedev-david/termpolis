import React, { useEffect, useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useTerminalStore } from '../../store/terminalStore'
import type { AISessionSummary, ShellType } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago'
  if (diff < 30 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd ago'
  return new Date(ts).toLocaleDateString()
}

function projectLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/') || cwd
}

export function PastAISessions({ open, onClose }: Props) {
  const [sessions, setSessions] = useState<AISessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const defaultShell = useTerminalStore(s => s.defaultShell)
  const addTerminal = useTerminalStore(s => s.addTerminal)
  const setActiveTerminal = useTerminalStore(s => s.setActiveTerminal)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    window.termpolis.listAISessions()
      .then(res => {
        if (res.success && res.data) setSessions(res.data)
        else setError(res.error || 'Failed to list sessions')
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const filtered = useMemo(() => {
    if (!filter.trim()) return sessions
    const q = filter.toLowerCase()
    return sessions.filter(s =>
      s.cwd.toLowerCase().includes(q)
      || (s.firstUserMessage || '').toLowerCase().includes(q)
      || (s.gitBranch || '').toLowerCase().includes(q)
      || s.id.toLowerCase().includes(q)
    )
  }, [sessions, filter])

  const grouped = useMemo(() => {
    const m = new Map<string, AISessionSummary[]>()
    for (const s of filtered) {
      const key = s.cwd
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(s)
    }
    return [...m.entries()].sort((a, b) => b[1][0].lastModified - a[1][0].lastModified)
  }, [filtered])

  const resume = async (session: AISessionSummary) => {
    const newId = uuidv4()
    addTerminal({
      id: newId,
      name: 'claude (resumed)',
      color: '#FF7F50',
      shellType: defaultShell as ShellType,
      cwd: session.cwd,
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'Consolas, Menlo, monospace',
      agentCommand: 'claude --resume ' + session.id,
    })
    setActiveTerminal(newId)
    onClose()
    try {
      await window.termpolis.createTerminal(newId, defaultShell as ShellType, session.cwd)
      // Give the shell ~800ms to print its first prompt before injecting the
      // resume command — too soon and the keystrokes land before the prompt
      // is ready, too late and the user sees a blank pane.
      setTimeout(() => {
        window.termpolis.writeToTerminal(newId, 'claude --resume ' + session.id + '\r')
      }, 800)
    } catch (e) {
      console.error('[PastAISessions] resume failed', e)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50"
      onClick={onClose}
      data-testid="past-ai-sessions-overlay"
    >
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-2xl w-[820px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <div>
            <h2 className="text-sm font-semibold text-[#e0e0e0]">Resume past AI session</h2>
            <p className="text-[11px] text-[#999] mt-0.5">
              Cross-project view of every Claude Code session on this machine. Pick one to open it
              in a new terminal at the original project folder.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[#999] hover:text-white px-2"
            aria-label="Close"
          >&#x2715;</button>
        </div>

        <div className="px-4 py-2 border-b border-[#3c3c3c]">
          <input
            autoFocus
            type="text"
            placeholder="Filter by project, branch, or first message..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1.5 text-xs text-[#e0e0e0] focus:outline-none focus:border-[#0078d4]"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && <div className="text-xs text-[#999] px-2 py-4">Scanning ~/.claude/projects/...</div>}
          {error && <div className="text-xs text-red-400 px-2 py-4">Error: {error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="text-xs text-[#999] px-2 py-6 text-center">
              {sessions.length === 0
                ? 'No past Claude sessions found in ~/.claude/projects/.'
                : 'No sessions match this filter.'}
            </div>
          )}
          {grouped.map(([cwd, items]) => (
            <div key={cwd} className="mb-3">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[#7ee2a3] font-semibold flex items-center gap-2">
                <i className="fa-solid fa-folder-open text-[9px]"></i>
                <span title={cwd}>{projectLabel(cwd)}</span>
                <span className="text-[#666] normal-case font-normal">{cwd}</span>
              </div>
              {items.map(s => (
                <div
                  key={s.id}
                  className="group flex items-start gap-3 px-2 py-2 mx-1 rounded hover:bg-[#2a2a2a] cursor-pointer"
                  onClick={() => resume(s)}
                  data-testid="past-ai-session-row"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-[11px] text-[#999]">
                      <span>{formatRelative(s.lastModified)}</span>
                      {s.gitBranch && (
                        <span className="text-[#7ee2a3]"><i className="fa-solid fa-code-branch text-[9px]"></i> {s.gitBranch}</span>
                      )}
                      {s.version && <span className="text-[#666]">v{s.version}</span>}
                      <span className="text-[#666]">{(s.sizeBytes / 1024).toFixed(0)} KB</span>
                    </div>
                    <div className="text-xs text-[#d4d4d4] mt-0.5 line-clamp-2 break-all">
                      {s.firstUserMessage || <span className="text-[#666] italic">(no user message)</span>}
                    </div>
                    <div className="text-[10px] text-[#666] mt-0.5 font-mono">{s.id}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); resume(s) }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] bg-[#0e639c] hover:bg-[#1177bb] text-white rounded px-2 py-1 self-center shrink-0"
                  >
                    Resume
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-[#3c3c3c] text-[10px] text-[#666] flex items-center justify-between">
          <span>{sessions.length} session{sessions.length === 1 ? '' : 's'} across {new Set(sessions.map(s => s.cwd)).size} project{new Set(sessions.map(s => s.cwd)).size === 1 ? '' : 's'}</span>
          <span>Resume opens a new terminal at the session's original cwd and runs <code className="text-[#7ee2a3]">claude --resume &lt;id&gt;</code></span>
        </div>
      </div>
    </div>
  )
}
