import React, { useEffect, useRef, useState } from 'react'
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

function TerminalCard({
  t,
  index,
  total,
  onRemove,
}: {
  t: { id: string; name: string; color: string; fontSize: number; theme: string; fontFamily: string }
  index: number
  total: number
  onRemove: (id: string) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [isInViewport, setIsInViewport] = useState(true)

  useEffect(() => {
    const el = cardRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => setIsInViewport(entry.isIntersecting),
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={cardRef}
      key={t.id}
      className="flex flex-col bg-[#1e1e1e] overflow-hidden rounded"
      style={getCellStyle(index, total)}
    >
      <div
        className="flex items-center gap-2 px-2 py-1 bg-[#2d2d2d] shrink-0"
        style={{ borderLeft: `3px solid ${t.color}` }}
      >
        <span className="text-xs font-medium truncate flex-1">{t.name}</span>
        <button
          onClick={() => { window.termpolis.killTerminal(t.id); onRemove(t.id) }}
          className="text-[#6b7280] hover:text-white text-xs px-1"
          aria-label={`Close ${t.name}`}
        >✕</button>
      </div>
      <div className="flex-1 overflow-hidden relative">
        <TerminalPane
          terminalId={t.id}
          terminalName={t.name}
          isVisible={isInViewport}
          fontSize={t.fontSize}
          theme={t.theme}
          fontFamily={t.fontFamily}
        />
      </div>
    </div>
  )
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
        <TerminalCard
          key={t.id}
          t={t}
          index={i}
          total={terminals.length}
          onRemove={removeTerminal}
        />
      ))}
    </div>
  )
}
