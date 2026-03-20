import React, { useState } from 'react'
import type { ShellInfo, ShellType } from '../../types'
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
  shells: ShellInfo[]
  nextIndex: number
  defaultShell: ShellType
  onCreate: (opts: { name: string; shellType: ShellType; color: string; fontSize: number; theme: string; fontFamily: string }) => void
  onCancel: () => void
}

export function AddTerminalModal({ shells, nextIndex, defaultShell, onCreate, onCancel }: Props) {
  const [name, setName] = useState(`Terminal ${nextIndex}`)
  const [shellType, setShellType] = useState<ShellType>(defaultShell)
  const [color, setColor] = useState(COLOR_SWATCHES[0])
  const [fontSize, setFontSize] = useState(14)
  const [theme, setTheme] = useState('dark')
  const [fontFamily, setFontFamily] = useState(FONT_FAMILY_OPTIONS[0].value)

  const selectedTheme = getTheme(theme)

  const handleFontSizeChange = (value: number) => {
    setFontSize(Math.min(32, Math.max(8, value)))
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn">
      <div className="bg-[#252526] rounded-lg p-6 w-96 shadow-xl flex flex-col gap-4">
        <h2 className="text-base font-semibold">New Terminal</h2>

        {/* Name */}
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#0078d4]"
          />
        </label>

        {/* Shell + Font Size side by side */}
        <div className="flex gap-3 items-end">
          <label className="flex flex-col gap-1 text-sm flex-1">
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
            Font Size
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleFontSizeChange(fontSize - 1)}
                className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm hover:bg-[#3c3c3c] leading-none"
              >−</button>
              <input
                type="number"
                min={8}
                max={32}
                value={fontSize}
                onChange={e => handleFontSizeChange(Number(e.target.value))}
                className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none w-14 text-center"
              />
              <button
                onClick={() => handleFontSizeChange(fontSize + 1)}
                className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm hover:bg-[#3c3c3c] leading-none"
              >+</button>
            </div>
          </div>
        </div>

        {/* Theme pills */}
        <div className="flex flex-col gap-1 text-sm">
          Theme
          <div className="flex flex-wrap gap-2 mt-1">
            {THEME_IDS.map(id => {
              const t = getTheme(id)
              return (
                <button
                  key={id}
                  onClick={() => setTheme(id)}
                  style={{
                    background: t.background as string,
                    color: t.foreground as string,
                    border: `2px solid ${theme === id ? '#0078d4' : 'transparent'}`,
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 12,
                  }}
                >
                  {TERMINAL_THEMES[id].name}
                </button>
              )
            })}
          </div>
        </div>

        {/* Font Family */}
        <label className="flex flex-col gap-1 text-sm">
          Font Family
          <select
            value={fontFamily}
            onChange={e => setFontFamily(e.target.value)}
            className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
          >
            {FONT_FAMILY_OPTIONS.map(f => (
              <option key={f.label} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>

        {/* Color swatches */}
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

        {/* Theme Preview */}
        <div
          style={{
            background: selectedTheme.background as string,
            color: selectedTheme.foreground as string,
            fontFamily,
            fontSize,
            padding: '8px 12px',
            borderRadius: 4,
            height: 80,
            overflow: 'hidden',
            lineHeight: 1.5,
            border: '1px solid #3c3c3c',
          }}
        >
          <div>user@host:~/projects$ git status</div>
          <div>On branch main</div>
          <div>nothing to commit, working tree clean</div>
        </div>

        {/* Buttons */}
        <div className="flex gap-2 justify-end mt-2">
          <button onClick={onCancel} className="px-3 py-1 text-sm rounded hover:bg-[#3c3c3c]">Cancel</button>
          <button
            onClick={() => onCreate({
              name: name.trim() || `Terminal ${nextIndex}`,
              shellType,
              color,
              fontSize,
              theme,
              fontFamily,
            })}
            className="px-3 py-1 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >Create</button>
        </div>
      </div>
    </div>
  )
}
