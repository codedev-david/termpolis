import React from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalPane } from '../TerminalPane/TerminalPane'

export function TabView() {
  const { terminals, activeTerminalId } = useTerminalStore()

  if (terminals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#6b7280]">
        <p>No terminals open. Click <strong className="text-[#d4d4d4]">+ Add Terminal</strong> to get started.</p>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full">
      {terminals.map(t => (
        <TerminalPane
          key={t.id}
          terminalId={t.id}
          terminalName={t.name}
          isVisible={t.id === activeTerminalId}
        />
      ))}
    </div>
  )
}
