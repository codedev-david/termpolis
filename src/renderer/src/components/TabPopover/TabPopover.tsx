import { useState, useRef, useEffect } from 'react'
import { TERMINAL_THEMES, THEME_IDS, getTheme } from '../../themes/terminalThemes'

const COLOR_SWATCHES = [
  '#22D3EE','#A5D6A7','#CE93D8','#EF9A9A','#FFE082',
  '#80CBC4','#FFCC80','#9FA8DA','#F48FB1','#C5E1A5','#80DEEA','#B0BEC5',
]

const FONT_FAMILY_OPTIONS = [
  { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono, monospace' },
]

interface Props {
  name: string
  color: string
  fontSize: number
  theme: string
  fontFamily: string
  anchorEl: HTMLElement | null
  onSave: (opts: { name: string; color: string; fontSize: number; theme: string; fontFamily: string }) => void
  onClose: () => void
}

export function TabPopover({ name, color, fontSize, theme, fontFamily, anchorEl, onSave, onClose }: Props) {
  const [editName, setEditName] = useState(name)
  const [editColor, setEditColor] = useState(color)
  const [editFontSize, setEditFontSize] = useState(fontSize)
  const [editTheme, setEditTheme] = useState(theme)
  const [editFontFamily, setEditFontFamily] = useState(fontFamily)
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

  const handleFontSizeChange = (value: number) => {
    setEditFontSize(Math.min(32, Math.max(8, value)))
  }

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', top: pos.top, left: pos.left }}
      className="z-50 bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-xl p-4 w-72 flex flex-col gap-3"
    >
      {/* Name */}
      <input
        value={editName}
        onChange={e => setEditName(e.target.value)}
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#0078d4]"
      />

      {/* Font Size */}
      <div className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Font Size
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleFontSizeChange(editFontSize - 1)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm hover:bg-[#3c3c3c] leading-none"
          >−</button>
          <input
            type="number"
            min={8}
            max={32}
            value={editFontSize}
            onChange={e => handleFontSizeChange(Number(e.target.value))}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none w-14 text-center"
            aria-label="Font size"
          />
          <button
            onClick={() => handleFontSizeChange(editFontSize + 1)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm hover:bg-[#3c3c3c] leading-none"
          >+</button>
        </div>
      </div>

      {/* Theme pills */}
      <div className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Theme
        <div className="flex flex-wrap gap-1 mt-1">
          {THEME_IDS.map(id => {
            const t = getTheme(id)
            return (
              <button
                key={id}
                onClick={() => setEditTheme(id)}
                style={{
                  background: t.background as string,
                  color: t.foreground as string,
                  border: `2px solid ${editTheme === id ? '#0078d4' : 'transparent'}`,
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 11,
                }}
              >
                {TERMINAL_THEMES[id].name}
              </button>
            )
          })}
        </div>
      </div>

      {/* Font Family */}
      <div className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Font Family
        <select
          value={editFontFamily}
          onChange={e => setEditFontFamily(e.target.value)}
          className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
          aria-label="Font family"
        >
          {FONT_FAMILY_OPTIONS.map(f => (
            <option key={f.label} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      {/* Color swatches */}
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
          onClick={() => onSave({
            name: editName.trim() || name,
            color: editColor,
            fontSize: editFontSize,
            theme: editTheme,
            fontFamily: editFontFamily,
          })}
          className="text-xs px-2 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
        >Save</button>
      </div>
    </div>
  )
}
