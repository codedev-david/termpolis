import { useEffect } from 'react'
import { eventToKeybinding } from '../../lib/keybindings'

interface Props {
  /** Combo to show when not recording, e.g. "Ctrl+Shift+C". */
  value: string
  /** Whether this recorder is the one currently listening for a keypress. */
  recording: boolean
  /** Toggle recording on/off (parent owns which recorder is armed). */
  onToggle: () => void
  /** Fired with the captured combo once a full (non-modifier-only) key is pressed. */
  onCapture: (combo: string) => void
  /** Fired when the user presses Escape to abandon recording. */
  onCancel: () => void
  /** Shown when value is empty and not recording. */
  placeholder?: string
}

/**
 * A small press-to-record key-combo button. Controlled: the parent decides
 * which recorder is armed (so only one global keydown listener is active at a
 * time) and what to do with the captured combo.
 */
export function KeyComboRecorder({ value, recording, onToggle, onCapture, onCancel, placeholder }: Props) {
  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      const combo = eventToKeybinding(e)
      if (!combo) return // modifier-only keypress — wait for the full combo
      onCapture(combo)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording, onCapture, onCancel])

  return (
    <button
      onClick={onToggle}
      className={`px-2 py-0.5 rounded font-mono text-xs border transition-colors ${
        recording
          ? 'border-[#0078d4] bg-[#0078d420] text-[#4fc3f7] animate-pulse'
          : 'border-[#3c3c3c] bg-[#2d2d2d] text-[#d4d4d4] hover:border-[#555] hover:bg-[#37373d]'
      }`}
    >
      {recording ? 'Press a key combination...' : (value || placeholder || 'Unset')}
    </button>
  )
}
