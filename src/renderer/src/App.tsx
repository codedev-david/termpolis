import React, { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabView } from './components/TabView/TabView'
import { GridView } from './components/GridView/GridView'
import { SettingsPane } from './components/SettingsPane/SettingsPane'
import { HistorySearchModal } from './components/HistorySearch/HistorySearchModal'
import { useTerminalStore } from './store/terminalStore'

export default function App() {
  const { viewMode, showSettings, terminals } = useTerminalStore()
  const [historyOpen, setHistoryOpen] = useState(false)

  // Restore session on mount
  useEffect(() => {
    window.termpolis.loadSession().then(res => {
      if (!res.success || !res.data) return
      const { terminals: saved, workspaces, defaultShell: ds, viewMode: vm } = res.data
      useTerminalStore.setState({ workspaces, defaultShell: ds, viewMode: vm })
      saved.forEach(t => {
        useTerminalStore.getState().addTerminal(t)
        window.termpolis.createTerminal(t.id, t.shellType, t.cwd)
      })
    })
  }, [])

  // Persist session on terminal list changes
  useEffect(() => {
    const state = useTerminalStore.getState()
    window.termpolis.saveSession({
      terminals: state.terminals,
      workspaces: state.workspaces,
      defaultShell: state.defaultShell,
      viewMode: state.viewMode,
    })
  }, [terminals])

  // Global keyboard shortcut for history search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
        e.preventDefault()
        setHistoryOpen(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const renderMain = () => {
    if (showSettings) return <SettingsPane />
    if (viewMode === 'grid') return <GridView />
    return <TabView />
  }

  return (
    <div className="flex h-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        {renderMain()}
      </main>
      {historyOpen && <HistorySearchModal onClose={() => setHistoryOpen(false)} />}
    </div>
  )
}
