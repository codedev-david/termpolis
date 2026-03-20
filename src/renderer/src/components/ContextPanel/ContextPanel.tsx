import React, { useEffect, useState, useCallback } from 'react'
import { subscribe, unsubscribe } from '../../lib/pollingService'

interface Props {
  cwd: string
  onClose: () => void
}

interface FileEntry {
  name: string
  isDir: boolean
}

interface GitInfo {
  status: string
  recentCommits: string
}

export function ContextPanel({ cwd, onClose }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }, [])

  const refresh = useCallback(async () => {
    if (!cwd) return

    // Fetch file tree
    try {
      const res = await window.termpolis.completionPathEntries(cwd)
      if (res.success && res.data) {
        // Sort: directories first, then alphabetical
        const sorted = [...res.data].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        setFiles(sorted)
      }
    } catch {}

    // Fetch git info
    try {
      const res = await window.termpolis.getGitInfo(cwd)
      if (res.success && res.data) {
        setGitInfo(res.data)
      } else {
        setGitInfo(null)
      }
    } catch {
      setGitInfo(null)
    }
  }, [cwd])

  useEffect(() => {
    refresh()
    const pollId = `context-panel-${cwd}`
    subscribe(pollId, refresh, 5000)
    return () => {
      unsubscribe(pollId)
    }
  }, [refresh, cwd])

  const statusLines = gitInfo?.status ? gitInfo.status.split('\n').filter(Boolean) : []
  const commitLines = gitInfo?.recentCommits ? gitInfo.recentCommits.split('\n').filter(Boolean) : []

  const getStatusColor = (line: string) => {
    const code = line.trim().charAt(0)
    if (code === 'M') return '#e5c07b' // modified - yellow
    if (code === 'A') return '#98c379' // added - green
    if (code === 'D') return '#e06c75' // deleted - red
    if (code === '?') return '#61afef' // untracked - blue
    if (code === 'R') return '#c678dd' // renamed - purple
    return '#abb2bf'
  }

  return (
    <div className="flex flex-col h-full border-l border-[#3c3c3c] bg-[#252526] select-none"
      style={{ width: 250, minWidth: 250, maxWidth: 250 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#888]">Context</span>
        <button
          className="text-[#888] hover:text-[#d4d4d4] text-xs cursor-pointer"
          onClick={onClose}
          title="Close panel (Ctrl+Shift+E)"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto text-[12px]">
        {/* File Tree Section */}
        <div>
          <button
            className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-[#2a2d2e] cursor-pointer text-left"
            onClick={() => toggleSection('files')}
          >
            <i className={`fa-solid fa-chevron-${collapsedSections.files ? 'right' : 'down'} text-[8px] text-[#888]`}></i>
            <i className="fa-solid fa-folder text-[#dcb67a] text-[10px]"></i>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#bbb]">File Tree</span>
            <span className="text-[10px] text-[#666] ml-auto">{files.length}</span>
          </button>
          {!collapsedSections.files && (
            <div className="pb-1">
              {files.length === 0 && (
                <div className="px-5 py-1 text-[#666] italic text-[11px]">No files</div>
              )}
              {files.map(f => (
                <div key={f.name} className="flex items-center gap-1.5 px-5 py-0.5 hover:bg-[#2a2d2e] truncate">
                  <i className={`fa-solid ${f.isDir ? 'fa-folder text-[#dcb67a]' : 'fa-file text-[#888]'} text-[10px] w-3 text-center`}></i>
                  <span className={`truncate ${f.isDir ? 'text-[#dcb67a]' : 'text-[#ccc]'}`}>
                    {f.name}{f.isDir ? '/' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Git Status Section */}
        <div>
          <button
            className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-[#2a2d2e] cursor-pointer text-left"
            onClick={() => toggleSection('status')}
          >
            <i className={`fa-solid fa-chevron-${collapsedSections.status ? 'right' : 'down'} text-[8px] text-[#888]`}></i>
            <i className="fa-solid fa-code-branch text-[#61afef] text-[10px]"></i>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#bbb]">Git Status</span>
            {statusLines.length > 0 && (
              <span className="text-[10px] text-[#e5c07b] ml-auto">{statusLines.length}</span>
            )}
          </button>
          {!collapsedSections.status && (
            <div className="pb-1 font-mono">
              {statusLines.length === 0 && (
                <div className="px-5 py-1 text-[#666] italic text-[11px]">
                  {gitInfo ? 'Clean working tree' : 'Not a git repo'}
                </div>
              )}
              {statusLines.map((line, i) => (
                <div
                  key={i}
                  className="px-5 py-0.5 hover:bg-[#2a2d2e] truncate text-[11px]"
                  style={{ color: getStatusColor(line) }}
                  title={line}
                >
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Commits Section */}
        <div>
          <button
            className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-[#2a2d2e] cursor-pointer text-left"
            onClick={() => toggleSection('commits')}
          >
            <i className={`fa-solid fa-chevron-${collapsedSections.commits ? 'right' : 'down'} text-[8px] text-[#888]`}></i>
            <i className="fa-solid fa-clock-rotate-left text-[#c678dd] text-[10px]"></i>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#bbb]">Recent Commits</span>
          </button>
          {!collapsedSections.commits && (
            <div className="pb-1 font-mono">
              {commitLines.length === 0 && (
                <div className="px-5 py-1 text-[#666] italic text-[11px]">No commits</div>
              )}
              {commitLines.map((line, i) => {
                const spaceIdx = line.indexOf(' ')
                const hash = spaceIdx > 0 ? line.slice(0, spaceIdx) : line
                const msg = spaceIdx > 0 ? line.slice(spaceIdx + 1) : ''
                return (
                  <div key={i} className="flex gap-1.5 px-5 py-0.5 hover:bg-[#2a2d2e] text-[11px] truncate" title={line}>
                    <span className="text-[#e5c07b] flex-shrink-0">{hash}</span>
                    <span className="text-[#abb2bf] truncate">{msg}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer with cwd */}
      <div className="px-3 py-1.5 border-t border-[#3c3c3c] text-[10px] text-[#666] truncate" title={cwd}>
        {cwd}
      </div>
    </div>
  )
}
