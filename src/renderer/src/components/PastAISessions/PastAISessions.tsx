import { useEffect, useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useTerminalStore } from '../../store/terminalStore'
import type { AISessionSummary, ShellType } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
}

type HandoffAgent = 'claude' | 'codex' | 'gemini' | 'qwen'

const AGENT_COMMANDS: Record<HandoffAgent, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  qwen: 'qwen',
}

const AGENT_LABELS: Record<HandoffAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
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
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const [handoffMenu, setHandoffMenu] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

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

  // Cross-AI context handoff: load the full JSONL, render a portable
  // prompt, then either inject it into the active shell or spawn a new
  // terminal with the chosen agent and paste the prompt as its first turn.
  const handoff = async (session: AISessionSummary, target: 'inject' | HandoffAgent) => {
    setBusy(true)
    setStatusMsg(null)
    try {
      const res = await window.termpolis.digestAISession(session.filePath)
      if (!res.success || !res.data) {
        setStatusMsg('Could not digest session: ' + (res.error || 'unknown'))
        return
      }
      const prompt = res.data.prompt

      if (target === 'inject') {
        if (!activeTerminalId) {
          setStatusMsg('No active terminal to inject into. Open one first.')
          return
        }
        // Write the prompt without a trailing CR — let the user review and submit.
        window.termpolis.writeToTerminal(activeTerminalId, prompt)
        onClose()
        return
      }

      // Spawn a new terminal at the source cwd with the chosen agent.
      const newId = uuidv4()
      const cmd = AGENT_COMMANDS[target]
      addTerminal({
        id: newId,
        name: cmd + ' (handoff)',
        color: '#7ee2a3',
        shellType: defaultShell as ShellType,
        cwd: session.cwd,
        fontSize: 14,
        theme: 'dark',
        fontFamily: 'Consolas, Menlo, monospace',
        agentCommand: cmd,
      })
      setActiveTerminal(newId)
      onClose()
      try {
        await window.termpolis.createTerminal(newId, defaultShell as ShellType, session.cwd)
        // 1. Boot the agent. 2. Wait for it to be ready. 3. Paste the prompt.
        // Two-step delay because agents take time to print their banner.
        setTimeout(() => {
          window.termpolis.writeToTerminal(newId, cmd + '\r')
          setTimeout(() => {
            // Write the prompt without auto-submit. User reads + presses Enter
            // when they're satisfied — gives them an "abort" lever if the
            // digest looks wrong.
            window.termpolis.writeToTerminal(newId, prompt)
          }, 2500)
        }, 800)
      } catch (e) {
        console.error('[PastAISessions] handoff failed', e)
      }
    } finally {
      setBusy(false)
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
                  <div className="relative flex items-center gap-1 shrink-0 self-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); resume(s) }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] bg-[#0e639c] hover:bg-[#1177bb] text-white rounded px-2 py-1"
                      title="Resume this session natively in Claude Code"
                    >
                      Resume
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setHandoffMenu(handoffMenu === s.id ? null : s.id) }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] bg-[#3c3c3c] hover:bg-[#4d4d4d] text-white rounded px-2 py-1"
                      title="Continue this context in a different AI agent or inject it into the active shell"
                      data-testid="past-ai-session-handoff-btn"
                      disabled={busy}
                    >
                      Continue ▾
                    </button>
                    {handoffMenu === s.id && (
                      <div
                        className="absolute right-0 top-full mt-1 z-40 bg-[#252526] border border-[#3c3c3c] rounded shadow-xl py-1 min-w-[210px]"
                        onClick={(e) => e.stopPropagation()}
                        data-testid="past-ai-session-handoff-menu"
                      >
                        <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[#7ee2a3]">Cross-AI handoff</div>
                        {(['codex', 'gemini', 'qwen', 'claude'] as HandoffAgent[]).map(target => (
                          <button
                            key={target}
                            onClick={() => { setHandoffMenu(null); handoff(s, target) }}
                            className="w-full text-left text-xs px-3 py-1.5 hover:bg-[#094771] text-[#d4d4d4]"
                          >
                            Continue in {AGENT_LABELS[target]}
                          </button>
                        ))}
                        <div className="border-t border-[#3c3c3c] my-1" />
                        <button
                          onClick={() => { setHandoffMenu(null); handoff(s, 'inject') }}
                          className="w-full text-left text-xs px-3 py-1.5 hover:bg-[#094771] text-[#d4d4d4] disabled:opacity-50"
                          disabled={!activeTerminalId}
                          title={activeTerminalId ? 'Paste this session\'s context summary into the focused terminal' : 'Open a terminal first'}
                          data-testid="past-ai-session-inject-btn"
                        >
                          Inject context into active shell
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-[#3c3c3c] text-[10px] text-[#666] flex items-center justify-between">
          <span>{sessions.length} session{sessions.length === 1 ? '' : 's'} across {new Set(sessions.map(s => s.cwd)).size} project{new Set(sessions.map(s => s.cwd)).size === 1 ? '' : 's'}</span>
          {statusMsg ? (
            <span className="text-[#e57373]" data-testid="past-ai-sessions-status">{statusMsg}</span>
          ) : (
            <span>Resume = native <code className="text-[#7ee2a3]">claude --resume</code>. Continue ▾ = inject context into another AI.</span>
          )}
        </div>
      </div>
    </div>
  )
}
