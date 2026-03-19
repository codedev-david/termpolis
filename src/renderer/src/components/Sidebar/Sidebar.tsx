import React, { useEffect, useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalTab } from './TerminalTab'
import { AddTerminalModal } from './AddTerminalModal'
import { WorkspaceList } from './WorkspaceList'
import { getHomedir } from '../../lib/homedir'
import { v4 as uuid } from 'uuid'
import type { ShellInfo } from '../../types'
import { TERMINAL_DEFAULTS } from '../../lib/terminalDefaults'

export function Sidebar() {
  const {
    terminals, activeTerminalId, viewMode, showSettings, defaultShell,
    addTerminal, removeTerminal, updateTerminal,
    setActiveTerminal, toggleViewMode, setShowSettings,
    sidebarCollapsed, setSidebarCollapsed,
  } = useTerminalStore()

  const [showAddModal, setShowAddModal] = useState(false)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])

  useEffect(() => {
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setAvailableShells(res.data)
    })
  }, [])

  const handleCreate = async (opts: { name: string; shellType: any; color: string; fontSize?: number; theme?: string; fontFamily?: string }) => {
    const id = uuid()
    const cwd = await getHomedir()
    const res = await window.termpolis.createTerminal(id, opts.shellType, cwd)
    if (!res.success) { alert(`Failed to open terminal: ${res.error}`); return }
    addTerminal({
      id,
      name: opts.name,
      color: opts.color,
      shellType: opts.shellType,
      cwd,
      fontSize: opts.fontSize ?? TERMINAL_DEFAULTS.fontSize,
      theme: opts.theme ?? TERMINAL_DEFAULTS.theme,
      fontFamily: opts.fontFamily ?? TERMINAL_DEFAULTS.fontFamily,
    })
    setShowAddModal(false)
  }

  const handleClose = (id: string) => {
    window.termpolis.killTerminal(id)
    removeTerminal(id)
  }

  if (sidebarCollapsed) {
    return (
      <aside className="w-10 shrink-0 flex flex-col items-center bg-[#252526] border-r border-[#3c3c3c] h-full py-2">
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="text-[#6b7280] hover:text-white px-2 py-3 rounded hover:bg-[#37373d]"
          title="Expand sidebar"
        ><i className="fa-solid fa-chevron-right text-lg"></i></button>
      </aside>
    )
  }

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-[#252526] border-r border-[#3c3c3c] h-full">
      <div className="flex flex-col gap-1 p-2 border-b border-[#3c3c3c]">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-[#37373d] flex-1 ${showSettings ? 'bg-[#37373d]' : ''}`}
          >⚙ Settings</button>
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="text-[#6b7280] hover:text-white px-2 py-2 rounded hover:bg-[#37373d]"
            title="Collapse sidebar"
          ><i className="fa-solid fa-chevron-left text-lg"></i></button>
        </div>
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
      <div className="border-t border-[#3c3c3c]"></div>
      <div className="px-3 py-1.5 text-xs text-[#6b7280] uppercase tracking-wider">Terminals</div>
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
