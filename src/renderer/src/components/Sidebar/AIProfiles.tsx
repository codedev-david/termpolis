import React, { useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { v4 as uuid } from 'uuid'
import { getHomedir } from '../../lib/homedir'
import { TERMINAL_DEFAULTS } from '../../lib/terminalDefaults'
import type { AIProfile, ShellInfo, ShellType } from '../../types'

const DEFAULT_AI_PROFILES: AIProfile[] = [
  { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude', shell: 'bash', color: '#D97706' },
  { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', command: 'codex', shell: 'bash', color: '#10B981' },
  { id: 'aider', name: 'Aider', icon: 'fa-solid fa-code', command: 'aider', shell: 'bash', color: '#8B5CF6' },
  { id: 'copilot', name: 'GitHub Copilot', icon: 'fa-brands fa-github', command: 'gh copilot', shell: 'bash', color: '#6366F1' },
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
  const [color, setColor] = useState('#4FC3F7')

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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <form
        className="bg-[#2d2d2d] rounded-lg p-5 w-80 flex flex-col gap-3 border border-[#3c3c3c]"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="text-sm font-semibold text-[#d4d4d4]">Add AI Profile</h3>
        <input
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#4FC3F7]"
          placeholder="Name (e.g. My Agent)"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />
        <input
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#4FC3F7]"
          placeholder="Command (e.g. claude --model opus)"
          value={command}
          onChange={e => setCommand(e.target.value)}
        />
        <select
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#4FC3F7]"
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
          <button type="submit" className="px-3 py-1.5 text-sm rounded bg-[#4FC3F7] text-[#1e1e1e] font-medium hover:bg-[#3bacda]">Add</button>
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
    // Wait for shell init, then send the command
    setTimeout(() => {
      window.termpolis.writeToTerminal(id, profile.command + '\r')
    }, 500)
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
          className="text-[#6b7280] hover:text-[#4FC3F7] text-xs px-1"
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
            return (
              <div key={profile.id} className="group flex items-center">
                <button
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-[#37373d] flex-1 text-left"
                  onClick={() => handleLaunch(profile)}
                  title={`Launch ${profile.name}: ${profile.command}`}
                >
                  <i className={profile.icon} style={{ color: profile.color, fontSize: '11px', width: '14px', textAlign: 'center' }}></i>
                  <span className="text-[#d4d4d4] truncate">{profile.name}</span>
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
            )
          })}
        </div>
      )}
      {showAddModal && <AddProfileModal onSave={handleAddProfile} onCancel={() => setShowAddModal(false)} />}
    </>
  )
}
