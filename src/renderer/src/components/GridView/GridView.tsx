import React from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalPane } from '../TerminalPane/TerminalPane'

function getGridStyle(count: number): React.CSSProperties {
  if (count === 1) return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
  return { gridTemplateColumns: '1fr 1fr', gridAutoRows: '1fr' }
}

function getCellStyle(index: number, total: number): React.CSSProperties {
  if (total > 2 && total % 2 !== 0 && index === total - 1) {
    return { gridColumn: '1 / -1' }
  }
  return {}
}

export function GridView() {
  const { terminals, removeTerminal } = useTerminalStore()

  if (terminals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#6b7280]">
        <p>No terminals open. Click <strong className="text-[#d4d4d4]">+ Add Terminal</strong> to get started.</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full grid gap-1 p-1 bg-[#252526]" style={getGridStyle(terminals.length)}>
      {terminals.map((t, i) => (
        <div
          key={t.id}
          className="flex flex-col bg-[#1e1e1e] overflow-hidden rounded"
          style={getCellStyle(i, terminals.length)}
        >
          <div
            className="flex items-center gap-2 px-2 py-1 bg-[#2d2d2d] shrink-0"
            style={{ borderLeft: `3px solid ${t.color}` }}
          >
            <span className="text-xs font-medium truncate flex-1">{t.name}</span>
            <button
              onClick={() => { window.termpolis.killTerminal(t.id); removeTerminal(t.id) }}
              className="text-[#6b7280] hover:text-white text-xs px-1"
              aria-label={`Close ${t.name}`}
            >✕</button>
          </div>
          <div className="flex-1 overflow-hidden">
            <TerminalPane terminalId={t.id} terminalName={t.name} isVisible={true} />
          </div>
        </div>
      ))}
    </div>
  )
}
