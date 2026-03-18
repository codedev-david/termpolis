import React, { useState } from 'react'
import type { ShellInfo, ShellType } from '../../types'

const COLOR_SWATCHES = [
  '#4FC3F7','#A5D6A7','#CE93D8','#EF9A9A','#FFE082',
  '#80CBC4','#FFCC80','#9FA8DA','#F48FB1','#C5E1A5','#80DEEA','#B0BEC5',
]

interface Props {
  shells: ShellInfo[]
  nextIndex: number
  defaultShell: ShellType
  onCreate: (opts: { name: string; shellType: ShellType; color: string }) => void
  onCancel: () => void
}

export function AddTerminalModal({ shells, nextIndex, defaultShell, onCreate, onCancel }: Props) {
  const [name, setName] = useState(`Terminal ${nextIndex}`)
  const [shellType, setShellType] = useState<ShellType>(defaultShell)
  const [color, setColor] = useState(COLOR_SWATCHES[0])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#252526] rounded-lg p-6 w-80 shadow-xl flex flex-col gap-4">
        <h2 className="text-base font-semibold">New Terminal</h2>
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#0078d4]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Shell
          <select
            value={shellType}
            onChange={e => setShellType(e.target.value as ShellType)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
          >
            {shells.map(s => <option key={s.type} value={s.type}>{s.label}</option>)}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-sm">
          Color
          <div className="flex flex-wrap gap-2 mt-1">
            {COLOR_SWATCHES.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{ background: c, width: 20, height: 20, borderRadius: 4, border: color === c ? '2px solid white' : '2px solid transparent' }}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-2">
          <button onClick={onCancel} className="px-3 py-1 text-sm rounded hover:bg-[#3c3c3c]">Cancel</button>
          <button
            onClick={() => onCreate({ name: name.trim() || `Terminal ${nextIndex}`, shellType, color })}
            className="px-3 py-1 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >Create</button>
        </div>
      </div>
    </div>
  )
}
