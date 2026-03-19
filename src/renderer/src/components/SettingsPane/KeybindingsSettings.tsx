import React, { useState, useEffect, useRef } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import {
  KEYBINDING_LABELS,
  DEFAULT_KEYBINDINGS,
  eventToKeybinding,
  type KeybindingMap,
} from '../../lib/keybindings'

export function KeybindingsSettings() {
  const { keybindings, setKeybinding, resetKeybindings } = useTerminalStore()
  const [recording, setRecording] = useState<keyof KeybindingMap | null>(null)
  const recordingRef = useRef<keyof KeybindingMap | null>(null)

  // Keep ref in sync so the keydown handler always sees current value
  recordingRef.current = recording

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = recordingRef.current
      if (!action) return

      e.preventDefault()
      e.stopPropagation()

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }

      const combo = eventToKeybinding(e)
      if (!combo) return // modifier-only keypress, wait for full combo

      setKeybinding(action, combo)
      setRecording(null)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [setKeybinding])

  const actions = Object.keys(KEYBINDING_LABELS) as (keyof KeybindingMap)[]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Keyboard Shortcuts</label>
        <button
          onClick={() => {
            resetKeybindings()
            setRecording(null)
          }}
          className="text-xs text-[#6b7280] hover:text-[#d4d4d4] px-2 py-1 rounded hover:bg-[#37373d] transition-colors"
        >
          Reset All
        </button>
      </div>
      <div className="border border-[#3c3c3c] rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#2d2d2d] border-b border-[#3c3c3c]">
              <th className="text-left px-3 py-2 text-xs text-[#6b7280] font-medium uppercase tracking-wider">Action</th>
              <th className="text-left px-3 py-2 text-xs text-[#6b7280] font-medium uppercase tracking-wider">Shortcut</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action, i) => {
              const isRecording = recording === action
              const isDefault = keybindings[action] === DEFAULT_KEYBINDINGS[action]
              return (
                <tr
                  key={action}
                  className={`border-b border-[#3c3c3c] last:border-b-0 ${i % 2 === 0 ? 'bg-[#1e1e1e]' : 'bg-[#252526]'}`}
                >
                  <td className="px-3 py-2 text-[#d4d4d4]">{KEYBINDING_LABELS[action]}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setRecording(isRecording ? null : action)}
                      className={`px-2 py-0.5 rounded font-mono text-xs border transition-colors ${
                        isRecording
                          ? 'border-[#0078d4] bg-[#0078d420] text-[#4fc3f7] animate-pulse'
                          : 'border-[#3c3c3c] bg-[#2d2d2d] text-[#d4d4d4] hover:border-[#555] hover:bg-[#37373d]'
                      }`}
                    >
                      {isRecording ? 'Press a key combination...' : keybindings[action]}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-center">
                    {!isDefault && (
                      <button
                        onClick={() => setKeybinding(action, DEFAULT_KEYBINDINGS[action])}
                        title="Reset to default"
                        className="text-[#6b7280] hover:text-[#d4d4d4] text-xs px-1"
                      >
                        <i className="fa-solid fa-rotate-left"></i>
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {recording && (
        <p className="text-xs text-[#6b7280]">
          Click anywhere outside or press Escape to cancel.
        </p>
      )}
    </div>
  )
}
