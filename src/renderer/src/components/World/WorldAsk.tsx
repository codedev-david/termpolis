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
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { WorldDoc } from '../../../../shared/world/types'
import type { WorldViewer } from '../../world/engine'
import type { WorldAskLink } from './WorldView'
import { WorldAnswerPanel } from './WorldAnswer'
import { formatTokens } from '../../../../shared/world/tokens'
import { spokenText } from '../../../../shared/world/answerMarkdown'
import { MAX_QUESTION_CHARS } from '../../../../shared/world/askLimits'
import { isDesignKey, useWorldAsk } from './useWorldAsk'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { useTerminalStore } from '../../store/terminalStore'
import { tapOrHoldKeydownAction, tapOrHoldKeyupAction } from '../../lib/voice/voicePipeline'

export interface WorldAskProps {
  viewer: WorldViewer | null
  /** The loaded world: chips open cards only for building and edge ids found in it. */
  doc?: WorldDoc | null
  /** The world's key: the project root it was drawn for (WorldView's resolved git root), or design:<id>. Empty: asking is off. */
  root: string
  /** `start` and `stop` (both) let the mic button take a hold as well as a tap; without them a click toggles. */
  voice?: { supported: boolean; listening: boolean; toggle: () => void; start?: () => void; stop?: () => void }
  /** WorldView's side of Esc and of world swaps; absent when the bar is used on its own. */
  link?: WorldAskLink
  /** The proposal selected in the toolbar; null or absent: none. A question carries it to the agent. */
  proposal?: string | null
}

const SUGGESTIONS = [
  'How does it all fit together?',
  'What happens when I press Enter in a terminal?',
  'Where is memory stored?',
  "What isn't tested?"
]

const stopSpeech = (): void => { window.speechSynthesis?.cancel() }

export function WorldAsk({ viewer, doc, root, voice: voiceOverride, link, proposal }: WorldAskProps): JSX.Element {
  const { ask, cancel, retry, replay, dismiss, stop, state, answer, cited, revealed, error, playing, cost, noMemory } = useWorldAsk(viewer, root, link?.setDoc, proposal ?? undefined)
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
  const inputRef = useRef<HTMLInputElement>(null)
  /** The focus goes back to the field after a cancel or a close, so the next question can be typed at once (U11). */
  const refocus = (): void => { inputRef.current?.focus() }
  const rootRef = useRef(root)
  rootRef.current = root
  /** The world the mic was listening for; a transcript that lands once the pane shows another one is dropped (U2). */
  const micRoot = useRef<string | null>(null)
  // A spoken question fills the box and is asked straight away; nothing reaches a terminal.
  // The push-to-talk hotkey is deliberately not wired here: the terminal owns it at window level.
  const mic = useVoiceInput(null, false, {
    onTranscript: (t) => {
      if (micRoot.current !== null && micRoot.current !== rootRef.current) return
      hush(); setText(t); ask(t)
    },
  })
  const micListening = mic.status === 'listening'
  // Taken as the capture starts only: a root change while it listens must not move it to the new world.
  useEffect(() => { if (micListening) micRoot.current = rootRef.current }, [micListening])
  // A mic still listening when the pane moves to another world is stopped; what it heard is then dropped above.
  const stopListening = useRef(mic.stop)
  stopListening.current = mic.stop
  const listeningRef = useRef(micListening)
  listeningRef.current = micListening
  useEffect(() => {
    if (listeningRef.current && micRoot.current !== root) stopListening.current()
  }, [root])
  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  const voice = voiceOverride ?? { supported: micSupported, listening: mic.status === 'listening', toggle: mic.toggle, start: mic.start, stop: mic.stop }
  // Tap or hold (the default): a hold records until release, a tap starts and the next tap stops. In the
  // other modes, and where the voice has no start and stop, a click toggles.
  const pushToTalk = useTerminalStore((s) => s.voiceSettings.pushToTalkMode)
  const startMic = voice.start
  const stopMic = voice.stop
  const hold = pushToTalk === 'tapOrHold' && !!startMic && !!stopMic
  /** When the press in progress began (null: none). */
  const pressAt = useRef<number | null>(null)
  const onMicDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (!hold || e.button !== 0) return
    const act = tapOrHoldKeydownAction({ listening: voice.listening, pressActive: pressAt.current !== null, repeat: false })
    if (act === 'none') return
    if (act === 'stop') { (stopMic as () => void)(); return }
    // A release outside the button still ends the press.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pressAt.current = Date.now()
    ;(startMic as () => void)()
  }
  const onMicUp = (): void => {
    if (pressAt.current === null) return
    const heldMs = Date.now() - pressAt.current
    pressAt.current = null
    if (tapOrHoldKeyupAction({ pressActive: true, heldMs }) === 'stop') (stopMic as () => void)()
  }
  /** A press that cannot end with a release (the gesture was taken, or the button went off): the mic stops,
   *  however short the press, so it never stays live hands-free. */
  const endPress = (): void => {
    if (pressAt.current === null) return
    pressAt.current = null
    ;(stopMic as () => void)()
  }
  const endPressRef = useRef(endPress)
  endPressRef.current = endPress
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
    const line = spokenText(answer.text)
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

  // Esc from WorldView: used (true) when it stopped the speech, the answer's tour or a running question. All
  // three stop together, speech on or off, so the camera is left where the tour put it (T4).
  const onEscape = useRef<(() => boolean) | null>(null)
  onEscape.current = () => {
    const used = state === 'thinking' || speaking || playing
    hush()
    stop()
    cancel()
    if (used) refocus()
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

  // A question that is not taken (blank once cleaned, or over the limit) keeps its draft (U9).
  const submit = (q: string): void => {
    if (q.trim() === '') return
    hush()
    if (ask(q)) setText('')
  }

  // What a screen reader hears: each sentence once, as it is revealed, without markers or markdown (U10).
  // A replay of the same answer reveals nothing new, so it says nothing again.
  const [heard, setHeard] = useState('')
  const said = useRef<{ answer: unknown; count: number }>({ answer: null, count: 0 })
  useEffect(() => {
    if (state !== 'answered' || !answer) {
      said.current = { answer: null, count: 0 }
      setHeard('')
      return
    }
    if (said.current.answer !== answer) said.current = { answer, count: 0 }
    if (revealed <= said.current.count) return
    setHeard(answer.sentences.slice(said.current.count, revealed).map((s) => spokenText(s.text)).join(' '))
    said.current.count = revealed
  }, [state, answer, revealed])

  const disabled = root === '' || (viewer === null && !design)
  const placeholder = design ? 'Change the design…' : 'Ask about this project…'
  // A disabled button gets no release, so a press in progress ends here rather than firing late.
  useEffect(() => { if (disabled) endPressRef.current() }, [disabled])

  return (
    <div className="flex flex-col items-center gap-2 w-full" data-testid="world-ask">
      <p className="sr-only" aria-live="polite" data-testid="world-ask-live">{heard}</p>
      {state === 'thinking' && (
        <div className="flex items-center gap-2">
          <div role="status" className="animate-pulse rounded bg-[#252526] border border-[#3c3c3c] px-3 py-1.5 text-xs text-[#9ca3af]">
            Thinking…
          </div>
          <button
            type="button"
            onClick={() => { hush(); cancel(); refocus() }}
            className="text-xs px-2 py-1 rounded border border-[#3c3c3c] bg-[#252526] text-[#d4d4d4] hover:bg-[#2a2d2e]"
          >
            Cancel
          </button>
        </div>
      )}
      {state === 'answered' && answer && (
        <WorldAnswerPanel
          answer={answer}
          cited={cited}
          revealed={revealed}
          noMemory={noMemory}
          isPart={(id) => !!doc && (doc.buildings.some((b) => b.id === id) || doc.edges.some((e) => e.id === id))}
          onClose={() => { hush(); dismiss(); refocus() }}
          onReplay={replay}
          partName={(id) => doc?.buildings.find((b) => b.id === id)?.name ?? doc?.edges.find((e) => e.id === id)?.label}
          onOpenPart={(id, highlight) => {
            // Open the part first: opening a card moves the focus, so the highlight follows it.
            void Promise.resolve(viewer?.apply({ type: 'openCard', id }))
              .then(() => (highlight.length > 0 ? viewer?.apply({ type: 'highlight', ids: highlight }) : undefined))
              .catch(() => undefined)
          }}
        />
      )}
      {state === 'error' && (
        <div className="w-full rounded border border-[#3c3c3c] bg-[#252526] text-sm text-[#d4d4d4] p-3 flex items-center gap-2" role="alert">
          <span className="flex-1 min-w-0 break-words">{error}</span>
          <button type="button" onClick={retry} className="text-xs px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#2a2d2e]">Retry</button>
          <button type="button" aria-label="Close answer" onClick={() => { hush(); dismiss(); refocus() }} className="text-[#9ca3af] hover:text-white px-1">&times;</button>
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
          ref={inputRef}
          value={text}
          disabled={disabled}
          maxLength={MAX_QUESTION_CHARS}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setText(e.target.value)}
          // Enter that ends an IME composition (isComposing, or keyCode 229 where that is missing) only picks the
          // characters; Shift+Enter does nothing (U7).
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
            submit(text)
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-[#d4d4d4] placeholder:text-[#9ca3af] disabled:opacity-50"
        />
        {voice?.supported && (
          <button
            type="button"
            aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
            onPointerDown={onMicDown}
            onPointerUp={onMicUp}
            onPointerCancel={endPress}
            // A mouse or touch press is handled above; a click with no pointer (Enter or Space) still toggles.
            onClick={(e) => { if (!hold || e.detail === 0) voice.toggle() }}
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
        <div className="max-w-full text-center text-xs leading-snug text-[#9ca3af]" data-testid="world-ask-cost">
          This answer: {formatTokens(cost.answer)} · this session: {formatTokens(cost.session)}
        </div>
      )}
      {mic.errorMsg && (
        <div role="alert" className="max-w-full text-xs text-[#f14c4c]">{mic.errorMsg}</div>
      )}
    </div>
  )
}
