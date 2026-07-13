import { useEffect, useState } from 'react'

interface ShieldScanFailedEvent {
  op: 'commit' | 'push'
  cwd: string
  error: string
}

interface ShieldSubscriber {
  onShieldScanFailed?: (cb: (data: ShieldScanFailedEvent) => void) => () => void
}

/**
 * The Commit Shield tried to scan, could not, and let the git operation through anyway.
 *
 * Fail-open is deliberate: a scanner or git error must never wedge your commit for a reason that has
 * nothing to do with secrets. But fail-open must never be fail-SILENT, and that is the entire reason
 * this component exists. A security control whose failure is indistinguishable from success is worse
 * than no control at all, because you go on believing you are protected. (That is exactly what made
 * the gpg-private watcher rule useless for so long: it could never fire, and its silence read as
 * "nothing to report".)
 *
 * So this does not auto-dismiss. "Your commit was not scanned" is not a toast — it is a fact you
 * have to actually see, and the only person who can decide what to do about it is you.
 */
export function ShieldScanFailedBanner() {
  const [event, setEvent] = useState<ShieldScanFailedEvent | null>(null)

  useEffect(() => {
    const api = (window as any).aiSecurity as ShieldSubscriber | undefined
    if (!api?.onShieldScanFailed) return
    const unsub = api.onShieldScanFailed((data) => setEvent(data))
    return () => {
      try { unsub?.() } catch { /* ignore */ }
    }
  }, [])

  if (!event) return null

  const repo = event.cwd ? event.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="shield-scan-failed-banner"
      className="px-4 py-2 flex items-center justify-between text-sm bg-[#3d2a1a] border-t border-[#FF9800]/50 text-[#FFB74D]"
    >
      <div className="flex items-center gap-2">
        <i className="fa-solid fa-shield-halved"></i>
        <span>
          Commit Shield could <strong>not scan</strong> your {event.op}
          {repo ? ` in ${repo}` : ''} — it was <strong>allowed through unscanned</strong>.
          {' '}Secrets in it would not have been caught. ({event.error})
        </span>
      </div>
      <button
        onClick={() => setEvent(null)}
        className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
        aria-label="Dismiss shield warning"
      >
        <i className="fa-solid fa-xmark"></i>
      </button>
    </div>
  )
}
