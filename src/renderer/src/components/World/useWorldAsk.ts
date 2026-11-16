// Lumopolis ask state: one question at a time about the project, answered by the user's own agent.
// A newer question cancels the older one, and a late result for a cancelled ask is ignored.
// The rolling `summary` (from main) is what carries the conversation from one question to the next.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldAnswer } from '../../../../shared/world/answerProtocol'
import type { Evidence, WorldAction } from '../../../../shared/world/types'
import type { WorldViewer } from '../../world/engine'

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
}

/** Shown when the question could not even reach main (the bridge failed): never the raw error. */
export const ASK_UNREACHABLE = "Lumopolis couldn't answer that question. Try again."

const noop = (): void => undefined

export function useWorldAsk(viewer: WorldViewer | null, root: string): UseWorldAsk {
  const [state, setState] = useState<AskState>('idle')
  const [answer, setAnswer] = useState<WorldAnswer | null>(null)
  const [cited, setCited] = useState<Record<string, Evidence>>({})
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const current = useRef<string | null>(null)
  const counter = useRef(0)
  const summary = useRef('')
  const lastQ = useRef<string | null>(null)
  /** Bumped by every play (and a root change): only the latest play may clear `playing`. */
  const playGen = useRef(0)

  const cancelCurrent = useCallback((): void => {
    const id = current.current
    current.current = null
    if (id !== null) void Promise.resolve(window.termpolis.worldAskCancel(id)).catch(noop)
  }, [])

  const playOn = useCallback((v: WorldViewer, actions: WorldAction[]): void => {
    const gen = ++playGen.current
    setPlaying(true)
    v.play(actions).catch(noop).then(() => { if (playGen.current === gen) setPlaying(false) })
  }, [])

  const ask = useCallback((raw: string): void => {
    const q = raw.trim()
    if (q === '' || !viewer || !root) return
    cancelCurrent()
    viewer.cancelActions()
    const askId = `ask-${Date.now()}-${++counter.current}`
    current.current = askId
    lastQ.current = q
    setState('thinking')
    setError(null)
    const fail = (message: string): void => {
      if (current.current !== askId) return
      current.current = null
      setError(message)
      setState('error')
    }
    void (async () => {
      try {
        const res = await window.termpolis.worldAsk({ askId, root, question: q, selection: viewer.getSelection(), cameraRegion: viewer.cameraRegion(), summary: summary.current })
        if (current.current !== askId) return
        if (!res.success) return fail(res.error)
        const r = res.data
        if (!r.ok) {
          if (r.cancelled) { current.current = null; setState('idle'); return }
          return fail(r.error)
        }
        current.current = null
        summary.current = r.summary
        setAnswer(r.answer)
        setCited(r.cited)
        setState('answered')
        playOn(viewer, r.answer.actions)
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
    lastQ.current = null
    playGen.current++
    setPlaying(false)
    setAnswer(null)
    setCited({})
    setError(null)
    setState('idle')
  }, [root, cancelCurrent])

  return { ask, cancel, retry, replay, dismiss, state, answer, cited, error, playing }
}
