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
 * the heap looked like at the time, and WHAT WAS RUNNING.
 *
 * That last part used to be the whole problem. This panel promised "the breadcrumb below names it"
 * and then printed `synchronous work` on every single row, because the watchdog read the breadcrumb
 * after the frozen work had already cleared it (see processHealth.ts). Two answers now, and a row
 * falls back to the next one only when it has to:
 *
 *   1. the LABELLED operation that held the thread, in the user's terms and with its share of the
 *      freeze — "Building the search index, 15.2s of 18.8s"
 *   2. the function the CPU was actually in, sampled straight through the freeze by V8 — which needs
 *      nobody to have predicted the freeze in advance, and so can name the one you didn't
 *   3. "synchronous work" — now an admission of ignorance rather than the only thing it could say
 */

const POLL_MS = 3000

interface SampledFrame {
  fn: string
  file: string
  line: number
  ms: number
}

interface Stall {
  ts: number
  startedAt?: number
  durationMs: number
  cause: 'gc' | 'sync-work'
  gcPauseMs: number
  heapUsedMB: number
  rssMB: number
  breadcrumb: string | null
  spans?: Array<{ label: string; ms: number }>
  stack?: SampledFrame[]
  sampledGcMs?: number
}

const secs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

/**
 * The machine label -> what it means to a person. A row that says `memory:build-index` is only an
 * answer to the person who wrote it; the panel is for the person who just lost eighteen seconds.
 */
const OP_NAMES: Record<string, string> = {
  'memory:load-shard': 'Loading the memory brain from disk',
  'memory:build-index': 'Building the memory search index',
  'memory:compact': 'Compacting the memory store',
  'memory:compact-vectors': 'Repacking the vector store',
  'memory:persist-hnsw': 'Saving the search graph',
  'memory:load-hnsw': 'Loading the search graph',
  'memory:load-graph': 'Loading the memory knowledge graph',
  'code-graph:sweep': 'Indexing this repo’s code graph',
  'code-graph:reindex': 'Re-indexing changed files',
  'code-graph:persist': 'Saving the code graph',
}

const humanLabel = (label: string): string => {
  if (OP_NAMES[label]) return OP_NAMES[label]
  // `exec:git`, `exec:npm` — a synchronous child process on the main thread.
  if (label.startsWith('exec:')) return `Running \`${label.slice(5)}\``
  return label // an unmapped label is still a real answer; never hide it behind a generic one
}

/** The headline for one freeze: the best true thing we can say about it. */
function titleOf(s: Stall): string {
  if (s.cause === 'gc') return 'garbage collection'
  if (s.breadcrumb) return humanLabel(s.breadcrumb)
  const top = s.stack?.[0]
  if (top) return top.file ? `${top.fn} — ${top.file}` : top.fn
  return 'synchronous work' // we genuinely do not know, and say so rather than inventing a cause
}

/** The evidence under the headline: what was labelled, and what the CPU was actually executing. */
function evidenceOf(s: Stall): string {
  const bits: string[] = []
  for (const sp of (s.spans ?? []).slice(0, 3)) bits.push(`${sp.label} ${secs(sp.ms)}`)
  for (const f of (s.stack ?? []).slice(0, 3)) {
    bits.push(f.file ? `${f.fn} (${f.file}) ${secs(f.ms)}` : `${f.fn} ${secs(f.ms)}`)
  }
  return bits.join(' · ')
}

/** One name per freeze, so the session can be aggregated into "what is actually costing you time". */
function culpritOf(s: Stall): string | null {
  if (s.cause === 'gc') return 'garbage collection'
  if (s.breadcrumb) return humanLabel(s.breadcrumb)
  return s.stack?.[0]?.fn ?? null
}

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

  // The single most useful sentence this panel can produce: across everything recorded, which
  // operation has actually cost you the most time? One freeze is an anecdote; this is the pattern.
  const totals = new Map<string, { ms: number; n: number }>()
  for (const s of stalls) {
    const who = culpritOf(s)
    if (!who) continue
    const t = totals.get(who) ?? { ms: 0, n: 0 }
    t.ms += s.durationMs
    t.n += 1
    totals.set(who, t)
  }
  const worstOffender = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms)[0]
  const unnamed = stalls.filter((s) => s.cause !== 'gc' && !s.breadcrumb && !s.stack?.length).length

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
              {stalls.length} freeze{stalls.length === 1 ? '' : 's'} recorded &mdash; worst {secs(worst)}
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
                  synchronous work blocking the loop. Each row below names what was running.
                </>
              ) : (
                <>
                  None were garbage collection &mdash; something ran <strong>synchronously</strong> on
                  the main thread. Each row below names what was running.
                </>
              )}
            </div>
            {worstOffender && (
              <div data-testid="stall-worst-offender" className="text-xs mt-1.5 leading-relaxed">
                Biggest cost: <strong>{worstOffender[0]}</strong> &mdash;{' '}
                {secs(worstOffender[1].ms)} across {worstOffender[1].n} freeze
                {worstOffender[1].n === 1 ? '' : 's'}.
              </div>
            )}
            {unnamed > 0 && (
              <div className="text-[10px] mt-1 opacity-70">
                {unnamed} could not be attributed &mdash; stack sampling was off, or the work finished
                before it could be sampled.
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            {recent.map((s, i) => {
              const evidence = evidenceOf(s)
              return (
                <div
                  key={`${s.ts}-${i}`}
                  data-testid="stall-row"
                  className="flex items-start justify-between gap-2 text-xs rounded border border-[#3c3c3c] bg-[#2d2d2d] px-2.5 py-1.5"
                >
                  <span className="font-medium text-[#FFB74D] tabular-nums pt-px">{secs(s.durationMs)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-[#d4d4d4] block truncate">{titleOf(s)}</span>
                    {evidence && (
                      <span
                        data-testid="stall-evidence"
                        className="text-[10px] text-[#7d8590] block truncate font-mono mt-0.5"
                        title={evidence}
                      >
                        {evidence}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-[#7d8590] tabular-nums whitespace-nowrap pt-px">
                    heap {s.heapUsedMB} MB &middot; rss {s.rssMB} MB
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
