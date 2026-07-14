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
// One IPC call on mount and on Refresh. Two in-memory reads in main. Never a timer — polling the
// main thread from a dashboard is the exact mistake v1.25.16 was written to undo.
import { useEffect, useState } from 'react'

type Mode = 'host' | 'inproc' | 'unstarted'

interface HostStatus {
  mode: Mode
  pid: number | null
}

export function BrainProcessPanel({ refreshToken }: { refreshToken: number }): JSX.Element | null {
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // A STATUS panel must never take down the tab it reports on. If the bridge isn't there (an
    // older preload, a test harness with a partial `window.termpolis`), render nothing and get out
    // of the way — the dashboard beside this is the thing the user actually came for.
    const read = window.termpolis?.memoryHostStatus
    if (typeof read !== 'function') return
    read()
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data) { setStatus(res.data); setError(null) }
        else setError(res.error ?? 'could not read the memory process status')
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [refreshToken])

  if (error) {
    return (
      <div data-testid="brain-process-panel" className="text-xs text-[#999]">
        Memory process: unknown ({error})
      </div>
    )
  }
  if (!status) return null

  // The fallback is the whole reason this panel exists, so it does not get to look like a footnote.
  const degraded = status.mode !== 'host'

  return (
    <div
      data-testid="brain-process-panel"
      data-mode={status.mode}
      className={`rounded border px-3 py-2 ${
        degraded ? 'border-[#f0a020] bg-[#f0a02014]' : 'border-[#3c3c3c] bg-[#ffffff08]'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${degraded ? 'bg-[#f0a020]' : 'bg-[#4ec9b0]'}`} />
        <span className={`text-xs font-semibold ${degraded ? 'text-[#f0a020]' : 'text-[#4ec9b0]'}`}>
          {degraded ? 'Memory is running on the main thread' : 'Memory runs in its own process'}
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
