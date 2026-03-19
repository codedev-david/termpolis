import React, { useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { getHomedir } from '../../lib/homedir'
import { v4 as uuid } from 'uuid'

export function WorkspaceList() {
  const { workspaces, addWorkspace, renameWorkspace, updateWorkspace, removeWorkspace, terminals } = useTerminalStore()
  const [saving, setSaving] = useState(false)
  const [wsName, setWsName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [showInfo, setShowInfo] = useState(false)

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

  const startRename = (e: React.MouseEvent, ws: { id: string; name: string }) => {
    e.stopPropagation()
    setEditingId(ws.id)
    setEditName(ws.name)
  }

  const commitRename = () => {
    if (editingId && editName.trim()) {
      renameWorkspace(editingId, editName.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="border-b border-[#3c3c3c]">
      <div className="px-3 py-1.5 flex items-center justify-between">
        <span className="text-xs text-[#6b7280] uppercase tracking-wider">Workspaces</span>
        <button
          onClick={() => setShowInfo(true)}
          className="text-[#6b7280] hover:text-[#4FC3F7]"
          title="What are workspaces?"
        ><i className="fa-solid fa-circle-info text-xs"></i></button>
      </div>
      {showInfo && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#252526] rounded-lg p-6 w-96 shadow-xl flex flex-col gap-4 border border-[#3c3c3c]">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <i className="fa-solid fa-layer-group text-[#4FC3F7]"></i>
                Workspaces
              </h2>
              <button
                onClick={() => setShowInfo(false)}
                className="text-[#6b7280] hover:text-white text-lg px-1"
              >&times;</button>
            </div>
            <p className="text-sm text-[#d4d4d4] leading-relaxed">
              Workspaces let you <strong>save and restore groups of terminals</strong> with a single click.
              Think of them as snapshots of your terminal layout.
            </p>
            <div className="text-sm text-[#999] flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <i className="fa-solid fa-bookmark text-[#A5D6A7] mt-0.5"></i>
                <span><strong>Save</strong> — captures all your current terminals (names, shells, colors, themes) into a workspace.</span>
              </div>
              <div className="flex items-start gap-2">
                <i className="fa-solid fa-rotate-right text-[#4FC3F7] mt-0.5"></i>
                <span><strong>Restore</strong> — click a workspace to close current terminals and reopen the saved set.</span>
              </div>
              <div className="flex items-start gap-2">
                <i className="fa-solid fa-arrows-rotate text-[#FFE082] mt-0.5"></i>
                <span><strong>Update</strong> — overwrite a workspace with your current terminal setup.</span>
              </div>
            </div>
            <p className="text-xs text-[#6b7280]">
              Great for switching between projects — e.g. a "Frontend" workspace with
              Node + build terminals, and a "Backend" workspace with API + database terminals.
            </p>
            <button
              onClick={() => setShowInfo(false)}
              className="self-end px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
            >Got it</button>
          </div>
        </div>
      )}
      {workspaces.map(ws => (
        <div key={ws.id}>
          {editingId === ws.id ? (
            <div className="px-2 py-1 flex gap-1">
              <input
                autoFocus
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onBlur={commitRename}
                className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-0.5 text-xs focus:outline-none flex-1 min-w-0"
              />
            </div>
          ) : (
            <div
              className="flex items-center gap-1.5 px-3 py-2 hover:bg-[#2a2d2e] group cursor-pointer"
              onClick={() => handleActivate(ws.id)}
            >
              <span className="flex-1 text-sm truncate">{ws.name}</span>
              <button
                onClick={e => { e.stopPropagation(); updateWorkspace(ws.id) }}
                className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-[#4FC3F7] text-sm px-1 py-0.5 rounded hover:bg-[#37373d]"
                aria-label={`Update ${ws.name}`}
                title="Update with current terminals"
              >↻</button>
              <button
                onClick={e => startRename(e, ws)}
                className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white text-sm px-1 py-0.5 rounded hover:bg-[#37373d]"
                aria-label={`Rename ${ws.name}`}
              >✎</button>
              <button
                onClick={e => { e.stopPropagation(); removeWorkspace(ws.id) }}
                className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white text-sm px-1 py-0.5 rounded hover:bg-[#37373d]"
                aria-label={`Delete ${ws.name}`}
              >✕</button>
            </div>
          )}
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
          className="w-full text-left text-sm text-[#6b7280] hover:text-[#d4d4d4] hover:bg-[#37373d] px-3 py-2.5 rounded disabled:opacity-40"
        >+ Save Workspace</button>
      )}
    </div>
  )
}
