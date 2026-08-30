// Where is the brain actually running?
//
// v1.26 moved the memory store into its own utilityProcess, which is what took the launch freeze
// from 19.5s to 0.2s and the main process from 1.9 GB to ~105 MB. But `memoryClient` falls back to
// running it on the main thread whenever the child cannot start — and that fallback is DESIGNED to
// be invisible, because the alternative is an app with no memory at all.
//
// Invisible is the problem. A user could run for months paying the full main-thread cost with no
// way to know the release did nothing for them, and every test would still pass. So say it out
// loud, in the one tab where someone would think to look.
//
// v1.38.2 — and say the RIGHT thing. STARTING IS NOT FAILING. The child reports ready only once it
// has decrypted and parsed the whole shard set, which on a large brain is tens of seconds; for that
// entire window this panel used to render the failure copy ("could not start ... fell back to the
// main thread") because it treated every non-'host' mode as the fallback. Opening this tab shortly
// after launch — the single most likely moment to open it — therefore produced a confident, false
// bug report, and because the panel reads once and never again, it stayed on screen for the rest of
// the session while the brain ran perfectly well in its own process the whole time.
//
// One IPC call on mount and on Refresh. Two in-memory reads in main. The ONLY timer is the bounded
// re-probe below, which exists solely to leave the transitional state — it is not the v1.25.16
// steady-state poll this file was written to avoid, and it stops itself the moment the mode settles.
import { useEffect, useState } from 'react'

type Mode = 'host' | 'starting' | 'inproc' | 'unstarted'

interface HostStatus {
  mode: Mode
  pid: number | null
}

/** How often to re-ask while the child is still coming up, and for how long. The client gives the
 *  host 120 s to report ready and will respawn up to 3 times before giving up, so the probe has to
 *  outlast that or it would park on 'starting' and become a new, quieter lie. It ends immediately on
 *  any settled mode — the cap is only there so a wedged state can never poll forever. */
const PROBE_MS = 2000
const MAX_PROBES = 300 // 10 minutes

export function BrainProcessPanel({ refreshToken }: { refreshToken: number }): JSX.Element | null {
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState(0)

  // A Refresh (or a re-mount) restarts the probe budget: the user is asking again, so an earlier
  // exhausted budget must not make this read the last one.
  useEffect(() => { setProbe(0) }, [refreshToken])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // A STATUS panel must never take down the tab it reports on. If the bridge isn't there (an
    // older preload, a test harness with a partial `window.termpolis`), render nothing and get out
    // of the way — the dashboard beside this is the thing the user actually came for.
    const read = window.termpolis?.memoryHostStatus
    if (typeof read !== 'function') return
    read()
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data) {
          setStatus(res.data)
          setError(null)
          if (res.data.mode === 'starting' && probe < MAX_PROBES) {
            timer = setTimeout(() => { if (!cancelled) setProbe((p) => p + 1) }, PROBE_MS)
          }
        } else setError(res.error ?? 'could not read the memory process status')
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [refreshToken, probe])

  if (error) {
    return (
      <div data-testid="brain-process-panel" className="text-xs text-[#999]">
        Memory process: unknown ({error})
      </div>
    )
  }
  if (!status) return null

  // Three states, not two. The fallback is the whole reason this panel exists, so it does not get to
  // look like a footnote — but neither does a healthy launch get to wear the fallback's clothes.
  const starting = status.mode === 'starting'
  const degraded = !starting && status.mode !== 'host'

  return (
    <div
      data-testid="brain-process-panel"
      data-mode={status.mode}
      className={`rounded border px-3 py-2 ${
        degraded ? 'border-[#f0a020] bg-[#f0a02014]' : starting ? 'border-[#3794d2] bg-[#3794d214]' : 'border-[#3c3c3c] bg-[#ffffff08]'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${degraded ? 'bg-[#f0a020]' : starting ? 'bg-[#3794d2] animate-pulse' : 'bg-[#4ec9b0]'}`} />
        <span className={`text-xs font-semibold ${degraded ? 'text-[#f0a020]' : starting ? 'text-[#3794d2]' : 'text-[#4ec9b0]'}`}>
          {degraded
            ? 'Memory is running on the main thread'
            : starting
              ? 'Memory is starting in its own process…'
              : 'Memory runs in its own process'}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[#999]">
        {degraded ? (
          <>
            The memory store could not start in a separate process, so it fell back to the{' '}
            <strong className="text-[#ccc]">main thread</strong> — the same thread that draws this window and
            echoes your keystrokes. The app still works, but launch is slower and typing can stutter while
            memory is busy. Restarting Termpolis usually clears it.
          </>
        ) : starting ? (
          <>
            The store is loading in its own <strong className="text-[#ccc]">utilityProcess</strong>
            {status.pid ? <> (pid {status.pid})</> : null} — it reports ready only once the whole shard set is
            decrypted and parsed, which takes longer the bigger your brain is. Nothing is wrong and nothing is
            running on the main thread; this panel updates itself when it finishes.
          </>
        ) : (
          <>
            The store, its indexes and the knowledge graph live in a separate{' '}
            <strong className="text-[#ccc]">utilityProcess</strong>
            {status.pid ? <> (pid {status.pid})</> : null} — so loading ~90k memories at launch never blocks
            the window or your typing. You can see it in Task Manager as a second Termpolis process.
          </>
        )}
      </p>
    </div>
  )
}
