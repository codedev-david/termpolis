import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Recent FREEZES of the main thread — the ones you actually feel.
 *
 * Termpolis pumps every PTY and serves all IPC on the main process's event loop. When that loop
 * stops being served, the whole app stops: Windows paints "(Not Responding)" on the title bar and
 * every window goes dead at once, then it all comes back. That is not "a bit of lag" — it is a
 * discrete event, and it needs to be recorded as one.
 *
 * A percentile cannot show you this. One 2.5-second stop-the-world pause barely moves a p99 over a
 * 60-second window, so a dashboard full of healthy-looking averages will sit there insisting nothing
 * is wrong while the app freezes twice a minute. So: log each freeze, with how long it lasted, what
 * the heap looked like at the time, and what was in flight.
 *
 * The difference this makes is the difference between "the app feels slow sometimes" and
 * "GC, 2.4 s, heap 1.1 GB" — which is a bug you can actually go and fix.
 */

const POLL_MS = 3000

interface Stall {
  ts: number
  durationMs: number
  cause: 'gc' | 'sync-work'
  gcPauseMs: number
  heapUsedMB: number
  rssMB: number
  breadcrumb: string | null
}

const secs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

export function StallHistoryPanel() {
  const [stalls, setStalls] = useState<Stall[] | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await window.termpolis?.memoryGetStalls?.()
      if (!mounted.current) return
      if (res?.success && Array.isArray(res.data)) setStalls(res.data as Stall[])
    } catch { /* a diagnostic that breaks the settings pane is worse than no diagnostic */ }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => { mounted.current = false; clearInterval(t) }
  }, [load])

  if (!stalls) return null

  const worst = stalls.reduce((m, s) => Math.max(m, s.durationMs), 0)
  const gcCount = stalls.filter((s) => s.cause === 'gc').length
  const recent = [...stalls].reverse().slice(0, 8)

  return (
    <section data-testid="stall-history-panel" className="flex flex-col gap-2">
      <h3 className="font-semibold text-[#22D3EE] mb-0.5 flex items-center gap-2">
        <i className="fa-solid fa-hourglass-half text-xs"></i> App freezes
      </h3>

      {stalls.length === 0 ? (
        <p data-testid="stall-none" className="text-xs text-[#9ccc9c]">
          No freezes recorded this session. The main thread has served the event loop without a
          noticeable stall &mdash; nothing to chase.
        </p>
      ) : (
        <>
          <div
            data-testid="stall-summary"
            className="rounded border px-3 py-2 bg-[#3d2a1a] border-[#7a4a20] text-[#FFB74D]"
          >
            <div className="text-sm font-medium">
              {stalls.length} freeze{stalls.length === 1 ? '' : 's'} this session &mdash; worst {secs(worst)}
            </div>
            <div className="text-xs mt-1 opacity-90 leading-relaxed">
              {gcCount === stalls.length ? (
                <>
                  <strong>All of them were garbage collection.</strong> The main thread stops dead while
                  V8 traces the heap, so the bigger the heap, the longer the app is gone. This is the
                  &ldquo;(Not Responding)&rdquo; you see &mdash; and it is a memory-size problem, not a
                  CPU one.
                </>
              ) : gcCount > 0 ? (
                <>
                  <strong>{gcCount} of {stalls.length} were garbage collection</strong>; the rest were
                  synchronous work blocking the loop. The breadcrumb below names what was running.
                </>
              ) : (
                <>
                  None were garbage collection &mdash; something ran <strong>synchronously</strong> on
                  the main thread. The breadcrumb below names it.
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            {recent.map((s, i) => (
              <div
                key={`${s.ts}-${i}`}
                data-testid="stall-row"
                className="flex items-center justify-between gap-2 text-xs rounded border border-[#3c3c3c] bg-[#2d2d2d] px-2.5 py-1.5"
              >
                <span className="font-medium text-[#FFB74D] tabular-nums">{secs(s.durationMs)}</span>
                <span className="text-[#9ca3af] flex-1">
                  {s.cause === 'gc' ? 'garbage collection' : (s.breadcrumb || 'synchronous work')}
                </span>
                <span className="text-[10px] text-[#7d8590] tabular-nums">
                  heap {s.heapUsedMB} MB &middot; rss {s.rssMB} MB
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
