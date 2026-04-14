import React, { useEffect, useState, useCallback } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { subscribe, unsubscribe } from '../../lib/pollingService'

interface GitFile {
  file: string
  status: string
}

interface GitStatus {
  branch: string
  staged: GitFile[]
  unstaged: GitFile[]
}

interface GitPanelProps {
  onClose: () => void
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Untracked',
  '?': 'Untracked',
}

const STATUS_COLORS: Record<string, string> = {
  M: 'text-yellow-400',
  A: 'text-green-400',
  D: 'text-red-400',
  R: 'text-blue-400',
  C: 'text-blue-400',
  U: 'text-gray-400',
  '?': 'text-gray-400',
}

export function GitPanel({ onClose }: GitPanelProps) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [diffContent, setDiffContent] = useState<string>('')
  const [liveCwd, setLiveCwd] = useState<string>('')
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [unstagedCollapsed, setUnstagedCollapsed] = useState(false)

  const activeTerminal = useTerminalStore(s => {
    const id = s.activeTerminalId
    return id ? s.terminals.find(t => t.id === id) : null
  })
  // The store's cwd is kept up-to-date by TerminalPane's prompt parser
  const cwd = activeTerminal?.cwd || ''

  const refresh = useCallback(async () => {
    if (!cwd) return
    setLiveCwd(cwd)
    try {
      const res = await window.termpolis.gitStatusParsed(cwd)
      if (res.success && res.data) {
        setGitStatus(res.data)
        setError(null)
      } else {
        setGitStatus(null)
        setError(res.error || 'Not a git repository')
      }
    } catch {
      setGitStatus(null)
      setError('Failed to read git status')
    }
  }, [cwd])

  // Poll every 3 seconds
  useEffect(() => {
    refresh()
    const pollId = 'git-panel'
    subscribe(pollId, refresh, 3000)
    return () => unsubscribe(pollId)
  }, [refresh])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (diffFile) setDiffFile(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, diffFile])

  const handleStage = async (files: string[]) => {
    if (!liveCwd) return
    setLoading(true)
    const res = await window.termpolis.gitStage(liveCwd, files)
    if (!res.success) setError(res.error || 'Stage failed')
    await refresh()
    setLoading(false)
  }

  const handleUnstage = async (files: string[]) => {
    if (!liveCwd) return
    setLoading(true)
    const res = await window.termpolis.gitUnstage(liveCwd, files)
    if (!res.success) setError(res.error || 'Unstage failed')
    await refresh()
    setLoading(false)
  }

  const handleCommit = async () => {
    if (!liveCwd || !commitMsg.trim()) return
    setLoading(true)
    const res = await window.termpolis.gitCommit(liveCwd, commitMsg.trim())
    if (res.success) {
      setCommitMsg('')
      setError(null)
    } else {
      setError(res.error || 'Commit failed')
    }
    await refresh()
    setLoading(false)
  }

  const handlePull = async () => {
    if (!liveCwd) return
    setLoading(true)
    const res = await window.termpolis.gitPull(liveCwd)
    if (!res.success) setError(res.error || 'Pull failed')
    else setError(null)
    await refresh()
    setLoading(false)
  }

  const handlePush = async () => {
    if (!liveCwd) return
    setLoading(true)
    const res = await window.termpolis.gitPush(liveCwd)
    if (!res.success) setError(res.error || 'Push failed')
    else setError(null)
    await refresh()
    setLoading(false)
  }

  const handleViewDiff = async (file: string) => {
    if (!liveCwd) return
    setDiffFile(file)
    const res = await window.termpolis.gitFileDiff(liveCwd, file)
    setDiffContent(res.success && res.data ? res.data : 'No diff available')
  }

  const renderFileList = (files: GitFile[], isStaged: boolean) => (
    <div className="space-y-0.5">
      {files.map(f => (
        <div key={`${isStaged ? 's' : 'u'}-${f.file}`} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[#2a2d2e] group text-xs">
          <span className={`font-mono w-4 text-center font-bold ${STATUS_COLORS[f.status] || 'text-gray-400'}`} title={STATUS_LABELS[f.status] || f.status}>
            {f.status}
          </span>
          <span
            className="flex-1 truncate text-[#d4d4d4] cursor-pointer hover:underline"
            onClick={() => handleViewDiff(f.file)}
            title={`Click to view diff: ${f.file}`}
          >
            {f.file}
          </span>
          <button
            onClick={() => isStaged ? handleUnstage([f.file]) : handleStage([f.file])}
            className={`opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity ${
              isStaged
                ? 'text-red-400 hover:bg-red-500/20'
                : 'text-green-400 hover:bg-green-500/20'
            }`}
            title={isStaged ? 'Unstage' : 'Stage'}
          >
            {isStaged ? '−' : '+'}
          </button>
        </div>
      ))}
    </div>
  )

  if (!activeTerminal) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
        <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl w-[500px] p-6" onClick={e => e.stopPropagation()}>
          <p className="text-[#9ca3af] text-sm text-center">No terminal selected. Open a terminal first.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl w-[560px] max-w-[90vw] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-3">
            <i className="fa-brands fa-git-alt text-[#F05032]"></i>
            <h2 className="text-base font-semibold text-[#d4d4d4]">Git</h2>
            {gitStatus && (
              <span className="text-xs text-[#22D3EE] bg-[#22D3EE]/10 px-2 py-0.5 rounded-full font-mono">
                <i className="fa-solid fa-code-branch mr-1 text-[10px]"></i>
                {gitStatus.branch}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={handlePull} disabled={loading} className="px-2.5 py-1 rounded text-xs text-[#9ca3af] hover:text-white hover:bg-[#37373d] disabled:opacity-50" title="Pull">
              <i className="fa-solid fa-arrow-down mr-1"></i>Pull
            </button>
            <button onClick={handlePush} disabled={loading} className="px-2.5 py-1 rounded text-xs text-[#9ca3af] hover:text-white hover:bg-[#37373d] disabled:opacity-50" title="Push">
              <i className="fa-solid fa-arrow-up mr-1"></i>Push
            </button>
            <button onClick={() => refresh()} className="px-2 py-1 rounded text-xs text-[#9ca3af] hover:text-white hover:bg-[#37373d]" title="Refresh">
              <i className="fa-solid fa-arrows-rotate"></i>
            </button>
            <button onClick={onClose} className="text-[#9ca3af] hover:text-white px-2 py-1 rounded hover:bg-[#37373d]">
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>

        {/* Error banner — only for operational errors, not "not a git repo" */}
        {error && gitStatus && (
          <div className="mx-5 mt-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400 flex items-center gap-2">
            <i className="fa-solid fa-triangle-exclamation"></i>
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300"><i className="fa-solid fa-xmark"></i></button>
          </div>
        )}

        {/* Diff overlay */}
        {diffFile && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center gap-2 px-5 py-2 border-b border-[#3c3c3c]">
              <button onClick={() => setDiffFile(null)} className="text-xs text-[#22D3EE] hover:underline">
                <i className="fa-solid fa-arrow-left mr-1"></i>Back
              </button>
              <span className="text-xs text-[#d4d4d4] font-mono">{diffFile}</span>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-[#d4d4d4] bg-[#1a1a1a] leading-relaxed">
              {diffContent.split('\n').map((line, i) => (
                <div key={i} className={
                  line.startsWith('+') && !line.startsWith('+++') ? 'text-green-400 bg-green-500/10' :
                  line.startsWith('-') && !line.startsWith('---') ? 'text-red-400 bg-red-500/10' :
                  line.startsWith('@@') ? 'text-blue-400' :
                  ''
                }>{line}</div>
              ))}
            </pre>
          </div>
        )}

        {/* Main content */}
        {!diffFile && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {!gitStatus ? (
              <div className="text-center py-12">
                {error ? (
                  <>
                    <i className="fa-solid fa-folder-open text-3xl text-[#555] mb-4 block"></i>
                    <p className="text-[#d4d4d4] text-sm font-medium mb-2">Not a Git Repository</p>
                    <p className="text-[#9ca3af] text-xs max-w-xs mx-auto">
                      The current terminal directory isn't inside a git repo. Navigate to a project folder with <code className="bg-[#2d2d2d] px-1 rounded">cd</code> or open a terminal in a git project.
                    </p>
                  </>
                ) : (
                  <p className="text-[#9ca3af] text-sm">Loading git status...</p>
                )}
              </div>
            ) : gitStatus.staged.length === 0 && gitStatus.unstaged.length === 0 ? (
              <p className="text-[#9ca3af] text-sm text-center py-8">
                <i className="fa-solid fa-circle-check text-green-400 mr-2"></i>
                Working tree clean — nothing to commit
              </p>
            ) : (
              <>
                {/* Staged changes */}
                <div>
                  <button onClick={() => setStagedCollapsed(!stagedCollapsed)} className="flex items-center gap-2 text-xs font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5 hover:text-[#d4d4d4]">
                    <i className={`fa-solid fa-chevron-${stagedCollapsed ? 'right' : 'down'} text-[9px]`}></i>
                    <i className="fa-solid fa-check text-green-400 text-[10px]"></i>
                    Staged Changes
                    <span className="text-[10px] normal-case tracking-normal">({gitStatus.staged.length})</span>
                    {gitStatus.staged.length > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUnstage(gitStatus.staged.map(f => f.file)) }}
                        className="ml-auto text-[10px] text-red-400 hover:text-red-300 normal-case tracking-normal font-normal"
                      >Unstage All</button>
                    )}
                  </button>
                  {!stagedCollapsed && (
                    gitStatus.staged.length > 0
                      ? renderFileList(gitStatus.staged, true)
                      : <p className="text-[#888] text-xs pl-6">No staged changes</p>
                  )}
                </div>

                {/* Unstaged changes */}
                <div>
                  <button onClick={() => setUnstagedCollapsed(!unstagedCollapsed)} className="flex items-center gap-2 text-xs font-semibold text-[#9ca3af] uppercase tracking-wider mb-1.5 hover:text-[#d4d4d4]">
                    <i className={`fa-solid fa-chevron-${unstagedCollapsed ? 'right' : 'down'} text-[9px]`}></i>
                    <i className="fa-solid fa-pen text-yellow-400 text-[10px]"></i>
                    Changes
                    <span className="text-[10px] normal-case tracking-normal">({gitStatus.unstaged.length})</span>
                    {gitStatus.unstaged.length > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStage(gitStatus.unstaged.map(f => f.file)) }}
                        className="ml-auto text-[10px] text-green-400 hover:text-green-300 normal-case tracking-normal font-normal"
                      >Stage All</button>
                    )}
                  </button>
                  {!unstagedCollapsed && (
                    gitStatus.unstaged.length > 0
                      ? renderFileList(gitStatus.unstaged, false)
                      : <p className="text-[#888] text-xs pl-6">No unstaged changes</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Commit bar */}
        {!diffFile && gitStatus && gitStatus.staged.length > 0 && (
          <div className="px-5 py-3 border-t border-[#3c3c3c] flex items-center gap-2">
            <input
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && commitMsg.trim()) handleCommit() }}
              placeholder="Commit message..."
              className="flex-1 bg-[#2d2d2d] border border-[#3c3c3c] rounded px-3 py-1.5 text-xs text-[#d4d4d4] placeholder-[#777] focus:border-[#22D3EE] outline-none"
            />
            <button
              onClick={handleCommit}
              disabled={!commitMsg.trim() || loading}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                !commitMsg.trim() || loading
                  ? 'bg-[#3c3c3c] text-[#888] cursor-not-allowed'
                  : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
              }`}
            >
              <i className="fa-solid fa-check mr-1"></i>Commit
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
