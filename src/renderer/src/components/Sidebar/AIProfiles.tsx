import React, { useState, useEffect } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { v4 as uuid } from 'uuid'
import { InstallHint } from '../InstallHint/InstallHint'
import type { AIProfile, ShellInfo, ShellType } from '../../types'
import { DEFAULT_AI_PROFILES, launchAgentProfile, resolveShellType } from '../../lib/aiProfiles'
import { CLAUDE_MODEL_OPTIONS } from '../../lib/modelBroker'

interface AddProfileModalProps {
  availableShells: ShellInfo[]
  onSave: (profile: AIProfile) => void
  onCancel: () => void
}

function AddProfileModal({ availableShells, onSave, onCancel }: AddProfileModalProps) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  // The shells offered are the ones this machine actually has — the same probe
  // that feeds the New Terminal dialog — not a fixed list of five. Offering an
  // uninstalled shell was a lie the launch then quietly corrected: a profile
  // saved as 'zsh' on Windows never ran in zsh, it fell through
  // resolveShellType() into Git Bash without ever saying so.
  const [shell, setShell] = useState<ShellType | ''>('')
  const [color, setColor] = useState('#22D3EE')
  const [model, setModel] = useState('')
  // Detection is async, so the modal can open before the list lands. Resolving
  // the displayed value the same way a launch resolves it keeps the control
  // from showing a shell it does not offer, without an effect to sync state.
  const effectiveShell: ShellType =
    shell && availableShells.some(s => s.type === shell)
      ? shell
      : resolveShellType('bash', availableShells)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !command.trim()) return
    onSave({
      id: uuid(),
      name: name.trim(),
      icon: 'fa-solid fa-terminal',
      command: command.trim(),
      shell: effectiveShell,
      color,
      ...(model && { model }),
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
          value={effectiveShell}
          onChange={e => setShell(e.target.value as ShellType)}
          title="Shells detected on this machine"
          data-testid="profile-shell-select"
        >
          {availableShells.length === 0 ? (
            <option value={effectiveShell}>Detecting shells…</option>
          ) : (
            availableShells.map(s => <option key={s.type} value={s.type}>{s.label}</option>)
          )}
        </select>
        <select
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#22D3EE]"
          value={model}
          onChange={e => setModel(e.target.value)}
          title="Claude model for this profile (appended as --model on launch). Cheaper models save tokens."
          data-testid="profile-model-select"
        >
          <option value="">Model: default (Claude only)</option>
          {CLAUDE_MODEL_OPTIONS.map(m => (
            <option key={m.alias} value={m.alias}>
              {m.label}{m.note ? ` — ${m.note}` : m.savingsPct > 0 ? ` — ${m.savingsPct}% cheaper` : ''}
            </option>
          ))}
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
  const [installedAgents, setInstalledAgents] = useState<Record<string, boolean>>({})
  const [detectingAgents, setDetectingAgents] = useState(true)
  const [installHint, setInstallHint] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    window.termpolis.detectAgents().then(res => {
      if (res.success && res.data) setInstalledAgents(res.data)
      setDetectingAgents(false)
    }).catch(() => setDetectingAgents(false))
  }, [])

  const allProfiles = [...DEFAULT_AI_PROFILES, ...aiProfiles]

  const handleLaunch = (profile: AIProfile) =>
    launchAgentProfile(profile, { availableShells, addTerminal, setLaunchingAgent })

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
            return (
              <div key={profile.id} className="group flex flex-col">
                <div className="flex items-center">
                  <button
                    className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-[#37373d] flex-1 text-left"
                    onClick={() => {
                      const notInstalled = !detectingAgents && installedAgents[profile.id] === false
                      if (notInstalled) {
                        setInstallHint({ id: profile.id, name: profile.name })
                        return
                      }
                      handleLaunch(profile)
                    }}
                    title={`Launch ${profile.name}: ${profile.command}`}
                  >
                    {profile.iconImage ? (
                      <img src={profile.iconImage} alt={profile.name} style={{ height: '14px', width: 'auto', objectFit: 'contain' }} />
                    ) : (
                      <i className={profile.icon} style={{ color: profile.color, fontSize: '11px', width: '14px', textAlign: 'center' }}></i>
                    )}
                    <span className="text-[#d4d4d4] truncate">{profile.name}</span>
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
        </div>
      )}
      {showAddModal && <AddProfileModal availableShells={availableShells} onSave={handleAddProfile} onCancel={() => setShowAddModal(false)} />}
      {installHint && <InstallHint agentId={installHint.id} agentName={installHint.name} onClose={() => setInstallHint(null)} />}
    </>
  )
}
