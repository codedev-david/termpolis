import { useShallow } from 'zustand/react/shallow'
import { useTerminalStore } from '../../store/terminalStore'
import { TerminalPane } from '../TerminalPane/TerminalPane'

export function TabView() {
  // Select only what we render. A bare useTerminalStore() re-runs this on EVERY store write —
  // including ones that touch neither terminals nor the active id — and re-maps every pane element.
  const { terminals, activeTerminalId } = useTerminalStore(
    useShallow(s => ({ terminals: s.terminals, activeTerminalId: s.activeTerminalId })),
  )

  if (terminals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#9ca3af]">
        <p>No terminals open. Click <strong className="text-[#d4d4d4]">+ Add Terminal</strong> to get started.</p>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full">
      {terminals.filter(t => !t.hidden).map(t => (
        <TerminalPane
          key={t.id}
          terminalId={t.id}
          terminalName={t.name}
          shellType={t.shellType}
          cwd={t.cwd}
          isVisible={t.id === activeTerminalId}
          fontSize={t.fontSize}
          theme={t.theme}
          fontFamily={t.fontFamily}
        />
      ))}
    </div>
  )
}
