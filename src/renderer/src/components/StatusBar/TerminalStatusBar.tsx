import React, { useEffect, useState } from 'react'
import type { ShellType } from '../../types'

interface Props {
  terminalId: string
  shellType: ShellType
  cwd: string
  parsedBranch?: string | null
}

export function TerminalStatusBar({ terminalId, shellType, cwd, parsedBranch }: Props) {
  const [ipcBranch, setIpcBranch] = useState('')

  // IPC-based git branch lookup as fallback (works on macOS/Linux with live cwd)
  useEffect(() => {
    let disposed = false

    const fetchStatus = async () => {
      try {
        const res = await window.termpolis.getTerminalStatus(terminalId, cwd)
        if (!disposed && res.success && res.data) {
          setIpcBranch(res.data.gitBranch)
        }
      } catch {}
    }

    fetchStatus()

    const interval = setInterval(fetchStatus, 5000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [terminalId, cwd])

  // Prefer prompt-parsed branch (works on all platforms), fall back to IPC
  const gitBranch = parsedBranch || ipcBranch

  const shellLabel: Record<ShellType, string> = {
    bash: 'Bash',
    zsh: 'Zsh',
    cmd: 'CMD',
    powershell: 'PowerShell',
    gitbash: 'Git Bash',
  }

  return (
    <div className="flex items-center gap-3 px-2 py-0.5 bg-[#007acc] text-white text-[11px] shrink-0 select-none overflow-hidden">
      <span className="flex items-center gap-1 shrink-0" title="Shell">
        <i className="fa-solid fa-terminal text-[10px]"></i>
        {shellLabel[shellType] ?? shellType}
      </span>
      <span className="flex items-center gap-1 truncate min-w-0" title={`Working directory: ${cwd}`}>
        <i className="fa-solid fa-folder text-[10px] shrink-0"></i>
        <span className="truncate">{cwd}</span>
      </span>
      {gitBranch && (
        <span className="flex items-center gap-1 shrink-0" title={`Git branch: ${gitBranch}`}>
          <i className="fa-brands fa-git-alt text-[10px]"></i>
          {gitBranch}
        </span>
      )}
    </div>
  )
}
