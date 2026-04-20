import { useEffect, useRef, useState } from 'react'
import type { AgentActivityEvent } from '../types'
import { analyzeEfficiency, type EfficiencyReport } from '../lib/efficiencyAnalyzer'

const DEFAULT_WINDOW_MS = 30 * 60 * 1000
const DEFAULT_POLL_MS = 30_000
const DEFAULT_QUERY_LIMIT = 2000

interface Options {
  windowMs?: number
  pollMs?: number
  queryLimit?: number
}

export function useEfficiencyReport(opts: Options = {}): {
  report: EfficiencyReport | null
  refreshing: boolean
  refresh: () => Promise<void>
} {
  const [report, setReport] = useState<EfficiencyReport | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const mountedRef = useRef(true)

  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const queryLimit = opts.queryLimit ?? DEFAULT_QUERY_LIMIT

  async function run(): Promise<void> {
    const api = window.agentActivity
    if (!api) return
    try {
      setRefreshing(true)
      const res = await api.query({ since: Date.now() - windowMs, limit: queryLimit })
      if (!mountedRef.current) return
      const events: AgentActivityEvent[] = res?.success && Array.isArray(res.data) ? res.data : []
      setReport(analyzeEfficiency(events, { windowMs }))
    } catch {
      if (mountedRef.current) setReport(null)
    } finally {
      if (mountedRef.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    const api = window.agentActivity
    if (!api) return () => { mountedRef.current = false }

    run()
    const id = setInterval(run, pollMs)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowMs, pollMs, queryLimit])

  return { report, refreshing, refresh: run }
}
