// Lumopolis ask state: one question at a time about the project, answered by the user's own agent.
// A newer question cancels the older one, and a late result for a cancelled ask is ignored.
// The rolling `summary` (from main) is what carries the conversation from one question to the next.
// Design mode (the key is design:<id>): each message is a change to the design, sent through
// world:design-refine; the changed design goes back to the pane through `onDesign`, and the answer
// is the designer's reply (no tour).
// An answer arrives whole, so it is revealed one sentence at a time at reading pace and each
// sentence's steps play as it appears (REVEAL_MS_PER_WORD). Reduced motion reveals it at once; a new
// question, a replay, a dismissal and unmount all clear the pending reveal first. A design needs no viewer: it can be changed from the 2D view.
import { useCallback, useEffect, useRef, useState } from 'react'
import { revealMs, type WorldAnswer } from '../../../../shared/world/answerProtocol'
import type { AskNoMemory, CitedEvidence, WorldDoc } from '../../../../shared/world/types'
import type { WorldViewer } from '../../world/engine'
import { lumopolisModel } from './worldAgentModel'

export type AskState = 'idle' | 'thinking' | 'answered' | 'error'

export interface UseWorldAsk {
  ask(q: string): void
  cancel(): void
  retry(): void
  /** Plays the answer's actions again ("Show me again"). */
  replay(): void
  /** Closes the answer or error panel. */
  dismiss(): void
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
  /** Stops the pending reveal: its timers, and the `playing` it would have cleared when it finished. */
  const clearTimers = useCallback((): void => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
    playGen.current++
    setPlaying(false)
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
    const plays: Promise<void>[] = []
    setRevealed(0)
    setPlaying(true)
    // Lifts the fog an earlier answer left; 'reset' would also close the card and move the camera.
    void Promise.resolve(v.apply({ type: 'fog', ids: [] })).catch(noop)
    const step = (i: number): void => {
      setRevealed(i + 1)
      const steps = a.sentences[i].actions.map((n) => a.actions[n])
      if (steps.length > 0) plays.push(v.play(steps).catch(noop))
      if (i + 1 < a.sentences.length) {
        timers.current.push(setTimeout(() => step(i + 1), revealMs(a.sentences[i].text, reduced)))
        return
      }
      void Promise.all(plays).then(() => { if (playGen.current === gen) setPlaying(false) })
    }
    if (a.sentences.length === 0) setPlaying(false)
    else step(0)
  }, [clearTimers])

  const ask = useCallback((raw: string): void => {
    const q = raw.trim()
    const design = isDesignKey(root)
    if (q === '' || (!viewer && !design) || !root) return
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
      lumopolisModel().then((model) => window.termpolis.worldDesignRefine(root, q, said, model)).then(
        (res) => {
          if (current.current !== askId) return
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
      return
    }
    const v = viewer as WorldViewer
    void (async () => {
      try {
        const model = await lumopolisModel()
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
        reveal(v, r.answer)
      } catch {
        fail(ASK_UNREACHABLE)
      }
    })()
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

  const dismiss = useCallback((): void => {
    clearTimers()
    setAnswer(null)
    setCited({})
    setError(null)
    setNoMemory(null)
    setState('idle')
  }, [clearTimers])

  useEffect(() => cancelCurrent, [cancelCurrent])
  useEffect(() => clearTimers, [clearTimers])

  // A different project: drop the old project's question, answer and conversation.
  const lastRoot = useRef(root)
  useEffect(() => {
    if (lastRoot.current === root) return
    lastRoot.current = root
    cancelCurrent()
    clearTimers()
    summary.current = ''
    sessionTokens.current = 0
    setCost(null)
    lastQ.current = null
    setAnswer(null)
    setCited({})
    setError(null)
    setNoMemory(null)
    setState('idle')
  }, [root, cancelCurrent, clearTimers])

  return { ask, cancel, retry, replay, dismiss, state, answer, cited, revealed, error, playing, cost, noMemory }
}
