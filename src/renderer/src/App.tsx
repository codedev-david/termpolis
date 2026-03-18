import React, { useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabView } from './components/TabView/TabView'
import { GridView } from './components/GridView/GridView'
import { SettingsPane } from './components/SettingsPane/SettingsPane'
import { HistorySearchModal } from './components/HistorySearch/HistorySearchModal'
import { TitleBar } from './components/TitleBar/TitleBar'
import { StatusBar } from './components/StatusBar/StatusBar'
import { useTerminalStore } from './store/terminalStore'

export default function App() {
  const { viewMode, showSettings, terminals, workspaces } = useTerminalStore()
  const [historyOpen, setHistoryOpen] = useState(false)
  const restored = useRef(false)

  // Restore session on mount (guard against StrictMode double-fire)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    window.termpolis.loadSession().then(res => {
      if (!res.success || !res.data) return
      const { terminals: saved, workspaces, defaultShell: ds, viewMode: vm } = res.data
      // Set state all at once, then spawn ptys
      useTerminalStore.setState({
        terminals: saved,
        workspaces,
        defaultShell: ds,
        viewMode: vm,
        activeTerminalId: saved[0]?.id ?? null,
      })
      saved.forEach(t => {
        window.termpolis.createTerminal(t.id, t.shellType, t.cwd)
      })
    })
  }, [])

  // Persist session on terminal or workspace changes (skip initial empty state)
  useEffect(() => {
    if (!restored.current) return
    const state = useTerminalStore.getState()
    window.termpolis.saveSession({
      terminals: state.terminals,
      workspaces: state.workspaces,
      defaultShell: state.defaultShell,
      viewMode: state.viewMode,
    })
  }, [terminals, workspaces])

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
    <div className="flex flex-col h-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          {renderMain()}
        </main>
      </div>
      <StatusBar />
      {historyOpen && <HistorySearchModal onClose={() => setHistoryOpen(false)} />}
    </div>
  )
}
