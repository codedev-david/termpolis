import { useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import {
  KEYBINDING_LABELS,
  DEFAULT_KEYBINDINGS,
  findKeybindingConflict,
  type KeybindingMap,
} from '../../lib/keybindings'
import { KeyComboRecorder } from './KeyComboRecorder'
import { CustomKeybindings } from './CustomKeybindings'

export function KeybindingsSettings() {
  const { keybindings, customKeybindings, setKeybinding, resetKeybindings } = useTerminalStore()
  // A single armed recorder across the whole pane (fixed rows + custom rows),
  // keyed by action name, `custom:<id>`, or `custom-new`.
  const [recordingId, setRecordingId] = useState<string | null>(null)

  const actions = Object.keys(KEYBINDING_LABELS) as (keyof KeybindingMap)[]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Keyboard Shortcuts</label>
        <button
          onClick={() => {
            resetKeybindings()
            setRecordingId(null)
          }}
          className="text-xs text-[#9ca3af] hover:text-[#d4d4d4] px-2 py-1 rounded hover:bg-[#37373d] transition-colors"
        >
          Reset All
        </button>
      </div>
      <div className="border border-[#3c3c3c] rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#2d2d2d] border-b border-[#3c3c3c]">
              <th className="text-left px-3 py-2 text-xs text-[#9ca3af] font-medium uppercase tracking-wider">Action</th>
              <th className="text-left px-3 py-2 text-xs text-[#9ca3af] font-medium uppercase tracking-wider">Shortcut</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action, i) => {
              const isDefault = keybindings[action] === DEFAULT_KEYBINDINGS[action]
              const conflict = findKeybindingConflict(keybindings[action], keybindings, customKeybindings, { action })
              return (
                <tr
                  key={action}
                  className={`border-b border-[#3c3c3c] last:border-b-0 ${i % 2 === 0 ? 'bg-[#1e1e1e]' : 'bg-[#252526]'}`}
                >
                  <td className="px-3 py-2 text-[#d4d4d4]">{KEYBINDING_LABELS[action]}</td>
                  <td className="px-3 py-2">
                    <KeyComboRecorder
                      value={keybindings[action]}
                      recording={recordingId === action}
                      onToggle={() => setRecordingId(recordingId === action ? null : action)}
                      onCapture={combo => { setKeybinding(action, combo); setRecordingId(null) }}
                      onCancel={() => setRecordingId(null)}
                    />
                    {conflict && (
                      <span
                        className="ml-2 text-[11px] text-[#e0a458]"
                        title={`This combo is also assigned to “${conflict}”`}
                      >
                        <i className="fa-solid fa-triangle-exclamation mr-1"></i>Conflicts with {conflict}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-center">
                    {!isDefault && (
                      <button
                        onClick={() => setKeybinding(action, DEFAULT_KEYBINDINGS[action])}
                        title="Reset to default"
                        className="text-[#9ca3af] hover:text-[#d4d4d4] text-xs px-1"
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
      {recordingId && (
        <p className="text-xs text-[#9ca3af]">
          Click anywhere outside or press Escape to cancel.
        </p>
      )}

      <CustomKeybindings recordingId={recordingId} setRecordingId={setRecordingId} />
    </div>
  )
}
