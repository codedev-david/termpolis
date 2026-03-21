import React, { useState, useEffect } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { v4 as uuid } from 'uuid'
import { getHomedir } from '../../lib/homedir'
import { TERMINAL_DEFAULTS } from '../../lib/terminalDefaults'
import type { AIProfile, ShellInfo, ShellType } from '../../types'

const DEFAULT_AI_PROFILES: AIProfile[] = [
  { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude', shell: 'bash', color: '#D97706' },
  { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', command: 'codex', shell: 'bash', color: '#10B981' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'fa-brands fa-google', command: 'gemini', shell: 'bash', color: '#4285F4' },
  { id: 'aider', name: 'Aider', icon: 'fa-solid fa-code', command: 'aider', shell: 'bash', color: '#8B5CF6' },
  { id: 'aider-qwen', name: 'Aider + Qwen3', icon: 'fa-solid fa-bolt', command: 'aider --model ollama/qwen3-coder', shell: 'bash', color: '#06B6D4' },
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
          <label className="text-xs text-[#6b7280]">Color</label>
          <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-8 h-6 border-0 bg-transparent cursor-pointer" />
        </div>
        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded hover:bg-[#37373d] text-[#6b7280]">Cancel</button>
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
  const { aiProfiles, addAIProfile, removeAIProfile, addTerminal } = useTerminalStore()
  const [showAddModal, setShowAddModal] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'installed' | 'not-installed'>('checking')
  const [showOllamaHint, setShowOllamaHint] = useState(false)

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
  }, [])

  const allProfiles = [...DEFAULT_AI_PROFILES, ...aiProfiles]

  const handleLaunch = async (profile: AIProfile) => {
    const id = uuid()
    const shellType = resolveShellType(profile.shell, availableShells)
    const cwd = await getHomedir()
    const res = await window.termpolis.createTerminal(id, shellType, cwd)
    if (!res.success) {
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
    })
    // Wait for shell to fully initialize before sending command
    // Git Bash on Windows can take 1-2 seconds to show the prompt
    setTimeout(() => {
      window.termpolis.writeToTerminal(id, profile.command + '\r')
    }, 1500)
  }

  const handleAddProfile = (profile: AIProfile) => {
    addAIProfile(profile)
    setShowAddModal(false)
  }

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          className="flex items-center gap-1 text-xs text-[#6b7280] uppercase tracking-wider hover:text-[#d4d4d4]"
          onClick={() => setCollapsed(!collapsed)}
        >
          <i className={`fa-solid fa-chevron-${collapsed ? 'right' : 'down'} text-[9px]`}></i>
          AI Agents
        </button>
        <button
          className="text-[#6b7280] hover:text-[#22D3EE] text-xs px-1"
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
            const isAider = profile.id === 'aider'
            return (
              <div key={profile.id} className="group flex flex-col">
                <div className="flex items-center">
                  <button
                    className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-[#37373d] flex-1 text-left"
                    onClick={() => {
                      if (isAiderQwen && ollamaStatus === 'not-installed') {
                        setShowOllamaHint(true)
                        return
                      }
                      handleLaunch(profile)
                    }}
                    title={isAiderQwen
                      ? 'Free & local — runs Qwen3-Coder via Ollama (no API costs)'
                      : isAider
                        ? 'Open source AI coding tool — connect any LLM'
                        : `Launch ${profile.name}: ${profile.command}`}
                  >
                    <i className={profile.icon} style={{ color: profile.color, fontSize: '11px', width: '14px', textAlign: 'center' }}></i>
                    <span className="text-[#d4d4d4] truncate">{profile.name}</span>
                    {isAiderQwen && (
                      <span className="text-[8px] px-1 py-0.5 rounded bg-[#06B6D4]/20 text-[#06B6D4] ml-auto shrink-0">FREE</span>
                    )}
                    {isAiderQwen && ollamaStatus === 'installed' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title="Ollama detected"></span>
                    )}
                  </button>
                  {isCustom && (
                    <button
                      className="text-[#6b7280] hover:text-red-400 text-[10px] px-1 opacity-0 group-hover:opacity-100"
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
                <strong className="text-[#22D3EE]">Free AI Coding with Qwen3-Coder</strong>
                <button onClick={() => setShowOllamaHint(false)} className="text-[#666] hover:text-white">×</button>
              </div>
              <p className="mb-1">Aider + Qwen3-Coder runs completely free and local — no API keys, no cloud, no costs.</p>
              <p className="mb-1">To set up:</p>
              <ol className="list-decimal ml-3 flex flex-col gap-0.5">
                <li>Install <a href="https://ollama.com" className="text-[#22D3EE] underline" onClick={e => { e.preventDefault(); window.open('https://ollama.com', '_blank') }}>Ollama</a></li>
                <li>Run: <code className="bg-[#0d1b0d] px-1 rounded">ollama pull qwen3-coder</code></li>
                <li>Click "Aider + Qwen3" above to start coding</li>
              </ol>
            </div>
          )}
        </div>
      )}
      {showAddModal && <AddProfileModal onSave={handleAddProfile} onCancel={() => setShowAddModal(false)} />}
    </>
  )
}
