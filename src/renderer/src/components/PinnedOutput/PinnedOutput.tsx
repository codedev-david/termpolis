import { useState } from 'react'

export interface PinnedItem {
  id: string
  text: string
  timestamp: number
  terminalName: string
}

interface Props {
  pins: PinnedItem[]
  onUnpin: (id: string) => void
}

export function PinnedOutput({ pins, onUnpin }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (pins.length === 0) return null

  return (
    <div className="absolute top-0 left-0 right-0 z-40 bg-[#1e1e1e] border-b border-[#3c3c3c]">
      <button
        className="w-full flex items-center gap-2 px-3 py-1 text-xs text-[#d4d4d4] hover:bg-[#2a2d2e] cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <i className="fa-solid fa-thumbtack text-[10px] text-[#D97706]"></i>
        <span>{pins.length} pinned</span>
        <i className={`fa-solid fa-chevron-${expanded ? 'up' : 'down'} text-[10px] ml-auto`}></i>
      </button>
      {expanded && (
        <div className="max-h-[200px] overflow-y-auto px-2 pb-2 flex flex-col gap-1.5">
          {pins.map(pin => (
            <div
              key={pin.id}
              className="bg-[#2a2d2e] border border-[#3c3c3c] rounded px-2 py-1.5 relative group"
            >
              <button
                className="absolute top-1 right-1 text-[#999] hover:text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer w-4 h-4 flex items-center justify-center"
                onClick={() => onUnpin(pin.id)}
                title="Unpin"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
              <pre className="text-[11px] text-[#d4d4d4] font-mono whitespace-pre-wrap max-h-[4lh] overflow-y-auto leading-tight pr-4">
                {pin.text}
              </pre>
              <div className="text-[9px] text-[#999] mt-1">
                {new Date(pin.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
