import { useEffect, useRef, useState } from 'react'
import { mergeEvents, MAX_FEED_EVENTS } from '../lib/activityFeed'
import type { AgentActivityEvent } from '../types'

/**
 * Live feed of AgentActivityEvent coming from the main-process bus.
 * Seeds with a recent-history query then listens for pushed events.
 *
 * Security/safety:
 * - Hard cap on in-memory events (MAX_FEED_EVENTS)
 * - Defensive: tolerates missing window.agentActivity (non-Electron envs, tests)
 */
export function useActivityFeed(): {
  events: AgentActivityEvent[]
  clear: () => void
} {
  const [events, setEvents] = useState<AgentActivityEvent[]>([])
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const api = window.agentActivity
    if (!api) return () => { mountedRef.current = false }

    // Seed with recent history (capped by main-side ring, further clamped here)
    let cancelled = false
    api.query({ limit: MAX_FEED_EVENTS })
      .then((res) => {
        if (cancelled || !mountedRef.current) return
        if (res?.success && Array.isArray(res.data)) {
          setEvents((prev) => mergeEvents(prev, res.data!))
        }
      })
      .catch(() => {})

    // Subscribe to pushed events
    const unsub = api.onEvent((event) => {
      if (!mountedRef.current) return
      setEvents((prev) => mergeEvents(prev, [event]))
    })

    return () => {
      mountedRef.current = false
      cancelled = true
      try { unsub() } catch {}
    }
  }, [])

  return {
    events,
    clear: () => setEvents([]),
  }
}
