import { useEffect, useState } from 'react'
import { computePressure, type ContextWindow } from '../lib/contextPressure'
import type { AgentActivityEvent } from '../types'

// Live context-window pressure for one terminal's agent. Subscribes to the agent
// activity bus (real token_update events for Claude; message-count heuristic for
// others), recomputes on each relevant event, and returns a ContextWindow — or null
// when there's no terminal, no bridge, or no usage signal yet. The presentation lives
// in <ContextPressureIndicator>. This hook is intentionally thin (and not in the
// coverage-gated set), so the testable logic stays in lib/contextPressure.

// Map the agent's coarse type to a model string contextPressure can size a window for.
const AGENT_MODEL: Record<string, string> = {
  claude: 'claude',
  codex: 'gpt-4o',
  gemini: 'gemini',
}

function modelFromEvents(events: AgentActivityEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.agentType
    if (t && AGENT_MODEL[t]) return AGENT_MODEL[t]
  }
  return ''
}

// Coalesce recompute during a burst. Each recompute is a full IPC round-trip (query up to 500
// events) plus a token count — and an agent streaming a reply fires token_update far faster than a
// pressure gauge needs to move. Throttle so a burst costs at most one recompute per window while
// still refreshing at a steady cadence during continuous streaming (a trailing debounce would wait
// for silence and never update mid-stream).
export const PRESSURE_THROTTLE_MS = 300

export function useLiveContextPressure(terminalId: string | null): ContextWindow | null {
  const [pressure, setPressure] = useState<ContextWindow | null>(null)

  useEffect(() => {
    if (!terminalId) {
      setPressure(null)
      return
    }
    const api = window.agentActivity
    if (!api?.query) {
      setPressure(null)
      return
    }
    let disposed = false
    let throttle: ReturnType<typeof setTimeout> | null = null

    const recompute = (): void => {
      api
        .query({ terminalId, kind: ['token_update', 'message'], limit: 500 })
        .then((res) => {
          if (disposed) return
          const events = res?.success && Array.isArray(res.data) ? res.data : []
          const w = computePressure(events, { model: modelFromEvents(events) })
          setPressure(w.used > 0 ? w : null) // nothing to show until the agent uses context
        })
        .catch(() => {})
    }

    // At most one recompute per PRESSURE_THROTTLE_MS: the first event schedules a trailing recompute,
    // and everything else in that window is folded into it.
    const scheduleRecompute = (): void => {
      if (throttle) return
      throttle = setTimeout(() => { throttle = null; recompute() }, PRESSURE_THROTTLE_MS)
    }

    recompute() // initial read is immediate; only the event-driven storm is throttled
    const unsub = api.onEvent?.((event) => {
      if (disposed) return
      if (event.terminalId === terminalId && (event.kind === 'token_update' || event.kind === 'message')) {
        scheduleRecompute()
      }
    })

    return () => {
      disposed = true
      if (throttle) clearTimeout(throttle)
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
    }
  }, [terminalId])

  return pressure
}
