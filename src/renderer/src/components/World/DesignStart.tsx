// Lumopolis: design something new. The user describes the app (typed, or spoken through the same
// voice sink as the Ask bar: nothing reaches a terminal), main's designer drafts a planned world
// read-only, and the pane opens it. The draft runs under a draft:<token> key, so Cancel can stop it
// before its design key exists.
import { useRef, useState } from 'react'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { btnCls, dialogCls, fieldCls, primaryCls } from './worldTargets'
import { lumopolisModel } from './worldAgentModel'
import { useUiZoom } from './worldPane'

export interface DesignStartProps {
  onDrafted: (key: string) => void
  onClose: () => void
}

export const DRAFT_UNREACHABLE = "Lumopolis couldn't draft that design. Try again."

let drafts = 0
const draftKey = (): string => `draft:${Date.now().toString(36)}-${++drafts}`

export function DesignStart({ onDrafted, onClose }: DesignStartProps): JSX.Element {
  const zoom = useUiZoom()
  const [text, setText] = useState('')
  const [drafting, setDrafting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = useRef<string | null>(null)
  const mic = useVoiceInput(null, false, {
    onTranscript: (t) => setText((prev) => (prev.trim() === '' ? t : `${prev.trimEnd()} ${t}`)),
  })
  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  const description = text.trim()
  const submit = (): void => {
    if (description === '' || drafting !== null) return
    const key = draftKey()
    current.current = key
    setDrafting(key)
    setError(null)
    const done = (message: string | null, designKey?: string): void => {
      if (current.current !== key) return
      current.current = null
      setDrafting(null)
      if (designKey) onDrafted(designKey)
      else setError(message)
    }
    lumopolisModel().then((model) => window.termpolis.worldDesignDraft(description, key, model)).then(
      (res) => (res.success ? done(null, res.data.key) : done(res.error)),
      () => done(DRAFT_UNREACHABLE),
    )
  }

  const cancel = (): void => {
    if (drafting === null) { onClose(); return }
    current.current = null
    setDrafting(null)
    window.termpolis.worldDesignCancel(drafting).catch(() => undefined)
  }

  return (
    <div role="dialog" aria-label="Design something new" data-testid="world-design-start" className={dialogCls} style={zoom}>
      <h2 className="text-base font-semibold text-white">Design something new</h2>
      <p className="text-xs text-[#9ca3af]">Lumopolis drafts a planned world from your description. Nothing is written until you choose Build it.</p>
      <div className="relative">
        <textarea
          value={text}
          rows={5}
          disabled={drafting !== null}
          placeholder="Describe the app you want…"
          aria-label="Describe the app you want"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit() }}
          className={`${fieldCls} resize-none pr-9`}
        />
        {micSupported && (
          <button
            type="button"
            aria-label={mic.status === 'listening' ? 'Stop listening' : 'Describe by voice'}
            onClick={mic.toggle}
            disabled={drafting !== null}
            className={`absolute right-2 top-2 px-1 ${mic.status === 'listening' ? 'text-[#f14c4c]' : 'text-[#9ca3af] hover:text-white'}${mic.status === 'transcribing' ? ' animate-pulse' : ''}`}
          >
            <i className="fa-solid fa-microphone" aria-hidden="true" />
          </button>
        )}
      </div>
      {mic.errorMsg && <p role="alert" className="text-xs text-[#f14c4c]">{mic.errorMsg}</p>}
      {drafting !== null && <p role="status" className="text-xs text-[#9ca3af] animate-pulse">Drafting your design…</p>}
      {error !== null && <p role="alert" className="text-xs text-[#f14c4c]">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnCls} onClick={cancel}>Cancel</button>
        <button type="button" className={primaryCls} disabled={description === '' || drafting !== null} onClick={submit}>Design it</button>
      </div>
    </div>
  )
}
