import { useEffect, useRef, useState } from 'react'
import type { AgentActivityEvent } from '../types'
import {
  detectRedundancy,
  type RedundancyFinding,
  type DetectRedundancyOptions,
} from '../lib/redundancyDetector'

const DEFAULT_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_QUERY_LIMIT = 1000
const DEFAULT_POLL_MS = 15_000

interface Options extends DetectRedundancyOptions {
  pollMs?: number
  queryLimit?: number
}

export function useRedundancyFindings(opts: Options = {}): {
  findings: RedundancyFinding[]
  refreshing: boolean
  refresh: () => Promise<void>
} {
  const [findings, setFindings] = useState<RedundancyFinding[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const mountedRef = useRef(true)

  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const minParticipants = opts.minParticipants
  const ignoreTerminalIds = opts.ignoreTerminalIds
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const queryLimit = opts.queryLimit ?? DEFAULT_QUERY_LIMIT

  async function runDetection(): Promise<void> {
    const api = window.agentActivity
    if (!api) {
      if (mountedRef.current) setFindings([])
      return
    }
    try {
      setRefreshing(true)
      const res = await api.query({
        since: Date.now() - windowMs,
        kind: 'tool_call',
        limit: queryLimit,
      })
      if (!mountedRef.current) return
      const events: AgentActivityEvent[] = res?.success && Array.isArray(res.data) ? res.data : []
      const next = detectRedundancy(events, {
        windowMs,
        minParticipants,
        ignoreTerminalIds,
      })
      setFindings(next)
    } catch {
      if (mountedRef.current) setFindings([])
    } finally {
      if (mountedRef.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    const api = window.agentActivity
    if (!api) return () => { mountedRef.current = false }

    runDetection()
    const id = setInterval(runDetection, pollMs)

    const unsub = api.onEvent?.((ev: AgentActivityEvent) => {
      if (!mountedRef.current) return
      if (ev.kind !== 'tool_call') return
      runDetection()
    })

    return () => {
      mountedRef.current = false
      clearInterval(id)
      try { unsub?.() } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowMs, minParticipants, JSON.stringify(ignoreTerminalIds ?? []), pollMs, queryLimit])

  return {
    findings,
    refreshing,
    refresh: runDetection,
  }
}
