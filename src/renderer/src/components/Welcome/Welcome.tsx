import { useState, useEffect } from 'react'
import { InstallHint } from '../InstallHint/InstallHint'

interface WelcomeProps {
  onNewTerminal: () => void
  onLaunchAgent: (agentId: string) => void
  onStartSwarm: () => void
}

const AGENT_OPTIONS = [
  { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', color: '#D97706' },
  { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', color: '#10B981' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'fa-brands fa-google', color: '#4285F4' },
  { id: 'qwen-code', name: 'Qwen Code', icon: 'fa-solid fa-feather', color: '#A855F7' },
]

export function Welcome({ onNewTerminal, onLaunchAgent, onStartSwarm }: WelcomeProps) {
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [installedAgents, setInstalledAgents] = useState<Record<string, boolean>>({})
  const [detecting, setDetecting] = useState(true)
  const [installHint, setInstallHint] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    window.termpolis.detectAgents().then(res => {
      if (res.success && res.data) setInstalledAgents(res.data)
      setDetecting(false)
    }).catch(() => setDetecting(false))
  }, [])

  const handleAgentClick = (agent: typeof AGENT_OPTIONS[0]) => {
    const installed = detecting || installedAgents[agent.id] !== false
    if (!installed) {
      setShowAgentPicker(false)
      setInstallHint({ id: agent.id, name: agent.name })
      return
    }
    setShowAgentPicker(false)
    onLaunchAgent(agent.id)
  }

  return (
    <div className="flex items-center justify-center h-full w-full select-none">
      <div className="flex flex-col items-center gap-8 max-w-xl px-6">
        {/* Logo / Icon */}
        <div className="w-16 h-16 rounded-2xl bg-[#22D3EE]/10 border border-[#22D3EE]/20 flex items-center justify-center">
          <i className="fa-solid fa-terminal text-[#22D3EE] text-2xl"></i>
        </div>

        {/* Title */}
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#d4d4d4] mb-1">Welcome to Termpolis</h1>
          <p className="text-sm text-[#9ca3af]">The AI-native terminal for developers</p>
        </div>

        {/* Action Cards */}
        <div className="grid grid-cols-3 gap-3 w-full">
          <button
            onClick={onNewTerminal}
            className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2a2d2e] hover:border-[#22D3EE]/40 transition-colors text-center group"
          >
            <div className="w-10 h-10 rounded-lg bg-[#37373d] group-hover:bg-[#22D3EE]/10 flex items-center justify-center transition-colors">
              <i className="fa-solid fa-terminal text-[#22D3EE]"></i>
            </div>
            <span className="text-sm font-medium text-[#d4d4d4]">New Terminal</span>
            <span className="text-[10px] text-[#9ca3af] leading-tight">Create a terminal with custom shell and theme</span>
          </button>

          <div className="relative">
            <button
              onClick={() => setShowAgentPicker(!showAgentPicker)}
              className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2a2d2e] hover:border-[#D97706]/40 transition-colors text-center group w-full h-full"
            >
              <div className="w-10 h-10 rounded-lg bg-[#37373d] group-hover:bg-[#D97706]/10 flex items-center justify-center transition-colors">
                <i className="fa-solid fa-robot text-[#D97706]"></i>
              </div>
              <span className="text-sm font-medium text-[#d4d4d4]">Launch AI Agent</span>
              <span className="text-[10px] text-[#9ca3af] leading-tight">Choose an AI coding agent to start</span>
            </button>
            {showAgentPicker && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#2d2d2d] border border-[#3c3c3c] rounded-lg shadow-xl z-10 py-1 animate-fadeIn">
                {AGENT_OPTIONS.map(agent => {
                  const installed = detecting || installedAgents[agent.id] !== false
                  const notInstalled = !detecting && installedAgents[agent.id] === false
                  return (
                    <button
                      key={agent.id}
                      onClick={() => handleAgentClick(agent)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                        notInstalled ? 'hover:bg-[#2a2a2a]' : 'hover:bg-[#37373d]'
                      }`}
                    >
                      <i className={agent.icon} style={{ color: notInstalled ? '#555' : agent.color, fontSize: '12px' }}></i>
                      <span className={`text-xs flex-1 ${notInstalled ? 'text-[#888]' : 'text-[#d4d4d4]'}`}>{agent.name}</span>
                      {installed && !detecting && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" title="Installed"></span>
                      )}
                      {notInstalled && (
                        <span className="text-[8px] px-1 py-0.5 rounded bg-red-900/30 text-red-400">Install</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <button
            onClick={onStartSwarm}
            className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2a2d2e] hover:border-[#A5D6A7]/40 transition-colors text-center group"
          >
            <div className="w-10 h-10 rounded-lg bg-[#37373d] group-hover:bg-[#A5D6A7]/10 flex items-center justify-center transition-colors">
              <i className="fa-solid fa-network-wired text-[#A5D6A7]"></i>
            </div>
            <span className="text-sm font-medium text-[#d4d4d4]">Start Swarm</span>
            <span className="text-[10px] text-[#9ca3af] leading-tight">Coordinate multiple AI agents to build a new project or modify an existing one — review every change before it lands.</span>
          </button>
        </div>

        {/* Feature Highlights */}
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-[#888]">
          <span>Ctrl+K Command Palette</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>Split Panes</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>Smart Routing</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>MCP Server</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>Session Recording</span>
        </div>

        {/* Observability Shortcuts */}
        <div className="flex flex-col items-center gap-1 text-[11px] text-[#888] max-w-md text-center">
          <span className="text-[#9ca3af] font-medium">AI Observability</span>
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            <span><kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+Shift+A</kbd> Activity Feed</span>
            <span className="text-[#3c3c3c]">·</span>
            <span><kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+Shift+D</kbd> Redundancy</span>
            <span className="text-[#3c3c3c]">·</span>
            <span><kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+Shift+Y</kbd> Efficiency</span>
            <span className="text-[#3c3c3c]">·</span>
            <span><kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+Shift+S</kbd> Swarm</span>
          </div>
        </div>

        {/* Hint */}
        <p className="text-[11px] text-[#888]">
          Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+K</kbd> to open the command palette, or click <strong className="text-[#9ca3af]">+ Add Terminal</strong> in the sidebar
        </p>
      </div>

      {installHint && (
        <InstallHint agentId={installHint.id} agentName={installHint.name} onClose={() => setInstallHint(null)} />
      )}
    </div>
  )
}
