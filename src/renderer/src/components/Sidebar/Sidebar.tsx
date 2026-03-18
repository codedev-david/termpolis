import React, { useEffect, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalTab } from './TerminalTab'
import { AddTerminalModal } from './AddTerminalModal'
import { WorkspaceList } from './WorkspaceList'
import { getHomedir } from '../../lib/homedir'
import { v4 as uuid } from 'uuid'
import type { ShellInfo } from '../../types'

export function Sidebar() {
  const {
    terminals, activeTerminalId, viewMode, showSettings, defaultShell,
    addTerminal, removeTerminal, updateTerminal,
    setActiveTerminal, toggleViewMode, setShowSettings,
  } = useTerminalStore()

  const [showAddModal, setShowAddModal] = useState(false)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])

  useEffect(() => {
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setAvailableShells(res.data)
    })
  }, [])

  const handleCreate = async (opts: { name: string; shellType: any; color: string }) => {
    const id = uuid()
    const cwd = await getHomedir()
    const res = await window.termpolis.createTerminal(id, opts.shellType, cwd)
    if (!res.success) { alert(`Failed to open terminal: ${res.error}`); return }
    addTerminal({ id, name: opts.name, color: opts.color, shellType: opts.shellType, cwd })
    setShowAddModal(false)
  }

  const handleClose = (id: string) => {
    window.termpolis.killTerminal(id)
    removeTerminal(id)
  }

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-[#252526] border-r border-[#3c3c3c] h-full">
      <div className="flex flex-col gap-1 p-2 border-b border-[#3c3c3c]">
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d] ${showSettings ? 'bg-[#37373d]' : ''}`}
        >⚙ Settings</button>
        <button
          onClick={() => {
            toggleViewMode()
            setShowSettings(false)
            if (!activeTerminalId && terminals.length > 0) {
              setActiveTerminal(terminals[0].id)
            }
          }}
          className="flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d]"
        >{viewMode === 'tabs' ? '⊞ Grid View' : '☰ Tab View'}</button>
      </div>
      <WorkspaceList />
      <div className="flex-1 overflow-y-auto">
        {terminals.map(t => (
          <TerminalTab
            key={t.id}
            terminal={t}
            isActive={t.id === activeTerminalId && !showSettings}
            onClick={() => setActiveTerminal(t.id)}
            onClose={() => handleClose(t.id)}
            onUpdate={patch => updateTerminal(t.id, patch)}
          />
        ))}
      </div>
      <div className="p-2 border-t border-[#3c3c3c]">
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d] text-[#4FC3F7] w-full"
        >+ Add Terminal</button>
      </div>
      {showAddModal && (
        <AddTerminalModal
          shells={availableShells}
          nextIndex={terminals.length + 1}
          defaultShell={defaultShell}
          onCreate={handleCreate}
          onCancel={() => setShowAddModal(false)}
        />
      )}
    </aside>
  )
}
