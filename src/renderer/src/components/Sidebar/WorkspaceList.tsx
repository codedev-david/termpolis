import React, { useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { getHomedir } from '../../lib/homedir'
import { v4 as uuid } from 'uuid'

export function WorkspaceList() {
  const { workspaces, addWorkspace, removeWorkspace, terminals } = useTerminalStore()
  const [saving, setSaving] = useState(false)
  const [wsName, setWsName] = useState('')

  const handleActivate = async (wsId: string) => {
    const ws = workspaces.find(w => w.id === wsId)
    if (!ws) return

    // Kill all existing terminals first
    const current = useTerminalStore.getState().terminals
    for (const t of current) {
      window.termpolis.killTerminal(t.id)
    }
    useTerminalStore.setState({ terminals: [], activeTerminalId: null })

    // Spawn workspace terminals
    const cwd = await getHomedir()
    const newTerminals = []
    for (const t of ws.terminals) {
      const id = uuid()
      await window.termpolis.createTerminal(id, t.shellType as any, cwd)
      newTerminals.push({ id, name: t.name, color: t.color, shellType: t.shellType as any, cwd })
    }
    useTerminalStore.setState({
      terminals: newTerminals,
      activeTerminalId: newTerminals[0]?.id ?? null,
      showSettings: false,
    })
  }

  return (
    <div className="border-b border-[#3c3c3c]">
      {workspaces.length > 0 && (
        <div className="px-3 py-1 text-xs text-[#6b7280] uppercase tracking-wider">Workspaces</div>
      )}
      {workspaces.map(ws => (
        <div
          key={ws.id}
          className="flex items-center gap-1 px-3 py-1 hover:bg-[#2a2d2e] group cursor-pointer"
          onClick={() => handleActivate(ws.id)}
        >
          <span className="flex-1 text-xs truncate">{ws.name}</span>
          <button
            onClick={e => { e.stopPropagation(); removeWorkspace(ws.id) }}
            className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white text-xs"
            aria-label={`Delete ${ws.name}`}
          >✕</button>
        </div>
      ))}
      {saving ? (
        <div className="px-2 py-2 flex flex-col gap-1">
          <input
            autoFocus
            placeholder="Workspace name"
            value={wsName}
            onChange={e => setWsName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { addWorkspace(wsName.trim() || 'Workspace'); setSaving(false) }
              if (e.key === 'Escape') setSaving(false)
            }}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-xs focus:outline-none"
          />
          <div className="flex gap-1">
            <button onClick={() => setSaving(false)} className="text-xs px-2 py-0.5 rounded hover:bg-[#3c3c3c]">Cancel</button>
            <button onClick={() => { addWorkspace(wsName.trim() || 'Workspace'); setSaving(false) }} className="text-xs px-2 py-0.5 rounded bg-[#0078d4] text-white">Save</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setSaving(true); setWsName('') }}
          disabled={terminals.length === 0}
          className="w-full text-left text-xs text-[#6b7280] hover:text-[#d4d4d4] px-3 py-1 disabled:opacity-40"
        >+ Save Workspace</button>
      )}
    </div>
  )
}
