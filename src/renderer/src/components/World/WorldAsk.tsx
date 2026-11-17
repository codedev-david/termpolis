// Lumopolis ask bar: a question box with suggestions, a thinking indicator and the answer panel.
// The text is typed here or, when `voice` is supplied, spoken; answers can be read aloud (opt-in).
//
// Esc never reaches this component's own handlers: WorldView takes every Esc in the pane at window
// level. Through `link` it asks here first, so Esc stops the speech and cancels a running question
// (and leaves the camera alone) before it resets the view. `link` also tells WorldView when an answer
// is under way (thinking, its tour, its speech), so a newer world waits instead of wiping the answer.
// On a design world (root design:<id>) the bar changes the design instead ("Change the design…"):
// no suggestions, and the changed design goes back to the pane through `link.setDoc`.
// Width: the bar fills the slot WorldView puts it in (34rem, the pane less 24 px when narrower), so
// in a narrow pane the suggestion chips wrap and the input shrinks instead of running past the edge.
import { useEffect, useRef, useState } from 'react'
import type { WorldDoc } from '../../../../shared/world/types'
import type { WorldViewer } from '../../world/engine'
import type { WorldAskLink } from './WorldView'
import { WorldAnswerPanel } from './WorldAnswer'
import { formatTokens } from '../../../../shared/world/tokens'
import { isDesignKey, useWorldAsk } from './useWorldAsk'
import { useVoiceInput } from '../../hooks/useVoiceInput'

export interface WorldAskProps {
  viewer: WorldViewer | null
  /** The loaded world: chips open cards only for building and edge ids found in it. */
  doc?: WorldDoc | null
  /** The world's key: the project root it was drawn for (WorldView's resolved git root), or design:<id>. Empty: asking is off. */
  root: string
  voice?: { supported: boolean; listening: boolean; toggle: () => void }
  /** WorldView's side of Esc and of world swaps; absent when the bar is used on its own. */
  link?: WorldAskLink
}

const SUGGESTIONS = [
  'How does it all fit together?',
  'What happens when I press Enter in a terminal?',
  'Where is memory stored?',
  "What isn't tested?"
]

const stopSpeech = (): void => { window.speechSynthesis?.cancel() }

export function WorldAsk({ viewer, doc, root, voice: voiceOverride, link }: WorldAskProps): JSX.Element {
  const { ask, cancel, retry, replay, dismiss, state, answer, cited, error, playing, cost } = useWorldAsk(viewer, root, link?.setDoc)
  const design = isDesignKey(root)
  const [text, setText] = useState('')
  const [speaking, setSpeaking] = useState(false)
  /** The utterance being read: an end event from an older one changes nothing. */
  const utterance = useRef<unknown>(null)
  const hush = (): void => {
    stopSpeech()
    utterance.current = null
    setSpeaking(false)
  }
  // A spoken question fills the box and is asked straight away; nothing reaches a terminal.
  // The push-to-talk hotkey is deliberately not wired here: the terminal owns it at window level.
  const mic = useVoiceInput(null, false, {
    onTranscript: (t) => { hush(); setText(t); ask(t) },
  })
  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  const voice = voiceOverride ?? { supported: micSupported, listening: mic.status === 'listening', toggle: mic.toggle }
  const transcribing = !voiceOverride && mic.status === 'transcribing'
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
    const u = new SpeechSynthesisUtterance(line)
    const done = (): void => {
      if (utterance.current !== u) return
      utterance.current = null
      setSpeaking(false)
    }
    u.onend = done
    u.onerror = done
    utterance.current = u
    setSpeaking(true)
    window.speechSynthesis.speak(u)
  }, [speak, state, answer])

  // Esc from WorldView: used (true) when it stopped the speech or a running question.
  const onEscape = useRef<(() => boolean) | null>(null)
  onEscape.current = () => {
    const used = state === 'thinking' || speaking
    hush()
    cancel()
    return used
  }
  useEffect(() => {
    if (!link) return
    link.onEscape(() => (onEscape.current as () => boolean)())
    return () => link.onEscape(null)
  }, [link])

  // An answer under way: WorldView holds a newer world until it is over.
  const busy = state === 'thinking' || playing || speaking
  useEffect(() => { link?.setBusy(busy) }, [link, busy])
  useEffect(() => () => link?.setBusy(false), [link])

  const submit = (q: string): void => {
    if (q.trim() === '') return
    hush()
    ask(q)
    setText('')
  }

  const disabled = root === '' || (viewer === null && !design)

  return (
    <div className="flex flex-col items-center gap-2 w-full" data-testid="world-ask">
      {state === 'thinking' && (
        <div role="status" className="animate-pulse rounded bg-[#252526] border border-[#3c3c3c] px-3 py-1.5 text-xs text-[#9ca3af]">
          Thinking…
        </div>
      )}
      {state === 'answered' && answer && (
        <WorldAnswerPanel
          answer={answer}
          cited={cited}
          isPart={(id) => !!doc && (doc.buildings.some((b) => b.id === id) || doc.edges.some((e) => e.id === id))}
          onClose={() => { hush(); dismiss() }}
          onReplay={replay}
          onOpenPart={(id) => { viewer?.apply({ type: 'openCard', id })?.catch(() => undefined) }}
        />
      )}
      {state === 'error' && (
        <div className="w-full rounded border border-[#3c3c3c] bg-[#252526] text-sm text-[#d4d4d4] p-3 flex items-center gap-2" role="alert">
          <span className="flex-1 min-w-0 break-words">{error}</span>
          <button type="button" onClick={retry} className="text-xs px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#2a2d2e]">Retry</button>
          <button type="button" aria-label="Close answer" onClick={() => { hush(); dismiss() }} className="text-[#9ca3af] hover:text-white px-1">&times;</button>
        </div>
      )}
      {!design && text === '' && state === 'idle' && (
        <div className="flex flex-wrap justify-center gap-1.5 max-w-full" data-testid="world-ask-chips">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => submit(s)}
              className="max-w-full text-xs px-2 py-1 rounded-full border border-[#3c3c3c] bg-[#252526] text-[#d4d4d4] hover:bg-[#2a2d2e] disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 rounded border border-[#3c3c3c] bg-[#252526] px-2 py-1.5 w-full" data-testid="world-ask-row">
        <input
          value={text}
          disabled={disabled}
          placeholder={design ? 'Change the design…' : 'Ask about this project…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(text) }}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-[#d4d4d4] placeholder:text-[#6b7280] disabled:opacity-50"
        />
        {voice?.supported && (
          <button
            type="button"
            aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
            onClick={voice.toggle}
            disabled={disabled}
            className={`px-1.5 ${voice.listening ? 'text-[#f14c4c]' : 'text-[#9ca3af] hover:text-white'}${transcribing ? ' animate-pulse' : ''}`}
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
      {state === 'answered' && cost && (
        <div className="max-w-full text-center text-[11px] leading-snug text-[#9ca3af]" data-testid="world-ask-cost">
          This answer: {formatTokens(cost.answer)} · this session: {formatTokens(cost.session)}
        </div>
      )}
      {mic.errorMsg && (
        <div role="alert" className="max-w-full text-xs text-[#f14c4c]">{mic.errorMsg}</div>
      )}
    </div>
  )
}
