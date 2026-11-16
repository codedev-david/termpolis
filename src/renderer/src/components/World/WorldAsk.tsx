// Lumopolis ask bar: a question box with suggestions, a thinking indicator and the answer panel.
// The text is typed here or, when `voice` is supplied, spoken; answers can be read aloud (opt-in).
import { useEffect, useRef, useState } from 'react'
import type { WorldViewer } from '../../world/engine'
import { WorldAnswerPanel } from './WorldAnswer'
import { useWorldAsk } from './useWorldAsk'

export interface WorldAskProps {
  viewer: WorldViewer | null
  root: string
  voice?: { supported: boolean; listening: boolean; toggle: () => void }
}

const SUGGESTIONS = [
  'How does it all fit together?',
  'What happens when I press Enter in a terminal?',
  'Where is memory stored?',
  "What isn't tested?"
]

const stopSpeech = (): void => { window.speechSynthesis?.cancel() }

export function WorldAsk({ viewer, root, voice }: WorldAskProps): JSX.Element {
  const { ask, cancel, retry, dismiss, state, answer, cited, error } = useWorldAsk(viewer, root)
  const [text, setText] = useState('')
  const [speak, setSpeak] = useState(false)

  useEffect(() => {
    let live = true
    window.termpolis.worldSettingsGet?.()
      ?.then((res) => { if (live && res.success) setSpeak(res.data.worldSpeakAnswers === true) })
      ?.catch(() => undefined)
    return () => { live = false; stopSpeech() }
  }, [])

  // Read the answer aloud once, with the [E<n>] markers left out.
  const spoken = useRef<unknown>(null)
  useEffect(() => {
    if (!speak || state !== 'answered' || !answer || spoken.current === answer) return
    spoken.current = answer
    if (!window.speechSynthesis) return
    const line = answer.text.replace(/\s*\[E\d+\]/g, '').trim()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(line))
  }, [speak, state, answer])

  const submit = (q: string): void => {
    if (q.trim() === '') return
    stopSpeech()
    ask(q)
    setText('')
  }

  const disabled = viewer === null

  return (
    <div className="flex flex-col items-center gap-2" data-testid="world-ask">
      {state === 'thinking' && (
        <div role="status" className="animate-pulse rounded bg-[#252526] border border-[#3c3c3c] px-3 py-1.5 text-xs text-[#9ca3af]">
          Thinking…
        </div>
      )}
      {state === 'answered' && answer && (
        <WorldAnswerPanel
          answer={answer}
          cited={cited}
          onClose={() => { stopSpeech(); dismiss() }}
          onReplay={() => { viewer?.cancelActions(); void viewer?.play(answer.actions) }}
          onOpenPart={(id) => { void viewer?.apply({ type: 'openCard', id }) }}
        />
      )}
      {state === 'error' && (
        <div className="w-[34rem] max-w-[90vw] rounded border border-[#3c3c3c] bg-[#252526] text-sm text-[#d4d4d4] p-3 flex items-center gap-2" role="alert">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={retry} className="text-xs px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#2a2d2e]">Retry</button>
          <button type="button" aria-label="Close answer" onClick={() => { stopSpeech(); dismiss() }} className="text-[#9ca3af] hover:text-white px-1">&times;</button>
        </div>
      )}
      {text === '' && state === 'idle' && (
        <div className="flex flex-wrap justify-center gap-1.5 max-w-[40rem]">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => submit(s)}
              className="text-xs px-2 py-1 rounded-full border border-[#3c3c3c] bg-[#252526] text-[#d4d4d4] hover:bg-[#2a2d2e] disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 rounded border border-[#3c3c3c] bg-[#252526] px-2 py-1.5 w-[34rem] max-w-[90vw]">
        <input
          value={text}
          disabled={disabled}
          placeholder="Ask about this project…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(text)
            else if (e.key === 'Escape') { stopSpeech(); cancel() }
          }}
          className="flex-1 bg-transparent outline-none text-sm text-[#d4d4d4] placeholder:text-[#6b7280] disabled:opacity-50"
        />
        {voice?.supported && (
          <button
            type="button"
            aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
            onClick={voice.toggle}
            disabled={disabled}
            className={`px-1.5 ${voice.listening ? 'text-[#f14c4c]' : 'text-[#9ca3af] hover:text-white'}`}
          >
            <i className="fa-solid fa-microphone" aria-hidden="true"></i>
          </button>
        )}
        <button
          type="button"
          aria-label="Ask"
          disabled={disabled}
          onClick={() => submit(text)}
          className="px-1.5 text-[#9ca3af] hover:text-white disabled:opacity-50"
        >
          <i className="fa-solid fa-paper-plane" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  )
}
