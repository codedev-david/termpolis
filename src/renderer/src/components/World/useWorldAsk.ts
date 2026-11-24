// Lumopolis ask state: one question at a time about the project, answered by the user's own agent.
// A newer question cancels the older one, and a late result for a cancelled ask is ignored.
// The rolling `summary` (from main) is what carries the conversation from one question to the next.
// Design mode (the key is design:<id>): each message is a change to the design, sent through
// world:design-refine; the changed design goes back to the pane through `onDesign`, and the answer
// is the designer's reply (no tour).
// An answer arrives whole, so it is revealed one sentence at a time at reading pace and each
// sentence's steps play as it appears (REVEAL_MS_PER_WORD). Reduced motion reveals it at once; a new
// question, a replay, a dismissal and unmount all clear the pending reveal first. A design needs no viewer: it can be changed from the 2D view.
// A cancel, a newer question or a different project that lands while a request waits on its model lookup
// stops it there: it never reaches main (U3). Closing the answer, or the viewer going (2D) or changing,
// while its tour flies stops the tour in the viewer and lets the pane go at once; the rest of the answer
// is then shown whole (U5, U6). `stop` is that same stop for Esc and a different project (T4). A sentence's
// steps wait for the sentence before to finish playing, so two sentences' tours never fly at once (T4).
import { useCallback, useEffect, useRef, useState } from 'react'
import { revealMs, type WorldAnswer } from '../../../../shared/world/answerProtocol'
import { cleanQuestion, questionFits } from '../../../../shared/world/askLimits'
import type { AskNoMemory, CitedEvidence, WorldDoc } from '../../../../shared/world/types'
import type { WorldViewer } from '../../world/engine'
import { lumopolisModel } from './worldAgentModel'

export type AskState = 'idle' | 'thinking' | 'answered' | 'error'

export interface UseWorldAsk {
  /** Sends the question; false when it was not taken (blank once cleaned, over the limit, or nothing to ask about). */
  ask(q: string): boolean
  cancel(): void
  retry(): void
  /** Plays the answer's actions again ("Show me again"). */
  replay(): void
  /** Closes the answer or error panel. */
  dismiss(): void
  /** Stops the answer's tour and its pending reveal, and shows the answer whole; a tour not the answer's is left alone. */
  stop(): void
  state: AskState
  answer: WorldAnswer | null
  /** The evidence labels (E1, E2, ...) cited by the answer text. */
  cited: Record<string, CitedEvidence>
  /** How many of the answer's sentences are on show (they appear one by one at reading pace). */
  revealed: number
  error: string | null
  /** True while the answer's actions (its tour) play in the viewer. */
  playing: boolean
  /** Estimated tokens of the answer on show and of every answer since this world opened; null before the first. */
  cost: { answer: number; session: number } | null
  /** Why the answer on show was made without the project memory (WPA); null when it had it, or there is none. */
  noMemory: AskNoMemory | null
}

/** Shown when the question could not even reach main (the bridge failed): never the raw error. */
export const ASK_UNREACHABLE = "Lumopolis couldn't answer that question. Try again."

/** Shown when a design change could not even reach main. */
export const REFINE_UNREACHABLE = "Lumopolis couldn't change the design. Try again."

const noop = (): void => undefined

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** True for a design world's key. */
export const isDesignKey = (key: string): boolean => key.startsWith('design:')

export function useWorldAsk(viewer: WorldViewer | null, root: string, onDesign?: (doc: WorldDoc) => void, proposalId?: string): UseWorldAsk {
  const [state, setState] = useState<AskState>('idle')
  const [answer, setAnswer] = useState<WorldAnswer | null>(null)
  const [cited, setCited] = useState<Record<string, CitedEvidence>>({})
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [revealed, setRevealed] = useState(0)
  const [cost, setCost] = useState<{ answer: number; session: number } | null>(null)
  const [noMemory, setNoMemory] = useState<AskNoMemory | null>(null)
  const sessionTokens = useRef(0)
  const current = useRef<string | null>(null)
  /** Stops the running question or design change in main (set with it). */
  const stopCurrent = useRef<() => unknown>(noop)
  const onDesignRef = useRef(onDesign)
  onDesignRef.current = onDesign
  /** The design proposal on show; read when a question is sent, so a change of proposal never recreates `ask`. */
  const proposalRef = useRef(proposalId)
  proposalRef.current = proposalId
  const counter = useRef(0)
  const summary = useRef('')
  const lastQ = useRef<string | null>(null)
  /** Bumped by every play (and a root change): only the latest play may clear `playing`. */
  const playGen = useRef(0)
  /** The pending reveal steps of the answer on show. */
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  /** `playing` as it is now, for the handlers that stop a tour only when one is flying. */
  const playingRef = useRef(false)
  const setPlay = (on: boolean): void => {
    playingRef.current = on
    setPlaying(on)
  }
  /** The viewer as of the latest render: an answer that lands after a switch to 2D has none to tour. */
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  /** The answer on show, for showing it whole when its tour is cut short. */
  const answerRef = useRef(answer)
  answerRef.current = answer
  /** Stops the pending reveal: its timers, and the `playing` it would have cleared when it finished. */
  const clearTimers = useCallback((): void => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
    playGen.current++
    setPlay(false)
  }, [])
  /** Adds one finished answer's tokens to the session (a failed or cancelled ask adds nothing). */
  const spend = (tokens: number): void => {
    sessionTokens.current += tokens
    setCost({ answer: tokens, session: sessionTokens.current })
  }

  const cancelCurrent = useCallback((): void => {
    const id = current.current
    current.current = null
    if (id !== null) void Promise.resolve(stopCurrent.current()).catch(noop)
  }, [])

  /** Shows the answer sentence by sentence, playing each one's steps as it appears. */
  const reveal = useCallback((v: WorldViewer, a: WorldAnswer): void => {
    clearTimers()
    const gen = ++playGen.current
    const reduced = reducedMotion()
    /** The sentences' plays so far, one after another; null until a sentence has steps. */
    let chain: Promise<void> | null = null
    setRevealed(0)
    setPlay(true)
    // Lifts the fog an earlier answer left; 'reset' would also close the card and move the camera.
    void Promise.resolve(v.apply({ type: 'fog', ids: [] })).catch(noop)
    const step = (i: number): void => {
      setRevealed(i + 1)
      const steps = a.sentences[i].actions.map((n) => a.actions[n])
      if (steps.length > 0) {
        const play = (): Promise<void> => v.play(steps).catch(noop)
        // Stopped meanwhile (a newer play, Esc, a close): a queued sentence never starts.
        chain = chain === null ? play() : chain.then(() => (playGen.current === gen ? play() : undefined))
      }
      if (i + 1 < a.sentences.length) {
        timers.current.push(setTimeout(() => step(i + 1), revealMs(a.sentences[i].text, reduced)))
        return
      }
      void Promise.resolve(chain).then(() => { if (playGen.current === gen) setPlay(false) })
    }
    if (a.sentences.length === 0) setPlay(false)
    else step(0)
  }, [clearTimers])

  const ask = useCallback((raw: string): boolean => {
    const q = cleanQuestion(raw)
    const design = isDesignKey(root)
    if (!questionFits(q) || (!viewer && !design) || !root) return false
    cancelCurrent()
    clearTimers()
    viewer?.cancelActions()
    const askId = `ask-${Date.now()}-${++counter.current}`
    current.current = askId
    stopCurrent.current = design ? () => window.termpolis.worldDesignCancel(root) : () => window.termpolis.worldAskCancel(askId)
    lastQ.current = q
    setState('thinking')
    setError(null)
    setNoMemory(null)
    const fail = (message: string): void => {
      if (current.current !== askId) return
      current.current = null
      setError(message)
      setState('error')
    }
    if (design) {
      const said = summary.current
      // Checked again once the model is known: a change cancelled or replaced meanwhile is never sent (U3).
      lumopolisModel().then((model) => (current.current === askId ? window.termpolis.worldDesignRefine(root, q, said, model) : null)).then(
        (res) => {
          if (current.current !== askId || res === null) return
          if (!res.success) return fail(res.error)
          current.current = null
          summary.current = res.data.summary
          spend(res.data.tokens)
          onDesignRef.current?.(res.data.doc)
          setAnswer({ text: res.data.text, sentences: [{ text: res.data.text, actions: [], sep: '' }], actions: [], evidence: [], dropped: 0, unsupported: [], uncited: false })
          setCited({})
          setRevealed(1)
          setState('answered')
        },
        () => fail(REFINE_UNREACHABLE),
      )
      return true
    }
    const v = viewer as WorldViewer
    void (async () => {
      try {
        const model = await lumopolisModel()
        // A question cancelled or replaced while its model was looked up never reaches main (U3).
        if (current.current !== askId) return
        const res = await window.termpolis.worldAsk({ askId, root, question: q, selection: v.getSelection(), cameraRegion: v.cameraRegion(), summary: summary.current, ...(model === undefined ? {} : { model }), ...(proposalRef.current === undefined ? {} : { proposalId: proposalRef.current }) })
        if (current.current !== askId) return
        if (!res.success) return fail(res.error)
        const r = res.data
        if (!r.ok) {
          if (r.cancelled) { current.current = null; setState('idle'); return }
          return fail(r.error)
        }
        current.current = null
        summary.current = r.summary
        spend(r.tokens)
        setAnswer(r.answer)
        setCited(r.cited)
        setNoMemory(r.noMemory ?? null)
        setState('answered')
        // The viewer as it is now: none (the 2D view) shows the answer whole, with no tour (U6).
        const now = viewerRef.current
        if (now) reveal(now, r.answer)
        else setRevealed(r.answer.sentences.length)
      } catch {
        fail(ASK_UNREACHABLE)
      }
    })()
    return true
  }, [viewer, root, cancelCurrent, clearTimers, reveal])

  const cancel = useCallback((): void => {
    if (current.current === null) return
    cancelCurrent()
    setState('idle')
  }, [cancelCurrent])

  const retry = useCallback((): void => {
    if (lastQ.current !== null) ask(lastQ.current)
  }, [ask])

  const replay = useCallback((): void => {
    if (!viewer || !answer) return
    viewer.cancelActions()
    reveal(viewer, answer)
  }, [viewer, answer, reveal])

  /** Stops the answer's tour in the viewer, if one is flying, and its reveal (U5, T4). */
  const stopTour = useCallback((): void => {
    if (playingRef.current) (viewerRef.current as WorldViewer).cancelActions()
    clearTimers()
  }, [clearTimers])

  const stop = useCallback((): void => {
    stopTour()
    const a = answerRef.current
    if (a) setRevealed(a.sentences.length)
  }, [stopTour])

  const dismiss = useCallback((): void => {
    // A tour still flying is stopped in the viewer, not left to land after the answer is gone (U5).
    stopTour()
    setAnswer(null)
    setCited({})
    setError(null)
    setNoMemory(null)
    setState('idle')
  }, [stopTour])

  // The viewer went (2D) or changed mid-tour: stop the tour in the old one and show the answer whole (U6).
  const lastViewer = useRef(viewer)
  useEffect(() => {
    const prev = lastViewer.current
    lastViewer.current = viewer
    if (prev === viewer || !playingRef.current) return
    ;(prev as WorldViewer).cancelActions()
    clearTimers()
    setRevealed((answerRef.current as WorldAnswer).sentences.length)
  }, [viewer, clearTimers])

  useEffect(() => cancelCurrent, [cancelCurrent])
  // Unmount (the home, the pane closing): the answer's tour stops in the viewer too, so a step already dwelling
  // never captions over the home (T4).
  useEffect(() => stopTour, [stopTour])

  // A different project: drop the old project's question, answer and conversation.
  const lastRoot = useRef(root)
  useEffect(() => {
    if (lastRoot.current === root) return
    lastRoot.current = root
    cancelCurrent()
    stopTour()
    summary.current = ''
    sessionTokens.current = 0
    setCost(null)
    lastQ.current = null
    setAnswer(null)
    setCited({})
    setError(null)
    setNoMemory(null)
    setState('idle')
  }, [root, cancelCurrent, stopTour])

  return { ask, cancel, retry, replay, dismiss, stop, state, answer, cited, revealed, error, playing, cost, noMemory }
}
