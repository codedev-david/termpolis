import React, { useEffect, useState } from 'react'
import type { ShellType } from '../../types'
import type { AgentInfo } from '../../lib/agentDetector'
import { formatTokens, type CostInfo } from '../../lib/costTracker'

interface Props {
  terminalId: string
  shellType: ShellType
  cwd: string
  parsedBranch?: string | null
  agent?: AgentInfo | null
  costInfo?: CostInfo | null
  isRecording?: boolean
}

export function TerminalStatusBar({ terminalId, shellType, cwd, parsedBranch, agent, costInfo, isRecording }: Props) {
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
      {isRecording && (
        <span className="flex items-center gap-1 shrink-0" title="Recording session">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          <span className="text-red-200 font-medium">REC</span>
        </span>
      )}
      {agent && (
        <span
          className="flex items-center gap-1 shrink-0 rounded px-1.5 py-px text-[10px] font-medium"
          style={{ backgroundColor: agent.color, color: '#fff' }}
          title={`AI Agent: ${agent.name}`}
        >
          <i className={`${agent.icon} text-[10px]`}></i>
          {agent.name}
        </span>
      )}
      {agent && costInfo && costInfo.estimatedCost > 0 && (
        <span className="flex items-center gap-1 shrink-0" title={`Estimated cost: $${costInfo.estimatedCost.toFixed(2)}${costInfo.tokensIn ? ` (${costInfo.tokensIn.toLocaleString()} tokens)` : ''}`}>
          <i className="fa-solid fa-dollar-sign text-[10px]"></i>
          ${costInfo.estimatedCost.toFixed(2)}
          {costInfo.tokensIn > 0 && (
            <span className="opacity-75">({formatTokens(costInfo.tokensIn)} tokens)</span>
          )}
        </span>
      )}
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
