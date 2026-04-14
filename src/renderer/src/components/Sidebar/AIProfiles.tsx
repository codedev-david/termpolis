import React, { useState, useEffect } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { v4 as uuid } from 'uuid'
import { getHomedir } from '../../lib/homedir'
import { TERMINAL_DEFAULTS } from '../../lib/terminalDefaults'
import { InstallHint } from '../InstallHint/InstallHint'
import type { AIProfile, ShellInfo, ShellType } from '../../types'
import { resolveAgentCommand, testDelay } from '../../lib/testAgents'

const DEFAULT_AI_PROFILES: AIProfile[] = [
  { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude', shell: 'bash', color: '#D97706' },
  { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', command: 'codex', shell: 'bash', color: '#10B981' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'fa-brands fa-google', command: 'gemini', shell: 'bash', color: '#4285F4' },
  { id: 'aider-qwen', name: 'Qwen AI', icon: 'fa-solid fa-bolt', command: 'aider --model ollama/qwen3-coder-next --no-show-model-warnings', shell: 'bash', color: '#06B6D4' },
]

function resolveShellType(profileShell: string, availableShells: ShellInfo[]): ShellType {
  const available = availableShells.map(s => s.type)
  if (profileShell === 'bash') {
    // On Windows, prefer gitbash if available
    if (navigator.platform.startsWith('Win') && available.includes('gitbash')) return 'gitbash'
    if (available.includes('bash')) return 'bash'
  }
  if (available.includes(profileShell as ShellType)) return profileShell as ShellType
  // Fallback to first available shell
  return available[0] ?? 'bash'
}

interface AddProfileModalProps {
  onSave: (profile: AIProfile) => void
  onCancel: () => void
}

function AddProfileModal({ onSave, onCancel }: AddProfileModalProps) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [shell, setShell] = useState('bash')
  const [color, setColor] = useState('#22D3EE')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !command.trim()) return
    onSave({
      id: uuid(),
      name: name.trim(),
      icon: 'fa-solid fa-terminal',
      command: command.trim(),
      shell,
      color,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn" onClick={onCancel}>
      <form
        className="bg-[#2d2d2d] rounded-lg p-5 w-80 flex flex-col gap-3 border border-[#3c3c3c]"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="text-sm font-semibold text-[#d4d4d4]">Add AI Profile</h3>
        <input
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#22D3EE]"
          placeholder="Name (e.g. My Agent)"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />
        <input
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#22D3EE]"
          placeholder="Command (e.g. claude --model opus)"
          value={command}
          onChange={e => setCommand(e.target.value)}
        />
        <select
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#22D3EE]"
          value={shell}
          onChange={e => setShell(e.target.value)}
        >
          <option value="bash">Bash</option>
          <option value="powershell">PowerShell</option>
          <option value="cmd">CMD</option>
          <option value="zsh">Zsh</option>
          <option value="gitbash">Git Bash</option>
        </select>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[#9ca3af]">Color</label>
          <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-8 h-6 border-0 bg-transparent cursor-pointer" />
        </div>
        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded hover:bg-[#37373d] text-[#9ca3af]">Cancel</button>
          <button type="submit" className="px-3 py-1.5 text-sm rounded bg-[#22D3EE] text-[#1e1e1e] font-medium hover:bg-[#06b6d4]">Add</button>
        </div>
      </form>
    </div>
  )
}

interface AIProfilesProps {
  availableShells: ShellInfo[]
}

export function AIProfiles({ availableShells }: AIProfilesProps) {
  const { aiProfiles, addAIProfile, removeAIProfile, addTerminal, setLaunchingAgent } = useTerminalStore()
  const [showAddModal, setShowAddModal] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'installed' | 'not-installed'>('checking')
  const [showOllamaHint, setShowOllamaHint] = useState(false)
  const [installedAgents, setInstalledAgents] = useState<Record<string, boolean>>({})
  const [detectingAgents, setDetectingAgents] = useState(true)
  const [installHint, setInstallHint] = useState<{ id: string; name: string } | null>(null)

  // Check if Ollama is installed on mount
  useEffect(() => {
    const check = async () => {
      try {
        const { execSync } = window as any
        // Try via fetch to Ollama's local API (runs on port 11434)
        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) }).catch(() => null)
        if (res?.ok) {
          setOllamaStatus('installed')
        } else {
          setOllamaStatus('not-installed')
        }
      } catch {
        setOllamaStatus('not-installed')
      }
    }
    check()
    // Also detect all agent installations
    window.termpolis.detectAgents().then(res => {
      if (res.success && res.data) setInstalledAgents(res.data)
      setDetectingAgents(false)
    }).catch(() => setDetectingAgents(false))
  }, [])

  const allProfiles = [...DEFAULT_AI_PROFILES, ...aiProfiles]

  const handleLaunch = async (profile: AIProfile) => {
    // Prompt user to pick a project directory
    const dirRes = await window.termpolis.pickDirectory()
    if (!dirRes.success || !dirRes.data) return  // user cancelled
    const cwd = dirRes.data
    setLaunchingAgent(profile.name)
    const id = uuid()
    const shellType = resolveShellType(profile.shell, availableShells)
    // Inject Ollama path for Aider + Qwen so it can find the ollama binary
    let extraPaths: string[] | undefined
    if (profile.id === 'aider-qwen') {
      const ollamaRes = await window.termpolis.getOllamaPath()
      if (ollamaRes.success && ollamaRes.data && ollamaRes.data !== 'ollama') {
        extraPaths = [ollamaRes.data]
      }
    }
    const res = await window.termpolis.createTerminal(id, shellType, cwd, extraPaths)
    if (!res.success) {
      setLaunchingAgent(null)
      alert(`Failed to open terminal: ${res.error}`)
      return
    }
    addTerminal({
      id,
      name: profile.name,
      color: profile.color,
      shellType,
      cwd,
      fontSize: TERMINAL_DEFAULTS.fontSize,
      theme: TERMINAL_DEFAULTS.theme,
      fontFamily: TERMINAL_DEFAULTS.fontFamily,
      agentCommand: profile.command,
    })
    // Wait for shell to fully initialize before sending command
    // Git Bash on Windows can take 3-5 seconds to show the prompt
    // Send a no-op newline first to flush any partial shell init, then the real command
    setTimeout(() => {
      window.termpolis.writeToTerminal(id, '\r')
      setTimeout(() => {
        window.termpolis.writeToTerminal(id, resolveAgentCommand(profile.command) + '\r')
      }, 500)
    }, testDelay(4000))
    // Auto-trust: Claude/Codex show trust prompts ~5s after launch.
    // Send Enter to confirm the pre-selected trust option.
    if (profile.command.startsWith('claude')) {
      setTimeout(() => window.termpolis.writeToTerminal(id, '\r'), testDelay(9000))
    }
    if (profile.command.startsWith('codex')) {
      // Codex requires '1' to trust the directory
      setTimeout(() => window.termpolis.writeToTerminal(id, '1\r'), testDelay(9000))
    }
    const dismissMs = (profile.id === 'gemini' || profile.id === 'aider-qwen') ? 15000 : 8000
    setTimeout(() => setLaunchingAgent(null), testDelay(dismissMs))
  }

  const handleAddProfile = (profile: AIProfile) => {
    addAIProfile(profile)
    setShowAddModal(false)
  }

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          className="flex items-center gap-1 text-xs text-[#9ca3af] uppercase tracking-wider hover:text-[#d4d4d4]"
          onClick={() => setCollapsed(!collapsed)}
        >
          <i className={`fa-solid fa-chevron-${collapsed ? 'right' : 'down'} text-[9px]`}></i>
          AI Agents
        </button>
        <button
          className="text-[#9ca3af] hover:text-[#22D3EE] text-xs px-1"
          onClick={() => setShowAddModal(true)}
          title="Add custom AI profile"
        >
          <i className="fa-solid fa-plus"></i>
        </button>
      </div>
      {!collapsed && (
        <div className="px-2 pb-1 flex flex-col gap-0.5">
          {allProfiles.map(profile => {
            const isCustom = aiProfiles.some(p => p.id === profile.id)
            const isAiderQwen = profile.id === 'aider-qwen'
            return (
              <div key={profile.id} className="group flex flex-col">
                <div className="flex items-center">
                  <button
                    className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-[#37373d] flex-1 text-left"
                    onClick={() => {
                      // Check if agent is installed
                      const notInstalled = !detectingAgents && installedAgents[profile.id] === false
                      if (notInstalled) {
                        setInstallHint({ id: profile.id, name: profile.name })
                        return
                      }
                      if (isAiderQwen && ollamaStatus === 'not-installed') {
                        setShowOllamaHint(true)
                        return
                      }
                      handleLaunch(profile)
                    }}
                    title={isAiderQwen
                      ? 'Free & local — runs Qwen3-Coder-Next via Ollama (no API costs)'
                      : `Launch ${profile.name}: ${profile.command}`}
                  >
                    <i className={profile.icon} style={{ color: profile.color, fontSize: '11px', width: '14px', textAlign: 'center' }}></i>
                    <span className="text-[#d4d4d4] truncate">{profile.name}</span>
                    {isAiderQwen && (
                      <span className="text-[8px] px-1 py-0.5 rounded bg-[#06B6D4]/20 text-[#06B6D4] ml-auto shrink-0">FREE</span>
                    )}
                  </button>
                  {!detectingAgents && (
                    installedAgents[profile.id] === false ? (
                      <button
                        className="text-[#E57373] hover:text-red-300 text-[10px] px-1 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          setInstallHint({ id: profile.id, name: profile.name })
                        }}
                        title={`${profile.name} not installed — click for setup instructions`}
                      >
                        <i className="fa-solid fa-circle-xmark"></i>
                      </button>
                    ) : (
                      <span className="text-green-400 text-[10px] px-1 shrink-0" title={`${profile.name} installed`}>
                        <i className="fa-solid fa-circle-check"></i>
                      </span>
                    )
                  )}
                  {isCustom && (
                    <button
                      className="text-[#9ca3af] hover:text-red-400 text-[10px] px-1 opacity-0 group-hover:opacity-100"
                      onClick={() => removeAIProfile(profile.id)}
                      title="Remove profile"
                    >
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {showOllamaHint && (
            <div className="mx-2 mt-1 p-2 bg-[#1e3a1e] border border-[#2d5a2d] rounded text-[10px] text-[#A5D6A7] leading-relaxed">
              <div className="flex justify-between items-start mb-1">
                <strong className="text-[#22D3EE]">Free AI Coding with Qwen AI</strong>
                <button onClick={() => setShowOllamaHint(false)} className="text-[#999] hover:text-white">×</button>
              </div>
              <p className="mb-1">Qwen AI runs completely free and local via Ollama — no API keys, no cloud, no costs.</p>
              <p className="mb-1">To set up:</p>
              <ol className="list-decimal ml-3 flex flex-col gap-0.5">
                <li>Install <a href="https://ollama.com" className="text-[#22D3EE] underline" onClick={e => { e.preventDefault(); window.open('https://ollama.com', '_blank') }}>Ollama</a></li>
                <li>Run: <code className="bg-[#0d1b0d] px-1 rounded">ollama pull qwen3-coder-next</code></li>
                <li>Click "Qwen AI" above to start coding</li>
              </ol>
            </div>
          )}
        </div>
      )}
      {showAddModal && <AddProfileModal onSave={handleAddProfile} onCancel={() => setShowAddModal(false)} />}
      {installHint && <InstallHint agentId={installHint.id} agentName={installHint.name} onClose={() => setInstallHint(null)} />}
    </>
  )
}
