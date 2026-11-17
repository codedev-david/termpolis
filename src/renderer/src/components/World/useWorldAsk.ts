// Lumopolis ask state: one question at a time about the project, answered by the user's own agent.
// A newer question cancels the older one, and a late result for a cancelled ask is ignored.
// The rolling `summary` (from main) is what carries the conversation from one question to the next.
// Design mode (the key is design:<id>): each message is a change to the design, sent through
// world:design-refine; the changed design goes back to the pane through `onDesign`, and the answer
// is the designer's reply (no tour). A design needs no viewer: it can be changed from the 2D view.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldAnswer } from '../../../../shared/world/answerProtocol'
import type { Evidence, WorldAction, WorldDoc } from '../../../../shared/world/types'
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
  cited: Record<string, Evidence>
  error: string | null
  /** True while the answer's actions (its tour) play in the viewer. */
  playing: boolean
  /** Estimated tokens of the answer on show and of every answer since this world opened; null before the first. */
  cost: { answer: number; session: number } | null
}

/** Shown when the question could not even reach main (the bridge failed): never the raw error. */
export const ASK_UNREACHABLE = "Lumopolis couldn't answer that question. Try again."

/** Shown when a design change could not even reach main. */
export const REFINE_UNREACHABLE = "Lumopolis couldn't change the design. Try again."

const noop = (): void => undefined

/** True for a design world's key. */
export const isDesignKey = (key: string): boolean => key.startsWith('design:')

export function useWorldAsk(viewer: WorldViewer | null, root: string, onDesign?: (doc: WorldDoc) => void, proposalId?: string): UseWorldAsk {
  const [state, setState] = useState<AskState>('idle')
  const [answer, setAnswer] = useState<WorldAnswer | null>(null)
  const [cited, setCited] = useState<Record<string, Evidence>>({})
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [cost, setCost] = useState<{ answer: number; session: number } | null>(null)
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

  const playOn = useCallback((v: WorldViewer, actions: WorldAction[]): void => {
    const gen = ++playGen.current
    setPlaying(true)
    // Lifts the fog an earlier answer left; 'reset' would also close the card and move the camera.
    void Promise.resolve(v.apply({ type: 'fog', ids: [] })).catch(noop)
    v.play(actions).catch(noop).then(() => { if (playGen.current === gen) setPlaying(false) })
  }, [])

  const ask = useCallback((raw: string): void => {
    const q = raw.trim()
    const design = isDesignKey(root)
    if (q === '' || (!viewer && !design) || !root) return
    cancelCurrent()
    viewer?.cancelActions()
    const askId = `ask-${Date.now()}-${++counter.current}`
    current.current = askId
    stopCurrent.current = design ? () => window.termpolis.worldDesignCancel(root) : () => window.termpolis.worldAskCancel(askId)
    lastQ.current = q
    setState('thinking')
    setError(null)
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
          setAnswer({ text: res.data.text, actions: [], evidence: [], dropped: 0, unsupported: [], uncited: false })
          setCited({})
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
        setState('answered')
        playOn(v, r.answer.actions)
      } catch {
        fail(ASK_UNREACHABLE)
      }
    })()
  }, [viewer, root, cancelCurrent, playOn])

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
    playOn(viewer, answer.actions)
  }, [viewer, answer, playOn])

  const dismiss = useCallback((): void => {
    setAnswer(null)
    setCited({})
    setError(null)
    setState('idle')
  }, [])

  useEffect(() => cancelCurrent, [cancelCurrent])

  // A different project: drop the old project's question, answer and conversation.
  const lastRoot = useRef(root)
  useEffect(() => {
    if (lastRoot.current === root) return
    lastRoot.current = root
    cancelCurrent()
    summary.current = ''
    sessionTokens.current = 0
    setCost(null)
    lastQ.current = null
    playGen.current++
    setPlaying(false)
    setAnswer(null)
    setCited({})
    setError(null)
    setState('idle')
  }, [root, cancelCurrent])

  return { ask, cancel, retry, replay, dismiss, state, answer, cited, error, playing, cost }
}
