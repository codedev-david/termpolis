import React, { useState, useRef, useEffect } from 'react'

const COLOR_SWATCHES = [
  '#4FC3F7','#A5D6A7','#CE93D8','#EF9A9A','#FFE082',
  '#80CBC4','#FFCC80','#9FA8DA','#F48FB1','#C5E1A5','#80DEEA','#B0BEC5',
]

interface Props {
  name: string
  color: string
  anchorEl: HTMLElement | null
  onSave: (opts: { name: string; color: string }) => void
  onClose: () => void
}

export function TabPopover({ name, color, anchorEl, onSave, onClose }: Props) {
  const [editName, setEditName] = useState(name)
  const [editColor, setEditColor] = useState(color)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect()
      setPos({ top: rect.top, left: rect.right + 4 })
    }
  }, [anchorEl])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', top: pos.top, left: pos.left }}
      className="z-50 bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-xl p-4 w-56 flex flex-col gap-3"
    >
      <input
        value={editName}
        onChange={e => setEditName(e.target.value)}
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#0078d4]"
      />
      <div className="flex flex-wrap gap-1">
        {COLOR_SWATCHES.map(c => (
          <button
            key={c}
            onClick={() => setEditColor(c)}
            style={{ background: c, width: 18, height: 18, borderRadius: 3, border: editColor === c ? '2px solid white' : '2px solid transparent' }}
            aria-label={c}
          />
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="text-xs px-2 py-1 rounded hover:bg-[#3c3c3c]">Cancel</button>
        <button
          onClick={() => onSave({ name: editName.trim() || name, color: editColor })}
          className="text-xs px-2 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
        >Save</button>
      </div>
    </div>
  )
}
