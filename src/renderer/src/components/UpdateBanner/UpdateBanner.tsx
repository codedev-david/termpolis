import { useEffect, useState } from 'react'

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  error?: string
  // Set on an 'error' that is the user's to act on, with `error` in plain words.
  reason?: 'read-only-location' | 'disk-full' | 'no-new-privs'
  downloadedBytes?: number
  totalBytes?: number
}

// Thin banner above the status bar. Hidden unless an update has finished
// downloading and is waiting for the user to restart and install — or the
// updater needs the user to do something first (free up disk space; on macOS,
// run Termpolis from Applications), which shows as a hint instead. A failure
// that isn't the user's to fix never shows here.
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  // Per version: after a later check, or a check that failed, main announces
  // the same download again — which mustn't bring back a banner already dismissed.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [dismissedHints, setDismissedHints] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const updater = (window as any).updater
    if (!updater) return

    updater.getStatus().then((s: UpdateState) => s && setState(s)).catch(() => {})
    const unsub = updater.onState((next: UpdateState) => setState(next))
    return () => unsub?.()
  }, [])

  const { reason } = state
  if (state.status === 'error' && reason && state.error) {
    if (dismissedHints.has(reason)) return null
    return (
      <div
        role="status"
        className="px-4 py-2 flex items-center justify-between text-sm bg-[#FF9800]/10 border-t border-[#FF9800]/30 text-[#FFB74D]"
      >
        <div className="flex items-center gap-2">
          <i className={reason === 'disk-full' ? 'fa-solid fa-hard-drive' : 'fa-solid fa-circle-info'}></i>
          <span>{state.error}</span>
        </div>
        <button
          onClick={() => setDismissedHints((prev) => new Set(prev).add(reason))}
          className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
          aria-label="Dismiss update hint"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
    )
  }

  if (state.status !== 'downloaded') return null
  const version = state.version ?? ''
  if (dismissedVersion === version) return null

  const handleRestart = async () => {
    const updater = (window as any).updater
    if (!updater) return
    await updater.quitAndInstall()
  }

  return (
    <div className="px-4 py-2 flex items-center justify-between text-sm bg-[#22D3EE]/10 border-t border-[#22D3EE]/30 text-[#22D3EE]">
      <div className="flex items-center gap-2">
        <i className="fa-solid fa-circle-arrow-down"></i>
        <span>
          Termpolis {state.version ? `v${state.version} ` : ''}is ready — restart to install.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleRestart}
          className="text-xs px-3 py-1 rounded bg-[#22D3EE]/20 hover:bg-[#22D3EE]/30 font-medium"
        >
          Restart now
        </button>
        <button
          onClick={() => setDismissedVersion(version)}
          className="text-xs px-1.5 py-1 rounded hover:bg-white/10"
          aria-label="Dismiss update banner"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  )
}
