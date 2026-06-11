import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useTerminalStore } from '../../store/terminalStore'
import { customComboHasModifier } from '../../lib/keybindings'
import { KeyComboRecorder } from './KeyComboRecorder'

interface Props {
  /** Id of the recorder currently armed across the whole Keybindings pane. */
  recordingId: string | null
  setRecordingId: (id: string | null) => void
}

const NEW_ID = 'custom-new'
const inputClass =
  'bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm text-[#d4d4d4] outline-none focus:border-[#0078d4]'

/**
 * User-defined "macro" shortcuts: a combo that types a snippet (optionally
 * pressing Enter) into the active terminal. Listed below the fixed shortcut
 * table in Settings → Keybindings.
 */
export function CustomKeybindings({ recordingId, setRecordingId }: Props) {
  const { customKeybindings, addCustomKeybinding, updateCustomKeybinding, removeCustomKeybinding } = useTerminalStore()
  const [draft, setDraft] = useState({ label: '', combo: '', text: '', runOnSend: true })

  const comboNeedsModifier = !!draft.combo && !customComboHasModifier(draft.combo)
  const canAdd = !!(draft.label.trim() && draft.combo.trim() && draft.text.trim() && customComboHasModifier(draft.combo))

  const handleAdd = () => {
    if (!canAdd) return
    addCustomKeybinding({
      id: uuid(),
      label: draft.label.trim(),
      combo: draft.combo,
      text: draft.text,
      runOnSend: draft.runOnSend,
    })
    setDraft({ label: '', combo: '', text: '', runOnSend: true })
    setRecordingId(null)
  }

  return (
    <div className="flex flex-col gap-2 mt-4">
      <label className="text-sm font-medium">Custom Shortcuts</label>
      <p className="text-xs text-[#9ca3af]">
        Bind a key (with Ctrl or Alt) to a snippet that&apos;s typed into the active terminal. Enable “Run” to press Enter after it.
      </p>
      <p className="text-[11px] text-[#6b7280]">
        <i className="fa-solid fa-circle-info mr-1"></i>
        Saved unencrypted in your app data — don&apos;t store passwords or tokens here.
      </p>

      {customKeybindings.length === 0 && (
        <p className="text-xs text-[#6b7280] italic">No custom shortcuts yet.</p>
      )}

      {customKeybindings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {customKeybindings.map(cb => (
            <div key={cb.id} className="flex items-center gap-2 flex-wrap">
              <input
                value={cb.label}
                onChange={e => updateCustomKeybinding(cb.id, { label: e.target.value })}
                placeholder="Label"
                aria-label={`Label for ${cb.label || 'shortcut'}`}
                className={`${inputClass} w-32`}
              />
              <KeyComboRecorder
                value={cb.combo}
                recording={recordingId === `custom:${cb.id}`}
                onToggle={() => setRecordingId(recordingId === `custom:${cb.id}` ? null : `custom:${cb.id}`)}
                onCapture={combo => { updateCustomKeybinding(cb.id, { combo }); setRecordingId(null) }}
                onCancel={() => setRecordingId(null)}
                placeholder="Set combo"
              />
              <input
                value={cb.text}
                onChange={e => updateCustomKeybinding(cb.id, { text: e.target.value })}
                placeholder="Text to send"
                aria-label={`Text sent by ${cb.label || 'shortcut'}`}
                className={`${inputClass} flex-1 min-w-[8rem] font-mono`}
              />
              <label className="flex items-center gap-1 text-xs text-[#9ca3af]">
                <input
                  type="checkbox"
                  aria-label="Run on send"
                  checked={cb.runOnSend}
                  onChange={e => updateCustomKeybinding(cb.id, { runOnSend: e.target.checked })}
                />
                Run
              </label>
              <button
                title="Remove shortcut"
                onClick={() => removeCustomKeybinding(cb.id)}
                className="text-[#9ca3af] hover:text-red-400 text-xs px-1"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div className="flex items-center gap-2 flex-wrap border-t border-[#3c3c3c] pt-2">
        <input
          value={draft.label}
          onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
          placeholder="Label (e.g. Git status)"
          className={`${inputClass} w-32`}
        />
        <KeyComboRecorder
          value={draft.combo}
          recording={recordingId === NEW_ID}
          onToggle={() => setRecordingId(recordingId === NEW_ID ? null : NEW_ID)}
          onCapture={combo => { setDraft(d => ({ ...d, combo })); setRecordingId(null) }}
          onCancel={() => setRecordingId(null)}
          placeholder="Set combo"
        />
        <input
          value={draft.text}
          onChange={e => setDraft(d => ({ ...d, text: e.target.value }))}
          placeholder="Text to send (e.g. git status)"
          className={`${inputClass} flex-1 min-w-[8rem] font-mono`}
        />
        <label className="flex items-center gap-1 text-xs text-[#9ca3af]">
          <input
            type="checkbox"
            aria-label="Run new shortcut on send"
            checked={draft.runOnSend}
            onChange={e => setDraft(d => ({ ...d, runOnSend: e.target.checked }))}
          />
          Run
        </label>
        <button
          onClick={handleAdd}
          disabled={!canAdd}
          className={`px-3 py-1 text-sm rounded ${
            canAdd ? 'bg-[#0078d4] hover:bg-[#106ebe] text-white' : 'bg-[#2d2d2d] text-[#6b7280] cursor-not-allowed'
          }`}
        >
          Add Shortcut
        </button>
      </div>
      {comboNeedsModifier && (
        <p className="text-[11px] text-[#e0a458]">
          <i className="fa-solid fa-triangle-exclamation mr-1"></i>
          Custom shortcuts must include Ctrl or Alt so they don&apos;t collide with normal typing.
        </p>
      )}
    </div>
  )
}
