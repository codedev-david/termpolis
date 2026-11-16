// Lumopolis ask state: one question at a time about the project, answered by the user's own agent.
// A newer question cancels the older one, and a late result for a cancelled ask is ignored.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldAnswer } from '../../../../shared/world/answerProtocol'
import type { Evidence } from '../../../../shared/world/types'
import type { WorldViewer } from '../../world/engine'

export type AskState = 'idle' | 'thinking' | 'answered' | 'error'

export interface UseWorldAsk {
  ask(q: string): void
  cancel(): void
  retry(): void
  /** Closes the answer or error panel. */
  dismiss(): void
  state: AskState
  answer: WorldAnswer | null
  /** The evidence labels (E1, E2, ...) cited by the answer text. */
  cited: Record<string, Evidence>
  error: string | null
  history: { q: string; a: string }[]
}

const noop = (): void => undefined

export function useWorldAsk(viewer: WorldViewer | null, root: string): UseWorldAsk {
  const [state, setState] = useState<AskState>('idle')
  const [answer, setAnswer] = useState<WorldAnswer | null>(null)
  const [cited, setCited] = useState<Record<string, Evidence>>({})
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<{ q: string; a: string }[]>([])
  const current = useRef<string | null>(null)
  const counter = useRef(0)
  const summary = useRef('')
  const lastQ = useRef<string | null>(null)

  const cancelCurrent = useCallback((): void => {
    const id = current.current
    current.current = null
    if (id !== null) void Promise.resolve(window.termpolis.worldAskCancel(id)).catch(noop)
  }, [])

  const ask = useCallback((raw: string): void => {
    const q = raw.trim()
    if (q === '' || !viewer) return
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
        setHistory((h) => [...h, { q, a: r.answer.text }])
        setState('answered')
        viewer.play(r.answer.actions).catch(noop)
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [viewer, root, cancelCurrent])

  const cancel = useCallback((): void => {
    if (current.current === null) return
    cancelCurrent()
    setState('idle')
  }, [cancelCurrent])

  const retry = useCallback((): void => {
    if (lastQ.current !== null) ask(lastQ.current)
  }, [ask])

  const dismiss = useCallback((): void => {
    setAnswer(null)
    setCited({})
    setError(null)
    setState('idle')
  }, [])

  useEffect(() => cancelCurrent, [cancelCurrent])

  return { ask, cancel, retry, dismiss, state, answer, cited, error, history }
}
