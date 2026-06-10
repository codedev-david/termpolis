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
  'qwen-code': 'qwen',
}

function modelFromEvents(events: AgentActivityEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.agentType
    if (t && AGENT_MODEL[t]) return AGENT_MODEL[t]
  }
  return ''
}

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

    recompute()
    const unsub = api.onEvent?.((event) => {
      if (disposed) return
      if (event.terminalId === terminalId && (event.kind === 'token_update' || event.kind === 'message')) {
        recompute()
      }
    })

    return () => {
      disposed = true
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
    }
  }, [terminalId])

  return pressure
}
